import http from "node:http";
import { Readable, Transform } from "node:stream";
import { loadConfig } from "./config.js";
import {
  anthropicSseToChatSse,
  anthropicToChat,
  anthropicToResponses,
  anthropicToResponsesResponse,
  anthropicToChatResponse,
  chatSseToAnthropicSse,
  chatToAnthropic,
  chatToAnthropicResponse,
  chatToResponses,
  chatToResponsesResponse,
  normalizeResponseInput,
  responsesSseToAnthropicSse,
  responsesSseToChatSse,
  responsesToAnthropic,
  responsesToAnthropicResponse,
  responsesToChat,
  responsesToChatResponse,
  shouldFallback,
} from "./convert.js";

const runtimeConfig = loadConfig();

export function createServer(options = {}) {
  const config = {
    ...runtimeConfig,
    ...options,
    baseUrl: (options.baseUrl || runtimeConfig.baseUrl || "").replace(/\/$/, ""),
    key: options.key || runtimeConfig.key,
    proxyApiKey: options.proxyApiKey ?? runtimeConfig.proxyApiKey,
    fetch: options.fetch || fetch,
  };

  return http.createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
      if (!authorized(req, config.proxyApiKey)) return json(res, 401, { error: { message: "Unauthorized" } });
      if (req.method === "GET" && req.url === "/v1/models") return proxy(req, res, config, "/v1/models");
      if (req.method === "POST" && req.url === "/v1/messages") return handleAnthropic(req, res, config);
      if (req.method === "POST" && req.url === "/v1/chat/completions") return handleChat(req, res, config);
      if (req.method === "POST" && req.url === "/v1/responses") return handleResponses(req, res, config);
      return json(res, 404, { error: { message: "Not found" } });
    } catch (error) {
      return json(res, 500, { error: { message: error.message } });
    }
  });
}

async function handleAnthropic(req, res, config) {
  const body = await readJson(req);
  const upstream = await upstreamFetch(config, "/v1/messages", body, req.headers);

  if (!(await needsFallback(upstream))) {
    return sendUpstream(res, upstream);
  }

  const chatBody = anthropicToChat(body);
  const fallback = await upstreamFetch(config, "/v1/chat/completions", chatBody, req.headers);
  if (!(await needsFallback(fallback))) {
    if (body.stream) return sendConvertedStream(res, fallback, (chunk) => chatSseToAnthropicSse(chunk, body.model), "text/event-stream");
    const chat = await fallback.json();
    return json(res, fallback.status, chatToAnthropicResponse(chat, body.model));
  }

  const responseBody = anthropicToResponses(body);
  const responses = await upstreamFetch(config, "/v1/responses", responseBody, req.headers);
  if (body.stream) return sendConvertedStream(res, responses, (chunk) => responsesSseToAnthropicSse(chunk, body.model), "text/event-stream");
  const response = await responses.json();
  return json(res, responses.status, responsesToAnthropicResponse(response, body.model));
}

async function handleChat(req, res, config) {
  const body = await readJson(req);
  const upstream = await upstreamFetch(config, "/v1/chat/completions", body, req.headers);

  if (!(await needsFallback(upstream))) return sendUpstream(res, upstream);

  const responsesBody = chatToResponses(body);
  const responses = await upstreamFetch(config, "/v1/responses", responsesBody, req.headers);
  if (!(await needsFallback(responses))) {
    if (body.stream) return sendConvertedStream(res, responses, responsesSseToChatSse, "text/event-stream");
    const response = await responses.json();
    return json(res, responses.status, responsesToChatResponse(response, body.model));
  }

  const fallback = await upstreamFetch(config, "/v1/messages", chatToAnthropic(body), req.headers);
  if (body.stream) return sendConvertedStream(res, fallback, anthropicSseToChatSse, "text/event-stream");
  const anthropic = await fallback.json();
  return json(res, fallback.status, anthropicToChatResponse(anthropic, body.model));
}

