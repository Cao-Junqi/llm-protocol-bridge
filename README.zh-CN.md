# LLM Protocol Bridge

[English](./README.md)

> 一个轻量前置代理，用于在 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses 之间做协议转换，可接任意兼容上游网关或供应商 endpoint。

LLM Protocol Bridge 是一个薄前置代理，用来转换常见 LLM API 协议：

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses

它可以放在任意支持其中一种或多种协议的上游网关或供应商 endpoint 前面。New API 是一个合适的上游选择，因为它已经提供供应商路由、渠道、额度、重试和日志，但本项目不是 New API 专用。

## 功能

- 对外暴露一组统一代理入口：
  - Anthropic Messages: `POST /v1/messages`
  - OpenAI Chat Completions: `POST /v1/chat/completions`
  - OpenAI Responses: `POST /v1/responses`
  - 模型列表透传: `GET /v1/models`
- 每次请求会先尝试用相同协议请求配置的上游。
- 如果上游返回协议、模型或 endpoint 不支持，代理会转换成其他协议再重试。
- 最终模型路由由上游决定。本项目不维护供应商或模型路由表。

## 协议覆盖

已实现的转换路径：

- Anthropic Messages -> Chat Completions -> Responses
- Chat Completions -> Responses -> Anthropic Messages
- Responses -> Chat Completions -> Anthropic Messages

已实现的工具调用转换：

- Anthropic `tool_use` / `tool_result`
- Chat Completions `tool_calls` / `tool` messages
- Responses `function_call` / `function_call_output`

高级内容处理：

- image 在目标协议有对应结构时会做结构化转换。
- reasoning/thinking 尽量映射到目标协议。
- audio、file、computer call 和未知 block 在目标协议没有等价结构时，会以结构化 payload 或 JSON 文本保留。
- 常见 SSE 流式文本、工具和 reasoning delta 会做格式转换。

## 部署形态

通用拓扑：

```text
Client
  -> http://server:8787
LLM Protocol Bridge
  -> http://127.0.0.1:3000 or http://gateway:3000
Upstream gateway/provider
  -> optional upstream providers
```

如果代理和上游网关直接跑在同一台宿主机上，可以用：

```text
http://127.0.0.1:3000
```

如果代理和上游网关跑在同一个 Docker Compose 网络里的不同容器中，要用服务名：

```text
http://new-api:3000
```

或：

```text
http://one-api:3000
```

如果代理容器使用 host network，`127.0.0.1` 也可以指向宿主机上的服务。

## 配置

支持环境变量、JSON 配置文件，或两者同时使用。

优先级：

```text
环境变量 > 配置文件 > 默认值
```

复制示例配置：

```sh
cp config.example.json config.json
```

示例 `config.json`：

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

环境变量：

```sh
PORT=8787
CONFIG_PATH=./config.json
PROXY_API_KEY=sk-proxy-change-me
UPSTREAM_BASE_URL=http://127.0.0.1:3000
UPSTREAM_API_KEY=sk-upstream-change-me
```

兼容 New API 命名的旧变量：

```sh
NEW_API_BASE_URL=http://127.0.0.1:3000
NEW_API_KEY=sk-newapi-change-me
```

`PROXY_API_KEY` 是可选的：

- 不设置：不校验客户端，所有请求都可使用代理
- 设置：客户端必须发送 `Authorization: Bearer <key>` 或 `x-api-key: <key>`

代理请求上游时始终使用 `UPSTREAM_API_KEY`。客户端不需要也不应该知道真实上游 key。

## Node 运行

```sh
npm start
```

只用环境变量：

```sh
UPSTREAM_BASE_URL=http://127.0.0.1:3000 \
UPSTREAM_API_KEY=sk-upstream-change-me \
PROXY_API_KEY=sk-proxy-change-me \
npm start
```

使用配置文件：

```sh
CONFIG_PATH=./config.json npm start
```

## Docker 运行

构建镜像：

```sh
docker build -t llm-protocol-bridge .
```

挂载配置文件运行：

```sh
docker run -d \
  --name llm-protocol-bridge \
  -p 8787:8787 \
  -e CONFIG_PATH=/app/config.json \
  -v "$PWD/config.json:/app/config.json:ro" \
  llm-protocol-bridge
```

也可以使用示例 compose：

```sh
cp config.example.json config.json
docker compose -f docker-compose.example.yml up -d --build
```

## 客户端配置

客户端应该指向本代理，而不是直接指向上游网关。

Anthropic / Claude 类客户端：

```text
Endpoint: http://server:8787
API key:  sk-proxy-change-me
```

有些客户端要求完整路径：

```text
http://server:8787/v1/messages
```

OpenAI Chat Completions 客户端：

```text
Base URL: http://server:8787/v1
API key:  sk-proxy-change-me
Path:     /chat/completions
```

OpenAI Responses 客户端：

```text
Base URL: http://server:8787/v1
API key:  sk-proxy-change-me
Path:     /responses
```

模型名使用上游网关暴露的模型名，例如：

```text
claude-sonnet-4
gpt-4.1
gemini-2.5-pro
```

本代理不决定模型由哪个供应商提供。这个由上游决定。

## 配合 New API 使用

当你需要供应商/渠道路由，再叠加本项目的协议转换时，New API 是推荐上游之一。

如果代理和 New API 跑在同一台宿主机：

```json
{
  "upstream": {
    "baseUrl": "http://127.0.0.1:3000",
    "apiKey": "your-new-api-token"
  }
}
```

如果代理和 New API 跑在同一个 Docker Compose 网络：

```json
{
  "upstream": {
    "baseUrl": "http://new-api:3000",
    "apiKey": "your-new-api-token"
  }
}
```

## 测试

Mock 集成测试：

```sh
npm test
```

真实上游 smoke test，缺少变量时会自动跳过：

```sh
UPSTREAM_BASE_URL=http://127.0.0.1:3000 \
UPSTREAM_API_KEY=sk-upstream-change-me \
UPSTREAM_TEST_MODEL=your-model \
npm run smoke:upstream
```

New API 旧变量也可用：

```sh
NEW_API_BASE_URL=http://127.0.0.1:3000 \
NEW_API_KEY=sk-newapi-change-me \
NEW_API_TEST_MODEL=your-model \
npm run smoke:upstream
```

## 安全说明

- 不要提交 `config.json`，它已经被 git 忽略。
- 如果代理暴露在 localhost 或私有网络之外，请设置 `PROXY_API_KEY`。
- 如果客户端通过公网访问，请把代理放在 HTTPS 后面。
- 尽量把供应商 key 留在上游网关里。本代理只需要一个上游 token。

## 非目标

- 不做供应商/渠道管理后台。
- 不做模型路由配置。
- 不做计费或额度系统。
- 不引入数据库。

这些能力应该放在上游网关或供应商层。
