import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Server as HttpServer } from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { CURRENT_SESSION_VERSION, SessionManager } from "@mariozechner/pi-coding-agent";
import {
  READ_SCOPE,
  WRITE_SCOPE,
  authorizeOperatorScopesForMethod,
} from "./method-scopes.js";
import {
  type RequestFrame,
  type ResponseFrame,
  ErrorCodes,
  errorShape,
} from "./protocol/index.js";
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "./protocol/client-info.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayClient, GatewayRequestContext } from "./server-methods/types.js";
import {
  GATEWAY_HTTP_REQUEST_CLAIMED,
  GATEWAY_HTTP_UPGRADE_CLAIMED,
} from "./server-http.js";
import {
  sendInvalidRequest,
  sendJson,
  sendMethodNotAllowed,
  setDefaultSecurityHeaders,
  readJsonBodyOrError,
} from "./http-common.js";
import {
  type AuthorizedGatewayHttpRequest,
  authorizeScopedGatewayHttpRequestOrReply,
  getBearerToken,
  resolveHttpBrowserOriginPolicy,
  resolveOpenAiCompatibleHttpOperatorScopes,
} from "./http-utils.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import { loadConfig } from "../config/config.js";
import { resolveSessionFilePath } from "../config/sessions.js";
import { loadSessionEntry } from "./session-utils.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveRequestClientIp } from "./net.js";
import { getSessionBindingService } from "../infra/outbound/session-binding-service.js";
import type { SessionBindingRecord } from "../infra/outbound/session-binding.types.js";

const MAX_UNIFIED_CHAT_BODY_BYTES = 512 * 1024;
const READY_EVENT = "ready";
const FORWARDED_GATEWAY_EVENTS = new Set([
  "chat",
  "chat.fallback",
  "session.message",
  "sessions.changed",
  "shutdown",
]);
const DEFAULT_FALLBACK_WAIT_MS = 180_000;
const MAX_FALLBACK_MODELS = 4;

type UnifiedChatApiBody = {
  session_id?: unknown;
  sessionId?: unknown;
  session_key?: unknown;
  sessionKey?: unknown;
  message?: unknown;
  thinking?: unknown;
  deliver?: unknown;
  originating_channel?: unknown;
  originatingChannel?: unknown;
  originating_to?: unknown;
  originatingTo?: unknown;
  originating_account_id?: unknown;
  originatingAccountId?: unknown;
  originating_thread_id?: unknown;
  originatingThreadId?: unknown;
  attachments?: unknown;
  timeout_ms?: unknown;
  timeoutMs?: unknown;
  idempotency_key?: unknown;
  idempotencyKey?: unknown;
  fallback_models?: unknown;
  fallbackModels?: unknown;
  fallback_wait_ms?: unknown;
  fallbackWaitMs?: unknown;
  relay_to_bindings?: unknown;
  relayToBindings?: unknown;
};

function getRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
}

function resolveRequestedSessionKey(params: {
  req?: IncomingMessage;
  body?: UnifiedChatApiBody | null;
}): string {
  const fromBody =
    normalizeOptionalString(
      params.body?.session_id ??
        params.body?.sessionId ??
        params.body?.session_key ??
        params.body?.sessionKey,
    ) ?? "";
  if (fromBody) {
    return fromBody;
  }
  if (params.req) {
    const url = getRequestUrl(params.req);
    const fromQuery =
      normalizeOptionalString(
        url.searchParams.get("session_id") ??
          url.searchParams.get("sessionId") ??
          url.searchParams.get("session_key") ??
          url.searchParams.get("sessionKey"),
      ) ?? "";
    if (fromQuery) {
      return fromQuery;
    }
  }
  return "main";
}

