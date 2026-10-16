# qoder-proxy — 把 Qoder 积分变成 OpenAI 兼容 API

用 Qoder CN 的账号积分跑任意 OpenAI 兼容客户端（DSH、Cline、Continue、各种 SDK）。

**已验证可用**：15 个模型、流式/非流式、思考链（`reasoning_content`）、逐次积分计量。

---

## 它是什么

```
你的客户端 ──OpenAI API──> qoder-proxy (127.0.0.1:8317) ──官方 SDK──> Qoder CN
                                  │
                                  └─ 每次请求返回消耗的积分
```

反代**不碰** Qoder 的私有协议，而是驱动官方 npm SDK
（`@qodercn-ai/qodercn-agent-sdk`）。SDK 内部带着完整的 worker runtime，
签名、加密、设备指纹都由官方代码处理——所以**Qoder 侧看到的是一次正常的官方请求**，
不存在自己实现签名导致的封号风险，也不需要每次客户端更新就修一遍。

积分从**同一个账号**扣，就是你在 Qoder 设置页看到的那个数字。

---

## 快速开始

### 0. 安装

```bash
git clone <this-repo> && cd qoder-proxy
npm install
```

> `npm install` 会拉下 `@qodercn-ai/qodercn-agent-sdk`，其中含一个约 33MB 的
> worker runtime。它必须完整存在，不要用 `--omit=optional` 之类的方式裁剪。

### 1. 登录（只需一次）

```bash
npx qodercn login
```

> 如果上面的命令不可用，也可以直接调 SDK 里的 CLI 入口：
> `node node_modules/@qodercn-ai/qodercn-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs login`

会打印一个 `https://qoder.cn/device/selectAccounts?...` 链接，浏览器里确认即可。
凭据由系统凭据管理器保存（Windows 上是 `qoder-cli-cn-oauth`），**不会**写进任何明文文件。

验证：

```bash
npx qodercn --list-models   # 应列出 15 个模型
```

### 2. 起反代

```bash
npm start
```

默认监听 `http://127.0.0.1:8317`。

### 3. 用

```bash
curl -s http://127.0.0.1:8317/v1/models

curl -s -H 'content-type: application/json' \
  -d '{"model":"DeepSeek-V4-Pro","messages":[{"role":"user","content":"你好"}]}' \
  http://127.0.0.1:8317/v1/chat/completions
```

