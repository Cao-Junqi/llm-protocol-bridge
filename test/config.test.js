import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";

test("config file loads and env overrides it", () => {
  const dir = mkdtempSync(join(tmpdir(), "newapi-bridge-"));
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({
    port: 1111,
    proxy: { apiKey: "file-proxy" },
    newApi: { baseUrl: "http://file:3000/", apiKey: "file-key" },
  }));

  const config = loadConfig({
    CONFIG_PATH: path,
    PORT: "2222",
    PROXY_API_KEY: "env-proxy",
    NEW_API_BASE_URL: "http://env:3000/",
    NEW_API_KEY: "env-key",
  });

  assert.deepEqual(config, {
    port: 2222,
    proxyApiKey: "env-proxy",
    baseUrl: "http://env:3000",
    key: "env-key",
  });
});
