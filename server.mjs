#!/usr/bin/env node
/**
 * qoder-proxy — expose Qoder CN (Qoder 积分) as an OpenAI-compatible API.
 *
 * Endpoints:
 *   GET  /v1/models
 *   POST /v1/chat/completions   (stream & non-stream)
 *   GET  /health
 *
 * Backend: @qodercn-ai/qodercn-agent-sdk (official SDK, reuses `qoderclicn login`).
 * Credits consumed per request are reported in the `x-qoder-credits` response header
 * and (for streams) in the final SSE chunk's `usage`.
 */
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { query, qodercliAuth } from '@qodercn-ai/qodercn-agent-sdk';

const PORT = Number(process.env.QODER_PROXY_PORT || 8317);
const HOST = process.env.QODER_PROXY_HOST || '127.0.0.1';
const DEFAULT_MODEL = process.env.QODER_PROXY_MODEL || 'Auto';
const API_KEY = process.env.QODER_PROXY_API_KEY || '';

/** Models the Qoder CN backend offers (id -> human label). */
const MODELS = [
  'Auto',
  'Fast',
  'Qwen3.8-Max',
  'Qwen3.8-Flash',
  'Qwen3.7-Max',
  'Qwen3.7-Plus',
  'Qwen3.7-Flash',
  'DeepSeek-V4-Pro',
  'DeepSeek-Flash',
  'GLM-5.3',
  'GLM-5.3-Flash',
  'GLM-5.2',
  'Kimi-K3',
  'Kimi-K2.8-Preview',
  'MiniMax-M2.7',
];
const MODEL_SET = new Set(MODELS);

const created = Math.floor(Date.now() / 1000);

// ---------------------------------------------------------------- helpers

