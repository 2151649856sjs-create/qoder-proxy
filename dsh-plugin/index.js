/**
 * dsh-llm-qoder — register the Qoder CN credit pool as a DSH model provider.
 *
 * The provider points at `qoder-proxy` (an OpenAI-compatible loopback server,
 * default http://127.0.0.1:8317/v1) that in turn drives the official
 * `@qodercn-ai/qodercn-agent-sdk`. Every completion is billed against the
 * Qoder account that `qoderclicn login` authenticated, so DSH agents consume
 * the same credits shown on the Qoder settings page.
 *
 * Host half only: no client half, because the model picker is driven entirely
 * by `ctx.llm.registerAdapter`.
 */
import z from '@deepseek-ai/schemastery';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';

export const name = 'dsh-llm-qoder';
export const inject = ['llm'];

const STREAM_IDLE_TIMEOUT_MS = 300_000;

/** No per-token pricing is knowable for a credit quota; report zero. */
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/** Image budgets at the dsh-llm-pi-ai defaults (required profile fields). */
const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20_971_520,
  requestImagePixelBudget: 4_194_304,
  requestImageMaxBytes: 1_048_576,
};

/** Inert pi-ai auth plane: the proxy authenticates by itself, not via pi-ai. */
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() {
      return [];
    },
    async modify() {
      throw new Error('dsh-llm-qoder: the qoder route has no pi-ai credential lifecycle');
    },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() {
      return false;
    },
  },
};

/** Models exposed by the Qoder CN backend (kept in sync with qoder-proxy). */
const QODER_MODELS = [
  { id: 'Auto', name: 'Qoder Auto', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Fast', name: 'Qoder Fast', reasoning: false, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Qwen3.8-Max', name: 'Qwen3.8 Max', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Qwen3.8-Flash', name: 'Qwen3.8 Flash', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Qwen3.7-Max', name: 'Qwen3.7 Max', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Qwen3.7-Plus', name: 'Qwen3.7 Plus', reasoning: true, vision: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Qwen3.7-Flash', name: 'Qwen3.7 Flash', reasoning: false, vision: true, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'DeepSeek-V4-Pro', name: 'DeepSeek V4 Pro', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'DeepSeek-Flash', name: 'DeepSeek Flash', reasoning: false, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'GLM-5.3', name: 'GLM-5.3', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'GLM-5.3-Flash', name: 'GLM-5.3 Flash', reasoning: false, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'GLM-5.2', name: 'GLM-5.2', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Kimi-K3', name: 'Kimi K3', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'Kimi-K2.8-Preview', name: 'Kimi K2.8 Preview', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
  { id: 'MiniMax-M2.7', name: 'MiniMax M2.7', reasoning: true, vision: false, contextWindow: 200_000, maxTokens: 32_000 },
];

export const Config = z.object({
  baseUrl: z.string().description('Base URL of the qoder-proxy OpenAI-compatible endpoint').default('http://127.0.0.1:8317/v1'),
  providerId: z.string().description('Provider id shown to DSH').default('qoder'),
  displayName: z.string().description('Provider display name').default('Qoder CN'),
  apiKey: z.string().description('Optional bearer token; leave empty to match qoder-proxy default').default(''),
  enabled: z.boolean().description('Register the provider').default(true),
});

export function apply(ctx, config) {
  ctx = ctx; // keep the cordis context name explicit for readers
  const settings = {
    baseUrl: config.baseUrl ?? 'http://127.0.0.1:8317/v1',
    providerId: config.providerId ?? 'qoder',
    displayName: config.displayName ?? 'Qoder CN',
    apiKey: config.apiKey ?? '',
    enabled: config.enabled !== false,
  };

  if (!settings.enabled) return;

  const baseUrl = settings.baseUrl.replace(/\/+$/, '');

  const buildModels = () =>
    QODER_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      api: 'openai-completions',
      provider: settings.providerId,
      baseUrl,
      input: m.vision ? ['text', 'image'] : ['text'],
      reasoning: m.reasoning,
      cost: NO_COST,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
      compat: { maxTokensField: 'max_tokens' },
    }));

  const provider = {
    ...createProvider({
      id: settings.providerId,
      name: settings.displayName,
      auth: {
        apiKey: {
          name: 'Qoder proxy API key',
          async resolve() {
            // The proxy is loopback-only and enforces its own (optional) key.
            return { auth: { apiKey: settings.apiKey || 'qoder-proxy' }, source: 'qoder-proxy' };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };

  const profile = {
    provider: settings.providerId,
    displayName: settings.displayName,
    streamIdleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    retryPolicy: resolveRetryPolicy(undefined, 'dsh-llm-qoder retryPolicy'),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };

  const profiles = new Map([[settings.providerId, profile]]);

  const adapter = new PiAiAdapter({
    profiles: () => profiles,
    auth: INERT_AUTH,
    resolveApiKey: async () => settings.apiKey || 'qoder-proxy',
  });

  const release = ctx.llm.registerAdapter([settings.providerId], adapter);
  try {
    ctx.effect(() => () => release());
  } catch {
    release();
  }

  ctx.logger?.info?.(
    `dsh-llm-qoder: registered provider "${settings.providerId}" (${QODER_MODELS.length} models) -> ${baseUrl}`,
  );
}
