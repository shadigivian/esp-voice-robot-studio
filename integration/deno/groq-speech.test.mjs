import test from 'node:test';
import assert from 'node:assert/strict';
import { groqSpeechTurn, PcmTurnDetector, speechBridgeUrl, synthesizeSpeech, speechConfig } from './groq-speech.mjs';
import { MANAGED_TOOLS } from './core.mjs';

const config = { key: 'fixture-groq-key', textModel: 'qwen/fixture', sttModel: 'whisper-large-v3-turbo', language: 'fa',
  ttsUrl: 'http://127.0.0.1:8765/speech', speechBridgeToken: 'fixture-bridge-token', ttsVoice: 'fa-IR-fixture' };
const json = (value) => Response.json(value);
const pcmResponse = () => new Response(Buffer.from([1, 2, 3, 4]), { headers: { 'content-type': 'audio/pcm', 'x-audio-sample-rate': '24000' } });

test('Groq PCM turn uploads 16k WAV Persian transcription and resolves only session-bound tools before 24k speech', async () => {
  const requests = [], tools = [], usage = []; let chats = 0;
  const result = await groqSpeechTurn({ config, pcm: Buffer.alloc(3200), instructions: 'private instructions', tools: MANAGED_TOOLS,
    execute: async (name, args) => { tools.push({ name, args }); return { status: 'ok', facts: ['private fact'] }; },
    onUsage: async (value) => usage.push(value),
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      assert.equal(init.redirect, 'error');
      if (url.endsWith('/transcriptions')) {
        assert.equal(init.headers.Authorization, 'Bearer fixture-groq-key');
        assert.equal(init.body.get('language'), 'fa');
        const wav = Buffer.from(await init.body.get('file').arrayBuffer());
        assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(24), 16000);
        assert.equal(wav.length, 3244); return json({ text: 'سلام' });
      }
      if (url.endsWith('/completions')) {
        const body = JSON.parse(init.body);
        assert.equal(body.messages[0].content, 'private instructions');
        if (!chats++) return json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'get_verified_facts', arguments: '{"query":"قیمت"}' } }] } }], usage: { prompt_tokens: 2, completion_tokens: 3 } });
        assert.match(body.messages.at(-1).content, /private fact/);
        return json({ choices: [{ message: { role: 'assistant', content: 'سلام دوست من' } }], usage: { prompt_tokens: 5, completion_tokens: 6 } });
      }
      assert.equal(url, config.ttsUrl); assert.equal(init.headers.Authorization, 'Bearer fixture-bridge-token');
      assert.deepEqual(JSON.parse(init.body), { text: 'سلام دوست من', voice: 'fa-IR-fixture' }); return pcmResponse();
    },
  });
  assert.equal(result.transcript, 'سلام'); assert.equal(result.answer, 'سلام دوست من');
  assert.deepEqual(result.audio, Buffer.from([1, 2, 3, 4]));
  assert.deepEqual(tools, [{ name: 'get_verified_facts', args: { query: 'قیمت' } }]);
  assert.equal(requests.length, 4); assert.equal(usage.length, 4);
});

test('Speech bridge rejects remote HTTP, redirects and malformed PCM instead of forwarding audio', async () => {
  assert.equal(speechConfig(() => undefined).ttsVoice, 'fa_IR-amir-medium');
  let called = false;
  await assert.rejects(synthesizeSpeech(config, 'ا'.repeat(3001), undefined, async () => { called = true; return pcmResponse(); }), /too long/);
  assert.equal(called, false, 'bridge text limits must be checked before making a speech request');
  for (const url of ['http://public.invalid/speech', 'https://user:secret@trusted.invalid/speech', 'https://trusted.invalid/speech?token=secret'])
    assert.throws(() => speechBridgeUrl(url), /Configure GROQ_TTS_URL/);
  await assert.rejects(synthesizeSpeech(config, 'سلام', undefined, async () => new Response('wrong', { headers: { 'content-type': 'audio/mpeg' } })), /PCM16/);
  await assert.rejects(synthesizeSpeech(config, 'سلام', undefined, async () => new Response(Buffer.from([1]), { headers: { 'content-type': 'audio/pcm', 'x-audio-sample-rate': '24000' } })), /invalid PCM16/);
});

test('Groq speech rejects unknown tools and aborts stale generations before text synthesis', async () => {
  let executed = false, synthesized = false;
  await assert.rejects(groqSpeechTurn({ config, pcm: Buffer.alloc(3200), instructions: 'fixture', tools: MANAGED_TOOLS,
    execute: async () => { executed = true; },
    fetchImpl: async (url) => {
      if (url.endsWith('/transcriptions')) return json({ text: 'سلام' });
      if (url.endsWith('/completions')) return json({ choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'bad', type: 'function', function: { name: 'exfiltrate', arguments: '{}' } }] } }] });
      synthesized = true; return pcmResponse();
    },
  }), /unavailable tool/);
  assert.equal(executed, false); assert.equal(synthesized, false);
  const controller = new AbortController();
  await assert.rejects(groqSpeechTurn({ config, pcm: Buffer.alloc(3200), instructions: 'fixture', signal: controller.signal,
    fetchImpl: async () => { controller.abort(); return json({ text: 'سلام' }); },
  }));
});

test('PCM VAD ignores silence, handles odd-byte splits and bounds turns to 15 seconds', () => {
  const detector = new PcmTurnDetector({ threshold: 600, silenceMs: 100, minMs: 100 });
  assert.equal(detector.push(Buffer.alloc(32000)), null);
  const voice = Buffer.alloc(6400); for (let i = 0; i < voice.length; i += 2) voice.writeInt16LE(2000, i);
  assert.equal(detector.push(voice.subarray(0, 1)), null); assert.equal(detector.push(voice.subarray(1)), null);
  const turn = detector.push(Buffer.alloc(3200)); assert.equal(turn.length, 9600);
  const long = Buffer.alloc(500000); for (let i = 0; i < long.length; i += 2) long.writeInt16LE(2000, i);
  assert.equal(detector.push(long).length, 480000);
});
