import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { createLogger, errToString } from "../logger";
import { QwenApiClient } from "../providers/qwen/QwenApiClient";
import { QwenAuthManager } from "../providers/qwen/QwenAuthManager";
import { QwenBrowserBridge } from "../providers/qwen/QwenBrowserBridge";
import { AuthExpiredError, type AIStreamChunk } from "../providers/types";
import { FileSecretStorage } from "./FileSecretStorage";
import {
  type ChatCompletionRequest,
  GATEWAY_MODEL_ID,
  RequestValidationError,
  toAIRequest,
} from "./openai";

const glog = createLogger("qwen-gateway");
const MAX_BODY_BYTES = 10 * 1024 * 1024;

export interface GatewayOptions {
  host: string;
  port: number;
  apiKey?: string;
  browserMode: "auto" | "headed" | "headless";
  model: string;
}

export class QwenGateway {
  private readonly secrets = new FileSecretStorage();
  private readonly auth = new QwenAuthManager();
  private readonly browser: QwenBrowserBridge;
  private readonly client: QwenApiClient;

  constructor(private readonly options: GatewayOptions) {
    this.browser = new QwenBrowserBridge(
      (message) => glog.warn(message),
      options.browserMode,
    );
    this.client = new QwenApiClient(this.browser);
  }

