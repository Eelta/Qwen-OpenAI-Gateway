import type { AIMessage } from "../types";

export const LANGUAGE_GUARD =
  "Always answer in the same language as the latest user message. Never switch language unless the user explicitly asks.";

export function contentToString(content: AIMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : "[image]"))
    .join("\n");
}

export function buildRolePrompt(
  messages: AIMessage[],
  options: { maxChars?: number } = {},
): string {
  const turns = messages.flatMap((message) => {
    if (message.role === "system") return [];
    const content = contentToString(message.content).trim();
    return content
      ? [`${message.role === "assistant" ? "Assistant" : "User"}: ${content}`]
      : [];
  });
  const kept = options.maxChars ? keepNewest(turns, options.maxChars) : turns;
  return [...kept, "Assistant:"].join("\n\n");
}

function keepNewest(turns: string[], maxChars: number): string[] {
  const kept: string[] = [];
  let total = "\n\nAssistant:".length;
  for (let index = turns.length - 1; index >= 0; index--) {
    const addition = turns[index].length + (kept.length ? 2 : 0);
    if (total + addition > maxChars) {
      if (!kept.length) kept.unshift(turns[index].slice(-(maxChars - total)));
      break;
    }
    kept.unshift(turns[index]);
    total += addition;
  }
  return kept;
}