---

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/models` | 15 个模型 |
| POST | `/v1/chat/completions` | 支持 `stream: true` |
| GET | `/health` | 健康检查 |

流式是标准 SSE，结尾有 `data: [DONE]`。

### 响应里的积分

非流式：`qoder_credits` 字段 + `x-qoder-credits` 响应头

```json
{
  "choices": [{"message": {"role":"assistant","content":"PONG",
               "reasoning_content":"The user asks..."}}],
  "qoder_credits": 0.12933373199999998
}
```

流式：最后一个 chunk 带 `usage: {"credits": 0.139...}`

> **关于 token 数**：Qoder 后端按积分计费，**不返回真实 token 数**。
> 反代会在后端返回 0 时按字符数估算并标记 `estimated_tokens: true`，
> 这样客户端（如 DSH 的用量徽章）不至于显示 0。

### 思考链

模型有思考过程时，会放在 `reasoning_content` 里（流式和非流式都支持）。
这是 DeepSeek / OpenAI SDK 生态的通用字段，客户端一般会自动渲染。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `QODER_PROXY_PORT` | `8317` | 监听端口 |
| `QODER_PROXY_HOST` | `127.0.0.1` | 监听地址（默认仅本机） |
| `QODER_PROXY_MODEL` | `Auto` | 客户端没指定 model 时用哪个 |
| `QODER_PROXY_API_KEY` | 空 | 设了就要 `Authorization: Bearer <key>` |

---

## 可用模型

```
Auto · Fast
Qwen3.8-Max · Qwen3.8-Flash · Qwen3.7-Max · Qwen3.7-Plus · Qwen3.7-Flash
DeepSeek-V4-Pro · DeepSeek-Flash
GLM-5.3 · GLM-5.3-Flash · GLM-5.2
Kimi-K3 · Kimi-K2.8-Preview
MiniMax-M2.7
```

名不对时会自动容错：`deepseek-v4-pro` → `DeepSeek-V4-Pro`，含 `flash`/`fast` → `Fast`。

---

## 接到 DSH

仓库里的 `dsh-plugin/` 是一个 DSH 模型 provider 插件，把上面的端点注册成 DSH provider：

1. 把 `dsh-plugin/` 挂进你的 DSH profile（例如用 junction / symlink 放到
   `<DSH_HOME>/profiles/web/node_modules/dsh-llm-qoder`，或直接 `dsh plugin add` 该目录）；
2. 在 `<DSH_HOME>/profiles/web/cordis.patch.yml` 末尾追加：

   ```yaml
   - insert:
       - id: llm-qoder
         name: dsh-llm-qoder
   ```

3. 重启 DSH。

之后：

- provider id：`qoder`，显示名 `Qoder CN`
- 15 个模型出现在模型选择器里
- 改 provider 设置（baseUrl / 显示名 / 开关键）改 `dsh-plugin/index.js` 里的 `Config` 默认值，
  或在 DSH 设置界面里覆盖。

**注意**：反代必须先在 8317 上跑着；否则模型列表能出来，但一发请求就 502。

---

## 接到其它客户端

任何 OpenAI 兼容客户端都能用：

- **Base URL**：`http://127.0.0.1:8317/v1`
- **API Key**：随便填（除非设了 `QODER_PROXY_API_KEY`）
- **Model**：见上表

---

## 已知限制

- **无状态**：每次请求都重新拼完整对话发给模型。这意味着没有服务端会话缓存，
  好处是任何客户端都能接、不会串话。代价是长对话的 prompt 处理成本略高。
- **不支持 function calling**：SDK 的 `allowedTools: []` 关掉了工具调用，
  所以 `tools` 参数会被忽略。DSH 的 agent 能力依赖它自己的工具循环，
  模型侧只需要能返回文本——这一点是满足的。
- **单账号串行**：反代本身可以并发，但积分是同一个账号的总额度。
- **依赖 worker runtime**：`node_modules/@qodercn-ai/qodercn-agent-sdk` 里的
  33MB worker runtime 必须完整存在。

---

## 排错

**`No qodercli login found`**
→ 还没登录，跑第 1 步。

**模型列表有，但请求 502**
→ 反代进程没起，或者 Qoder 凭据过期。看反代 stderr 里的具体报错。

**积分没变 / 一直是 0**
→ 检查 `qoder_credits` 字段是否非零。免费额度用尽时 Qoder 会返回错误，检查 stderr。

**重启后 DSH 里没有 `qoder` provider**
→ 看 `<DSH_HOME>/profiles/web/cordis.patch.yml` 里有没有 `- id: llm-qoder`，
  然后看 DSH 启动日志有没有 `dsh-llm-qoder: registered provider`。

---

## `dev/` 目录

逆向过程中的探针脚本，保留作为可复现证据，**不参与运行时**：

| 文件 | 作用 |
|---|---|
| `dev/t1-auth.mjs` | 验证 SDK 认证是否可用（对比实验：故意 import Global 版 SDK，证明它看不到 CN 版登录态） |
| `dev/t2-cn.mjs` | 确认走的是 CN 版配置目录（`.qoder-cn` 而非 `.qoder`） |
| `dev/t3-chat.mjs` | 非流式对话冒烟测试 |
| `dev/t4-stream.mjs` | 流式对话冒烟测试 |
| `dev/t5-usage.mjs` | **关键探针**：证明 Qoder 后端不回真实 token 数、只回积分 |

> 这些探针**需要本机已登录的 Qoder 凭据**才能跑，仅供开发参考，不参与运行时。

---

## License

MIT
