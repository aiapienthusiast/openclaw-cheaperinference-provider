import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDiscoveryCache,
  discoverModels,
  fetchModelList,
  mapModelList,
  mapModelRow,
  ModelListError,
} from "../src/discovery.js";
import { FALLBACK_CONTEXT_WINDOW, FALLBACK_MAX_TOKENS } from "../src/models.js";
import { jsonResponse, mockFetch, MODELS_RESPONSE } from "./fixtures.js";

beforeEach(() => {
  clearDiscoveryCache();
});

describe("mapModelRow", () => {
  it("maps limits, capabilities and prices", () => {
    const model = mapModelRow(MODELS_RESPONSE.data[0]);
    expect(model).toEqual({
      id: "gpt-5.4-mini",
      name: "gpt-5.4-mini",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.2, output: 1.6, cacheRead: 0.02, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 128000,
      compat: {
        supportsDeveloperRole: false,
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsReasoningEffort: true,
      },
    });
  });

  it("adds Anthropic cache markers to Claude rows only", () => {
    const claude = mapModelRow({ id: "claude-sonnet-5", type: "text" });
    expect(claude?.compat?.cacheControlFormat).toBe("anthropic");
    const gpt = mapModelRow({ id: "gpt-5.4-mini", type: "text" });
    expect(gpt?.compat).not.toHaveProperty("cacheControlFormat");
  });

  it("uses safe defaults when fields are missing", () => {
    const model = mapModelRow(MODELS_RESPONSE.data[2]);
    expect(model).toMatchObject({
      id: "deepseek-v4-flash",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: FALLBACK_CONTEXT_WINDOW,
      maxTokens: FALLBACK_MAX_TOKENS,
    });
    expect(model?.compat?.supportsReasoningEffort).toBe(false);
  });

  it("drops image and video rows", () => {
    expect(mapModelRow(MODELS_RESPONSE.data[3])).toBeUndefined();
    expect(mapModelRow(MODELS_RESPONSE.data[4])).toBeUndefined();
  });

  it("drops rows without a type or id", () => {
    expect(mapModelRow({ id: "x" })).toBeUndefined();
    expect(mapModelRow({ type: "text" })).toBeUndefined();
    expect(mapModelRow(null)).toBeUndefined();
  });

  it("does not convert non-USD prices", () => {
    const model = mapModelRow({
      id: "m",
      type: "text",
      pricing: { currency: "EUR", input_per_million: "1", output_per_million: "2" },
    });
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("ignores bad price strings", () => {
    const model = mapModelRow({
      id: "m",
      type: "text",
      pricing: { currency: "USD", input_per_million: "abc", output_per_million: "-1" },
    });
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("caps the output limit at the context window", () => {
    const model = mapModelRow({ id: "m", type: "text", context_length: 1000, max_output_tokens: 5000 });
    expect(model?.maxTokens).toBe(1000);
  });
});

describe("mapModelList", () => {
  it("keeps only text rows and drops duplicates", () => {
    const body = { data: [...MODELS_RESPONSE.data, MODELS_RESPONSE.data[0]] };
    expect(mapModelList(body).map((m) => m.id)).toEqual([
      "gpt-5.4-mini",
      "claude-sonnet-5",
      "deepseek-v4-flash",
    ]);
  });

  it("returns an empty list for an unknown body", () => {
    expect(mapModelList({ models: [] })).toEqual([]);
    expect(mapModelList("x")).toEqual([]);
  });
});

describe("fetchModelList", () => {
  it("sends the key as a bearer token to the models endpoint", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    await fetchModelList({ apiKey: "ci_live_test", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://api.cheaperinference.com/v1/models");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ci_live_test");
  });

  it("reports a rejected key", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: "invalid key" }, 401));
    await expect(fetchModelList({ apiKey: "bad", fetchImpl })).rejects.toMatchObject({
      kind: "unauthorized",
      status: 401,
    });
  });

  it("reports a server error", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({}, 503));
    await expect(fetchModelList({ apiKey: "k", fetchImpl })).rejects.toMatchObject({
      kind: "http",
      status: 503,
    });
  });

  it("reports a network error", async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const error = await fetchModelList({ apiKey: "k", fetchImpl }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelListError);
    expect((error as ModelListError).kind).toBe("network");
  });

  it("reports bad JSON", async () => {
    const fetchImpl = mockFetch(() => new Response("not json", { status: 200 }));
    await expect(fetchModelList({ apiKey: "k", fetchImpl })).rejects.toMatchObject({
      kind: "invalid",
    });
  });
});

describe("discoverModels", () => {
  it("caches a good result for 60 seconds", async () => {
    let now = 1_000;
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    const first = await discoverModels({ apiKey: "k", fetchImpl, now: () => now });
    now += 59_000;
    const second = await discoverModels({ apiKey: "k", fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    now += 2_000;
    await discoverModels({ apiKey: "k", fetchImpl, now: () => now });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("uses a separate cache entry per key", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    await discoverModels({ apiKey: "a", fetchImpl });
    await discoverModels({ apiKey: "b", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns undefined on failure and does not cache it", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({}, 500));
    expect(await discoverModels({ apiKey: "k", fetchImpl })).toBeUndefined();
    expect(await discoverModels({ apiKey: "k", fetchImpl })).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when no text rows exist", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ data: [MODELS_RESPONSE.data[3]] }));
    expect(await discoverModels({ apiKey: "k", fetchImpl })).toBeUndefined();
  });
});
