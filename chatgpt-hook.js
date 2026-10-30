// Runs in the page's own JavaScript world, at document start, in chatgpt.com
// tabs the side panel opened (their URL ends in #yts). Reads ChatGPT's reply
// from its streamed network response: that is the exact Markdown, and it keeps
// arriving while the tab is in the background, where the page may not render.
// Reports to chatgpt.js with window.postMessage({ source: 'yts-hook', reply, stats }).
(() => {
  if (window.__ytsHook || !location.hash.includes('yts')) return;
  window.__ytsHook = true;

  // For troubleshooting; never contains conversation text.
  const stats = { requests: 0, streams: 0, events: 0, other: [] };
  let reply = null; // { text, done, ended, error } for the latest conversation request

  const post = () => window.postMessage({ source: 'yts-hook', reply, stats }, location.origin);
  window.addEventListener('message', (event) => {
    if (event.source === window && event.data?.source === 'yts-content') post();
  });

  // ---- ChatGPT's stream format ------------------------------------------------
  // Current versions send JSON-patch-like deltas, { p: path, o: op, v: value, c:
  // message counter }, leaving out p and o when they repeat. Older versions
  // resend the whole message with each event. Both are handled.

  const isOps = (value) =>
    Array.isArray(value) && value.length > 0 && value.every((item) => item && typeof item === 'object' && ('p' in item || 'o' in item));

  function apply(root, path, op, value) {
    const keys = path.split('/').slice(1).map((key) => key.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!keys.length) return op === 'append' && typeof root === 'string' ? root + value : value;
    root = root && typeof root === 'object' ? root : {};
    let parent = root;
    for (const key of keys.slice(0, -1)) {
      if (!parent[key] || typeof parent[key] !== 'object') parent[key] = {};
      parent = parent[key];
    }
    const key = keys.at(-1);
    const current = parent[key];
    if (op === 'append') {
      if (typeof current === 'string') parent[key] = current + value;
      else if (Array.isArray(current)) current.push(...(Array.isArray(value) ? value : [value]));
      else if (current && typeof current === 'object' && value && typeof value === 'object') Object.assign(current, value);
      else parent[key] = value;
    } else if (op === 'truncate') {
      if (typeof current === 'string' || Array.isArray(current)) parent[key] = current.slice(0, value);
    } else if (op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(key), 1);
      else delete parent[key];
    } else {
      parent[key] = value; // add, replace
    }
    return root;
  }

  function createConversationStream() {
    const messages = new Map(); // message counter (or id) -> { message, ... }
    let current;
    let leaf = { p: '', o: 'add' }; // what a delta without p/o repeats
    let textLeaf = null; // the last path text was appended to
    let complete = false;
    let error = '';

    function applyDelta(delta) {
      if (delta.o === 'patch' || isOps(delta.v)) {
        for (const op of delta.v) applyDelta(op);
        return;
      }
      let { p, o } = delta;
      if (p === undefined && delta.v?.message) [p, o] = ['', 'add']; // a new message
      if (p === undefined && typeof delta.v === 'string' && textLeaf) ({ p, o } = textLeaf);
      p ??= leaf.p;
      o ??= leaf.o;
      leaf = { p, o };
      if (o === 'append' && typeof delta.v === 'string') textLeaf = { p, o };
      messages.set(current, apply(messages.get(current), p, o, delta.v));
    }

    function onData(data) {
      stats.events++;
      if (data === '[DONE]') return void (complete = true);
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        return;
      }
      if (!event || typeof event !== 'object') return; // e.g. the "v1" encoding announcement
      if (typeof event.type === 'string') {
        if (!stats.other.includes(event.type) && stats.other.length < 20) stats.other.push(event.type);
        if (event.type === 'message_stream_complete') complete = true;
        return;
      }
      if (typeof event.error === 'string' && event.error) error = event.error;
      if (event.message && !('v' in event)) {
        messages.set(event.message.id ?? messages.size, event);
      } else if ('v' in event || 'o' in event) {
        if (event.c !== undefined) current = event.c;
        applyDelta(event);
      }
    }

    // The newest assistant text message: skips the user's message, reasoning
    // ("thoughts"), and tool calls.
    function result() {
      for (const wrapper of [...messages.values()].reverse()) {
        const message = wrapper?.message;
        if (message?.author?.role !== 'assistant') continue;
        if (message.recipient && message.recipient !== 'all') continue;
        if (/^(analysis|commentary)$/.test(message.channel || '')) continue;
        const { content_type: type, parts } = message.content || {};
        if (type !== 'text' && type !== 'multimodal_text') continue;
        const text = Object.values(parts || {})
          .filter((part) => typeof part === 'string')
          .join('')
          // Citation markers use private-use characters.
          .replace(/[^]*/g, '')
          .replace(/[-]/g, '');
        if (text.trim()) return { text, done: message.status === 'finished_successfully' || message.end_turn === true };
      }
      return { text: '', done: false };
    }

    return { onData, result, state: () => ({ complete, error }) };
  }

  async function readStream(response) {
    stats.streams++;
    const stream = createConversationStream();
    const update = (ended) => {
      const { text, done } = stream.result();
      const { complete, error } = stream.state();
      reply = { text, done: done && (complete || ended), ended, error };
      post();
    };
    update(false);
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer = (buffer + value).replace(/\r\n?/g, '\n');
        let boundary;
        let changed = false;
        while ((boundary = buffer.indexOf('\n\n')) !== -1) {
          const data = buffer
            .slice(0, boundary)
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          buffer = buffer.slice(boundary + 2);
          if (data) {
            stream.onData(data);
            changed = true;
          }
        }
        if (changed) update(false);
      }
    } catch {} // Aborted (e.g. the stop button); report what arrived.
    update(true);
  }

  async function readError(response) {
    let detail = `${response.status} ${response.statusText}`.trim();
    try {
      const body = await response.json();
      detail = body.detail?.message || (typeof body.detail === 'string' ? body.detail : '') || body.error?.message || detail;
    } catch {}
    reply = { text: '', done: false, ended: true, error: detail };
    post();
  }

  const originalFetch = window.fetch;
  window.fetch = async function fetch(...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const [input, init] = args;
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
      if (method === 'POST' && url.pathname.startsWith('/backend-api/') && url.pathname.includes('conversation')) {
        stats.requests++;
        const type = response.headers.get('content-type') || '';
        if (type.includes('text/event-stream') && response.body) readStream(response.clone());
        else if (!response.ok && /\/conversation$/.test(url.pathname)) readError(response.clone());
        else post();
      }
    } catch {} // Never break ChatGPT's own request.
    return response;
  };
})();
