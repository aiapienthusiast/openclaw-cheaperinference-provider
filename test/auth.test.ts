import { describe, expect, it, vi } from "vitest";
import { checkApiKey, createApiKeyAuthMethod, pickDefaultModelRef } from "../src/auth.js";
import { jsonResponse, mockFetch, MODELS_RESPONSE } from "./fixtures.js";

function createPrompter() {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    note: vi.fn(),
    text: vi.fn(async () => {
      throw new Error("no prompt expected");
    }),
    confirm: vi.fn(async () => true),
    select: vi.fn(),
    multiselect: vi.fn(),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

/** Sign-in context with the key passed as a CLI flag, so no prompt runs. */
function createAuthContext(apiKey: string) {
  return {
    config: {},
    env: {},
    opts: { cheaperinferenceApiKey: apiKey },
    prompter: createPrompter(),
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    isRemote: false,
    openUrl: vi.fn(),
    oauth: { createVpsAwareHandlers: vi.fn() },
  } as never;
}

describe("checkApiKey", () => {
  it("accepts a key that can list models", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    await expect(checkApiKey({ apiKey: "ci_live_good", fetchImpl })).resolves.toEqual({
      ok: true,
      modelIds: ["gpt-5.4-mini", "claude-sonnet-5", "deepseek-v4-flash"],
    });
  });

  it("rejects a key on HTTP 401", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: "bad key" }, 401));
    await expect(checkApiKey({ apiKey: "ci_live_bad", fetchImpl })).resolves.toMatchObject({
      ok: false,
      kind: "unauthorized",
    });
  });

  it("reports a network error without throwing", async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(checkApiKey({ apiKey: "k", fetchImpl })).resolves.toMatchObject({
      ok: false,
      kind: "network",
    });
  });
});

describe("pickDefaultModelRef", () => {
  it("prefers gpt-5.4-mini", () => {
    expect(pickDefaultModelRef(["claude-sonnet-5", "gpt-5.4-mini"])).toBe(
      "cheaperinference/gpt-5.4-mini",
    );
  });

  it("falls back to the first listed model", () => {
    expect(pickDefaultModelRef(["glm-5.3", "claude-sonnet-5"])).toBe("cheaperinference/glm-5.3");
  });

  it("uses gpt-5.4-mini when the list is empty", () => {
    expect(pickDefaultModelRef([])).toBe("cheaperinference/gpt-5.4-mini");
  });
});

describe("API-key sign-in", () => {
  it("has the expected id and kind", () => {
    const method = createApiKeyAuthMethod();
    expect(method.id).toBe("api-key");
    expect(method.kind).toBe("api_key");
    expect(method.starterModel).toBe("cheaperinference/gpt-5.4-mini");
  });

  it("saves a valid key and sets the default model", async () => {
    const fetchImpl = mockFetch(() => jsonResponse(MODELS_RESPONSE));
    const method = createApiKeyAuthMethod({ fetchImpl });
    const result = await method.run(createAuthContext("ci_live_good"));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(result.defaultModel).toBe("cheaperinference/gpt-5.4-mini");
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]).toMatchObject({
      profileId: "cheaperinference:default",
      credential: { type: "api_key", provider: "cheaperinference", key: "ci_live_good" },
    });
  });

  it("stops sign-in when the API rejects the key", async () => {
    const fetchImpl = mockFetch(() => jsonResponse({ error: "bad key" }, 401));
    const method = createApiKeyAuthMethod({ fetchImpl });
    await expect(method.run(createAuthContext("ci_live_bad"))).rejects.toThrow(
      /rejected the API key \(HTTP 401\)/,
    );
  });

  it("keeps the key and adds a note when the API cannot be reached", async () => {
    const fetchImpl = mockFetch(() => {
      throw new TypeError("fetch failed");
    });
    const method = createApiKeyAuthMethod({ fetchImpl });
    const result = await method.run(createAuthContext("ci_live_offline"));
    expect(result.profiles).toHaveLength(1);
    expect(result.defaultModel).toBe("cheaperinference/gpt-5.4-mini");
    expect(result.notes?.join("\n")).toMatch(/Could not check the key now/);
  });
});
