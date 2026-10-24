import { Buffer } from 'node:buffer';
import { bindDevice, GenerationGate, MANAGED_TOOLS } from './core.mjs';
import { groqSpeechTurn, PcmTurnDetector } from './groq-speech.mjs';

/** Cascaded Persian speech uses the same device token, revocation lease and playback ACK contract. */
export async function connectManagedGroq({ ws, client, token, context, sessionId, adapterSecret, config,
  createOpusPacketizer, fetchImpl = fetch, detectorOptions }) {
  const bound = bindDevice(client, token, context, sessionId), gate = new GenerationGate();
  const detector = new PcmTurnDetector(detectorOptions);
  let controller = new AbortController(), stopped = false, busy = false, speaking = false, draining = false;
  let playbackId = 0, accessLeaseUntil = Date.now() + 1500, checking = false, ended = false;
  let inferenceInFlight = false, usageUncertain = false;
  let history = [];
  const recordings = new Set();
  const send = (data) => { if (ws.readyState === 1) ws.send(JSON.stringify(data)); };
  const opus = createOpusPacketizer((packet) => {
    if (stopped || !speaking) return;
    if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
    if (ws.bufferedAmount > 8192) { stop('slow_device'); return; }
    if (ws.readyState === 1) ws.send(packet);
  });
  const record = (type, payload) => {
    if (!adapterSecret) return Promise.resolve();
    const task = client.call('server_event', { token, sessionId, event: { type, ...payload } }).then(() => {})
      .catch(() => { stop('telemetry_unavailable'); });
    recordings.add(task); void task.finally(() => recordings.delete(task)); return task;
  };
  function stop(reason) {
    if (stopped) return;
    // An interrupted request can still be billed upstream. Later complete turns cannot confirm that missing usage.
    if (inferenceInFlight) usageUncertain = true;
    const usageConfirmed = !usageUncertain && !inferenceInFlight;
    stopped = true; gate.close(); controller.abort(); detector.reset(); opus.close(); history = [];
    clearInterval(watchdog); clearInterval(accessCheck); clearTimeout(sessionTimeout);
    send({ type: 'server', msg: 'AUDIO.CLEAR', reason });
    if (ws.readyState === 1) ws.close(1000, reason.slice(0, 100));
    void Promise.allSettled([...recordings]).then(() => client.call('end_session', { token, sessionId, reason, usageConfirmed })).catch(() => {});
  }
  const watchdog = setInterval(() => { if (Date.now() > accessLeaseUntil) stop('access_validation_timeout'); }, 100);
  const accessCheck = setInterval(async () => {
    if (checking || stopped) return;
    checking = true; const ownController = controller;
    try { await bound.check(ownController.signal); if (ownController === controller) accessLeaseUntil = Date.now() + 1500; }
    catch { if (ownController === controller) stop('access_or_sources_changed'); }
    finally { checking = false; }
  }, 1000);
  const duration = Number(context.limits?.maxSessionSeconds || 600);
  const sessionTimeout = setTimeout(() => stop('session_duration_limit'), Math.max(1, Math.min(Number.isFinite(duration) ? duration : 600, 3600)) * 1000);
  const transcripts = context.privacy?.transcriptEnabled === true || context.privacy?.storeTranscripts === true;
  const turn = async (pcm, greeting) => {
    if (stopped || busy || draining) return;
    busy = true; detector.reset(); inferenceInFlight = true;
    if (pcm) send({ type: 'server', msg: 'AUDIO.COMMITTED' });
    const generation = gate.next(), ownController = controller;
    const current = () => !stopped && gate.accepts(generation) && ownController === controller;
    const check = async () => {
      ownController.signal.throwIfAborted();
      if (!current()) throw new Error('stale_generation');
      await bound.check(ownController.signal);
      if (!current()) throw new Error('stale_generation');
      accessLeaseUntil = Date.now() + 1500;
    };
    try {
      const result = await groqSpeechTurn({ config, pcm, greeting, instructions: context.instructions, history,
        tools: (context.tools || MANAGED_TOOLS).filter((tool) => MANAGED_TOOLS.some((allowed) => allowed.name === tool.name)),
        check, signal: ownController.signal, fetchImpl,
        execute: async (name, args) => {
          const output = await bound.execute(name, args, ownController.signal); await check();
          await record('tool', { name, status: output.status || 'ok' }); return output;
        },
        onUsage: async (usage) => { if (current()) await record('usage', usage); },
      });
      await check();
      inferenceInFlight = false;
      if (transcripts) {
        if (result.transcript) await record('message', { role: 'user', text: result.transcript });
        await record('message', { role: 'assistant', text: result.answer });
      }
      if (!current()) return;
      if (result.transcript) history.push({ role: 'user', content: result.transcript });
      history.push({ role: 'assistant', content: result.answer }); history = history.slice(-12);
      ended = result.ended; speaking = true; draining = false; playbackId++; opus.reset();
      send({ type: 'server', msg: 'RESPONSE.CREATED', playback_id: playbackId });
      // Pace PCM into Opus at playback speed so long replies cannot overrun ESP's small receive queue.
      for (let offset = 0; offset < result.audio.length && current(); offset += 960) {
        if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
        opus.push(result.audio.subarray(offset, offset + 960));
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      if (!current()) return;
      opus.flush(true); speaking = false; draining = true; busy = false;
      send({ type: 'server', msg: 'RESPONSE.COMPLETE', playback_id: playbackId });
    } catch {
      if (current()) { usageUncertain = true; stop('groq_speech_failed'); }
    } finally { if (current()) busy = false; }
  };
  ws.on('message', async (raw, binary) => {
    if (stopped) return;
    if (binary) {
      if (busy || speaking || draining) return;
      if (Date.now() > accessLeaseUntil) { stop('access_validation_timeout'); return; }
      const pcm = detector.push(Buffer.from(raw)); if (pcm) void turn(pcm);
      return;
    }
    let data; try { data = JSON.parse(raw.toString()); } catch { return; }
    if (data.type !== 'instruction') return;
    if (data.msg === 'END_SESSION') stop('user_ended');
    else if (data.msg === 'PLAYBACK.COMPLETE' && draining && data.playback_id === playbackId) {
      draining = false; detector.reset(); if (ended) stop('user_ended');
    } else if (data.msg === 'INTERRUPT' || data.msg === 'RESPONSE.CANCEL') {
      if (inferenceInFlight) usageUncertain = true;
      inferenceInFlight = false;
      gate.close(); controller.abort(); controller = new AbortController(); const ownController = controller;
      busy = speaking = draining = ended = false; history = []; detector.reset(); opus.reset();
      send({ type: 'server', msg: 'AUDIO.CLEAR' });
      try {
        await bound.check(ownController.signal);
        if (ownController !== controller || stopped) return;
        accessLeaseUntil = Date.now() + 1500;
        send({ type: 'server', msg: 'RESPONSE.COMPLETE' });
      } catch { if (ownController === controller) stop('access_revoked'); }
    }
  });
  ws.on('close', () => stop('device_disconnected')); ws.on('error', () => stop('device_transport_error'));
  await bound.check(controller.signal);
  send({ type: 'auth', volume_control: context.volume ?? 70, pitch_factor: 1, is_ota: false, is_reset: false });
  send({ type: 'server', msg: 'RESPONSE.COMPLETE' });
  if (context.character?.greeting) void turn(undefined, context.character.greeting);
}
