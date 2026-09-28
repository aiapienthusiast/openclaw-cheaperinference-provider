import { vi } from "vitest";
import type { FetchLike } from "../src/discovery.js";

/** Shape of GET /v1/models, with made-up prices. */
export const MODELS_RESPONSE = {
  object: "list",
  data: [
    {
      id: "gpt-5.4-mini",
      object: "model",
      type: "text",
      endpoint: "/v1/chat/completions",
      context_length: 400000,
      max_output_tokens: 128000,
      capabilities: { vision: true, reasoning: true, streaming: true },
      pricing: {
        currency: "USD",
        input_per_million: "0.20",
        output_per_million: "1.60",
        cache_read_input_per_million: "0.02",
        cache_write_input_per_million: "0",
      },
    },
    {
      id: "claude-sonnet-5",
      object: "model",
      type: "text",
      endpoint: "/v1/chat/completions",
      context_length: 1000000,
      max_output_tokens: 64000,
      capabilities: { vision: true, reasoning: true, streaming: true },
      pricing: {
        currency: "USD",
        input_per_million: "2.10",
        output_per_million: "10.50",
        cache_read_input_per_million: "0.21",
        cache_write_input_per_million: "2.625",
      },
    },
    {
      id: "deepseek-v4-flash",
      object: "model",
      type: "text",
      endpoint: "/v1/chat/completions",
      capabilities: { streaming: true },
    },
    {
      id: "image-model-1",
      object: "model",
      type: "image",
      endpoint: "/v1/images/generations",
      capabilities: {},
      pricing: { currency: "USD" },
    },
    {
      id: "video-model-1",
      object: "model",
      type: "video",
      endpoint: "/v1/videos",
      capabilities: {},
    },
  ],
};

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function mockFetch(handler: () => Response | Promise<Response>) {
  return vi.fn<FetchLike>(async () => handler());
}
