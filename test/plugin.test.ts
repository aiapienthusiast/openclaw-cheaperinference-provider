import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderPlugin, UnifiedModelCatalogProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import plugin from "../src/index.js";
import { clearDiscoveryCache } from "../src/discovery.js";
import { buildStaticModels } from "../src/models.js";
import { buildModelCatalogProvider, buildProvider, runCatalog } from "../src/provider.js";
import { jsonResponse, mockFetch, MODELS_RESPONSE } from "./fixtures.js";

const manifest = JSON.parse(
  readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
) as {
  id: string;
  providers: string[];
  setup: { providers: Array<{ id: string; envVars: string[] }> };
  providerAuthChoices: Array<{ provider: string; method: string; optionKey: string; cliFlag: string }>;
  modelCatalog: { providers: Record<string, { baseUrl: string; api: string; models: unknown[] }> };
};
const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { openclaw: { providers: string[] } };

function registerPlugin() {
  const providers: ProviderPlugin[] = [];
  const catalogs: UnifiedModelCatalogProviderPlugin[] = [];
  const api = {
    registerProvider: vi.fn((provider: ProviderPlugin) => providers.push(provider)),
    registerModelCatalogProvider: vi.fn((catalog: UnifiedModelCatalogProviderPlugin) =>
      catalogs.push(catalog),
    ),
  };
  plugin.register(api as never);
  return { providers, catalogs };
}

function catalogContext(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  config?: Record<string, unknown>;
  providerIds?: string[];
}) {
  return {
    config: params.config ?? {},
    env: {},
    ...(params.providerIds ? { providerIds: params.providerIds } : {}),
    resolveProviderApiKey: () => ({
      apiKey: params.apiKey,
      ...(params.discoveryApiKey ? { discoveryApiKey: params.discoveryApiKey } : {}),
    }),
    resolveProviderAuth: () => ({ apiKey: params.apiKey, mode: "api_key", source: "env" }),
  } as never;
}

beforeEach(() => {
  clearDiscoveryCache();
});

describe("plugin entry", () => {
  it("uses the manifest id", () => {
    expect(plugin.id).toBe(manifest.id);
    expect(plugin.id).toBe("cheaperinference");
    expect(plugin.name).toBe("Cheaper Inference");
  });

  it("registers one text provider and one model catalog", () => {
    const { providers, catalogs } = registerPlugin();
    expect(providers).toHaveLength(1);
    expect(catalogs).toHaveLength(1);
    const provider = providers[0]!;
    expect(provider.id).toBe("cheaperinference");
    expect(provider.label).toBe("Cheaper Inference");
    expect(provider.envVars).toEqual(["CHEAPER_INFERENCE_API_KEY"]);
    expect(provider.auth.map((method) => method.id)).toEqual(["api-key"]);
    expect(catalogs[0]).toMatchObject({ provider: "cheaperinference", kinds: ["text"] });
  });
});

describe("manifest", () => {
  it("matches the runtime provider", () => {
    expect(manifest.providers).toEqual(["cheaperinference"]);
    expect(packageJson.openclaw.providers).toEqual(["cheaperinference"]);
    expect(manifest.setup.providers).toEqual([
      { id: "cheaperinference", authMethods: ["api-key"], envVars: ["CHEAPER_INFERENCE_API_KEY"] },
    ]);
    expect(manifest.providerAuthChoices[0]).toMatchObject({
      provider: "cheaperinference",
      method: "api-key",
      optionKey: "cheaperinferenceApiKey",
      cliFlag: "--cheaperinference-api-key",
    });
  });

  it("lists the same offline models as the runtime", () => {
    const catalog = manifest.modelCatalog.providers.cheaperinference!;
    expect(catalog.baseUrl).toBe("https://api.cheaperinference.com/v1");
    expect(catalog.api).toBe("openai-completions");
    const runtime = buildStaticModels().map(({ cost: _cost, ...rest }) => rest);
    const fromManifest = catalog.models.map((row) => {
      const { tags: _tags, ...rest } = row as Record<string, unknown>;
      return rest;
    });
    expect(fromManifest).toEqual(runtime);
  });
});

