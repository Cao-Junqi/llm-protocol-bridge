import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { createServer } from "../src/server.js";

test("anthropic text falls back to chat completions and converts response", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    if (req.url === "/v1/messages") return json(res, 404, {});
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(body.messages[0].role, "user");
    json(res, 200, {
      id: "chat-1",
      model: body.model,
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
    });
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/messages`, {
    model: "claude-test",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(res.status, 200);
  assert.equal(res.body.content[0].type, "text");
  assert.equal(res.body.content[0].text, "hello");
  await close(proxy, upstream);
});

test("optional proxy api key protects v1 endpoints", async () => {
  const upstream = await fixtureServer(async (_req, res) => {
    json(res, 200, { data: [] });
  });
  const proxy = await proxyServer(upstream.url, { proxyApiKey: "sk-proxy" });

  const unauthorized = await fetch(`${proxy.url}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const authorized = await fetch(`${proxy.url}/v1/models`, {
    headers: { authorization: "Bearer sk-proxy" },
  });
  assert.equal(authorized.status, 200);

  const anthropicStyle = await fetch(`${proxy.url}/v1/models`, {
    headers: { "x-api-key": "sk-proxy" },
  });
  assert.equal(anthropicStyle.status, 200);
  await close(proxy, upstream);
});

test("anthropic tool use maps to chat tool_calls", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    if (req.url === "/v1/messages") return json(res, 404, {});
    assert.equal(body.tools[0].function.name, "lookup");
    json(res, 200, {
      id: "chat-2",
      model: body.model,
      choices: [{
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{\"q\":\"x\"}" } }],
        },
        finish_reason: "tool_calls",
      }],
    });
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/messages`, {
    model: "claude-test",
    max_tokens: 32,
    tools: [{ name: "lookup", input_schema: { type: "object", properties: { q: { type: "string" } } } }],
    messages: [{ role: "user", content: "use tool" }],
  });

  assert.equal(res.body.stop_reason, "tool_use");
  assert.deepEqual(res.body.content[0], { type: "tool_use", id: "call_1", name: "lookup", input: { q: "x" } });
  await close(proxy, upstream);
});

test("chat tool message falls back to anthropic tool_result", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    if (req.url === "/v1/chat/completions") return json(res, 404, {});
    if (req.url === "/v1/responses") return json(res, 404, {});
    assert.equal(req.url, "/v1/messages");
    assert.equal(body.messages[0].content[0].type, "tool_result");
    json(res, 200, {
      id: "msg-1",
      model: body.model,
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/chat/completions`, {
    model: "gpt-test",
    messages: [{ role: "tool", tool_call_id: "call_1", content: "result" }],
  });

  assert.equal(res.body.choices[0].message.content, "done");
  await close(proxy, upstream);
});

test("responses passthrough normalizes messages to input", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    assert.equal(req.url, "/v1/responses");
    assert.ok(body.input);
    assert.equal(body.messages, undefined);
    json(res, 200, {
      id: "resp_1",
      object: "response",
      output: [{ type: "function_call", name: "lookup", arguments: "{\"q\":\"x\"}" }],
    });
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/responses`, {
    model: "gpt-test",
    messages: [{ role: "user", content: "hi" }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  });

  assert.equal(res.body.output[0].type, "function_call");
  await close(proxy, upstream);
});

test("streaming anthropic fallback emits anthropic sse", async () => {
  const upstream = await fixtureServer(async (req, res) => {
    if (req.url === "/v1/messages") return json(res, 404, {});
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end('data: {"id":"x","model":"m","choices":[{"delta":{"role":"assistant"},"index":0}]}\n\ndata: {"choices":[{"delta":{"content":"hi"},"index":0}]}\n\ndata: [DONE]\n\n');
  });
  const proxy = await proxyServer(upstream.url);

  const res = await fetch(`${proxy.url}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "m", max_tokens: 32, stream: true, messages: [{ role: "user", content: "hi" }] }),
  });
  const text = await res.text();

  assert.match(text, /event: message_start/);
  assert.match(text, /text_delta/);
  await close(proxy, upstream);
});

test("responses fallback to anthropic converts function call output", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    if (req.url === "/v1/responses") return json(res, 404, {});
    if (req.url === "/v1/chat/completions") return json(res, 404, {});
    assert.equal(req.url, "/v1/messages");
    assert.equal(body.messages[0].content[0].type, "tool_result");
    json(res, 200, {
      id: "msg-2",
      model: body.model,
      content: [{ type: "tool_use", id: "call_2", name: "lookup", input: { q: "next" } }],
      stop_reason: "tool_use",
    });
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/responses`, {
    model: "m",
    input: [{ type: "function_call_output", call_id: "call_1", output: "ok" }],
    tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
  });

  assert.equal(res.body.output[0].type, "function_call");
  assert.equal(res.body.output[0].name, "lookup");
  await close(proxy, upstream);
});

test("anthropic image and thinking survive responses fallback", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    if (req.url === "/v1/messages") return json(res, 404, {});
    if (req.url === "/v1/chat/completions") return json(res, 404, {});
    assert.equal(req.url, "/v1/responses");
    assert.equal(body.input[0].content[0].type, "input_image");
    json(res, 200, {
      id: "resp-2",
      model: body.model,
      output: [
        { type: "reasoning", summary: [{ type: "summary_text", text: "thought" }] },
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
      ],
    });
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/messages`, {
    model: "m",
    max_tokens: 32,
    messages: [{
      role: "user",
      content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }],
    }],
  });

  assert.equal(res.body.content[0].type, "thinking");
  assert.equal(res.body.content[1].text, "done");
  await close(proxy, upstream);
});

test("responses computer call maps to anthropic tool use on chat fallback", async () => {
  const upstream = await fixtureServer(async (req, res, body) => {
    if (req.url === "/v1/messages") return json(res, 404, {});
    if (req.url === "/v1/chat/completions") return json(res, 404, {});
    if (req.url === "/v1/responses") {
      json(res, 200, {
        id: "resp-3",
        model: body.model,
        output: [{ type: "computer_call", call_id: "comp_1", action: { type: "screenshot" } }],
      });
    }
  });
  const proxy = await proxyServer(upstream.url);

  const res = await post(`${proxy.url}/v1/messages`, {
    model: "m",
    max_tokens: 32,
    messages: [{ role: "user", content: "screen" }],
  });

  assert.equal(res.body.content[0].type, "tool_use");
  assert.equal(res.body.content[0].name, "computer");
  await close(proxy, upstream);
});

async function fixtureServer(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    handler(req, res, body);
  });
  server.listen(0);
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function proxyServer(baseUrl, options = {}) {
  const server = createServer({ baseUrl, key: "test-key", ...options });
  server.listen(0);
  await once(server, "listening");
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function close(...servers) {
  await Promise.all(servers.map(({ server }) => new Promise((resolve) => server.close(resolve))));
}
