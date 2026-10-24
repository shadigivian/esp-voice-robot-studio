// Copy this directory to existing server/deno/management; install the main.ts patch.
// This module attaches to the existing listener. It never opens a parallel voice server.
import { Buffer } from 'node:buffer';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'npm:ws';
import { bindDevice, GenerationGate, ManagementClient, MANAGED_TOOLS, Pcm16Resampler, Pcm16Frames } from './core.mjs';

type Packetizer = { push(pcm: Uint8Array): void; flush(pad?: boolean): void; reset(): void; close(): void };
type Options = {
  createOpusPacketizer(send: (packet: Uint8Array) => void): Packetizer;
  baseUrl?: string; adapterSecret?: string; apiKey?: string;
  provider?: 'openai' | 'qwen'; providerUrl?: string; model?: string; voice?: string;
  // Deterministic transport fixture; production leaves this unset.
  openProviderSocket?: (url: string, headers: Record<string, string>) => WebSocket;
};

export function createManagedVoiceUpgrade(options: Options) {
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 65536 });
  const baseUrl = options.baseUrl ?? Deno.env.get('MANAGEMENT_BASE_URL');
  const adapterSecret = options.adapterSecret ?? Deno.env.get('MANAGEMENT_ADAPTER_SECRET');
  const provider = options.provider || Deno.env.get('AI_PROVIDER') || Deno.env.get('VOICE_PROVIDER') || 'openai';
  const qwen = provider === 'qwen';
  const apiKey = options.apiKey ?? Deno.env.get(qwen ? 'DASHSCOPE_API_KEY' : 'OPENAI_API_KEY');
  const qwenModel = options.model || Deno.env.get('QWEN_REALTIME_MODEL') || 'qwen3.8-omni-flash-realtime';
  const qwenVoice = options.voice || Deno.env.get('QWEN_VOICE') || Deno.env.get('QWEN_REALTIME_VOICE');
  let providerUrl: string | undefined;
  try {
    if (qwen) {
      const workspace = Deno.env.get('DASHSCOPE_WORKSPACE_ID');
      const region = Deno.env.get('DASHSCOPE_REGION') || 'ap-southeast-1';
      if (!['ap-southeast-1', 'cn-beijing'].includes(region)) throw new Error('invalid_region');
      const endpoint = options.providerUrl || Deno.env.get('QWEN_REALTIME_URL') ||
        (workspace && /^[a-zA-Z0-9_-]+$/.test(workspace) ? `wss://${workspace}.${region}.maas.aliyuncs.com/api-ws/v1/realtime` : undefined);
      if (endpoint) {
        const url = new URL(endpoint);
        if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('invalid_endpoint');
        url.searchParams.set('model', qwenModel); providerUrl = url.toString();
      }
    } else if (provider === 'openai') providerUrl = 'wss://api.openai.com/v1/live/sessions';
  } catch { /* Invalid provider configuration disables the managed route without breaking the legacy listener. */ }
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
    let stopped = false, ready = false, speaking = false, draining = false, responding = false;
    let lastAudio = 0, playbackId = 0, generation = 0;
    let controller = new AbortController();
    let inputResampler = new Pcm16Resampler();
    let inputFrames = new Pcm16Frames(), outputFrames = new Pcm16Frames();
    let outputTranscript = '', inputTranscript = '';
    let finalUsageReceived = false;
    let finalizing = false;
    let accessLeaseUntil = Date.now() + 1500;
    let providerSessionId: string | undefined;
    const calls = new Set<string>();
    const pendingTools = new Map<string, { name: string; arguments: unknown }>();
    const usageEvents = new Set<string>();
    const completedResponses = new Set<string>();
    const recordings = new Set<Promise<void>>();
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
    const record = (type: string, payload: Record<string, unknown>): Promise<void> => {
      // The management endpoint requires the adapter key and an active matching session.
      if (!client || !adapterSecret) return Promise.resolve();
      const task = client.call('server_event', { token, sessionId, event: { type, ...payload } })
        .then(() => {}).catch(() => { stop('telemetry_unavailable'); });
      recordings.add(task); void task.finally(() => recordings.delete(task)); return task;
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
      if (!qwen && upstream?.readyState === WebSocket.OPEN) {
        finalizing = true; event({ type: 'session.close' });
        const old = upstream;
        const forceClose = setTimeout(() => old.close(), 15000);
        old.once('close', () => clearTimeout(forceClose));
      } else upstream?.close();
      if (ws.readyState === WebSocket.OPEN) ws.close(1000, reason.slice(0, 100));
      // Preserve room for session.closed usage; transport failure is explicitly unconfirmed.
      setTimeout(() => {
        void Promise.allSettled([...recordings]).then(() => client?.call('end_session', {
          token, sessionId, reason, usageConfirmed: finalUsageReceived && (!qwen || !responding),
        })).catch(() => {});
      }, finalizing ? 15500 : 0);
    }
    const input = (pcm: Buffer) => {
      if (!ready || speaking || draining || (qwen && responding) || stopped) return;
      if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
      const converted = qwen ? inputFrames.push(pcm) : inputResampler.push(pcm);
      if (converted.length) event({ type: qwen ? 'input_audio_buffer.append' : 'session.input_audio.append', audio: Buffer.from(converted).toString('base64') });
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
      // Qwen has an explicit response.done marker. Silence is not the end of a streamed response.
      if (!qwen && speaking && Date.now() - lastAudio >= idleMs) finishTurn();
    }, 100);
    let checking = false;
    const accessCheck = setInterval(async () => {
      if (checking || stopped) return;
      checking = true;
      const checkController = controller;
      try {
        await bound.check(checkController.signal);
        if (controller === checkController) accessLeaseUntil = Date.now() + 1500;
      }
      catch { if (controller === checkController) stop('access_or_sources_changed'); }
      finally { checking = false; }
    }, 1000);
    const sessionTimeout = setTimeout(() => stop('session_duration_limit'),
      Math.min(Number(context.limits?.maxSessionSeconds || 600), 3600) * 1000);

    const start = async () => {
      if (stopped) return;
      generation = gate.next(); const thisGeneration = generation;
      ready = speaking = draining = responding = false; lastAudio = 0; calls.clear(); pendingTools.clear();
      queued.length = 0; queuedBytes = 0; inputResampler = new Pcm16Resampler();
      inputFrames = new Pcm16Frames(); outputFrames = new Pcm16Frames(); opus.reset();
      const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
      const live = options.openProviderSocket?.(providerUrl!, headers) ?? new WebSocket(providerUrl!, {
        headers, maxPayload: 2 * 1024 * 1024,
      });
      upstream = live;
      const startup = setTimeout(() => { if (gate.accepts(thisGeneration) && !ready) stop('provider_timeout'); }, 10000);
      live.on('open', () => {
        if (!gate.accepts(thisGeneration)) { live.close(); return; }
        if (qwen) return; // Configure only after session.created, and authenticate the robot after session.updated.
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
        if (!qwen && data.type === 'session.closed' && (gate.accepts(thisGeneration) || finalizing)) {
          finalUsageReceived = true;
          if (typeof data.usage?.seconds === 'number')
            await record('usage', { provider: 'openai-live', model: liveModel,
              usage: { voice_session_seconds: data.usage.seconds }, final: true,
              eventId: `live:${data.session?.id || providerSessionId || sessionId}:${thisGeneration}:final` });
          live.close(); return;
        }
        if (!gate.accepts(thisGeneration) || stopped) return;
        try {
          if (qwen) {
            if (data.type === 'session.created') {
              providerSessionId = data.session?.id;
              const publishedVoice = context.character?.voice;
              const openaiVoices = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse', 'marin', 'cedar'];
              const voice = publishedVoice && !openaiVoices.includes(publishedVoice) ? publishedVoice : (qwenVoice || 'Tina');
              event({ type: 'session.update', session: {
                modalities: ['text', 'audio'], instructions: context.instructions,
                audio: {
                  input: { format: { type: 'pcm', sample_rate: 16000, sample_format: 's16le', channels: 1,
                    packing: 'interleaved', channel_layout: 'mono' } },
                  output: { voice, format: { type: 'pcm', sample_rate: 24000 } },
                },
                input_audio_transcription: transcriptEnabled ? { model: 'qwen3-asr-flash-realtime' } : null,
                turn_detection: { type: 'semantic_vad', threshold: 0.5, silence_duration_ms: 800 },
                tools: (context.tools || MANAGED_TOOLS)
                  .filter((tool: any) => MANAGED_TOOLS.some((allowed: any) => allowed.name === tool.name))
                  .map((tool: any) => ({ type: 'function', function: {
                    name: tool.name, description: tool.description, parameters: tool.parameters,
                  } })),
              } });
            } else if (data.type === 'session.updated' && !ready) {
              clearTimeout(startup); ready = true;
              sendDevice({ type: 'auth', volume_control: context.volume ?? 70, pitch_factor: 1, is_ota: false, is_reset: false });
              sendDevice({ type: 'server', msg: 'RESPONSE.COMPLETE' });
              if (thisGeneration === 1 && context.character?.greeting) {
                responding = true; finalUsageReceived = false;
                event({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text',
                  text: `Open this new interaction in ${context.character.language || 'fa'} with this greeting, then listen: ${context.character.greeting}`,
                }] } });
                event({ type: 'response.create' });
              }
              while (queued.length) input(queued.shift()!); queuedBytes = 0;
            } else if (data.type === 'response.created' && ready) {
              responding = true; finalUsageReceived = false;
            } else if (data.type === 'response.audio.delta' && ready && typeof data.delta === 'string') {
              responding = true;
              const pcm = outputFrames.push(Buffer.from(data.delta, 'base64'));
              if (!pcm.length) return;
              if (!speaking) {
                speaking = true; draining = false; playbackId++; opus.reset();
                // All local mic frames are dropped until the matching playback ACK arrives.
                inputFrames = new Pcm16Frames(); event({ type: 'input_audio_buffer.clear' });
                sendDevice({ type: 'server', msg: 'RESPONSE.CREATED', playback_id: playbackId });
              }
              lastAudio = Date.now(); opus.push(pcm);
            } else if (data.type === 'response.audio_transcript.delta' && transcriptEnabled) {
              outputTranscript = (outputTranscript + (data.delta || '')).slice(-32000);
            } else if (data.type === 'conversation.item.input_audio_transcription.completed' && transcriptEnabled) {
              inputTranscript = (inputTranscript + (data.transcript || '')).slice(-32000);
            } else if (data.type === 'response.function_call_arguments.done') {
              if (typeof data.call_id !== 'string' || calls.has(data.call_id)) return;
              calls.add(data.call_id);
              pendingTools.set(data.call_id, { name: data.name, arguments: data.arguments });
            } else if (data.type === 'response.done') {
              const responseKey = String(data.response?.id || data.event_id || '');
              if (responseKey && completedResponses.has(`${thisGeneration}:${responseKey}`)) return;
              if (responseKey) completedResponses.add(`${thisGeneration}:${responseKey}`);
              // The final snapshot also carries function calls; tolerate omitted argument-done notifications.
              for (const item of data.response?.output || []) {
                if (item.type === 'function_call' && typeof item.call_id === 'string' && !calls.has(item.call_id)) {
                  calls.add(item.call_id); pendingTools.set(item.call_id, { name: item.name, arguments: item.arguments });
                }
              }
              const reported = data.response?.usage;
              const usage: Record<string, number> = {};
              for (const key of ['input_tokens', 'output_tokens'])
                if (typeof reported?.[key] === 'number' && Number.isFinite(reported[key]) && reported[key] >= 0) usage[key] = reported[key];
              for (const side of ['input', 'output']) for (const modality of ['text', 'audio']) {
                const value = reported?.[`${side}_tokens_details`]?.[`${modality}_tokens`];
                if (typeof value === 'number' && Number.isFinite(value) && value >= 0) usage[`${side}_${modality}_tokens`] = value;
              }
              if (Object.keys(usage).length) {
                const eventId = `qwen:${providerSessionId || sessionId}:${thisGeneration}:${responseKey || crypto.randomUUID()}`;
                if (!usageEvents.has(eventId)) {
                  usageEvents.add(eventId);
                  await record('usage', { provider: 'qwen-realtime', model: qwenModel, usage, final: true, eventId });
                  if (!gate.accepts(thisGeneration) || stopped) return;
                }
                finalUsageReceived = true;
              } else finalUsageReceived = false;
              if (data.response?.status === 'failed' || data.response?.status === 'incomplete') {
                stop('provider_response_failed'); return;
              }
              const tools = [...pendingTools]; pendingTools.clear();
              for (const [callId, item] of tools) {
                const result = await bound.execute(item.name, item.arguments, controller.signal);
                if (!gate.accepts(thisGeneration) || stopped) return;
                event({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(result) } });
                void record('tool', { name: item.name, status: result.status || 'ok' });
                if (item.name === 'end_session') { responding = false; stop('user_ended'); return; }
              }
              if (tools.length) {
                responding = true; finalUsageReceived = false; event({ type: 'response.create' });
              } else {
                responding = false;
                if (outputFrames.pendingByte !== null) { stop('provider_invalid_audio'); return; }
                if (speaking) finishTurn();
                else { commitTranscript(); sendDevice({ type: 'server', msg: 'RESPONSE.COMPLETE' }); }
              }
            } else if (data.type === 'error') {
              void record('error', { code: String(data.error?.code || 'provider_error').slice(0, 100) });
              stop('provider_error');
            }
            return;
          }
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
        } catch { if (gate.accepts(thisGeneration)) stop('authorization_or_tool_failure'); }
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
        draining = false;
        if (qwen) { inputFrames = new Pcm16Frames(); event({ type: 'input_audio_buffer.clear' }); }
        else event({ type: 'session.input_audio.unmute' });
      } else if (data.msg === 'INTERRUPT' || data.msg === 'RESPONSE.CANCEL') {
        // Live mute does not cancel generated speech. Drop this entire upstream generation.
        gate.close(); controller.abort(); upstream?.close(); opus.reset();
        controller = new AbortController();
        const interruptController = controller;
        sendDevice({ type: 'server', msg: 'AUDIO.CLEAR' });
        commitTranscript();
        try {
          await bound.check(interruptController.signal);
          if (controller === interruptController && !stopped) await start();
        } catch { if (controller === interruptController) stop('access_revoked'); }
      }
    });
    ws.on('close', () => stop('device_disconnected')); ws.on('error', () => stop('device_transport_error'));
    await start();
  }

  return async function tryManagedUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
    if (new URL(req.url || '/', 'http://internal').pathname !== '/managed-voice') return false;
    const reject = (status: number) => { socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`); socket.destroy(); };
    if (!client || !apiKey || !adapterSecret || !providerUrl) { reject(503); return true; }
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
      wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
        void connect(ws, token, context, session.sessionId).catch(() => ws.close(1011, 'managed_voice_unavailable'));
      });
    } catch { reject(401); }
    return true;
  };
}
