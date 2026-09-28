import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import {
  API_KEY_ENV_VAR,
  DEFAULT_MODEL_ID,
  DEFAULT_MODEL_REF,
  PROVIDER_ID,
  PROVIDER_LABEL,
  SIGNUP_URL,
} from "./constants.js";
import { fetchModelList, ModelListError, type FetchLike } from "./discovery.js";

export type KeyCheck =
  | { ok: true; modelIds: string[] }
  | { ok: false; kind: ModelListError["kind"]; message: string };

/** Checks a key with GET /v1/models. Does not throw for API or network errors. */
export async function checkApiKey(params: {
  apiKey: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<KeyCheck> {
  try {
    const models = await fetchModelList(params);
    return { ok: true, modelIds: models.map((model) => model.id) };
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof ModelListError) {
      return { ok: false, kind: error.kind, message: error.message };
    }
    throw error;
  }
}

/** Picks the default model from the ids the key can use. */
export function pickDefaultModelRef(modelIds: string[]): string {
  if (modelIds.length === 0 || modelIds.includes(DEFAULT_MODEL_ID)) {
    return DEFAULT_MODEL_REF;
  }
  return `${PROVIDER_ID}/${modelIds[0]}`;
}

/**
 * API-key sign-in for `openclaw onboard` and `openclaw models auth login`.
 * After the user enters a key, the plugin calls GET /v1/models.
 * A rejected key stops sign-in, so OpenClaw does not save it.
 * A network error does not stop sign-in. OpenClaw saves the key and shows a note.
 */
export function createApiKeyAuthMethod(options: { fetchImpl?: FetchLike } = {}): ProviderAuthMethod {
  // One sign-in run uses one config object. The check result is stored per run.
  const checks = new WeakMap<object, KeyCheck>();

  const base = createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: "api-key",
    label: `${PROVIDER_LABEL} API key`,
    hint: "Key starts with ci_live_",
    optionKey: "cheaperinferenceApiKey",
    flagName: "--cheaperinference-api-key",
    envVar: API_KEY_ENV_VAR,
    promptMessage: `Enter your ${PROVIDER_LABEL} API key`,
    noteTitle: PROVIDER_LABEL,
    noteMessage: [
      `${PROVIDER_LABEL} is an OpenAI-compatible API for many models.`,
      `Get an API key at ${SIGNUP_URL}`,
    ].join("\n"),
    defaultModel: DEFAULT_MODEL_REF,
    // OpenClaw calls this with the entered key before it saves anything.
    resolveDefaultModel: async ({ apiKey, config, signal }) => {
      const check = await checkApiKey({
        apiKey,
        fetchImpl: options.fetchImpl,
        ...(signal ? { signal } : {}),
      });
      checks.set(config, check);
      return check.ok ? pickDefaultModelRef(check.modelIds) : DEFAULT_MODEL_REF;
    },
  });

  return {
    ...base,
    run: async (ctx) => {
      const result = await base.run(ctx);
      const check = checks.get(ctx.config);
      checks.delete(ctx.config);
      if (!check || check.ok) {
        return result;
      }
      if (check.kind === "unauthorized") {
        throw new Error(`${check.message} Check the key and try again.`);
      }
      return {
        ...result,
        notes: [...(result.notes ?? []), `Could not check the key now. ${check.message}`],
      };
    },
  };
}
