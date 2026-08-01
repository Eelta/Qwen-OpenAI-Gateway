const ALIASES: Record<string, string> = {
  "qwen3.8": "qwen3.8-max-preview",
  "qwen3.8-max": "qwen3.8-max-preview",
  "qwen3.7": "qwen3.7-max",
};

const THINKING_MODELS = new Set([
  "qwen3.8-max-preview",
  "qwen3.7-plus",
  "qwen3.7-max",
]);

export function resolveModelId(id: string): string {
  return ALIASES[id.toLowerCase()] ?? id;
}

export function thinkingEnabled(
  model: string,
  hasTools: boolean,
  mode: "auto" | "on" | "off" = "auto",
): boolean {
  if (hasTools || mode === "off") return false;
  return mode === "on" || THINKING_MODELS.has(model.toLowerCase());
}
