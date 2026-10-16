# qoder-proxy — turn Qoder credits into an OpenAI-compatible API

Use your Qoder CN account credits to power any OpenAI-compatible client
(DSH, Cline, Continue, various SDKs).

**Verified working**: 15 models, streaming + non-streaming, thinking chain
(`reasoning_content`), per-request credit metering.

> **English version.** 中文文档见 [`README.md`](./README.md).

## What it is

```
your client ──OpenAI API──> qoder-proxy (127.0.0.1:8317) ──official SDK──> Qoder CN
                                   │
                                   └─ each request returns the credits consumed
```

The proxy does **not** touch Qoder's private protocol. Instead it drives the official
npm SDK (`@qodercn-ai/qodercn-agent-sdk`). The SDK ships a complete worker runtime;
signing, encryption, and device fingerprinting are all handled by official code — so
**Qoder sees a normal official request**, with no ban risk from a hand-rolled signature,
and no need to re-fix things every time the client updates.

Credits are billed against **the same account** — the number you see on your Qoder
settings page.

## Quick start

### 0. Install

```bash
git clone <this-repo> && cd qoder-proxy
npm install
```

> `npm install` pulls `@qodercn-ai/qodercn-agent-sdk`, which contains a ~33MB worker
> runtime. It must be present in full — do not prune it with `--omit=optional` etc.

### 1. Login (once)

```bash
npm run setup        # equivalent to the manual command below; open the browser to confirm
```

`setup` invokes the device-code login built into Qoder's official SDK, authenticating
with **your own account**. Credentials go into the system credential manager
(`qoder-cli-cn-oauth` on Windows) and are **never** written to any plaintext file.

> Manual fallback (when setup is unavailable):
> ```bash
> npx qodercn login
> # or node node_modules/@qodercn-ai/qodercn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs login
> ```
> Confirm the `https://qoder.cn/device/selectAccounts?...` link in the browser.

Verify:

```bash
npx qodercn --list-models   # should list 15 models
```

### 2. Run the proxy

```bash
npm start
```

Listens on `http://127.0.0.1:8317` by default.

### 3. Use it

```bash
curl -s http://127.0.0.1:8317/v1/models

curl -s -H 'content-type: application/json' \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"hi"}]}' \
  http://127.0.0.1:8317/v1/chat/completions
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET  | `/v1/models` | 15 models |
| POST | `/v1/chat/completions` | supports `stream: true` |
| GET  | `/health` | health check |

Streaming is standard SSE, terminated with `data: [DONE]`.

### Credits in the response

Non-streaming: `qoder_credits` field + `x-qoder-credits` response header

```json
{
  "choices": [{"message": {"role":"assistant","content":"PONG",
             "reasoning_content":"The user asks..."}}],
  "qoder_credits": 0.12933373199999998
}
```

Streaming: the last chunk carries `usage: {"credits": 0.139...}`.

> **About token counts**: Qoder bills by credits and **returns no real token count**.
> When the backend returns 0, the proxy estimates from character count and marks
> `estimated_tokens: true`, so clients (e.g. DSH's usage badge) won't show 0.

### Thinking chain

When the model thinks, it goes into `reasoning_content` (supported in both streaming and
non-streaming). This is the common field in the DeepSeek / OpenAI SDK ecosystem; clients
usually render it automatically.

## Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `QODER_PROXY_PORT` | `8317` | listen port |
| `QODER_PROXY_HOST` | `127.0.0.1` | listen address (localhost only by default) |
| `QODER_PROXY_MODEL` | `Auto` | which model when the client doesn't specify |
| `QODER_PROXY_API_KEY` | empty | when set, requires `Authorization: Bearer <key>` |

## Available models

```
Auto · Fast
Qwen3.8-Max · Qwen3.8-Flash · Qwen3.7-Max · Qwen3.7-Plus · Qwen3.7-Flash
DeepSeek-V4-Pro · DeepSeek-Flash
GLM-5.3 · GLM-5.3-Flash · GLM-5.2
Kimi-K3 · Kimi-K2.8-Preview
MiniMax-M2.7
```

Names are auto-tolerant: `deepseek-v4-pro` → `DeepSeek-V4-Pro`; anything containing
`flash`/`fast` → `Fast`.

## Wiring into DSH

`dsh-plugin/` is a DSH model provider plugin that registers the endpoint above as a DSH provider.

One command (creates the junction + appends the patch entry, idempotent):

```bash
npm run install:dsh          # equivalent to node install-dsh-plugin.mjs
# optional: specify profile / DSH_HOME
DSH_PROFILE=web DSH_HOME=/path/to/.dsh node install-dsh-plugin.mjs
```

Manual:

1. Mount `dsh-plugin/` into your DSH profile (e.g. junction/symlink to
   `<DSH_HOME>/profiles/web/node_modules/dsh-llm-qoder`, or `dsh plugin add` the dir);
2. Append to the end of `<DSH_HOME>/profiles/web/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: llm-qoder
         name: dsh-llm-qoder
   ```

3. Restart DSH.

After that:

- provider id: `qoder`, display name `Qoder CN`
- 15 models appear in the model picker
- change provider settings (baseUrl / display name / on-off) via the `Config` defaults in
  `dsh-plugin/index.js`, or override in the DSH settings UI

**Note**: the proxy must be running on 8317 first; otherwise the model list loads but
requests 502.

## Using with other clients

Any OpenAI-compatible client works:

- **Base URL**: `http://127.0.0.1:8317/v1`
- **API Key**: anything (unless `QODER_PROXY_API_KEY` is set)
- **Model**: see table above

## Known limitations

- **Stateless**: every request re-assembles the full conversation to send to the model.
  No server-side session cache — any client can connect and won't cross-talk, at the cost
  of slightly higher prompt-processing cost for long conversations.
- **No function calling**: the SDK's `allowedTools: []` turns off tool calls, so `tools`
  is ignored. DSH's agent capability relies on its own tool loop; the model side only
  needs to return text — which it does.
- **Single-account, serial credits**: the proxy itself can be concurrent, but credits are
  one account's total quota.
- **Depends on worker runtime**: the ~33MB worker runtime inside
  `node_modules/@qodercn-ai/qodercn-agent-sdk` must be present in full.

## Troubleshooting

**`No qodercli login found`**
→ Not logged in yet, run step 1.

**Model list shows but requests 502**
→ Proxy process isn't up, or Qoder credentials expired. Check the proxy stderr for the
specific error.

**Credits didn't change / stays 0**
→ Check whether `qoder_credits` is non-zero. When free quota is exhausted Qoder returns an
error — check stderr.

**No `qoder` provider in DSH after restart**
→ Check `<DSH_HOME>/profiles/web/cordis.patch.yml` for `- id: llm-qoder`, then check the
DSH startup log for `dsh-llm-qoder: registered provider`.

## `dev/` directory

Probe scripts from the reverse-engineering process, kept as reproducible evidence; they
**are not part of the runtime**:

| File | Purpose |
|------|---------|
| `dev/t1-auth.mjs` | Verify SDK auth works (contrast: deliberately import the Global SDK to prove it can't see the CN login state) |
| `dev/t2-cn.mjs` | Confirm the CN config dir is used (`.qoder-cn`, not `.qoder`) |
| `dev/t3-chat.mjs` | Non-streaming chat smoke test |
| `dev/t4-stream.mjs` | Streaming chat smoke test |
| `dev/t5-usage.mjs` | **Key probe**: proves Qoder backend returns no real token counts, only credits |

> These probes **require a locally logged-in Qoder credential** to run; for development
> reference only, not part of the runtime.

## License

MIT
