import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProxyServer } from "./server/server.js";

const envFilePath = resolve(dirname(fileURLToPath(import.meta.url)), ".env");
if (existsSync(envFilePath)) {
  if (typeof process.loadEnvFile !== "function") {
    throw new Error("Loading .env files requires Node.js 20.12 or newer.");
  }
  process.loadEnvFile(envFilePath);
}

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const server = createProxyServer({
  host,
  username: process.env.PROXY_USERNAME,
  password: process.env.PROXY_PASSWORD,
});

server.listen(port, host, () => {
  console.log(`AnglerProxy listening on ${host}:${port}`);
});