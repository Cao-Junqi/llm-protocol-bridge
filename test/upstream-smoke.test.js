import { once } from "node:events";
import { createServer } from "../src/server.js";

const baseUrl = (process.env.UPSTREAM_BASE_URL || process.env.NEW_API_BASE_URL)?.replace(/\/$/, "");
const key = process.env.UPSTREAM_API_KEY || process.env.NEW_API_KEY;
const model = process.env.UPSTREAM_TEST_MODEL || process.env.NEW_API_TEST_MODEL;

if (!baseUrl || !key || !model) {
  console.log("skipped: set UPSTREAM_BASE_URL, UPSTREAM_API_KEY, UPSTREAM_TEST_MODEL");
  process.exit(0);
}

const server = createServer({ baseUrl, key });
server.listen(0);
await once(server, "listening");
const proxyUrl = `http://127.0.0.1:${server.address().port}`;

try {
  await call("/v1/messages", {
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "Reply with OK." }],
  });

  await call("/v1/chat/completions", {
    model,
    messages: [{ role: "user", content: "Reply with OK." }],
  });

  await call("/v1/responses", {
    model,
    input: "Reply with OK.",
  });

  console.log("ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
}

async function call(path, body) {
  const res = await fetch(`${proxyUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`${path} failed ${res.status}: ${await res.text()}`);
  }
}
