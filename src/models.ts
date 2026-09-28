import type { ProviderCatalogResult } from "openclaw/plugin-sdk/plugin-entry";
import { BASE_URL } from "./constants.js";

export type ProviderConfig = Extract<NonNullable<ProviderCatalogResult>, { provider: unknown }>["provider"];
export type ModelDefinition = ProviderConfig["models"][number];
export type ModelCompat = NonNullable<ModelDefinition["compat"]>;

/** Used when a model row does not state its context length. */
export const FALLBACK_CONTEXT_WINDOW = 128_000;
/** Used when a model row does not state its output limit. */
export const FALLBACK_MAX_TOKENS = 8_192;

/**
 * Request shape that works for every chat model on the gateway:
 * send `max_tokens`, send the system prompt with the `system` role,
 * and do not send the `store` field.
 * Claude models also get Anthropic `cache_control` markers. Without them,
 * the gateway caches only the system prompt of a Claude request.
 */
export function buildCompat(params: { id: string; reasoning: boolean }): ModelCompat {
  return {
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    supportsStore: false,
    supportsReasoningEffort: params.reasoning,
    ...(isClaudeModel(params.id) ? { cacheControlFormat: "anthropic" as const } : {}),
  };
}

/** Claude rows on the gateway use bare ids such as `claude-sonnet-5`. */
export function isClaudeModel(id: string): boolean {
  return id.trim().toLowerCase().startsWith("claude-");
}

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function staticModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow: number;
  maxTokens: number;
}): ModelDefinition {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.image ? ["text", "image"] : ["text"],
    // Prices come from live discovery. The offline list has no prices.
    cost: { ...ZERO_COST },
    contextWindow: params.contextWindow,
    maxTokens: params.maxTokens,
    compat: buildCompat({ id: params.id, reasoning: params.reasoning }),
  };
}

/**
 * Small offline list. OpenClaw uses it when live discovery is not possible,
 * for example before a key is set or when the network is down.
 * Keep this list in sync with `modelCatalog` in openclaw.plugin.json.
 */
export function buildStaticModels(): ModelDefinition[] {
  return [
    staticModel({
      id: "gpt-5.4-mini",
      name: "GPT-5.4 mini",
      reasoning: true,
      image: true,
      contextWindow: 400_000,
      maxTokens: 32_768,
    }),
    staticModel({
      id: "gpt-5.4",
      name: "GPT-5.4",
      reasoning: true,
      image: true,
      contextWindow: 1_000_000,
      maxTokens: 32_768,
    }),
    staticModel({
      id: "claude-sonnet-5",
      name: "Claude Sonnet 5",
      reasoning: false,
      image: false,
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    }),
    staticModel({
      id: "gemini-3.1-pro",
      name: "Gemini 3.1 Pro",
      reasoning: false,
      image: false,
      contextWindow: 1_048_576,
      maxTokens: 32_768,
    }),
  ];
}

export function buildProviderConfig(models: ModelDefinition[]): ProviderConfig {
  return {
    baseUrl: BASE_URL,
    api: "openai-completions",
    models,
  };
}

/** Model for an id that is not in the current list. Uses safe limits. */
export function buildDynamicModel(modelId: string): ModelDefinition {
  return {
    id: modelId,
    name: modelId,
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: FALLBACK_CONTEXT_WINDOW,
    maxTokens: FALLBACK_MAX_TOKENS,
    compat: buildCompat({ id: modelId, reasoning: false }),
  };
}
