import { createHash } from "node:crypto";
import { MODELS_URL } from "./constants.js";
import {
  buildCompat,
  FALLBACK_CONTEXT_WINDOW,
  FALLBACK_MAX_TOKENS,
  type ModelDefinition,
} from "./models.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const CACHE_TTL_MS = 60_000;

export class ModelListError extends Error {
  readonly kind: "unauthorized" | "http" | "network" | "invalid";
  readonly status?: number;

  constructor(kind: ModelListError["kind"], message: string, status?: number) {
    super(message);
    this.name = "ModelListError";
    this.kind = kind;
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPositiveInt(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return Math.floor(parsed);
}

/** Reads a USD-per-million price. The API sends prices as decimal strings. */
function readPrice(value: unknown): number {
  const parsed = typeof value === "string" ? Number(value.trim()) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }
  return parsed;
}

function readCost(pricing: unknown): ModelDefinition["cost"] {
  if (!isRecord(pricing)) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  const currency = typeof pricing.currency === "string" ? pricing.currency.toUpperCase() : "USD";
  if (currency !== "USD") {
    // OpenClaw costs are in USD. Do not guess an exchange rate.
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  }
  return {
    input: readPrice(pricing.input_per_million),
    output: readPrice(pricing.output_per_million),
    cacheRead: readPrice(pricing.cache_read_input_per_million),
    cacheWrite: readPrice(pricing.cache_write_input_per_million),
  };
}

/**
 * Maps one row of GET /v1/models to an OpenClaw model definition.
 * Returns undefined for rows that are not chat models.
 */
export function mapModelRow(row: unknown): ModelDefinition | undefined {
  if (!isRecord(row)) {
    return undefined;
  }
  const id = typeof row.id === "string" ? row.id.trim() : "";
  if (!id || row.type !== "text") {
    return undefined;
  }
  const capabilities = isRecord(row.capabilities) ? row.capabilities : {};
  const reasoning = capabilities.reasoning === true;
  const vision = capabilities.vision === true;
  const contextWindow = readPositiveInt(row.context_length) ?? FALLBACK_CONTEXT_WINDOW;
  const maxTokens = Math.min(
    readPositiveInt(row.max_output_tokens) ?? FALLBACK_MAX_TOKENS,
    contextWindow,
  );
  const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : id;
  return {
    id,
    name,
    reasoning,
    input: vision ? ["text", "image"] : ["text"],
    cost: readCost(row.pricing),
    contextWindow,
    maxTokens,
    compat: buildCompat({ id, reasoning }),
  };
}

/** Maps a full GET /v1/models body. Keeps only text rows. Drops duplicate ids. */
export function mapModelList(body: unknown): ModelDefinition[] {
  const rows = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const seen = new Set<string>();
  const models: ModelDefinition[] = [];
  for (const row of rows) {
    const model = mapModelRow(row);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** Calls GET /v1/models with the key. Throws ModelListError on failure. */
export async function fetchModelList(params: {
  apiKey: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
}): Promise<ModelDefinition[]> {
  const fetchImpl = params.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(MODELS_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${params.apiKey}`,
      },
      redirect: "error",
      signal,
    });
  } catch (error) {
    params.signal?.throwIfAborted();
    const reason = error instanceof Error ? error.message : String(error);
    throw new ModelListError("network", `Could not reach the Cheaper Inference API: ${reason}`);
  }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelListError(
      "unauthorized",
      `Cheaper Inference rejected the API key (HTTP ${response.status}).`,
      response.status,
    );
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelListError(
      "http",
      `Cheaper Inference model list failed (HTTP ${response.status}).`,
      response.status,
    );
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new ModelListError("invalid", "Cheaper Inference model list is too large.");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ModelListError("invalid", "Cheaper Inference model list is not valid JSON.");
  }
  return mapModelList(body);
}

type CacheEntry = { expiresAt: number; models: ModelDefinition[] };
const cache = new Map<string, CacheEntry>();

function cacheKey(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex");
}

/**
 * Returns the live chat model list, or undefined when discovery fails.
 * Caches a non-empty result for 60 seconds per key.
 */
export async function discoverModels(params: {
  apiKey: string;
  fetchImpl?: FetchLike;
  signal?: AbortSignal;
  now?: () => number;
}): Promise<ModelDefinition[] | undefined> {
  const now = params.now ?? Date.now;
  const key = cacheKey(params.apiKey);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now()) {
    return hit.models.map((model) => structuredClone(model));
  }
  try {
    const models = await fetchModelList(params);
    if (models.length === 0) {
      return undefined;
    }
    cache.set(key, { expiresAt: now() + CACHE_TTL_MS, models });
    return models.map((model) => structuredClone(model));
  } catch (error) {
    params.signal?.throwIfAborted();
    if (error instanceof ModelListError) {
      return undefined;
    }
    throw error;
  }
}

export function clearDiscoveryCache(): void {
  cache.clear();
}
