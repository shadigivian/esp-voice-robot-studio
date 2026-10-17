// Copy this directory to existing server/deno/management; install the main.ts patch.
// This module attaches to the existing listener. It never opens a parallel voice server.
import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'npm:ws';
import { bindDevice, GenerationGate, ManagementClient, MANAGED_TOOLS, Pcm16Resampler } from './core.mjs';

type Packetizer = { push(pcm: Uint8Array): void; flush(pad?: boolean): void; reset(): void; close(): void };
type Options = {
  createOpusPacketizer(send: (packet: Uint8Array) => void): Packetizer;
  baseUrl?: string; adapterSecret?: string; apiKey?: string;
  // Deterministic transport fixture; production leaves this unset.
  openProviderSocket?: () => WebSocket;
};

export function createManagedVoiceUpgrade(options: Options) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 });
  const baseUrl = options.baseUrl ?? Deno.env.get('MANAGEMENT_BASE_URL');
  const adapterSecret = options.adapterSecret ?? Deno.env.get('MANAGEMENT_ADAPTER_SECRET');
  const apiKey = options.apiKey ?? Deno.env.get('OPENAI_API_KEY');
  const liveModel = Deno.env.get('OPENAI_LIVE_MODEL') || 'gpt-live-1';
  // Keep the backend model choice consistent with the existing working provider.
  const backendModel = Deno.env.get('OPENAI_LIVE_BACKEND_MODEL') || 'gpt-5.6-luna';
  const configuredIdle = Number(Deno.env.get('OPENAI_LIVE_TURN_IDLE_MS') || '900');
  const idleMs = Number.isFinite(configuredIdle) ? Math.min(10000, Math.max(100, configuredIdle)) : 900;
  const allowLocal = Deno.env.get('MANAGEMENT_ALLOW_LOCAL_HTTP') === 'true';
  let client: ManagementClient | null = null;
  try { if (baseUrl) client = new ManagementClient({ baseUrl, adapterSecret, allowLocalHttp: allowLocal }); }
  catch { /* A bad optional management URL must not prevent legacy voice from starting. Managed route returns 503. */ }

  async function connect(ws: WebSocket, token: string, context: any, sessionId: string) {
    const bound = bindDevice(client!, token, context, sessionId);
    const gate = new GenerationGate();
    let upstream: WebSocket | undefined;
    let stopped = false, ready = false, speaking = false, draining = false;
    let lastAudio = 0, playbackId = 0, generation = 0;
    let controller = new AbortController();
    let inputResampler = new Pcm16Resampler();
    let outputTranscript = '', inputTranscript = '';
    let finalUsageReceived = false;
    let finalizing = false;
    let accessLeaseUntil = Date.now() + 1500;
    let providerSessionId: string | undefined;
    const calls = new Set<string>();
    const queued: Buffer[] = [];
    let queuedBytes = 0;
    const maxQueueBytes = 16000 * 2; // one second; never retain unbounded microphone data
    const sendDevice = (data: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
    };
    const opus = options.createOpusPacketizer((packet) => {
      if (!stopped && speaking && ws.readyState === WebSocket.OPEN) {
        if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
        if (ws.bufferedAmount > 8192) { stop('slow_device'); return; }
        ws.send(packet);
      }
    });
    const event = (payload: Record<string, unknown>) => {
      if (upstream?.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ event_id: crypto.randomUUID(), ...payload }));
    };
    const record = async (type: string, payload: Record<string, unknown>) => {
      // The management endpoint requires the adapter key and an active matching session.
      if (!client || !adapterSecret) return;
      try { await client.call('server_event', { token, sessionId, event: { type, ...payload } }); }
      catch { stop('telemetry_unavailable'); }
    };
    const transcriptEnabled = context.privacy?.transcriptEnabled === true || context.privacy?.storeTranscripts === true;
    const commitTranscript = () => {
      if (transcriptEnabled && outputTranscript.trim()) void record('message', { role: 'assistant', text: outputTranscript.slice(-20000) });
      if (transcriptEnabled && inputTranscript.trim()) void record('message', { role: 'user', text: inputTranscript.slice(-20000) });
      outputTranscript = inputTranscript = '';
    };
    function stop(reason: string) {
      if (stopped) return;
      stopped = true; ready = false; gate.close(); controller.abort();
      queued.length = 0; queuedBytes = 0; opus.close();
      sendDevice({ type: 'server', msg: 'AUDIO.CLEAR', reason });
      clearInterval(watchdog); clearInterval(accessCheck); clearTimeout(sessionTimeout);
      commitTranscript();
      // Request final usage but never forward queued audio after stop. No copied history on reconnect.
      if (upstream?.readyState === WebSocket.OPEN) {
        finalizing = true; event({ type: 'session.close' });
        const old = upstream;
        const forceClose = setTimeout(() => old.close(), 15000);
        old.once('close', () => clearTimeout(forceClose));
      } else upstream?.close();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason.slice(0, 100));
      // Preserve room for session.closed usage; transport failure is explicitly unconfirmed.
      setTimeout(() => {
        void client?.call('end_session', { token, sessionId, reason, usageConfirmed: finalUsageReceived }).catch(() => {});
      }, finalizing ? 15500 : 0);
    }
    const input = (pcm: Buffer) => {
      if (!ready || speaking || draining || stopped) return;
      if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
      const converted = inputResampler.push(pcm);
      if (converted.length) event({ type: 'session.input_audio.append', audio: Buffer.from(converted).toString('base64') });
    };
    const finishTurn = () => {
      if (!speaking || stopped) return;
      opus.flush(true); speaking = false; draining = true; lastAudio = 0;
      sendDevice({ type: 'server', msg: 'RESPONSE.COMPLETE', playback_id: playbackId });
      commitTranscript();
    };
    const watchdog = setInterval(() => {
      if (stopped) return;
      if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
      if (speaking && Date.now() - lastAudio >= idleMs) finishTurn();
    }, 100);
    let checking = false;
    const accessCheck = setInterval(async () => {
      if (checking || stopped) return;
      checking = true;
      try { await bound.check(controller.signal); accessLeaseUntil = Date.now() + 1500; }
      catch { stop('access_or_sources_changed'); }
      finally { checking = false; }
    }, 1000);
    const sessionTimeout = setTimeout(() => stop('session_duration_limit'),
      Math.min(Number(context.limits?.maxSessionSeconds || 600), 3600) * 1000);

    const start = async () => {
      if (stopped) return;
      generation = gate.next(); const thisGeneration = generation;
      ready = speaking = draining = false; lastAudio = 0; calls.clear();
      queued.length = 0; queuedBytes = 0; inputResampler = new Pcm16Resampler(); opus.reset();
      const live = options.openProviderSocket?.() ?? new WebSocket('wss://api.openai.com/v1/live/sessions', {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, maxPayload: 2 * 1024 * 1024,
      });
      upstream = live;
      const startup = setTimeout(() => { if (gate.accepts(thisGeneration) && !ready) stop('provider_timeout'); }, 10000);
      live.on('open', () => {
        if (!gate.accepts(thisGeneration)) { live.close(); return; }
        // Context instructions are built by the very same backend builder as Playground.
        event({ type: 'session.start', session: {
          model: liveModel, store: false, instructions: context.instructions,
          ...(thisGeneration === 1 && context.character?.greeting ? { input: [{
            type: 'message', role: 'developer', content: [{ type: 'input_text',
              text: `Open this new interaction in ${context.character.language || 'fa'} with this greeting, then listen: ${context.character.greeting}` }],
          }] } : {}),
          audio: { format: { type: 'audio/pcm', rate: 24000 }, output: { voice: context.character?.voice || 'marin' } },
          delegation: { type: 'responses', responses: { model: backendModel,
            instructions: context.instructions,
            tools: (context.tools || MANAGED_TOOLS).filter((tool: any) => MANAGED_TOOLS.some((allowed: any) => allowed.name === tool.name))
              .map((tool: any) => ({ ...tool, strict: true, parameters: { ...tool.parameters, required: tool.parameters.required || [] } })),
            tool_choice: 'auto' } },
        } });
      });
      live.on('message', async (raw: Buffer) => {
        let data: any; try { data = JSON.parse(raw.toString()); } catch { return; }
        if (data.type === 'session.closed' && (gate.accepts(thisGeneration) || finalizing)) {
          finalUsageReceived = true;
          if (typeof data.usage?.seconds === 'number')
            await record('usage', { provider: 'openai-live', model: liveModel,
              usage: { voice_session_seconds: data.usage.seconds }, final: true,
              eventId: `live:${data.session?.id || providerSessionId || sessionId}:${thisGeneration}:final` });
          live.close(); return;
        }
        if (!gate.accepts(thisGeneration) || stopped) return;
        try {
          if (data.type === 'session.started') {
            providerSessionId = data.session?.id;
            clearTimeout(startup); ready = true;
            sendDevice({ type: 'auth', volume_control: context.volume ?? 70, pitch_factor: 1, is_ota: false, is_reset: false });
            sendDevice({ type: 'server', msg: 'RESPONSE.COMPLETE' });
            // No greeting instruction is auto-triggered after a manual interrupt.
            while (queued.length) input(queued.shift()!); queuedBytes = 0;
          } else if (data.type === 'session.output_audio.delta' && typeof data.delta === 'string') {
            // Each received audio segment re-enters SPEAKING, even if Live paused over the idle threshold.
            if (!speaking) {
              speaking = true; draining = false; playbackId++; opus.reset();
              event({ type: 'session.input_audio.mute' });
              sendDevice({ type: 'server', msg: 'RESPONSE.CREATED', playback_id: playbackId });
            }
            lastAudio = Date.now(); opus.push(Buffer.from(data.delta, 'base64'));
          } else if (data.type === 'session.output_transcript.delta' && transcriptEnabled) {
            outputTranscript = (outputTranscript + (data.delta || '')).slice(-32000);
          } else if (data.type === 'session.input_transcript.delta' && transcriptEnabled) {
            inputTranscript = (inputTranscript + (data.delta || '')).slice(-32000);
          } else if (data.type === 'response.event') {
            const nested = data.event;
            if (nested?.type === 'response.output_item.done' && nested.item?.type === 'function_call') {
              const item = nested.item;
              if (!item.call_id || calls.has(item.call_id)) return;
              calls.add(item.call_id);
              const result = await bound.execute(item.name, item.arguments, controller.signal);
              if (!gate.accepts(thisGeneration)) return;
              event({ type: 'response.item.create', item: { type: 'function_call_output', call_id: item.call_id, output: JSON.stringify(result) } });
              if (item.name === 'end_session') { stop('user_ended'); return; }
              event({ type: 'response.create' });
              void record('tool', { name: item.name, status: result.status || 'ok' });
            } else if (nested?.type === 'response.completed') {
              const reported = nested.response?.usage;
              const usage: Record<string, number> = {};
              for (const key of ['input_tokens', 'output_tokens'])
                if (typeof reported?.[key] === 'number') usage[key] = reported[key];
              if (Object.keys(usage).length)
                void record('usage', { provider: 'openai-responses', model: backendModel, usage, final: true,
                  eventId: `responses:${nested.response?.id || nested.event_id || crypto.randomUUID()}` });
            }
          } else if (data.type === 'error') {
            // Do not forward provider errors: they can include prompts and private tool parameters.
            void record('error', { code: String(data.error?.code || 'provider_error').slice(0, 100) });
            stop('provider_error');
          }
        } catch { stop('authorization_or_tool_failure'); }
      });
      live.on('close', () => { clearTimeout(startup); if (gate.accepts(thisGeneration) && !stopped) stop('provider_disconnected'); });
      live.on('error', () => { if (gate.accepts(thisGeneration)) stop('provider_unavailable'); });
    };
    ws.on('message', async (raw: Buffer, binary: boolean) => {
      if (stopped) return;
      if (binary) {
        if (!ready) {
          if (queuedBytes + raw.length <= maxQueueBytes) { queued.push(Buffer.from(raw)); queuedBytes += raw.length; }
        } else input(raw);
        return;
      }
      let data: any; try { data = JSON.parse(raw.toString()); } catch { return; }
      if (data.type !== 'instruction') return;
      if (data.msg === 'END_SESSION') stop('user_ended');
      else if (data.msg === 'PLAYBACK.COMPLETE' && draining && data.playback_id === playbackId) {
        draining = false; event({ type: 'session.input_audio.unmute' });
      } else if (data.msg === 'INTERRUPT' || data.msg === 'RESPONSE.CANCEL') {
        // Live mute does not cancel generated speech. Drop this entire upstream generation.
        gate.close(); controller.abort(); upstream?.close(); opus.reset();
        controller = new AbortController();
        sendDevice({ type: 'server', msg: 'AUDIO.CLEAR' });
        commitTranscript();
        try { await bound.check(controller.signal); await start(); } catch { stop('access_revoked'); }
      }
    });
    ws.on('close', () => stop('device_disconnected')); ws.on('error', () => stop('device_transport_error'));
    await start();
  }

  return async function tryManagedUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    if (new URL(req.url || '/', 'http://internal').pathname !== '/managed-voice') return false;
    const reject = (status: number) => { socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!client || !apiKey || !adapterSecret) { reject(503); return true; }
    // This is a device-only route. Browser origins cannot present a device token here.
    if (req.headers.origin || req.headers['x-elato-playback-ack'] !== '1') { reject(403); return true; }
    const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]{20,2048})$/)?.[1];
    if (!token) { reject(401); return true; }
    try {
      const initial = await client.call('context', { token });
      bindDevice(client, token, initial);
      const session = await client.call('start_session', { token, type: 'live' });
      // The session snapshot pins the published configuration; never accept a model-supplied deviceId.
      const context = session.context || initial;
      wss.handleUpgrade(req, socket, head, (ws) => {
        void connect(ws, token, context, session.sessionId).catch(() => ws.close(1011, 'managed_voice_unavailable'));
      });
    } catch { reject(401); }
    return true;
  };
}
