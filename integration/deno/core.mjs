/** Shared transport-independent contracts. No provider key or tenant ID comes from a model. */
export class ManagementError extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}

export class ManagementClient {
  constructor({ baseUrl, adapterSecret, allowLocalHttp = false, fetchImpl = fetch }) {
    const url = new URL(baseUrl);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:'))) {
      throw new ManagementError('unsafe_management_url', 503);
    }
    this.url = new URL('/api/device', url);
    this.adapterSecret = adapterSecret;
    this.fetch = fetchImpl;
  }
  async call(action, input = {}, signal) {
    const timeout = AbortSignal.timeout(10000);
    const response = await this.fetch(this.url, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json',
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
        ...(this.adapterSecret ? { 'x-management-adapter-key': this.adapterSecret } : {}) },
      body: JSON.stringify({ ...input, action }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new ManagementError(response.status === 401 || response.status === 403
      ? 'device_unauthorized' : 'management_unavailable', response.status);
    const result = await response.json();
    if (result.error) throw new ManagementError(typeof result.error === 'string' ? result.error : 'management_error');
    return result.data ?? result;
  }
}

export const MANAGED_TOOLS = [
  ['search_device_knowledge', 'Search active approved private sources for this robot.', 'query'],
  ['get_verified_facts', 'Get verified facts for this robot. Do not invent prices or availability.', 'query'],
  ['get_device_public_profile', 'Get the public role and character of this robot.', null],
  ['end_session', 'End the current interaction when the user is finished.', 'reason'],
].map(([name, description, field]) => ({
  type: 'function', name, description, strict: true,
  parameters: { type: 'object', properties: field ? { [field]: { type: 'string', maxLength: 1000 } } : {},
    required: field ? [field] : [], additionalProperties: false },
}));

export function parseToolArgs(name, raw) {
  if (!MANAGED_TOOLS.some((tool) => tool.name === name)) throw new ManagementError('tool_forbidden', 403);
  let args;
  try { args = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { throw new ManagementError('invalid_tool_args', 400); }
  if (!args || Array.isArray(args) || typeof args !== 'object') throw new ManagementError('invalid_tool_args', 400);
  const field = name === 'end_session' ? 'reason' : name === 'get_device_public_profile' ? null : 'query';
  if (Object.keys(args).some((key) => key !== field) || (field &&
    (typeof args[field] !== 'string' || !args[field].trim() || args[field].length > 1000))) {
    throw new ManagementError('invalid_tool_args', 400);
  }
  return args;
}

export function contextFingerprint(context) {
  // Config versions are pinned per session; security epoch changes must end it.
  return `${context.workspaceId}:${context.deviceId}:${context.knowledgeEpoch}`;
}

export function bindDevice(client, token, initial, sessionId) {
  if (!token || !initial?.deviceId || !initial?.workspaceId || !initial?.instructions) {
    throw new ManagementError('invalid_device_context', 401);
  }
  const fingerprint = contextFingerprint(initial);
  const check = async (signal) => {
    const current = await client.call('context', { token, ...(sessionId ? { sessionId } : {}) }, signal);
    if (contextFingerprint(current) !== fingerprint) throw new ManagementError('context_revoked', 403);
    return current;
  };
  return {
    context: initial, check,
    async execute(name, raw, signal) {
      const args = parseToolArgs(name, raw);
      await check(signal);
      let result;
      if (name === 'search_device_knowledge') result = await client.call('search', { token, query: args.query, ...(sessionId ? { sessionId } : {}) }, signal);
      else if (name === 'get_verified_facts') result = await client.call('facts', { token, query: args.query, ...(sessionId ? { sessionId } : {}) }, signal);
      else if (name === 'get_device_public_profile') result = { status: 'ok', role: initial.role, character: initial.character };
      else result = { status: 'ok', ended: true };
      // Prevent a search started just before source deletion from returning old content.
      await check(signal);
      return result;
    },
  };
}

/** Streaming linear resampling. Carries boundary sample and odd byte across frames. */
export class Pcm16Resampler {
  constructor(fromRate = 16000, toRate = 24000) {
    this.step = fromRate / toRate; this.samples = []; this.position = 0; this.pendingByte = null;
  }
  push(bytes) {
    let index = 0;
    const sample = (lo, hi) => { const value = lo | (hi << 8); return value >= 32768 ? value - 65536 : value; };
    if (this.pendingByte !== null && bytes.length) { this.samples.push(sample(this.pendingByte, bytes[0])); index = 1; this.pendingByte = null; }
    for (; index + 1 < bytes.length; index += 2) this.samples.push(sample(bytes[index], bytes[index + 1]));
    if (index < bytes.length) this.pendingByte = bytes[index];
    const output = [];
    while (Math.floor(this.position) + 1 < this.samples.length) {
      const left = Math.floor(this.position), f = this.position - left;
      const value = Math.round(this.samples[left] * (1 - f) + this.samples[left + 1] * f);
      output.push(value & 255, (value >> 8) & 255); this.position += this.step;
    }
    const consumed = Math.floor(this.position);
    if (consumed) { this.samples.splice(0, consumed); this.position -= consumed; }
    return Uint8Array.from(output);
  }
}

/** Keep complete little-endian samples without changing the rate or dropping a split sample. */
export class Pcm16Frames {
  constructor() { this.pendingByte = null; }
  push(bytes) {
    if (!bytes.length) return new Uint8Array();
    const prefix = this.pendingByte === null ? 0 : 1;
    const length = bytes.length + prefix;
    const complete = length - length % 2;
    const output = new Uint8Array(complete);
    if (prefix && complete) output[0] = this.pendingByte;
    output.set(bytes.subarray(0, complete - prefix), prefix);
    this.pendingByte = length % 2 ? bytes[bytes.length - 1] : null;
    return output;
  }
}

/** Invalidate already queued callbacks when a generation is interrupted. */
export class GenerationGate {
  constructor() { this.id = 0; this.closed = false; }
  next() { this.closed = false; return ++this.id; }
  accepts(id) { return !this.closed && id === this.id; }
  close() { this.closed = true; this.id++; }
}