function resolveLimit(req: IncomingMessage): number | undefined {
  const raw = normalizeOptionalString(getRequestUrl(req).searchParams.get("limit"));
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function resolveMaxChars(req: IncomingMessage): number | undefined {
  const raw = normalizeOptionalString(
    getRequestUrl(req).searchParams.get("max_chars") ??
      getRequestUrl(req).searchParams.get("maxChars"),
  );
  if (!raw) {
    return undefined;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  return parsed;
}

function createUnifiedApiClient(params: {
  scopes: string[];
  clientIp?: string;
  connId?: string;
}): GatewayClient {
  return {
    ...(params.connId ? { connId: params.connId } : {}),
    ...(params.clientIp ? { clientIp: params.clientIp } : {}),
    connect: {
      minProtocol: 1,
      maxProtocol: 1,
      role: "operator",
      scopes: params.scopes,
      client: {
        id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
        displayName: "Unified Chat API",
        version: "1",
        platform: "http",
        mode: GATEWAY_CLIENT_MODES.BACKEND,
      },
    },
  };
}

async function invokeGatewayMethod(params: {
  method: string;
  payload: Record<string, unknown>;
  client: GatewayClient;
  context: GatewayRequestContext;
}): Promise<{
  ok: boolean;
  payload?: unknown;
  error?: ResponseFrame["error"];
  meta?: Record<string, unknown>;
}> {
  let response:
    | {
        ok: boolean;
        payload?: unknown;
        error?: ResponseFrame["error"];
        meta?: Record<string, unknown>;
      }
    | undefined;
  const req: RequestFrame = {
    type: "req",
    id: randomUUID(),
    method: params.method,
    params: params.payload,
  };
  await handleGatewayRequest({
    req,
    client: params.client,
    isWebchatConnect: () => false,
    respond: (ok, payload, error, meta) => {
      response = { ok, payload, error, meta };
    },
    context: params.context,
  });
  return (
    response ?? {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, `no response from ${params.method}`),
    }
  );
}

function statusFromGatewayError(error?: ResponseFrame["error"]): number {
  if (!error) {
    return 500;
  }
  switch (error.code) {
    case ErrorCodes.INVALID_REQUEST:
      return 400;
    case ErrorCodes.UNAVAILABLE:
      return 503;
    default:
      return 500;
  }
}

function buildUnifiedRequestAuth(authResult: GatewayAuthResult): AuthorizedGatewayHttpRequest {
  const authMethod = authResult.method;
  return {
    authMethod,
    trustDeclaredOperatorScopes: authMethod !== "token" && authMethod !== "password",
  };
}

function resolveUnifiedApiTokenFromUpgrade(req: IncomingMessage): string | undefined {
  const headerToken = getBearerToken(req);
  if (headerToken) {
    return headerToken;
  }
  return normalizeOptionalString(getRequestUrl(req).searchParams.get("token")) ?? undefined;
}

function normalizeText(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

function normalizeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function normalizeInteger(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

type AppendMessageArg = Parameters<SessionManager["appendMessage"]>[0];

function resolveTranscriptPath(params: {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
}): string | null {
  if (!params.storePath && !params.sessionFile) {
    return null;
  }
  try {
    const sessionsDir = params.storePath ? path.dirname(params.storePath) : undefined;
    return resolveSessionFilePath(
      params.sessionId,
      params.sessionFile ? { sessionFile: params.sessionFile } : undefined,
      sessionsDir ? { sessionsDir } : undefined,
    );
  } catch {
    return null;
  }
}

function ensureTranscriptFile(params: { transcriptPath: string; sessionId: string }) {
  if (fs.existsSync(params.transcriptPath)) {
    return { ok: true } as const;
  }
  try {
    fs.mkdirSync(path.dirname(params.transcriptPath), { recursive: true });
    fs.writeFileSync(
      params.transcriptPath,
      `${JSON.stringify({
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: params.sessionId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      })}\n`,
      {
        encoding: "utf-8",
        mode: 0o600,
      },
    );
    return { ok: true } as const;
  } catch (error) {
    return { ok: false, error: String(error) } as const;
  }
}

function transcriptHasIdempotencyKey(params: {
  transcriptPath: string;
  idempotencyKey?: string;
}): boolean {
  if (!params.idempotencyKey) {
    return false;
  }
  try {
    const raw = fs.readFileSync(params.transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as {
          message?: { idempotencyKey?: unknown };
        };
        if (parsed.message?.idempotencyKey === params.idempotencyKey) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

async function snapshotSessionModel(params: {
  sessionKey: string;
  client: GatewayClient;
  context: GatewayRequestContext;
}): Promise<string | null> {
  const res = await invokeGatewayMethod({
    method: "sessions.get",
    payload: { key: params.sessionKey },
    client: params.client,
    context: params.context,
  });
  if (!res.ok) {
    return null;
  }
  const payload = (res.payload ?? {}) as {
    session?: { model?: unknown; provider?: unknown };
  };
  const model = payload.session?.model;
  const provider = payload.session?.provider;
  if (typeof model !== "string" || !model.trim()) {
    return null;
  }
  const trimmedModel = model.trim();
  if (typeof provider === "string" && provider.trim() && !trimmedModel.includes("/")) {
    return `${provider.trim()}/${trimmedModel}`;
  }
  return trimmedModel;
}

function normalizeFallbackModels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = normalizeOptionalString(entry);
    if (trimmed && !out.includes(trimmed)) {
      out.push(trimmed);
      if (out.length >= MAX_FALLBACK_MODELS) {
        break;
      }
    }
  }
  return out;
}

type ChatRunOutcome =
  | { state: "final"; runId: string }
  | { state: "error"; runId: string; errorMessage?: string }
  | { state: "aborted"; runId: string }
  | { state: "timeout"; runId: string };

type ChatOutcomeObserver = {
  context: GatewayRequestContext;
  wait: (runId: string, timeoutMs: number) => Promise<ChatRunOutcome>;
  waitForAssistant: (timeoutMs: number) => Promise<string | null>;
  dispose: () => void;
};

function extractAssistantPayloadText(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const message = raw as { text?: unknown; content?: unknown };
  if (typeof message.text === "string" && message.text.trim()) {
    return message.text;
  }
  if (Array.isArray(message.content)) {
    const parts: string[] = [];
    for (const block of message.content) {
      if (block && typeof block === "object") {
        const b = block as { type?: unknown; text?: unknown };
        if (typeof b.text === "string") {
          parts.push(b.text);
        }
      } else if (typeof block === "string") {
        parts.push(block);
      }
    }
    const joined = parts.join("").trim();
    return joined || null;
  }
  if (typeof message.content === "string" && message.content.trim()) {
    return message.content;
  }
  return null;
}

function createChatOutcomeObserver(params: {
  context: GatewayRequestContext;
  sessionKey: string;
}): ChatOutcomeObserver {
  const outcomeByRun = new Map<string, ChatRunOutcome>();
  const waitersByRun = new Map<string, (outcome: ChatRunOutcome) => void>();
  let latestAssistantText: string | null = null;
  const assistantWaiters: Array<(text: string | null) => void> = [];
  const settle = (runId: string, outcome: ChatRunOutcome) => {
    if (outcomeByRun.has(runId)) {
      return;
    }
    outcomeByRun.set(runId, outcome);
    const waiter = waitersByRun.get(runId);
    if (waiter) {
      waitersByRun.delete(runId);
      waiter(outcome);
    }
  };
  const deliverAssistant = (text: string | null) => {
    if (!text) {
      return;
    }
    latestAssistantText = text;
    while (assistantWaiters.length > 0) {
      const waiter = assistantWaiters.shift();
      waiter?.(text);
    }
  };
  const originalBroadcast = params.context.broadcast;
  const wrappedBroadcast: typeof originalBroadcast = (event, payload, opts) => {
    originalBroadcast(event, payload, opts);
    if (event === "session.message") {
      const frame = payload as
        | { sessionKey?: unknown; message?: unknown; messageSeq?: unknown }
        | undefined;
      if (frame && frame.sessionKey === params.sessionKey) {
        const msg = frame.message as { role?: unknown } | undefined;
        if (msg?.role === "assistant") {
          const text = extractAssistantPayloadText(msg);
          if (text) {
            deliverAssistant(text);
          }
        }
      }
      return;
    }
    if (event !== "chat") {
      return;
    }
    const frame = payload as
      | {
          runId?: unknown;
          sessionKey?: unknown;
          state?: unknown;
          errorMessage?: unknown;
          message?: unknown;
        }
      | undefined;
    if (!frame || frame.sessionKey !== params.sessionKey) {
      return;
    }
    const runId = typeof frame.runId === "string" ? frame.runId : undefined;
    const state = typeof frame.state === "string" ? frame.state : undefined;
    if (!runId || !state) {
      return;
    }
    if (state === "final") {
      const text = extractAssistantPayloadText(frame.message);
      if (text) {
        deliverAssistant(text);
      }
      settle(runId, { state: "final", runId });
    } else if (state === "error") {
      settle(runId, {
        state: "error",
        runId,
        errorMessage: typeof frame.errorMessage === "string" ? frame.errorMessage : undefined,
      });
    } else if (state === "aborted") {
      settle(runId, { state: "aborted", runId });
    }
  };
  const wrappedContext: GatewayRequestContext = {
    ...params.context,
    broadcast: wrappedBroadcast,
  };
  return {
    context: wrappedContext,
    wait(runId, timeoutMs) {
      const existing = outcomeByRun.get(runId);
      if (existing) {
        return Promise.resolve(existing);
      }
      return new Promise<ChatRunOutcome>((resolve) => {
        const timer = setTimeout(() => {
          if (!outcomeByRun.has(runId)) {
            waitersByRun.delete(runId);
            resolve({ state: "timeout", runId });
          }
        }, timeoutMs);
        waitersByRun.set(runId, (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
        });
      });
    },
    waitForAssistant(timeoutMs) {
      if (latestAssistantText) {
        return Promise.resolve(latestAssistantText);
      }
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => {
          const index = assistantWaiters.indexOf(resolveWrapper);
          if (index >= 0) {
            assistantWaiters.splice(index, 1);
          }
          resolve(null);
        }, timeoutMs);
        const resolveWrapper = (text: string | null) => {
          clearTimeout(timer);
          resolve(text);
        };
        assistantWaiters.push(resolveWrapper);
      });
    },
    dispose() {
      waitersByRun.clear();
      outcomeByRun.clear();
      assistantWaiters.length = 0;
      latestAssistantText = null;
    },
  };
}

function buildBindingTarget(binding: SessionBindingRecord): {
  channel: string;
  accountId: string;
  to: string;
  threadId?: string;
} | null {
  const conversation = binding.conversation;
  if (!conversation || typeof conversation.channel !== "string") {
    return null;
  }
  const conversationId =
    typeof conversation.conversationId === "string" ? conversation.conversationId.trim() : "";
  if (!conversationId) {
    return null;
  }
  const parent =
    typeof conversation.parentConversationId === "string" &&
    conversation.parentConversationId.trim() &&
    conversation.parentConversationId.trim() !== conversationId
      ? conversation.parentConversationId.trim()
      : undefined;
  return {
    channel: conversation.channel,
    accountId: typeof conversation.accountId === "string" ? conversation.accountId : "",
    to: parent ?? conversationId,
    ...(parent ? { threadId: conversationId } : {}),
  };
}

async function relayAssistantToBoundChannels(params: {
  sessionKey: string;
  originatingChannel: string | undefined;
  originatingAccountId: string | undefined;
  assistantText: string;
  client: GatewayClient;
  context: GatewayRequestContext;
  log?: { warn: (message: string) => void };
}): Promise<void> {
  let bindings: SessionBindingRecord[];
  try {
    bindings = getSessionBindingService().listBySession(params.sessionKey);
  } catch (error) {
    params.log?.warn(`[unified chat relay] listBySession failed: ${String(error)}`);
    return;
  }
  for (const binding of bindings) {
    if (binding.status !== "active") {
      continue;
    }
    const target = buildBindingTarget(binding);
    if (!target) {
      continue;
    }
    if (
      params.originatingChannel &&
      target.channel === params.originatingChannel &&
      (!target.accountId ||
        !params.originatingAccountId ||
        target.accountId === params.originatingAccountId)
    ) {
      continue;
    }
    const idem = `unified-relay:${params.sessionKey}:${binding.bindingId ?? target.channel}:${Date.now()}`;
    try {
      const res = await invokeGatewayMethod({
        method: "send",
        payload: {
          channel: target.channel,
          to: target.to,
          message: params.assistantText,
          ...(target.threadId ? { threadId: target.threadId } : {}),
          ...(target.accountId ? { accountId: target.accountId } : {}),
          sessionKey: params.sessionKey,
          idempotencyKey: idem,
        },
        client: params.client,
        context: params.context,
      });
      if (!res.ok) {
        params.log?.warn(
          `[unified chat relay] send to ${target.channel} ${target.to} failed: ${
            res.error?.message ?? "unknown"
          }`,
        );
      }
    } catch (error) {
      params.log?.warn(
        `[unified chat relay] send to ${target.channel} ${target.to} crashed: ${String(error)}`,
      );
    }
  }
}

function transcriptHasAnyMessage(transcriptPath: string): boolean {
  try {
    const raw = fs.readFileSync(transcriptPath, "utf-8");
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as { type?: unknown };
        if (parsed.type === "message") {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return false;
  }
  return false;
}

function persistUserMessageForUnifiedChat(params: {
  sessionId: string;
  storePath?: string;
  sessionFile?: string;
  message: string;
  timestamp: number;
  idempotencyKey?: string;
}): { ok: true } | { ok: false; error: string } {
  const transcriptPath = resolveTranscriptPath({
    sessionId: params.sessionId,
    storePath: params.storePath,
    sessionFile: params.sessionFile,
  });
  if (!transcriptPath) {
    return { ok: false, error: "missing transcript path" };
  }
  const ensured = ensureTranscriptFile({
    transcriptPath,
    sessionId: params.sessionId,
  });
  if (!ensured.ok) {
    return ensured;
  }
  if (
    transcriptHasIdempotencyKey({
      transcriptPath,
      idempotencyKey: params.idempotencyKey,
    })
  ) {
    return { ok: true };
  }
  try {
    const messageBody: AppendMessageArg = {
      role: "user",
      content: params.message,
      timestamp: params.timestamp,
      ...(params.idempotencyKey ? { idempotencyKey: params.idempotencyKey } : {}),
    } as AppendMessageArg;
    if (!transcriptHasAnyMessage(transcriptPath)) {
      fs.appendFileSync(
        transcriptPath,
        `${JSON.stringify({
          type: "message",
          id: randomUUID().replace(/-/g, "").slice(0, 8),
          parentId: null,
          timestamp: new Date(params.timestamp).toISOString(),
          message: messageBody,
        })}\n`,
        "utf-8",
      );
      return { ok: true };
    }
    const sessionManager = SessionManager.open(transcriptPath);
    sessionManager.appendMessage(messageBody);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

async function persistUserMessageForUnifiedChatIfMissing(params: {
  sessionKey: string;
  message: string;
  idempotencyKey: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const latestSession = loadSessionEntry(params.sessionKey);
  if (!latestSession.entry?.sessionId) {
    return { ok: false, error: "session missing after chat.send" };
  }
  return persistUserMessageForUnifiedChat({
    sessionId: latestSession.entry.sessionId,
    storePath: latestSession.storePath,
    sessionFile: latestSession.entry.sessionFile,
    message: params.message,
    timestamp: Date.now(),
    idempotencyKey: params.idempotencyKey,
  });
}

function shouldForwardGatewayEvent(sessionKey: string, frame: unknown): frame is {
  type: "event";
  event: string;
  payload?: Record<string, unknown>;
  seq?: number;
  stateVersion?: Record<string, unknown>;
} {
  if (!frame || typeof frame !== "object") {
    return false;
  }
  const entry = frame as {
    type?: unknown;
    event?: unknown;
    payload?: Record<string, unknown>;
  };
  if (entry.type !== "event" || typeof entry.event !== "string") {
    return false;
  }
  if (!FORWARDED_GATEWAY_EVENTS.has(entry.event)) {
    return false;
  }
  if (entry.event === "shutdown") {
    return true;
  }
  const payloadSessionKey = normalizeOptionalString(entry.payload?.sessionKey);
  return payloadSessionKey === sessionKey;
}

function decodeWsPayload(data: unknown): string | null {
  if (typeof data === "string") {
    return data;
  }
  if (Buffer.isBuffer(data)) {
    return data.toString("utf8");
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((entry) => Buffer.from(entry))).toString("utf8");
  }
  return null;
}

function createFilteredGatewaySocket(params: {
  ws: WebSocket;
  sessionKey: string;
}): WebSocket {
  const proxy = {
    get bufferedAmount() {
      return params.ws.bufferedAmount;
    },
    send(data: unknown) {
      const text = decodeWsPayload(data);
      if (!text) {
        return;
      }
      try {
        const parsed = JSON.parse(text);
        if (!shouldForwardGatewayEvent(params.sessionKey, parsed)) {
          return;
        }
        params.ws.send(JSON.stringify(parsed));
      } catch {
        // Ignore malformed/non-event frames from the broadcast path.
      }
    },
    close(code?: number, reason?: string) {
      params.ws.close(code, reason);
    },
  };
  return proxy as unknown as WebSocket;
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write(
    "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n" +
      JSON.stringify({ error: { message: "Unauthorized", type: "unauthorized" } }),
  );
}

async function handleUnifiedChatPost(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  context: GatewayRequestContext;
  log?: { warn: (message: string) => void };
}): Promise<void> {
  if (params.req.method !== "POST") {
    sendMethodNotAllowed(params.res, "POST");
    return;
  }
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req: params.req,
    res: params.res,
    auth: params.auth,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
    operatorMethod: "chat.send",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
  });
  if (!authResult) {
    return;
  }
  const body = (await readJsonBodyOrError(
    params.req,
    params.res,
    MAX_UNIFIED_CHAT_BODY_BYTES,
  )) as UnifiedChatApiBody | undefined;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return;
  }
  const requestedSessionKey = resolveRequestedSessionKey({ body });
  const message = typeof body.message === "string" ? body.message : undefined;
  if (message === undefined) {
    sendInvalidRequest(params.res, "message is required");
    return;
  }
  const scopes = resolveOpenAiCompatibleHttpOperatorScopes(params.req, authResult.requestAuth);
  const client = createUnifiedApiClient({
    scopes,
    clientIp: resolveRequestClientIp(
      params.req,
      params.trustedProxies,
      params.allowRealIpFallback,
    ),
  });
  const idempotencyKey =
    normalizeText(body.idempotency_key ?? body.idempotencyKey) ?? randomUUID();
  const fallbackModels = normalizeFallbackModels(body.fallback_models ?? body.fallbackModels);
  const fallbackWaitMs =
    normalizeInteger(body.fallback_wait_ms ?? body.fallbackWaitMs) ?? DEFAULT_FALLBACK_WAIT_MS;
  const relayToBindings =
    normalizeBoolean(body.relay_to_bindings ?? body.relayToBindings) === true;
  const originatingChannel = normalizeText(body.originating_channel ?? body.originatingChannel);
  const originatingAccountId = normalizeText(
    body.originating_account_id ?? body.originatingAccountId,
  );
  let { canonicalKey, entry } = loadSessionEntry(requestedSessionKey);
  if (!entry?.sessionId) {
    const createRes = await invokeGatewayMethod({
      method: "sessions.create",
      payload: {
        key: requestedSessionKey,
      },
      client,
      context: params.context,
    });
    if (!createRes.ok) {
      sendJson(params.res, statusFromGatewayError(createRes.error), {
        ok: false,
        error: createRes.error,
      });
      return;
    }
    ({ canonicalKey, entry } = loadSessionEntry(requestedSessionKey));
  }
  const needsObserver = true;
  const observer = needsObserver
    ? createChatOutcomeObserver({ context: params.context, sessionKey: canonicalKey })
    : null;
  const chatSendContext = observer?.context ?? params.context;
  const chatSendPayload = (mergeIdempotencyKey: string) => ({
    sessionKey: canonicalKey,
    message,
    ...(normalizeText(body.thinking) ? { thinking: normalizeText(body.thinking) } : {}),
    ...(normalizeBoolean(body.deliver) !== undefined
      ? { deliver: normalizeBoolean(body.deliver) }
      : {}),
    ...(normalizeText(body.originating_channel ?? body.originatingChannel)
      ? {
          originatingChannel: normalizeText(
            body.originating_channel ?? body.originatingChannel,
          ),
        }
      : {}),
    ...(normalizeText(body.originating_to ?? body.originatingTo)
      ? { originatingTo: normalizeText(body.originating_to ?? body.originatingTo) }
      : {}),
    ...(normalizeText(body.originating_account_id ?? body.originatingAccountId)
      ? {
          originatingAccountId: normalizeText(
            body.originating_account_id ?? body.originatingAccountId,
          ),
        }
      : {}),
    ...(normalizeText(body.originating_thread_id ?? body.originatingThreadId)
      ? {
          originatingThreadId: normalizeText(
            body.originating_thread_id ?? body.originatingThreadId,
          ),
        }
      : {}),
    ...(Array.isArray(body.attachments) ? { attachments: body.attachments } : {}),
    ...(normalizeInteger(body.timeout_ms ?? body.timeoutMs) !== undefined
      ? { timeoutMs: normalizeInteger(body.timeout_ms ?? body.timeoutMs) }
      : {}),
    idempotencyKey: mergeIdempotencyKey,
  });
  const gatewayRes = await invokeGatewayMethod({
    method: "chat.send",
    payload: chatSendPayload(idempotencyKey),
    client,
    context: chatSendContext,
  });
  if (!gatewayRes.ok) {
    observer?.dispose();
    sendJson(params.res, statusFromGatewayError(gatewayRes.error), {
      ok: false,
      error: gatewayRes.error,
    });
    return;
  }
  const payload = (gatewayRes.payload ?? {}) as {
    runId?: string;
    status?: string;
  };
  if (observer && typeof payload.runId === "string") {
    void orchestrateFallbackAndRelay({
      observer: observer!,
      initialRunId: typeof payload.runId === "string" ? payload.runId : "",
      sessionKey: canonicalKey,
      fallbackModels,
      waitMsPerAttempt: fallbackWaitMs,
      chatSendPayload,
      client,
      originalContext: params.context,
      log: params.log,
      relayToBindings,
      originatingChannel,
      originatingAccountId,
      userMessage: {
        sessionKey: canonicalKey,
        message,
        idempotencyKey,
      },
      // Per-request fallback override: if we ever call sessions.patch, we
      // capture the original model first and unconditionally restore it after
      // the run finishes, so the session's default model stays locked to the
      // primary (qwen3.6:35b-a3b) between requests.
      restoreOriginalModelAfterFallback: true,
    });
  } else {
    if (typeof idempotencyKey === "string" && idempotencyKey) {
      void persistUserMessageForUnifiedChatIfMissing({
        sessionKey: canonicalKey,
        message,
        idempotencyKey,
      });
    }
    observer?.dispose();
  }
  sendJson(params.res, 200, {
    ok: true,
    session_id: canonicalKey,
    session_key: canonicalKey,
    session_internal_id: entry?.sessionId ?? null,
    run_id: payload.runId ?? null,
    status: payload.status ?? "ok",
    fallback_models: fallbackModels,
    gateway: gatewayRes.payload,
  });
}

