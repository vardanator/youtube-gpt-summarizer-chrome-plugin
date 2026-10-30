// Minimal OpenAI client: model listing and streamed text via the Responses API.

const API_BASE = 'https://api.openai.com/v1';
export const FALLBACK_MODEL = 'gpt-5-mini';

export class OpenAIError extends Error {
  constructor(message, { status = 0, code = '', param = '' } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.param = param;
  }
}

async function errorFromResponse(res, model) {
  let error = {};
  try {
    error = (await res.json()).error || {};
  } catch {}
  const detail = error.message || `${res.status} ${res.statusText}`;
  const meta = { status: res.status, code: error.code || '', param: error.param || '' };
  if (res.status === 401) {
    return new OpenAIError('OpenAI rejected the API key. Reconnect your account in Settings.', meta);
  }
  if (res.status === 402 || error.code === 'insufficient_quota' || /credits? remaining|quota/i.test(detail)) {
    return new OpenAIError(
      'Your OpenAI account has no API credit. Add credit at platform.openai.com, or disconnect in Settings and use your ChatGPT login instead.',
      meta
    );
  }
  if (res.status === 404 || error.code === 'model_not_found') {
    return new OpenAIError(`The model "${model}" isn't available for this key. Pick another in Settings.`, meta);
  }
  if (res.status === 429) return new OpenAIError(`OpenAI rate limit reached: ${detail}`, meta);
  return new OpenAIError(`OpenAI error: ${detail}`, meta);
}

export async function listModels(apiKey) {
  const res = await fetch(`${API_BASE}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!res.ok) throw await errorFromResponse(res);
  const { data = [] } = await res.json();
  return data.map((m) => m.id);
}

const NON_TEXT_MODEL =
  /(audio|realtime|tts|transcribe|whisper|image|dall-e|embedding|moderation|search|instruct|codex|computer-use|deep-research|sora)/;

// Keep text models that are useful here, dropping dated snapshots to cut clutter.
export function textModels(ids) {
  return ids
    .filter((id) => /^(gpt-|o\d|chatgpt-)/.test(id))
    .filter((id) => !NON_TEXT_MODEL.test(id) && !/-\d{4}-\d{2}-\d{2}$/.test(id))
    .sort();
}

// The newest "mini" model is fast, cheap and plenty for summarization.
export function pickDefaultModel(ids) {
  const minis = ids
    .filter((id) => /^gpt-\d+(\.\d+)?-mini$/.test(id))
    .sort((a, b) => parseFloat(b.slice(4)) - parseFloat(a.slice(4)));
  return minis[0] || ids.find((id) => id === 'gpt-4o-mini') || ids[0] || FALLBACK_MODEL;
}

const isReasoningModel = (model) => /^(o\d|gpt-5)/.test(model);

async function* readServerSentEvents(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer = (buffer + value).replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Streams a text response. Calls onText(fullTextSoFar) as tokens arrive and
 * resolves with the complete text.
 */
export async function streamText({ apiKey, model, instructions, input, onText }) {
  const body = { model, instructions, input, stream: true, store: false };
  // Summaries don't need long deliberation; low effort keeps latency down.
  if (isReasoningModel(model)) body.reasoning = { effort: 'low' };

  const post = () =>
    fetch(`${API_BASE}/responses`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
    });

  let res = await post();
  if (res.status === 400 && body.reasoning) {
    // Some models reject the reasoning parameter; retry without it.
    const error = await errorFromResponse(res, model);
    if (!/reasoning/i.test(`${error.param} ${error.message}`)) throw error;
    delete body.reasoning;
    res = await post();
  }
  if (!res.ok) throw await errorFromResponse(res, model);

  let text = '';
  for await (const event of readServerSentEvents(res.body)) {
    switch (event.type) {
      case 'response.output_text.delta':
        text += event.delta;
        onText?.(text);
        break;
      case 'response.failed':
        throw new OpenAIError(`OpenAI error: ${event.response?.error?.message || 'the request failed.'}`);
      case 'response.incomplete':
        if (!text) {
          const reason = event.response?.incomplete_details?.reason || 'unknown reason';
          throw new OpenAIError(`OpenAI stopped before writing anything (${reason}).`);
        }
        break;
      case 'error':
        throw new OpenAIError(`OpenAI error: ${event.message || event.error?.message || 'stream error.'}`);
    }
  }
  if (!text) throw new OpenAIError('OpenAI returned an empty response.');
  return text;
}