async function handleResponses(req, res, config) {
  const body = normalizeResponseInput(await readJson(req));
  const upstream = await upstreamFetch(config, "/v1/responses", body, req.headers);
  if (!(await needsFallback(upstream))) return sendUpstream(res, upstream);

  const chatBody = responsesToChat(body);
  const chat = await upstreamFetch(config, "/v1/chat/completions", chatBody, req.headers);
  if (!(await needsFallback(chat))) {
    if (body.stream) return sendConvertedStream(res, chat, (chunk) => chatToResponsesSse(chunk, body.model), "text/event-stream");
    const chatJson = await chat.json();
    return json(res, chat.status, chatToResponsesResponse(chatJson, body.model));
  }

  const anthropicBody = responsesToAnthropic(body);
  const anthropic = await upstreamFetch(config, "/v1/messages", anthropicBody, req.headers);
  if (body.stream) return sendConvertedStream(res, anthropic, (chunk) => anthropicToResponsesSse(chunk, body.model), "text/event-stream");
  const anthropicJson = await anthropic.json();
  return json(res, anthropic.status, anthropicToResponsesResponse(anthropicJson, body.model));
}

async function proxy(req, res, config, path) {
  const upstream = await config.fetch(`${config.baseUrl}${path}`, {
    method: req.method,
    headers: upstreamHeaders(req.headers, config.key),
  });
  return sendUpstream(res, upstream);
}

async function upstreamFetch(config, path, body, headers) {
  if (!config.baseUrl || !config.key) {
    return new Response(JSON.stringify({ error: { message: "UPSTREAM_BASE_URL and UPSTREAM_API_KEY are required" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return config.fetch(`${config.baseUrl}${path}`, {
    method: "POST",
    headers: upstreamHeaders(headers, config.key),
    body: JSON.stringify(body),
  });
}

function upstreamHeaders(headers, key) {
  const out = {
    "content-type": "application/json",
    authorization: `Bearer ${key}`,
  };
  if (headers["anthropic-version"]) out["anthropic-version"] = headers["anthropic-version"];
  if (headers["anthropic-beta"]) out["anthropic-beta"] = headers["anthropic-beta"];
  return out;
}

function authorized(req, proxyApiKey) {
  if (!proxyApiKey) return true;
  const authorization = req.headers.authorization || "";
  const bearer = authorization.toLowerCase().startsWith("bearer ") ? authorization.slice(7) : "";
  const headerKey = req.headers["x-api-key"] || req.headers["api-key"];
  return bearer === proxyApiKey || headerKey === proxyApiKey;
}

async function sendUpstream(res, upstream) {
  res.writeHead(upstream.status, headersObject(upstream.headers));
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
}

async function needsFallback(response) {
  if (![400, 404, 422].includes(response.status)) return false;
  const clone = response.clone();
  const contentType = clone.headers.get("content-type") || "";
  const body = contentType.includes("json") ? await clone.json().catch(() => null) : await clone.text().catch(() => "");
  return shouldFallback(response.status, body);
}

function sendConvertedStream(res, upstream, convert, contentType) {
  res.writeHead(upstream.status, { "content-type": contentType, "cache-control": "no-cache" });
  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body)
    .pipe(new Transform({
      transform(chunk, _encoding, callback) {
        callback(null, convert(chunk.toString()));
      },
    }))
    .pipe(res);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString() || "{}");
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function headersObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    if (!["connection", "content-encoding", "transfer-encoding"].includes(key)) out[key] = value;
  });
  return out;
}

function chatToResponsesSse(chunk) {
  return chunk
    .split("\n\n")
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event) => event.replace(/^data: /, ""))
    .filter((data) => data && data !== "[DONE]")
    .map((data) => {
      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta || {};
      if (delta.content) return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: delta.content })}\n\n`;
      if (delta.role) return `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: parsed.id, model: parsed.model } })}\n\n`;
      return "";
    })
    .join("");
}

function anthropicToResponsesSse(chunk) {
  return chunk
    .split("\n\n")
    .map((event) => event.trim())
    .filter(Boolean)
    .map((event) => event.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter(Boolean)
    .map((data) => {
      const parsed = JSON.parse(data);
      if (parsed.type === "message_start") return `event: response.created\ndata: ${JSON.stringify({ type: "response.created", response: { id: parsed.message?.id, model: parsed.message?.model } })}\n\n`;
      if (parsed.type === "content_block_delta" && parsed.delta?.text) return `event: response.output_text.delta\ndata: ${JSON.stringify({ type: "response.output_text.delta", delta: parsed.delta.text })}\n\n`;
      if (parsed.type === "message_stop") return `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed" })}\n\n`;
      return "";
    })
    .join("");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createServer().listen(runtimeConfig.port, () => {
    console.log(`llm-protocol-bridge listening on :${runtimeConfig.port}`);
  });
}