async function orchestrateFallbackAndRelay(params: {
  observer: ChatOutcomeObserver;
  initialRunId: string;
  sessionKey: string;
  fallbackModels: string[];
  waitMsPerAttempt: number;
  chatSendPayload: (idempotencyKey: string) => Record<string, unknown>;
  client: GatewayClient;
  originalContext: GatewayRequestContext;
  log?: { warn: (message: string) => void };
  relayToBindings: boolean;
  originatingChannel?: string;
  originatingAccountId?: string;
  userMessage?: {
    sessionKey: string;
    message: string;
    idempotencyKey: string;
  };
  restoreOriginalModelAfterFallback?: boolean;
}): Promise<void> {
  // Snapshot the session's current default model the first time we need to
  // temporarily override it via sessions.patch. We restore this on exit so the
  // session's persisted model is not mutated across requests.
  let originalModelSnapshot: string | null = null;
  let sessionModelPatched = false;
  try {
    let currentRunId = params.initialRunId;
    let finalOutcome: ChatRunOutcome | null = null;
    if (params.fallbackModels.length === 0) {
      finalOutcome = await params.observer.wait(currentRunId, params.waitMsPerAttempt);
    } else {
      for (let attempt = 0; attempt < params.fallbackModels.length; attempt += 1) {
        const outcome = await params.observer.wait(currentRunId, params.waitMsPerAttempt);
        if (outcome.state === "final") {
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            runId: currentRunId,
            result: attempt === 0 ? "primary_success" : "fallback_success",
            attempt,
          });
          finalOutcome = outcome;
          break;
        }
        if (outcome.state === "aborted") {
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            runId: currentRunId,
            result: "aborted",
            attempt,
          });
          finalOutcome = outcome;
          break;
        }
        const nextModel = params.fallbackModels[attempt];
        if (!nextModel) {
          finalOutcome = outcome;
          break;
        }
        params.originalContext.broadcast("chat.fallback", {
          sessionKey: params.sessionKey,
          runId: currentRunId,
          result: "retrying",
          nextModel,
          attempt,
          errorMessage: outcome.state === "error" ? outcome.errorMessage : "timeout",
        });
        if (params.restoreOriginalModelAfterFallback && !sessionModelPatched) {
          // Best-effort: capture the session's current model before we mutate
          // it, so the finally block can restore it.
          originalModelSnapshot = await snapshotSessionModel({
            sessionKey: params.sessionKey,
            client: params.client,
            context: params.originalContext,
          }).catch((error) => {
            params.log?.warn(
              `[unified chat fallback] sessions.get snapshot failed for ${params.sessionKey}: ${String(error)}`,
            );
            return null;
          });
        }
        const patchRes = await invokeGatewayMethod({
          method: "sessions.patch",
          payload: {
            key: params.sessionKey,
            model: nextModel,
          },
          client: params.client,
          context: params.originalContext,
        });
        if (patchRes.ok) {
          sessionModelPatched = true;
        }
        if (!patchRes.ok) {
          params.log?.warn(
            `[unified chat fallback] sessions.patch failed for ${params.sessionKey} -> ${nextModel}: ${
              patchRes.error?.message ?? "unknown"
            }`,
          );
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            runId: currentRunId,
            result: "failed",
            reason: "sessions_patch_failed",
            nextModel,
            attempt,
          });
          finalOutcome = outcome;
          break;
        }
        const nextIdempotencyKey = `${currentRunId}:fb${attempt + 1}`;
        const retryRes = await invokeGatewayMethod({
          method: "chat.send",
          payload: params.chatSendPayload(nextIdempotencyKey),
          client: params.client,
          context: params.observer.context,
        });
        if (!retryRes.ok) {
          params.log?.warn(
            `[unified chat fallback] chat.send retry failed: ${
              retryRes.error?.message ?? "unknown"
            }`,
          );
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            runId: currentRunId,
            result: "failed",
            reason: "chat_send_failed",
            nextModel,
            attempt,
          });
          finalOutcome = outcome;
          break;
        }
        const retryPayload = (retryRes.payload ?? {}) as { runId?: string };
        if (typeof retryPayload.runId !== "string") {
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            runId: currentRunId,
            result: "failed",
            reason: "missing_run_id",
            nextModel,
            attempt,
          });
          finalOutcome = outcome;
          break;
        }
        currentRunId = retryPayload.runId;
      }
      if (!finalOutcome) {
        finalOutcome = await params.observer.wait(currentRunId, params.waitMsPerAttempt);
        if (finalOutcome.state !== "final") {
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            runId: currentRunId,
            result: "exhausted",
            attempts: params.fallbackModels.length,
            lastState: finalOutcome.state,
            ...(finalOutcome.state === "error" && finalOutcome.errorMessage
              ? { errorMessage: finalOutcome.errorMessage }
              : {}),
          });
        }
      }
    }
    if (
      params.relayToBindings &&
      finalOutcome &&
      finalOutcome.state === "final"
    ) {
      const assistantText = await params.observer.waitForAssistant(5_000);
      if (assistantText) {
        await relayAssistantToBoundChannels({
          sessionKey: params.sessionKey,
          originatingChannel: params.originatingChannel,
          originatingAccountId: params.originatingAccountId,
          assistantText,
          client: params.client,
          context: params.originalContext,
          log: params.log,
        });
      } else {
        params.log?.warn(
          `[unified chat relay] assistant text not available for ${params.sessionKey}, skipping relay`,
        );
      }
    }
  } catch (error) {
    params.log?.warn(`[unified chat orchestrator] crashed: ${String(error)}`);
  } finally {
    if (sessionModelPatched && originalModelSnapshot) {
      try {
        const restoreRes = await invokeGatewayMethod({
          method: "sessions.patch",
          payload: {
            key: params.sessionKey,
            model: originalModelSnapshot,
          },
          client: params.client,
          context: params.originalContext,
        });
        if (!restoreRes.ok) {
          params.log?.warn(
            `[unified chat fallback] restore sessions.patch failed for ${params.sessionKey} -> ${originalModelSnapshot}: ${
              restoreRes.error?.message ?? "unknown"
            }`,
          );
        } else {
          params.originalContext.broadcast("chat.fallback", {
            sessionKey: params.sessionKey,
            result: "model_restored",
            restoredModel: originalModelSnapshot,
          });
        }
      } catch (error) {
        params.log?.warn(
          `[unified chat fallback] restore sessions.patch crashed for ${params.sessionKey}: ${String(error)}`,
        );
      }
    }
    if (params.userMessage?.idempotencyKey) {
      const persisted = await persistUserMessageForUnifiedChatIfMissing({
        sessionKey: params.userMessage.sessionKey,
        message: params.userMessage.message,
        idempotencyKey: params.userMessage.idempotencyKey,
      });
      if (!persisted.ok) {
        params.log?.warn(
          `[unified chat transcript] failed to persist user message fallback: ${persisted.error}`,
        );
      }
    }
    params.observer.dispose();
  }
}

