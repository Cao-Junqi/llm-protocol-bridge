import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadConfig(env = process.env) {
  const file = readConfigFile(env.CONFIG_PATH);
  return {
    port: Number(env.PORT || file.port || 8787),
    baseUrl: (env.NEW_API_BASE_URL || file.newApi?.baseUrl || "").replace(/\/$/, ""),
    key: env.NEW_API_KEY || file.newApi?.apiKey || "",
    proxyApiKey: env.PROXY_API_KEY || file.proxy?.apiKey || "",
  };
}

function readConfigFile(path) {
  const configPath = path || "config.json";
  const absolutePath = resolve(configPath);
  if (!existsSync(absolutePath)) return {};
  return JSON.parse(readFileSync(absolutePath, "utf8"));
}