  async listen(): Promise<void> {
    const token = await this.auth.getToken(this.secrets);
    if (!token) {
      throw new Error("Qwen is not signed in. Run `npm run login` first.");
    }

    const server = createServer((req, res) => {
      void this.route(req, res).catch((err) => this.sendError(res, err));
    });
    server.requestTimeout = 0;
    server.headersTimeout = 30000;

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.options.port, this.options.host, () => resolve());
    });
    glog.info(
      `OpenAI endpoint listening at http://${this.options.host}:${this.options.port}/v1`,
    );

    const shutdown = async () => {
      glog.info("shutting down");
      server.close();
      await this.browser.close();
    };
    process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
    process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
  }

  private async route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    this.setCommonHeaders(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204).end();
      return;
    }
    const url = new URL(req.url || "/", "http://gateway.local");
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/health")) {
      this.json(res, 200, {
        status: "ok",
        model: GATEWAY_MODEL_ID,
        upstream_model: this.options.model,
      });
      return;
    }
    if (!this.authorized(req)) {
      this.json(res, 401, { error: { message: "Invalid API key", type: "authentication_error" } });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/models") {
      this.json(res, 200, {
        object: "list",
        data: [{
          id: GATEWAY_MODEL_ID,
          object: "model",
          created: 0,
          owned_by: "qwen-web",
          upstream_model: this.options.model,
        }],
      });
      return;
    }
    if (req.method !== "POST" || url.pathname !== "/v1/chat/completions") {
      this.json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      return;
    }

    const body = JSON.parse(await readBody(req)) as ChatCompletionRequest;
    const abort = new AbortController();
    res.once("close", () => {
      if (!res.writableEnded) abort.abort();
    });
    const params = toAIRequest(body, abort.signal, this.options.model);
    const token = await this.auth.getToken(this.secrets);
    if (!token) throw new AuthExpiredError("qwen-web");
    const stream = this.client.sendMessageStream(params, token);
    if (body.stream) await this.streamResponse(res, stream);
    else await this.bufferedResponse(res, stream);
  }

  private async streamResponse(
    res: ServerResponse,
    stream: AsyncIterable<AIStreamChunk>,
  ): Promise<void> {
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    let nextToolIndex = 0;
    const toolIndexes = new Map<string, number>();
    let hadTools = false;
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (delta: Record<string, unknown>, finishReason: string | null = null) => {
      res.write(`data: ${JSON.stringify({
        id, object: "chat.completion.chunk", created, model: GATEWAY_MODEL_ID,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      })}\n\n`);
    };
    send({ role: "assistant" });
    try {
      for await (const chunk of stream) {
        if (chunk.type === "text") send({ content: chunk.content });
        else if (chunk.type === "thinking") send({ reasoning_content: chunk.content });
        else if (chunk.type === "tool_call") {
          hadTools = true;
          let index = toolIndexes.get(chunk.callId);
          if (index === undefined) {
            index = nextToolIndex++;
            toolIndexes.set(chunk.callId, index);
          }
          send({ tool_calls: [{
            index, id: chunk.callId, type: "function",
            function: { name: chunk.name, arguments: chunk.argumentsPart },
          }] });
        } else if (chunk.type === "usage") {
          res.write(`data: ${JSON.stringify({
            id, object: "chat.completion.chunk", created, model: GATEWAY_MODEL_ID,
            choices: [],
            usage: {
              prompt_tokens: chunk.promptTokens,
              completion_tokens: chunk.completionTokens,
              total_tokens: chunk.promptTokens + chunk.completionTokens,
            },
          })}\n\n`);
        }
      }
      send({}, hadTools ? "tool_calls" : "stop");
      res.end("data: [DONE]\n\n");
    } catch (err) {
      glog.error(`stream failed: ${errToString(err)}`);
      res.write(`data: ${JSON.stringify({ error: openAIError(err) })}\n\n`);
      res.end("data: [DONE]\n\n");
    }
  }

  private async bufferedResponse(
    res: ServerResponse,
    stream: AsyncIterable<AIStreamChunk>,
  ): Promise<void> {
    let content = "";
    let reasoning = "";
    let usage: Record<string, number> | undefined;
    const toolCalls = new Map<
      string,
      { id: string; type: "function"; function: { name: string; arguments: string } }
    >();
    for await (const chunk of stream) {
      if (chunk.type === "text") content += chunk.content;
      else if (chunk.type === "thinking") reasoning += chunk.content;
      else if (chunk.type === "tool_call") {
        const existing = toolCalls.get(chunk.callId);
        if (existing) {
          existing.function.arguments += chunk.argumentsPart;
          if (!existing.function.name) existing.function.name = chunk.name;
        } else {
          toolCalls.set(chunk.callId, {
            id: chunk.callId,
            type: "function",
            function: { name: chunk.name, arguments: chunk.argumentsPart },
          });
        }
      } else if (chunk.type === "usage") {
        usage = {
          prompt_tokens: chunk.promptTokens,
          completion_tokens: chunk.completionTokens,
          total_tokens: chunk.promptTokens + chunk.completionTokens,
        };
      }
    }
    const message: Record<string, unknown> = { role: "assistant", content };
    if (reasoning) message.reasoning_content = reasoning;
    const calls = [...toolCalls.values()];
    if (calls.length) message.tool_calls = calls;
    this.json(res, 200, {
      id: `chatcmpl-${crypto.randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: GATEWAY_MODEL_ID,
      choices: [{ index: 0, message, finish_reason: calls.length ? "tool_calls" : "stop" }],
      ...(usage ? { usage } : {}),
    });
  }

  private authorized(req: IncomingMessage): boolean {
    if (!this.options.apiKey) return true;
    const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, "");
    return bearer === this.options.apiKey || req.headers["x-api-key"] === this.options.apiKey;
  }

  private setCommonHeaders(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-API-Key");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }

  private json(res: ServerResponse, status: number, value: unknown): void {
    if (res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(value));
  }

  private sendError(res: ServerResponse, err: unknown): void {
    glog.error(errToString(err));
    this.setCommonHeaders(res);
    const status = err instanceof AuthExpiredError
      ? 401
      : err instanceof RequestValidationError || err instanceof SyntaxError
        ? 400
        : 500;
    this.json(res, status, {
      error: openAIError(err),
    });
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new RequestValidationError("Request body is too large");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function openAIError(err: unknown): Record<string, unknown> {
  const type = err instanceof AuthExpiredError
    ? "authentication_error"
    : err instanceof RequestValidationError || err instanceof SyntaxError
      ? "invalid_request_error"
      : "server_error";
  return {
    message: errToString(err),
    type,
    code: err instanceof AuthExpiredError ? "qwen_auth_expired" : undefined,
  };
}
