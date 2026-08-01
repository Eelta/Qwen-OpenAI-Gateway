import { createLogger } from "../logger";
import { QwenAuthManager } from "../providers/qwen/QwenAuthManager";
import { FileSecretStorage, gatewayDataDir } from "./FileSecretStorage";
import { QwenGateway } from "./QwenGateway";

const log = createLogger("gateway-cli");

async function main(): Promise<void> {
  const command = process.argv[2] || "serve";
  const secrets = new FileSecretStorage();
  const auth = new QwenAuthManager();

  if (command === "login") {
    await auth.login(secrets);
    log.info(`Qwen sign-in succeeded; data directory: ${gatewayDataDir()}`);
    return;
  }
  if (command === "logout") {
    await auth.logout(secrets);
    log.info("Qwen credentials and browser profile removed");
    return;
  }
  if (command === "status") {
    const signedIn = await auth.isAuthenticated(secrets);
    log.info(signedIn ? "Qwen: signed in" : "Qwen: signed out");
    // A non-zero result lets launch scripts trigger the interactive login only
    // when it is actually needed.
    if (!signedIn) process.exitCode = 2;
    return;
  }
  if (command !== "serve") {
    throw new Error("Usage: qwen-gateway [serve|login|logout|status]");
  }

  const rawPort = Number(process.env.QWEN_GATEWAY_PORT || 8765);
  if (!Number.isInteger(rawPort) || rawPort < 1 || rawPort > 65535) {
    throw new Error("QWEN_GATEWAY_PORT must be a valid TCP port");
  }
  const rawMode = process.env.QWEN_GATEWAY_BROWSER_MODE || "auto";
  const browserMode = rawMode === "headed" || rawMode === "headless" ? rawMode : "auto";
  const model = (process.env.QWEN_GATEWAY_MODEL || "qwen3.8-max-preview").trim();
  if (!/^[a-zA-Z0-9._/-]+$/.test(model)) {
    throw new Error("QWEN_GATEWAY_MODEL contains invalid characters");
  }
  await new QwenGateway({
    host: process.env.QWEN_GATEWAY_HOST || "127.0.0.1",
    port: rawPort,
    apiKey: process.env.QWEN_GATEWAY_API_KEY || undefined,
    browserMode,
    model,
  }).listen();
}

void main().catch((err) => {
  log.error(err instanceof Error ? err.stack || err.message : String(err));
  process.exitCode = 1;
});