async function handleUnifiedSessionsGet(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  context: GatewayRequestContext;
}): Promise<void> {
  if (params.req.method !== "GET") {
    sendMethodNotAllowed(params.res, "GET");
    return;
  }
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req: params.req,
    res: params.res,
    auth: params.auth,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
    operatorMethod: "sessions.list",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
  });
  if (!authResult) {
    return;
  }
  const url = getRequestUrl(params.req);
  const agentId = normalizeOptionalString(url.searchParams.get("agent_id") ?? url.searchParams.get("agentId")) ?? "main";
  const search = normalizeOptionalString(url.searchParams.get("search")) ?? undefined;
  const limitRaw = normalizeOptionalString(url.searchParams.get("limit"));
  const limit =
    limitRaw && Number.isFinite(Number.parseInt(limitRaw, 10))
      ? Math.max(1, Math.min(200, Number.parseInt(limitRaw, 10)))
      : 60;
  const activeMinutesRaw = normalizeOptionalString(
    url.searchParams.get("active_minutes") ?? url.searchParams.get("activeMinutes"),
  );
  const activeMinutes =
    activeMinutesRaw && Number.isFinite(Number.parseInt(activeMinutesRaw, 10))
      ? Math.max(1, Number.parseInt(activeMinutesRaw, 10))
      : undefined;

  const scopes = resolveOpenAiCompatibleHttpOperatorScopes(params.req, authResult.requestAuth);
  const client = createUnifiedApiClient({
    scopes,
    clientIp: resolveRequestClientIp(
      params.req,
      params.trustedProxies,
      params.allowRealIpFallback,
    ),
  });
  const gatewayRes = await invokeGatewayMethod({
    method: "sessions.list",
    payload: {
      agentId,
      limit,
      includeDerivedTitles: true,
      ...(search ? { search } : {}),
      ...(activeMinutes !== undefined ? { activeMinutes } : {}),
    },
    client,
    context: params.context,
  });
  if (!gatewayRes.ok) {
    sendJson(params.res, statusFromGatewayError(gatewayRes.error), {
      ok: false,
      error: gatewayRes.error,
    });
    return;
  }
  const payload = (gatewayRes.payload ?? {}) as {
    sessions?: Array<Record<string, unknown>>;
    count?: number;
    defaults?: Record<string, unknown>;
  };
  const sessions = (payload.sessions ?? []).map((row) => ({
    key: typeof row.key === "string" ? row.key : null,
    display_name: typeof row.displayName === "string" ? row.displayName : null,
    subject: typeof row.subject === "string" ? row.subject : null,
    label: typeof row.label === "string" ? row.label : null,
    agent_id: typeof row.agentId === "string" ? row.agentId : null,
    session_id: typeof row.sessionId === "string" ? row.sessionId : null,
    updated_at: typeof row.updatedAt === "number" ? row.updatedAt : null,
    last_channel: typeof row.lastChannel === "string" ? row.lastChannel : null,
    message_count: typeof row.messageCount === "number" ? row.messageCount : null,
  }));
  sendJson(params.res, 200, {
    ok: true,
    count: sessions.length,
    sessions,
    defaults: payload.defaults ?? null,
  });
}

