# LLM Protocol Bridge

[中文文档](./README.zh-CN.md)

> A thin proxy that bridges Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses for any compatible upstream gateway.

LLM Protocol Bridge is a thin front proxy that converts between common LLM API protocols:

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses

It can sit in front of any upstream gateway or provider endpoint that exposes one or more of those APIs. New API is a good upstream option because it already handles provider routing, channels, quota, retries, and logs, but this bridge is not New API-specific.

## What It Does

- Exposes one proxy endpoint for three API styles:
  - Anthropic Messages: `POST /v1/messages`
  - OpenAI Chat Completions: `POST /v1/chat/completions`
  - OpenAI Responses: `POST /v1/responses`
  - Models passthrough: `GET /v1/models`
- For each request, it first tries the same protocol on the configured upstream.
- If the upstream reports that the protocol/model/endpoint is unsupported, it converts to another protocol and retries.
- The upstream controls final model routing. This bridge does not keep a provider or model routing table.

## Protocol Coverage

Implemented conversion paths:

- Anthropic Messages -> Chat Completions -> Responses
- Chat Completions -> Responses -> Anthropic Messages
- Responses -> Chat Completions -> Anthropic Messages

Implemented tool translation:

- Anthropic `tool_use` / `tool_result`
- Chat Completions `tool_calls` / `tool` messages
- Responses `function_call` / `function_call_output`

Advanced content handling:

- Images are converted where the target protocol has an image shape.
- Reasoning/thinking is mapped where possible.
- Audio, files, computer calls, and unknown blocks are preserved as structured payloads or JSON text when the target protocol has no exact equivalent.
- Streaming text and basic tool/reasoning deltas are converted across the common SSE formats.

## Deployment Shape

Generic topology:

```text
Client
  -> http://server:8787
LLM Protocol Bridge
  -> http://127.0.0.1:3000 or http://gateway:3000
Upstream gateway/provider
  -> optional upstream providers
```

If the bridge runs directly on the same host as the upstream gateway, use:

```text
http://127.0.0.1:3000
```

If both services run in different Docker containers in the same compose network, use the upstream service name instead:

```text
http://new-api:3000
```

or:

```text
http://one-api:3000
```

If the bridge container uses host networking, `127.0.0.1` can also point to a host service.

## Configuration

You can configure the bridge with environment variables, a JSON file, or both.

Priority:

```text
environment variables > config file > defaults
```

Copy the example:

```sh
cp config.example.json config.json
```

Example `config.json`:

```json
{
  "port": 8787,
  "proxy": {
    "apiKey": "sk-proxy-change-me"
  },
  "upstream": {
    "baseUrl": "http://127.0.0.1:3000",
    "apiKey": "sk-upstream-change-me"
  }
}
```

Environment variables:

```sh
PORT=8787
CONFIG_PATH=./config.json
PROXY_API_KEY=sk-proxy-change-me
UPSTREAM_BASE_URL=http://127.0.0.1:3000
UPSTREAM_API_KEY=sk-upstream-change-me
```

Backward-compatible aliases are also accepted:

```sh
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_KEY=sk-newapi-change-me
```

`PROXY_API_KEY` is optional:

- unset: no client auth, all callers can use the bridge
- set: clients must send either `Authorization: Bearer <key>` or `x-api-key: <key>`

The bridge always uses `UPSTREAM_API_KEY` when calling the upstream. Clients should never receive the real upstream key.

## Run With Node

```sh
npm start
```

With env only:

```sh
UPSTREAM_BASE_URL=http://127.0.0.1:3000 \
UPSTREAM_API_KEY=sk-upstream-change-me \
PROXY_API_KEY=sk-proxy-change-me \
npm start
```

With config file:

```sh
CONFIG_PATH=./config.json npm start
```

## Run With Docker

Build:

```sh
docker build -t llm-protocol-bridge .
```

Run with a mounted config file:

```sh
docker run -d \
  --name llm-protocol-bridge \
  -p 8787:8787 \
  -e CONFIG_PATH=/app/config.json \
  -v "$PWD/config.json:/app/config.json:ro" \
  llm-protocol-bridge
```

Or use the example compose file:

```sh
cp config.example.json config.json
docker compose -f docker-compose.example.yml up -d --build
```

## Client Configuration

Clients should point to this bridge, not directly to the upstream gateway.

Anthropic / Claude-style clients:

```text
Endpoint: http://server:8787
API key:  sk-proxy-change-me
```

Some clients require the full path:

```text
http://server:8787/v1/messages
```

OpenAI Chat Completions clients:

```text
Base URL: http://server:8787/v1
API key:  sk-proxy-change-me
Path:     /chat/completions
```

OpenAI Responses clients:

```text
Base URL: http://server:8787/v1
API key:  sk-proxy-change-me
Path:     /responses
```

Use model names exposed by the upstream gateway, for example:

```text
claude-sonnet-4
gpt-4.1
gemini-2.5-pro
```

The bridge does not decide which provider serves the model. The upstream does.

## Using With New API

New API is a recommended upstream when you want provider/channel routing plus this bridge's protocol conversion.

If the bridge runs on the same host as New API:

```json
{
  "upstream": {
    "baseUrl": "http://127.0.0.1:3000",
    "apiKey": "your-new-api-token"
  }
}
```

If the bridge and New API run in the same Docker Compose network:

```json
{
  "upstream": {
    "baseUrl": "http://new-api:3000",
    "apiKey": "your-new-api-token"
  }
}
```

## Tests

Mocked integration tests:

```sh
npm test
```

Real upstream smoke test, skipped unless all variables are set:

```sh
UPSTREAM_BASE_URL=http://127.0.0.1:3000 \
UPSTREAM_API_KEY=sk-upstream-change-me \
UPSTREAM_TEST_MODEL=your-model \
npm run smoke:upstream
```

New API aliases still work:

```sh
NEW_API_BASE_URL=http://127.0.0.1:3000 \
NEW_API_KEY=sk-newapi-change-me \
NEW_API_TEST_MODEL=your-model \
npm run smoke:upstream
```

## Security Notes

- Do not commit `config.json`; it is ignored by git.
- Use `PROXY_API_KEY` if the bridge is exposed outside localhost or a private network.
- Put the bridge behind HTTPS if clients connect over the public internet.
- Keep provider keys inside the upstream gateway when possible. The bridge only needs one upstream token.

## Non-Goals

- No provider/channel dashboard.
- No model routing config.
- No billing or quota system.
- No database.

Those belong in the upstream gateway/provider layer.
