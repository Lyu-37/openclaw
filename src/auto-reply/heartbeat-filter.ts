import { stripHeartbeatToken } from "./heartbeat.js";
import { stripSilentToken } from "./tokens.js";

const HEARTBEAT_TASK_PROMPT_PREFIX =
  "Run the following periodic tasks (only those due based on their intervals):";
const HEARTBEAT_TASK_PROMPT_ACK = "After completing all due tasks, reply HEARTBEAT_OK.";
const MEMORY_FLUSH_PROMPT_PREFIX = "Pre-compaction memory flush.";
const MEMORY_FLUSH_ACK = "NO_REPLY";

function resolveMessageText(content: unknown): { text: string; hasNonTextContent: boolean } {
  if (typeof content === "string") {
    return { text: content, hasNonTextContent: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasNonTextContent: content != null };
  }
  let hasNonTextContent = false;
  const text = content
    .filter((block): block is { type: "text"; text: string } => {
      if (typeof block !== "object" || block === null || !("type" in block)) {
        hasNonTextContent = true;
        return false;
      }
      if (block.type !== "text") {
        hasNonTextContent = true;
        return false;
      }
      if (typeof (block as { text?: unknown }).text !== "string") {
        hasNonTextContent = true;
        return false;
      }
      return true;
    })
    .map((block) => block.text)
    .join("");
  return { text, hasNonTextContent };
}

export function isHeartbeatUserMessage(
  message: { role: string; content?: unknown },
  heartbeatPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedHeartbeatPrompt = heartbeatPrompt?.trim();
  if (normalizedHeartbeatPrompt && trimmed.startsWith(normalizedHeartbeatPrompt)) {
    return true;
  }
  return (
    trimmed.startsWith(HEARTBEAT_TASK_PROMPT_PREFIX) && trimmed.includes(HEARTBEAT_TASK_PROMPT_ACK)
  );
}

export function isHeartbeatOkResponse(
  message: { role: string; content?: unknown },
  ackMaxChars?: number,
): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  const parsedAckChars =
    typeof ackMaxChars === "string" ? Number(ackMaxChars) : ackMaxChars;
  if (stripHeartbeatToken(text, { mode: "heartbeat", maxAckChars: ackMaxChars }).shouldSkip) {
    return true;
  }
  if (typeof parsedAckChars === "number" && Number.isFinite(parsedAckChars) && parsedAckChars <= 0) {
    return false;
  }
  return stripHeartbeatToken(text, { mode: "message", maxAckChars: ackMaxChars }).didStrip;
}

export function isMemoryFlushUserMessage(
  message: { role: string; content?: unknown },
  memoryFlushPrompt?: string,
): boolean {
  if (message.role !== "user") {
    return false;
  }
  const { text } = resolveMessageText(message.content);
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }
  const normalizedPrompt = memoryFlushPrompt?.trim();
  if (normalizedPrompt && trimmed.startsWith(normalizedPrompt)) {
    return true;
  }
  return trimmed.startsWith(MEMORY_FLUSH_PROMPT_PREFIX) && trimmed.includes(MEMORY_FLUSH_ACK);
}

export function isNoReplyAckResponse(message: { role: string; content?: unknown }): boolean {
  if (message.role !== "assistant") {
    return false;
  }
  const { text, hasNonTextContent } = resolveMessageText(message.content);
  if (hasNonTextContent) {
    return false;
  }
  const trimmed = text.trim();
  const normalized = trimmed.replace(/^[`*_~\s]+|[`*_~\s]+$/g, "");
  if (normalized === MEMORY_FLUSH_ACK) {
    return true;
  }
  return stripSilentToken(text, MEMORY_FLUSH_ACK) !== trimmed;
}

export function filterHeartbeatPairs<T extends { role: string; content?: unknown }>(
  messages: T[],
  ackMaxChars?: number,
  heartbeatPrompt?: string,
  memoryFlushPrompt?: string,
): T[] {
  if (messages.length < 2) {
    return messages;
  }

  const result: T[] = [];
  let i = 0;
  while (i < messages.length) {
    if (
      i + 1 < messages.length &&
      ((isHeartbeatUserMessage(messages[i], heartbeatPrompt) &&
        isHeartbeatOkResponse(messages[i + 1], ackMaxChars)) ||
        (isMemoryFlushUserMessage(messages[i], memoryFlushPrompt) &&
          isNoReplyAckResponse(messages[i + 1])))
    ) {
      i += 2;
      continue;
    }
    result.push(messages[i]);
    i++;
  }

  return result;
}
