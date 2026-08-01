import type {
  AIMessage,
  AIMessageContentPart,
  AIRequestParams,
  AIToolDefinition,
} from "../providers/types";

/** Stable AstrBot-facing id; the selected upstream model may change per start. */
export const GATEWAY_MODEL_ID = "qwen-selected";

interface OpenAIContentPart {
  type?: string;
  text?: string;
  image_url?: { url?: string } | string;
}

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIMessage {
  role?: string;
  content?: string | OpenAIContentPart[] | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: OpenAIToolCall[];
}

interface OpenAITool {
  type?: string;
  function?: {
    name?: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

export interface ChatCompletionRequest {
  model?: string;
  messages?: OpenAIMessage[];
  tools?: OpenAITool[];
  tool_choice?: unknown;
  stream?: boolean;
  enable_thinking?: boolean;
  thinking?: boolean;
}

export function toAIRequest(
  body: ChatCompletionRequest,
  abortSignal: AbortSignal,
  selectedModel: string,
): AIRequestParams {
  if (
    body.model &&
    body.model !== GATEWAY_MODEL_ID &&
    body.model !== selectedModel
  ) {
    throw new RequestValidationError(
      `Use ${GATEWAY_MODEL_ID}; this gateway instance routes it to ${selectedModel}`,
    );
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw new RequestValidationError("messages must be a non-empty array");
  }

  const tools = toTools(body.tools);
  return {
    model: selectedModel,
    messages: body.messages.flatMap(toMessage),
    tools: tools.length ? tools : undefined,
    toolMode: toolMode(body.tool_choice, tools.length > 0),
    thinkingMode:
      body.enable_thinking === false || body.thinking === false ? "off" : "auto",
    abortSignal,
  };
}

function toMessage(message: OpenAIMessage): AIMessage[] {
  const role = String(message.role || "").toLowerCase();
  if (role === "tool") {
    return [{
      role: "user",
      content: `[Tool result id=${message.tool_call_id || "unknown"}${message.name ? ` name=${message.name}` : ""}]\n${contentText(message.content) || "{}"}`,
    }];
  }

  const mappedRole: AIMessage["role"] =
    role === "system" ? "system" : role === "assistant" ? "assistant" : "user";
  const content = contentParts(message.content);
  const callHistory = (message.tool_calls ?? []).map((call) =>
    "```tool_call\n" +
      JSON.stringify({
        name: call.function?.name || "unknown",
        arguments: parseArguments(call.function?.arguments),
      }) +
      "\n```",
  );

  if (callHistory.length === 0) return [{ role: mappedRole, content }];
  const prefix = typeof content === "string" ? content : contentText(message.content);
  return [{
    role: mappedRole,
    content: [prefix, ...callHistory].filter(Boolean).join("\n\n"),
  }];
}

function contentParts(
  content: OpenAIMessage["content"],
): string | AIMessageContentPart[] {
  if (typeof content === "string" || content == null) return content || "";
  const result: AIMessageContentPart[] = [];
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") {
      result.push({ type: "text", text: part.text });
    } else if (part?.type === "image_url") {
      const url =
        typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
      if (url) result.push({ type: "image_url", imageUrl: { url } });
    }
  }
  return result.some((part) => part.type === "image_url")
    ? result
    : result.map((part) => part.type === "text" ? part.text : "").join("");
}

function contentText(content: OpenAIMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => part?.type === "text" ? part.text || "" : "[image]")
    .join("\n");
}

function toTools(tools: OpenAITool[] | undefined): AIToolDefinition[] {
  if (!Array.isArray(tools)) return [];
  return tools.flatMap((tool) => {
    const fn = tool?.function;
    if (tool?.type !== "function" || !fn?.name) return [];
    return [{
      name: fn.name,
      description: fn.description || "",
      parameters: fn.parameters || { type: "object", properties: {} },
    }];
  });
}

function toolMode(
  choice: unknown,
  hasTools: boolean,
): "auto" | "required" | "none" {
  if (!hasTools || choice === "none") return "none";
  if (choice === "required" || (choice && typeof choice === "object")) {
    return "required";
  }
  return "auto";
}

function parseArguments(value: string | undefined): unknown {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class RequestValidationError extends Error {}
