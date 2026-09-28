# Cheaper Inference provider for OpenClaw

This plugin adds [Cheaper Inference](https://cheaperinference.com) as a model provider to OpenClaw.
Each model costs 15–60% less than the list price of its lab.

Cheaper Inference has an OpenAI-compatible API.
One API key gives access to models from many labs.

| Property        | Value                                   |
| --------------- | --------------------------------------- |
| Provider id     | `cheaperinference`                      |
| Package         | `openclaw-cheaperinference-provider`    |
| API key env var | `CHEAPER_INFERENCE_API_KEY`             |
| Onboarding flag | `--auth-choice cheaperinference-api-key` |
| Direct CLI flag | `--cheaperinference-api-key <key>`      |
| API             | OpenAI Chat Completions                 |
| Base URL        | `https://api.cheaperinference.com/v1`   |
| Default model   | `cheaperinference/gpt-5.4-mini`         |

## Requirements

- OpenClaw 2026.9.6 or later.
- A Cheaper Inference API key.
  Get a key at <https://cheaperinference.com/signup>.
  The key starts with `ci_live_`.

## Install

```bash
openclaw plugins install clawhub:openclaw-cheaperinference-provider
```

A running Gateway loads the plugin automatically.
If the Gateway does not run, the plugin loads at the next start.

## Set the API key

Use one of these methods.

Method 1: run onboarding and select **Cheaper Inference**.

```bash
openclaw onboard --auth-choice cheaperinference-api-key
```

The plugin sends one request to `GET /v1/models` to check the key.
If the API rejects the key, OpenClaw does not save it.
If the API is not available, OpenClaw saves the key and shows a note.

Method 2: sign in for one provider only.

```bash
openclaw models auth login --provider cheaperinference --set-default
```

Method 3: set the environment variable for the Gateway process.

```bash
export CHEAPER_INFERENCE_API_KEY="<your-api-key>"
```

Method 4: non-interactive setup, for example in a script.

```bash
openclaw onboard --non-interactive --accept-risk --skip-health \
  --mode local \
  --auth-choice cheaperinference-api-key \
  --cheaperinference-api-key "$CHEAPER_INFERENCE_API_KEY"
```

## Select a model

Show the models:

```bash
openclaw models list --provider cheaperinference
```

Set the default model:

```bash
openclaw models set cheaperinference/gpt-5.4-mini
```

Write the model id after the `cheaperinference/` prefix.
Examples:

- `cheaperinference/gpt-5.4-mini`
- `cheaperinference/gpt-5.4`
- `cheaperinference/claude-sonnet-5`
- `cheaperinference/gemini-3.1-pro`
- `cheaperinference/deepseek-v4-flash`
- `cheaperinference/glm-5.3`

The full model list is at <https://cheaperinference.com/#models>.

## Config example

`~/.openclaw/openclaw.json`:

```json5
{
  env: { vars: { CHEAPER_INFERENCE_API_KEY: "<your-api-key>" } },
  agents: {
    defaults: {
      model: {
        primary: "cheaperinference/gpt-5.4-mini",
        fallbacks: ["cheaperinference/claude-sonnet-5"],
      },
    },
  },
}
```

## How the model list works

When a key is set, the plugin reads `GET /v1/models`.
It keeps only chat models (rows with `type: "text"`).
It does not show image or video models.

For each model, the plugin reads these fields:

| API field                                 | OpenClaw field           |
| ----------------------------------------- | ------------------------ |
| `context_length`                          | context window           |
| `max_output_tokens`                       | output token limit       |
| `capabilities.vision`                     | image input              |
| `capabilities.reasoning`                  | reasoning                |
| `pricing.input_per_million`               | input cost (USD / 1M)    |
| `pricing.output_per_million`              | output cost (USD / 1M)   |
| `pricing.cache_read_input_per_million`    | cache read cost (USD / 1M)  |
| `pricing.cache_write_input_per_million`   | cache write cost (USD / 1M) |

The plugin keeps the list in memory for 60 seconds.

If the request fails, the plugin uses a small offline list:
`gpt-5.4-mini`, `gpt-5.4`, `claude-sonnet-5`, `gemini-3.1-pro`.
The offline list has no prices.

A model id that is not in the list also works.
OpenClaw uses a 128,000-token context window and an 8,192-token output limit for it.

## Request format

The plugin sends requests to `/v1/chat/completions`.
It sends the output limit as `max_tokens`.
It sends the system prompt with the `system` role.
It does not send the `store` field.
For Claude models (ids that start with `claude-`), it adds Anthropic `cache_control` markers.
With these markers, the API caches the conversation, not only the system prompt.

## Data and network

The plugin sends your API key only to `https://api.cheaperinference.com`.
If you set a different `baseUrl` for this provider, the plugin does not read the model list.
The plugin does not read environment variables directly.
OpenClaw gives the key to the plugin.

## Limits

- Chat models only.
  The plugin does not add embeddings, speech, image generation, or video generation.

## Links

- Documentation: <https://cheaperinference.com/docs>
- Models: <https://cheaperinference.com/#models>
- Sign up: <https://cheaperinference.com/signup>

## License

MIT
