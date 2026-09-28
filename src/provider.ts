import type {
  ProviderCatalogContext,
  ProviderCatalogResult,
  ProviderPlugin,
  UnifiedModelCatalogEntry,
  UnifiedModelCatalogProviderPlugin,
} from "openclaw/plugin-sdk/plugin-entry";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { createApiKeyAuthMethod } from "./auth.js";
import { API_KEY_ENV_VAR, BASE_URL, DOCS_URL, PROVIDER_ID, PROVIDER_LABEL } from "./constants.js";
import { discoverModels, type FetchLike } from "./discovery.js";
import {
  buildCompat,
  buildDynamicModel,
  buildProviderConfig,
  buildStaticModels,
  type ModelDefinition,
} from "./models.js";

function readConfiguredBaseUrl(ctx: ProviderCatalogContext): string | undefined {
  const providers = ctx.config.models?.providers as Record<string, { baseUrl?: unknown }> | undefined;
  const baseUrl = providers?.[PROVIDER_ID]?.baseUrl;
  return typeof baseUrl === "string" && baseUrl.trim() ? baseUrl.trim().replace(/\/+$/, "") : undefined;
}

function isUsableSecret(value: string | undefined): value is string {
  return Boolean(value && value.trim() && !isNonSecretApiKeyMarker(value));
}

/**
 * Runtime catalog. Returns null without a key.
 * With a key, it asks GET /v1/models for the live list.
 * If that fails, it returns the offline list.
 */
export async function runCatalog(
  ctx: ProviderCatalogContext,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProviderCatalogResult> {
  if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID)) {
    return null;
  }
  const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
  if (!auth.apiKey) {
    return null;
  }
  const configuredBaseUrl = readConfiguredBaseUrl(ctx);
  // Send the key only to the official API host.
  const canDiscover = !configuredBaseUrl || configuredBaseUrl === BASE_URL;
  const discoveryKey = auth.discoveryApiKey ?? auth.apiKey;
  let models: ModelDefinition[] | undefined;
  if (canDiscover && isUsableSecret(discoveryKey)) {
    models = await discoverModels({
      apiKey: discoveryKey,
      fetchImpl: options.fetchImpl,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
  }
  return {
    provider: {
      ...buildProviderConfig(models ?? buildStaticModels()),
      apiKey: auth.apiKey,
    },
  };
}

/** Offline catalog. No network. No key. */
export async function runStaticCatalog(): Promise<ProviderCatalogResult> {
  return { provider: buildProviderConfig(buildStaticModels()) };
}

function toUnifiedRows(
  result: ProviderCatalogResult,
  source: UnifiedModelCatalogEntry["source"],
): UnifiedModelCatalogEntry[] {
  if (!result || !("provider" in result)) {
    return [];
  }
  return result.provider.models.map((model) => ({
    kind: "text" as const,
    provider: PROVIDER_ID,
    model: model.id,
    ...(model.name ? { label: model.name } : {}),
    source,
  }));
}

export function buildProvider(options: { fetchImpl?: FetchLike } = {}): ProviderPlugin {
  return {
    id: PROVIDER_ID,
    label: PROVIDER_LABEL,
    docsPath: DOCS_URL,
    envVars: [API_KEY_ENV_VAR],
    auth: [createApiKeyAuthMethod(options)],
    catalog: {
      order: "simple",
      run: (ctx) => runCatalog(ctx, options),
    },
    staticCatalog: {
      order: "simple",
      run: () => runStaticCatalog(),
    },
    // A model id that is not in the list still works. It gets safe limits.
    resolveDynamicModel: (ctx) => {
      const modelId = ctx.modelId.trim();
      if (!modelId) {
        return undefined;
      }
      const model = buildDynamicModel(modelId);
      return {
        id: model.id,
        name: model.name,
        provider: PROVIDER_ID,
        api: "openai-completions",
        baseUrl: BASE_URL,
        reasoning: model.reasoning,
        input: ["text"],
        cost: model.cost,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        compat: model.compat,
      };
    },
    // Configured models also get the gateway request shape,
    // unless the user set a value.
    normalizeResolvedModel: ({ model }) => ({
      ...model,
      compat: {
        ...buildCompat({ id: model.id, reasoning: model.reasoning === true }),
        ...model.compat,
      },
    }),
  };
}

export function buildModelCatalogProvider(
  options: { fetchImpl?: FetchLike } = {},
): UnifiedModelCatalogProviderPlugin {
  return {
    provider: PROVIDER_ID,
    kinds: ["text"],
    staticCatalog: async () => toUnifiedRows(await runStaticCatalog(), "static"),
    liveCatalog: async (ctx) => toUnifiedRows(await runCatalog(ctx, options), "live"),
  };
}