describe("catalog", () => {
  it("returns null without a key", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    await expect(runCatalog(catalogContext({}), { fetchImpl })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns null when another provider is requested", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    const result = await runCatalog(catalogContext({ apiKey: "k", providerIds: ["other"] }), {
      fetchImpl,
    });
    expect(result).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns live text models with a key", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    const result = await runCatalog(catalogContext({ apiKey: "ci_live_k" }), { fetchImpl });
    if (!result || !("provider" in result)) throw new Error("expected provider");
    expect(result.provider.baseUrl).toBe("https://api.cheaperinference.com/v1");
    expect(result.provider.api).toBe("openai-completions");
    expect(result.provider.apiKey).toBe("ci_live_k");
    expect(result.provider.models.map((m) => m.id)).toEqual([
      "gpt-5.4-mini",
      "claude-sonnet-5",
      "deepseek-v4-flash",
    ]);
    expect(result.provider.models[1]).toMatchObject({
      input: ["text", "image"],
      reasoning: true,
      contextWindow: 1000000,
      maxTokens: 64000,
      cost: { input: 2.1, output: 10.5, cacheRead: 0.21, cacheWrite: 2.625 },
    });
  });

  it("uses the discovery key when auth supplies one", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    await runCatalog(catalogContext({ apiKey: "inference", discoveryApiKey: "discovery" }), {
      fetchImpl,
    });
    const init = fetchImpl.mock.calls[0]![1];
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer discovery");
  });

  it("falls back to the offline list when discovery fails", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({}, 500));
    const result = await runCatalog(catalogContext({ apiKey: "k" }), { fetchImpl });
    if (!result || !("provider" in result)) throw new Error("expected provider");
    expect(result.provider.models.map((m) => m.id)).toEqual(buildStaticModels().map((m) => m.id));
  });

  it("does not send the key to a custom base URL", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    const config = { models: { providers: { cheaperinference: { baseUrl: "https://proxy.example/v1" } } } };
    const result = await runCatalog(catalogContext({ apiKey: "k", config }), { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    if (!result || !("provider" in result)) throw new Error("expected provider");
    expect(result.provider.models).toHaveLength(4);
  });

  it("does not send a secret marker as a key", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    await runCatalog(catalogContext({ apiKey: "secretref-managed" }), { fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("static catalog needs no key and no network", async () => {
    const provider = buildProvider();
    const result = await provider.staticCatalog!.run(catalogContext({}));
    if (!result || !("provider" in result)) throw new Error("expected provider");
    expect(result.provider.models.map((m) => m.id)).toEqual([
      "gpt-5.4-mini",
      "gpt-5.4",
      "claude-sonnet-5",
      "gemini-3.1-pro",
    ]);
    expect(result.provider.apiKey).toBeUndefined();
  });

  it("projects unified catalog rows", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    const catalog = buildModelCatalogProvider({ fetchImpl });
    const staticRows = await catalog.staticCatalog!(catalogContext({}));
    expect(staticRows?.[0]).toEqual({
      kind: "text",
      provider: "cheaperinference",
      model: "gpt-5.4-mini",
      label: "GPT-5.4 mini",
      source: "static",
    });
    const liveRows = await catalog.liveCatalog!(catalogContext({ apiKey: "k" }));
    expect(liveRows?.map((row) => [row.model, row.source])).toEqual([
      ["gpt-5.4-mini", "live"],
      ["claude-sonnet-5", "live"],
      ["deepseek-v4-flash", "live"],
    ]);
  });
});

describe("model resolution", () => {
  it("resolves an unknown model id with safe limits", () => {
    const provider = buildProvider();
    const model = provider.resolveDynamicModel!({
      provider: "cheaperinference",
      modelId: "glm-5.3",
      modelRegistry: {} as never,
    });
    expect(model).toMatchObject({
      id: "glm-5.3",
      provider: "cheaperinference",
      api: "openai-completions",
      baseUrl: "https://api.cheaperinference.com/v1",
      input: ["text"],
      contextWindow: 128000,
      maxTokens: 8192,
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
    });
  });

  it("adds Anthropic cache markers to configured Claude models", () => {
    const provider = buildProvider();
    const model = provider.normalizeResolvedModel!({
      provider: "cheaperinference",
      modelId: "claude-opus-5",
      model: {
        id: "claude-opus-5",
        name: "Claude Opus 5",
        provider: "cheaperinference",
        api: "openai-completions",
        baseUrl: "https://api.cheaperinference.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 64000,
      },
    } as never);
    expect(model?.compat?.cacheControlFormat).toBe("anthropic");
  });

  it("adds the gateway request shape to configured models", () => {
    const provider = buildProvider();
    const model = provider.normalizeResolvedModel!({
      provider: "cheaperinference",
      modelId: "gpt-5.4",
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        provider: "cheaperinference",
        api: "openai-completions",
        baseUrl: "https://api.cheaperinference.com/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 32768,
        compat: { supportsStore: true },
      },
    } as never);
    expect(model?.compat).toEqual({
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      supportsStore: true,
      supportsReasoningEffort: true,
    });
  });
});
