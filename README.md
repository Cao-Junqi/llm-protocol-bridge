# NewAPI Protocol Bridge

NewAPI Protocol Bridge is a thin front proxy for [New API](https://github.com/QuantumNous/new-api). New API remains the main gateway for model routing, provider channels, keys, quota, retry, and logs. This project only handles protocol conversion before requests reach New API.

## What It Does

- Exposes one proxy endpoint for three API styles:
  - Anthropic Messages: `POST /v1/messages`
  - OpenAI Chat Completions: `POST /v1/chat/completions`
  - OpenAI Responses: `POST /v1/responses`
  - Models passthrough: `GET /v1/models`
- For each request, it first tries the same protocol on New API.
- If New API reports that the protocol/model/endpoint is unsupported, it converts to another protocol and retries.
- New API controls the final model-to-provider route. The bridge does not keep a second model routing table.

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

Recommended topology:

```text
Client
  -> http://server:8787
NewAPI Protocol Bridge
  -> http://127.0.0.1:3000 or http://new-api:3000
New API
  -> upstream providers
```

If the bridge runs directly on the same host as New API, use:

```text
http://127.0.0.1:3000
```

If both services run in different Docker containers in the same compose network, use the New API service name instead:

```text
http://new-api:3000
```

If the bridge container uses host networking, `127.0.0.1` can also point to the host New API service.

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
  "newApi": {
    "baseUrl": "http://127.0.0.1:3000",
    "apiKey": "sk-newapi-change-me"
  }
}
```

Environment variables:

```sh
PORT=8787
CONFIG_PATH=./config.json
PROXY_API_KEY=sk-proxy-change-me
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_KEY=sk-newapi-change-me
```

`PROXY_API_KEY` is optional:

- unset: no client auth, all callers can use the bridge
- set: clients must send either `Authorization: Bearer <key>` or `x-api-key: <key>`

The bridge always uses `NEW_API_KEY` when calling New API. Clients should never receive the real New API key.

## Run With Node

```sh
npm start
```

With env only:

```sh
NEW_API_BASE_URL=http://127.0.0.1:3000 \
NEW_API_KEY=sk-newapi-change-me \
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
docker build -t newapi-protocol-bridge .
```

Run with a mounted config file:

```sh
docker run -d \
  --name newapi-protocol-bridge \
  -p 8787:8787 \
  -e CONFIG_PATH=/app/config.json \
  -v "$PWD/config.json:/app/config.json:ro" \
  newapi-protocol-bridge
```

Or use the example compose file:

```sh
cp config.example.json config.json
docker compose -f docker-compose.example.yml up -d --build
```

## Client Configuration

Clients should point to this bridge, not directly to New API.

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

Use the model names configured in New API, for example:

```text
claude-sonnet-4
gpt-4.1
gemini-2.5-pro
```

The bridge does not decide which provider serves the model. New API does.

## Tests

Mocked integration tests:

```sh
npm test
```

Real New API smoke test, skipped unless all variables are set:

```sh
NEW_API_BASE_URL=http://127.0.0.1:3000 \
NEW_API_KEY=sk-newapi-change-me \
NEW_API_TEST_MODEL=your-model \
npm run smoke:new-api
```

## Security Notes

- Do not commit `config.json`; it is ignored by git.
- Use `PROXY_API_KEY` if the bridge is exposed outside localhost or a private network.
- Put the bridge behind HTTPS if clients connect over the public internet.
- Keep provider keys inside New API. The bridge only needs a New API token.

## Non-Goals

- No provider/channel dashboard.
- No model routing config.
- No billing or quota system.
- No database.

New API already owns those parts.
