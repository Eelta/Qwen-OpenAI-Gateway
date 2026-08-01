export interface AIMessage {
  role: "user" | "assistant" | "system";
  content: string | AIMessageContentPart[];
}

export type AIMessageContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; imageUrl: { url: string } };

export interface AIToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AIRequestParams {
  model: string;
  messages: AIMessage[];
  chatId?: string;
  parentId?: string;
  tools?: AIToolDefinition[];
  toolMode?: "auto" | "required" | "none";
  thinkingMode?: "auto" | "on" | "off";
  abortSignal?: AbortSignal;
}

export type AIStreamChunk =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | {
      type: "tool_call";
      callId: string;
      name: string;
      argumentsPart: string;
    }
  | { type: "usage"; promptTokens: number; completionTokens: number };

export class AuthExpiredError extends Error {
  constructor(public readonly providerId: string) {
    super(`Authentication expired for provider: ${providerId}`);
    this.name = "AuthExpiredError";
  }
}

export class RateLimitError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly retryAfterMs?: number,
  ) {
    super(`Rate limit exceeded for provider: ${providerId}`);
    this.name = "RateLimitError";
  }
}

export class ProviderError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

export class WafChallengeError extends Error {
  constructor(
    public readonly providerId: string,
    message: string,
  ) {
    super(message);
    this.name = "WafChallengeError";
  }
}