async function handleUnifiedHistoryGet(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  context: GatewayRequestContext;
}): Promise<void> {
  if (params.req.method !== "GET") {
    sendMethodNotAllowed(params.res, "GET");
    return;
  }
  const authResult = await authorizeScopedGatewayHttpRequestOrReply({
    req: params.req,
    res: params.res,
    auth: params.auth,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
    operatorMethod: "chat.history",
    resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
  });
  if (!authResult) {
    return;
  }
  const requestedSessionKey = resolveRequestedSessionKey({ req: params.req });
  const { canonicalKey } = loadSessionEntry(requestedSessionKey);
  const scopes = resolveOpenAiCompatibleHttpOperatorScopes(params.req, authResult.requestAuth);
  const client = createUnifiedApiClient({
    scopes,
    clientIp: resolveRequestClientIp(
      params.req,
      params.trustedProxies,
      params.allowRealIpFallback,
    ),
  });
  const gatewayRes = await invokeGatewayMethod({
    method: "chat.history",
    payload: {
      sessionKey: canonicalKey,
      ...(resolveLimit(params.req) !== undefined ? { limit: resolveLimit(params.req) } : {}),
      ...(resolveMaxChars(params.req) !== undefined
        ? { maxChars: resolveMaxChars(params.req) }
        : {}),
    },
    client,
    context: params.context,
  });
  if (!gatewayRes.ok) {
    sendJson(params.res, statusFromGatewayError(gatewayRes.error), {
      ok: false,
      error: gatewayRes.error,
    });
    return;
  }
  const payload = (gatewayRes.payload ?? {}) as {
    sessionKey?: string;
    sessionId?: string;
    messages?: unknown[];
    thinkingLevel?: string;
    fastMode?: boolean;
    verboseLevel?: string;
  };
  sendJson(params.res, 200, {
    ok: true,
    session_id: payload.sessionKey ?? canonicalKey,
    session_key: payload.sessionKey ?? canonicalKey,
    session_internal_id: payload.sessionId ?? null,
    messages: payload.messages ?? [],
    thinking_level: payload.thinkingLevel ?? null,
    fast_mode: payload.fastMode ?? null,
    verbose_level: payload.verboseLevel ?? null,
    gateway: gatewayRes.payload,
  });
}