function log(...args) {
  process.stderr.write(`[qoder-proxy ${new Date().toISOString()}] ${args.join(' ')}\n`);
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, message, type = 'invalid_request_error', code = null) {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

async function readBody(req, limitBytes = 16 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * OpenAI `messages` -> a single prompt string.
 *
 * Qoder's query() takes one prompt plus a system prompt. We flatten the
 * conversation so the proxy stays stateless: every request is self-contained,
 * which is exactly what OpenAI clients (including DSH) expect.
 */
function flattenMessages(messages) {
  const systemParts = [];
  const turns = [];

  for (const m of messages ?? []) {
    const role = m.role;
    const content = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content
            .map((c) => {
              if (typeof c === 'string') return c;
              if (c?.type === 'text') return c.text ?? '';
              if (c?.type === 'image_url') return '[image omitted]';
              return '';
            })
            .join('')
        : '';

    if (role === 'system' || role === 'developer') {
      if (content.trim()) systemParts.push(content.trim());
      continue;
    }
    if (!content.trim()) continue;

    if (role === 'user') turns.push(`User: ${content}`);
    else if (role === 'assistant') turns.push(`Assistant: ${content}`);
    else if (role === 'tool') turns.push(`Tool result: ${content}`);
  }

  // A single user turn can be sent verbatim (keeps the model's native behaviour).
  let prompt;
  if (turns.length === 1 && turns[0].startsWith('User: ')) {
    prompt = turns[0].slice('User: '.length);
  } else if (turns.length === 0) {
    prompt = systemParts.join('\n\n') || '';
  } else {
    prompt = `${turns.join('\n\n')}\n\nAssistant:`;
  }

  return { prompt, system: systemParts.join('\n\n') };
}

function resolveModel(requested) {
  if (!requested) return DEFAULT_MODEL;
  if (MODEL_SET.has(requested)) return requested;
  // tolerate case differences and common aliases
  const lower = String(requested).toLowerCase();
  for (const m of MODELS) {
    if (m.toLowerCase() === lower) return m;
  }
  for (const alias of ['v4-pro', 'deepseek-v4-pro', 'deepseek-pro']) {
    if (lower.includes(alias)) return 'DeepSeek-V4-Pro';
  }
  for (const alias of ['flash', 'fast']) {
    if (lower.includes(alias)) return 'Fast';
  }
  return requested; // let the backend decide
}

function stopReasonToFinishReason(stopReason) {
  switch (stopReason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return 'stop';
  }
}

// ---------------------------------------------------------------- usage estimate

/**
 * The Qoder backend bills in credits and reports `input_tokens`/`output_tokens`
 * as literal zeros, so an OpenAI-compatible client (DSH's usage badge included)
 * would always render "0 tok". Estimate the counts locally instead.
 *
 * Mixed CJK/Latin heuristic: CJK codepoints cost ~1 token each, everything else
 * ~4 chars per token. Closer than a flat chars/4 for Chinese-heavy prompts, and
 * it is only ever used for display -- credits stay the authoritative number.
 */
function estimateTokens(s) {
  if (!s) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    // CJK ideographs, kana, hangul, and fullwidth punctuation.
    if (
      (cp >= 0x3000 && cp <= 0x303f) ||
      (cp >= 0x3040 && cp <= 0x30ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xff00 && cp <= 0xffef)
    ) {
      cjk += 1;
    } else {
      other += 1;
    }
  }
  return cjk + Math.ceil(other / 4);
}

/**
 * Build an OpenAI-shaped `usage` object. Prefers real numbers from the backend
 * and falls back to the local estimate when the backend reports zeros.
 */
function usagePayload({ usage, promptText, text, reasoning, credits }) {
  const realIn = usage?.input_tokens ?? 0;
  const realOut = usage?.output_tokens ?? 0;
  const estIn = estimateTokens(promptText);
  const estOut = estimateTokens((text ?? '') + (reasoning ?? ''));
  const prompt_tokens = realIn > 0 ? realIn : estIn;
  const completion_tokens = realOut > 0 ? realOut : estOut;
  return {
    prompt_tokens,
    completion_tokens,
    total_tokens: prompt_tokens + completion_tokens,
    // non-standard extras: keep credit accounting and the estimate visible
    ...(credits ? { qoder_credits: credits } : {}),
    ...(realIn === 0 && realOut === 0 ? { estimated_tokens: true } : {}),
  };
}

// ---------------------------------------------------------------- qoder call

/**
 * Drive one Qoder query, invoking `onDelta({channel, text})` as tokens arrive.
 * `channel` is 'reasoning' for the model's thinking block, 'content' for the answer.
 */
async function runQoder({ prompt, system, model, signal, onDelta }) {
  const options = {
    auth: qodercliAuth(),
    permissionMode: 'bypassPermissions',
    allowedTools: [],
    maxTurns: 1,
    settingSources: [],
    persistSession: false,
    includePartialMessages: Boolean(onDelta),
    model,
  };
  if (system) options.systemPrompt = system;

  const q = query({ prompt, options });
  const abort = () => { try { q.close(); } catch {} };
  if (signal) {
    if (signal.aborted) { abort(); throw new Error('aborted'); }
    signal.addEventListener('abort', abort, { once: true });
  }

  let text = '';
  let reasoning = '';
  let credits = 0;
  let usage = null;
  let finishReason = 'stop';
  let errorMessage = null;
  let modelUsed = model;
  // Some backends deliver text only in the final `assistant` message; track the
  // per-index channel of each streamed block so a later full message can be
  // reconciled without duplicating text we already emitted.
  const blockChannel = new Map();

  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') {
        if (msg.model) modelUsed = msg.model;
        continue;
      }
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'content_block_start') {
          const ch = ev.content_block?.type === 'thinking' ? 'reasoning' : 'content';
          blockChannel.set(ev.index, ch);
        } else if (ev.type === 'content_block_delta') {
          const ch = blockChannel.get(ev.index)
            ?? (ev.delta?.type === 'thinking_delta' ? 'reasoning' : 'content');
          if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) {
            reasoning += ev.delta.thinking;
            onDelta?.({ channel: 'reasoning', text: ev.delta.thinking });
          } else if (ev.delta?.type === 'text_delta' && ev.delta.text) {
            text += ev.delta.text;
            onDelta?.({ channel: 'content', text: ev.delta.text });
          }
        } else if (ev.type === 'message_delta') {
          if (ev.delta?.stop_reason) finishReason = stopReasonToFinishReason(ev.delta.stop_reason);
          if (ev.usage) usage = ev.usage;
        }
        continue;
      }
      if (msg.type === 'assistant' && msg.message?.content) {
        // Only use this as a repair path: if streaming produced nothing, take the
        // full text from the assembled assistant message.
        const fullText = msg.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
        const fullThinking = msg.message.content.filter((b) => b.type === 'thinking').map((b) => b.thinking).join('');
        if (!text && fullText) {
          text = fullText;
          onDelta?.({ channel: 'content', text: fullText });
        }
        if (!reasoning && fullThinking) {
          reasoning = fullThinking;
          onDelta?.({ channel: 'reasoning', text: fullThinking });
        }
        continue;
      }
      if (msg.type === 'result') {
        if (typeof msg.total_credits === 'number') credits = msg.total_credits;
        if (msg.usage) usage = msg.usage;
        if (msg.subtype !== 'success') {
          errorMessage = Array.isArray(msg.errors) && msg.errors.length
            ? msg.errors.join('; ')
            : `qoder query ended with ${msg.subtype}`;
        }
        if (msg.subtype === 'success' && !text && msg.result) {
          text = String(msg.result);
          onDelta?.({ channel: 'content', text });
        }
      }
    }
  } finally {
    if (signal) signal.removeEventListener?.('abort', abort);
    try { q.close(); } catch {}
  }

  if (errorMessage && !text) throw new Error(errorMessage);
  return { text, reasoning, credits, usage, finishReason, modelUsed };
}

// ---------------------------------------------------------------- handlers

