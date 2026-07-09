import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadConfig(env = process.env) {
  const file = readConfigFile(env.CONFIG_PATH);
  const upstream = file.upstream || file.newApi || {};
  return {
    port: Number(env.PORT || file.port || 8787),
    baseUrl: (env.UPSTREAM_BASE_URL || env.NEW_API_BASE_URL || upstream.baseUrl || "").replace(/\/$/, ""),
    key: env.UPSTREAM_API_KEY || env.NEW_API_KEY || upstream.apiKey || "",
    proxyApiKey: env.PROXY_API_KEY || file.proxy?.apiKey || "",
  };
}

function readConfigFile(path) {
  const configPath = path || "config.json";
  const absolutePath = resolve(configPath);
  if (!existsSync(absolutePath)) return {};
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}
