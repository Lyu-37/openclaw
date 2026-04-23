const CONTROL_MARKER_LINE = /(?:^|\n)\s*(HEARTBEAT_OK|NO_REPLY)\s*(?=\n|$)/gi;
const PROMPT_LEAK_PATTERNS = [
  /\b(?:he|she|they|user)\s+wants?\b/i,
  /\breal-leaning answer\b/i,
  /\bone concrete choice\b/i,
  /\banswer (?:the question|naturally)\b/i,
  /\blighter topics\b/i,
];

function hasCjk(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text);
}

function countLatinLetters(text: string): number {
  return (text.match(/[A-Za-z]/g) ?? []).length;
}

function countPromptLeakSignals(text: string): number {
  let count = 0;
  for (const pattern of PROMPT_LEAK_PATTERNS) {
    if (pattern.test(text)) {
      count += 1;
    }
  }
  if (/\b(?:give|answer|keep|make|write|sound|use|stay|reply|ask|shift|focus)\b/i.test(text)) {
    count += 1;
  }
  return count;
}

function looksLikePromptLeakPrefix(text: string): boolean {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized || hasCjk(normalized)) {
    return false;
  }
  const signalCount = countPromptLeakSignals(normalized);
  if (signalCount >= 2) {
    return true;
  }
  const sentenceCount = normalized
    .split(/[.!?]+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
  return signalCount >= 1 && sentenceCount >= 2 && countLatinLetters(normalized) >= 24;
}

export function sanitizeAssistantVisibleText(text: string | null | undefined): string {
  if (typeof text !== "string") {
    return "";
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const matches = Array.from(trimmed.matchAll(CONTROL_MARKER_LINE));
  const lastMatch = matches.at(-1);
  if (!lastMatch || typeof lastMatch.index !== "number") {
    return trimmed;
  }

  const prefix = trimmed.slice(0, lastMatch.index).trim();
  const suffix = trimmed.slice(lastMatch.index + lastMatch[0].length).trim();
  if (!suffix) {
    return trimmed;
  }
  if (!prefix) {
    return suffix;
  }
  if (looksLikePromptLeakPrefix(prefix)) {
    return suffix;
  }
  if (!hasCjk(prefix) && hasCjk(suffix) && countLatinLetters(prefix) >= 20) {
    return suffix;
  }
  return trimmed;
}