function handleModels(res) {
  sendJson(res, 200, {
    object: 'list',
    data: MODELS.map((id) => ({
      id,
      object: 'model',
      created,
      owned_by: 'qoder',
    })),
  });
}

async function handleChatCompletions(req, res, body) {
  let payload;
  try {
    payload = JSON.parse(body || '{}');
  } catch {
    return sendError(res, 400, 'invalid JSON body');
  }

  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return sendError(res, 400, "you must provide a 'messages' array");
  }

  const model = resolveModel(payload.model);
  const wantsStream = payload.stream === true;
  const { prompt, system } = flattenMessages(messages);

  if (!prompt.trim()) return sendError(res, 400, 'no usable text content in messages');

  const controller = new AbortController();
  req.on('aborted', () => controller.abort());

  const id = `chatcmpl-${randomUUID().replace(/-/g, '')}`;

  if (!wantsStream) {
    try {
      const out = await runQoder({ prompt, system, model, signal: controller.signal });
      return sendJson(
        res,
        200,
        {
          id,
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model: out.modelUsed || model,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: out.text, ...(out.reasoning ? { reasoning_content: out.reasoning } : {}) },
              finish_reason: out.finishReason,
            },
          ],
          usage: usagePayload({ usage: out.usage, promptText: prompt, text: out.text, reasoning: out.reasoning, credits: out.credits }),
          // non-standard, keeps the credit accounting visible to the caller
          qoder_credits: out.credits,
        },
        { 'x-qoder-credits': String(out.credits), 'x-qoder-model': out.modelUsed || model },
      );
    } catch (e) {
      log('non-stream error:', e?.message);
      if (controller.signal.aborted) return;
      return sendError(res, 502, String(e?.message ?? e), 'upstream_error');
    }
  }

  // ---- streaming ----
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const modelUsedForChunks = model;
  const write = (obj) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };
  const finish = (credits, modelUsed) => {
    if (res.writableEnded) return;
    res.write('data: [DONE]\n\n');
    res.end();
    void credits; void modelUsed;
  };

  const baseChunk = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: modelUsedForChunks,
  };

  write({ ...baseChunk, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });

  // Some clients (and some proxies) require the very first byte promptly.
  res.write(': qoder-proxy stream open\n\n');

  let credits = 0;
  let finishReason = 'stop';
  let modelUsed = model;
  let sentAny = false;

  try {
    const out = await runQoder({
      prompt,
      system,
      model,
      signal: controller.signal,
      onDelta: ({ channel, text }) => {
        sentAny = true;
        if (channel === 'reasoning') {
          write({ ...baseChunk, choices: [{ index: 0, delta: { reasoning_content: text }, finish_reason: null }] });
        } else {
          write({ ...baseChunk, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
        }
      },
    });
    credits = out.credits;
    finishReason = out.finishReason;
    modelUsed = out.modelUsed || model;

    if (!sentAny && out.text) {
      write({ ...baseChunk, model: modelUsed, choices: [{ index: 0, delta: { content: out.text }, finish_reason: null }] });
    }

    write({ ...baseChunk, model: modelUsed, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
    // Always emit a usage chunk: DSH reads token counts off it, and the backend
    // reports zeros, so the payload carries a local estimate (see usagePayload).
    write({
      ...baseChunk,
      model: modelUsed,
      choices: [],
      usage: usagePayload({ usage: out.usage, promptText: prompt, text: out.text, reasoning: out.reasoning, credits }),
    });
    finish(credits, modelUsed);
  } catch (e) {
    log('stream error:', e?.message);
    if (!res.writableEnded) {
      write({ ...baseChunk, choices: [{ index: 0, delta: { content: `\n[proxy error] ${e?.message ?? e}` }, finish_reason: null }] });
      write({ ...baseChunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
}

// ---------------------------------------------------------------- server

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'authorization,content-type',
    });
    return res.end();
  }

  if (url.pathname === '/health' || url.pathname === '/') {
    return sendJson(res, 200, { status: 'ok', service: 'qoder-proxy', models: MODELS.length, default_model: DEFAULT_MODEL });
  }

  // Optional bearer check — off unless QODER_PROXY_API_KEY is set.
  if (API_KEY) {
    const auth = req.headers.authorization ?? '';
    if (auth !== `Bearer ${API_KEY}`) return sendError(res, 401, 'invalid api key', 'authentication_error');
  }

  if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/v1/models/')) {
    return handleModels(res);
  }

  if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/v1/chat/completions/')) {
    let body;
    try {
      body = await readBody(req);
    } catch (e) {
      return sendError(res, 413, String(e.message));
    }
    return handleChatCompletions(req, res, body);
  }

  return sendError(res, 404, `unknown route ${req.method} ${url.pathname}`, 'not_found_error');
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}`);
  log(`default model: ${DEFAULT_MODEL} | ${MODELS.length} models available`);
  log(`auth: qodercli login state${API_KEY ? ' + bearer key required' : ''}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => { log('shutting down'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 2000); });
}