export function attachUnifiedChatApi(params: {
  httpServers: HttpServer[];
  clients: Set<GatewayWsClient>;
  context: GatewayRequestContext;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  rateLimiter?: AuthRateLimiter;
  log?: { warn: (message: string) => void };
}) {
  const eventWss = new WebSocketServer({ noServer: true });
  const getResolvedAuth = params.getResolvedAuth ?? (() => params.resolvedAuth);
  let cleanedUp = false;

  const cleanup = () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    for (const client of params.clients) {
      if (client.connId.startsWith("unified-events:")) {
        try {
          client.socket.close(1012, "service restart");
        } catch {
          // Ignore close failures during shutdown.
        }
      }
    }
    void new Promise<void>((resolve) => eventWss.close(() => resolve())).catch(() => {});
  };

  for (const httpServer of params.httpServers) {
    httpServer.prependListener("request", (req: IncomingMessage, res: ServerResponse) => {
      const pathname = getRequestUrl(req).pathname;
      if (pathname !== "/chat" && pathname !== "/history" && pathname !== "/sessions") {
        return;
      }
      (
        req as IncomingMessage & {
          [GATEWAY_HTTP_REQUEST_CLAIMED]?: boolean;
        }
      )[GATEWAY_HTTP_REQUEST_CLAIMED] = true;
      setDefaultSecurityHeaders(res);
      void (async () => {
        try {
          const configSnapshot = loadConfig();
          const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
          const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
          const resolvedAuth = getResolvedAuth();
          if (pathname === "/chat") {
            await handleUnifiedChatPost({
              req,
              res,
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter: params.rateLimiter,
              context: params.context,
            });
            return;
          }
          if (pathname === "/sessions") {
            await handleUnifiedSessionsGet({
              req,
              res,
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter: params.rateLimiter,
              context: params.context,
            });
            return;
          }
          await handleUnifiedHistoryGet({
            req,
            res,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            rateLimiter: params.rateLimiter,
            context: params.context,
          });
        } catch (error) {
          params.log?.warn(`unified api request failed: ${String(error)}`);
          if (!res.writableEnded) {
            sendJson(res, 500, {
              ok: false,
              error: errorShape(ErrorCodes.UNAVAILABLE, "unified api request failed"),
            });
          }
        }
      })();
    });

    httpServer.prependListener("upgrade", (req, socket, head) => {
      const pathname = getRequestUrl(req).pathname;
      if (pathname !== "/events") {
        return;
      }
      (
        req as IncomingMessage & {
          [GATEWAY_HTTP_UPGRADE_CLAIMED]?: boolean;
        }
      )[GATEWAY_HTTP_UPGRADE_CLAIMED] = true;
      void (async () => {
        const configSnapshot = loadConfig();
        const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
        const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
        const token = resolveUnifiedApiTokenFromUpgrade(req);
        const auth = await authorizeHttpGatewayConnect({
          auth: getResolvedAuth(),
          connectAuth: token ? { token, password: token } : null,
          req,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter: params.rateLimiter,
          browserOriginPolicy: resolveHttpBrowserOriginPolicy(req, configSnapshot),
        });
        if (!auth.ok) {
          writeUpgradeAuthFailure(socket, auth);
          socket.destroy();
          return;
        }
        const requestAuth = buildUnifiedRequestAuth(auth);
        const scopes = resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth);
        const scopeAuth = authorizeOperatorScopesForMethod("chat.history", scopes);
        if (!scopeAuth.allowed || (!scopes.includes(READ_SCOPE) && !scopes.includes(WRITE_SCOPE))) {
          socket.write(
            "HTTP/1.1 403 Forbidden\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n" +
              JSON.stringify({
                error: {
                  message: `missing scope: ${scopeAuth.allowed ? READ_SCOPE : scopeAuth.missingScope}`,
                  type: "forbidden",
                },
              }),
          );
          socket.destroy();
          return;
        }
        const requestedSessionKey = resolveRequestedSessionKey({ req });
        const { canonicalKey, entry } = loadSessionEntry(requestedSessionKey);
        eventWss.handleUpgrade(req, socket, head, (ws) => {
          const connId = `unified-events:${randomUUID()}`;
          const gatewayClient: GatewayWsClient = {
            socket: createFilteredGatewaySocket({ ws, sessionKey: canonicalKey }),
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              role: "operator",
              scopes,
              client: {
                id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
                displayName: "Unified Events API",
                version: "1",
                platform: "http",
                mode: GATEWAY_CLIENT_MODES.BACKEND,
              },
            },
            connId,
            usesSharedGatewayAuth: auth.method === "token" || auth.method === "password",
            clientIp: resolveRequestClientIp(req, trustedProxies, allowRealIpFallback),
          };
          params.clients.add(gatewayClient);
          params.context.subscribeSessionEvents(connId);
          params.context.subscribeSessionMessageEvents(connId, canonicalKey);
          let closed = false;
          const dispose = () => {
            if (closed) {
              return;
            }
            closed = true;
            params.context.unsubscribeAllSessionEvents(connId);
            params.clients.delete(gatewayClient);
          };
          ws.once("close", dispose);
          ws.once("error", dispose);
          ws.send(
            JSON.stringify({
              type: "event",
              event: READY_EVENT,
              payload: {
                sessionKey: canonicalKey,
                sessionId: entry?.sessionId ?? null,
                ts: Date.now(),
              },
            }),
          );
        });
      })().catch((error) => {
        params.log?.warn(`unified events upgrade failed: ${String(error)}`);
        socket.destroy();
      });
    });

    httpServer.once("close", cleanup);
  }
}
