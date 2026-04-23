import { afterEach, describe, expect, test, vi } from "vitest";
import { WebSocket } from "ws";
import { extractFirstTextBlock } from "../shared/chat-message-content.js";
import {
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  testState,
  withGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

function resolveGatewayTestToken(): string {
  const token = (testState.gatewayAuth as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    throw new Error("expected gateway test token");
  }
  return token;
}

function extractMessageText(message: unknown): string {
  if (message && typeof message === "object") {
    const text = (message as { text?: unknown }).text;
    if (typeof text === "string") {
      return text;
    }
  }
  return extractFirstTextBlock(message) ?? "";
}

describe("unified chat api", () => {
  let ws: WebSocket | undefined;

  afterEach(() => {
    ws?.close();
    ws = undefined;
  });

  test("serves post/history/events on the same shared session", async () => {
    mockGetReplyFromConfigOnce(async () => ({ text: "assistant from unified api" }) as never);

    await withGatewayServer(async ({ port }) => {
      const token = resolveGatewayTestToken();
      ws = new WebSocket(
        `ws://127.0.0.1:${port}/events?session_id=main&token=${encodeURIComponent(token)}`,
      );

      const readyPromise = onceMessage(
        ws,
        (entry) => entry.type === "event" && entry.event === "ready",
        10_000,
      ).catch((error) => {
        throw new Error(`ready event failed: ${String(error)}`);
      });
      await new Promise<void>((resolve, reject) => {
        ws?.once("open", () => resolve());
        ws?.once("error", reject);
      });
      const ready = await readyPromise;
      const sessionKey = (ready.payload as { sessionKey?: unknown } | undefined)?.sessionKey;
      expect(typeof sessionKey).toBe("string");

      const messageEventPromise = onceMessage(
        ws,
        (entry) =>
          entry.type === "event" &&
          entry.event === "session.message" &&
          ((entry.payload as { sessionKey?: unknown } | undefined)?.sessionKey as string) ===
            sessionKey &&
          ((entry.payload as { message?: unknown } | undefined)?.message as { role?: unknown })
            ?.role === "user",
        10_000,
      ).catch((error) => {
        throw new Error(`session.message event failed: ${String(error)}`);
      });

      const statusEventPromise = onceMessage(
        ws,
        (entry) =>
          entry.type === "event" &&
          entry.event === "chat" &&
          ((entry.payload as { sessionKey?: unknown } | undefined)?.sessionKey as string) ===
            sessionKey &&
          ["final", "error", "aborted"].includes(
            String((entry.payload as { state?: unknown } | undefined)?.state ?? ""),
          ),
        10_000,
      ).catch((error) => {
        throw new Error(`chat status event failed: ${String(error)}`);
      });

      const postResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "main",
          message: "hello from unified api",
          idempotency_key: "unified-http-send-1",
        }),
      });
      expect(postResponse.status).toBe(200);
      const postBody = (await postResponse.json()) as {
        ok?: boolean;
        session_key?: string;
        run_id?: string;
        status?: string;
      };
      expect(postBody.ok).toBe(true);
      expect(postBody.session_key).toBe(sessionKey);
      expect(postBody.run_id).toBe("unified-http-send-1");
      expect(postBody.status).toBe("started");

      const messageEvent = await messageEventPromise;
      const userPayload = messageEvent.payload as {
        message?: unknown;
        messageSeq?: number;
        sessionKey?: string;
      };
      expect(userPayload.sessionKey).toBe(sessionKey);
      expect(extractMessageText(userPayload.message)).toContain("hello from unified api");
      expect((userPayload.message as { idempotencyKey?: unknown } | undefined)?.idempotencyKey).toBe(
        "unified-http-send-1",
      );
      expect(typeof userPayload.messageSeq).toBe("number");

      const statusEvent = await statusEventPromise;
      const statusPayload = statusEvent.payload as { sessionKey?: string; state?: string };
      expect(statusPayload.sessionKey).toBe(sessionKey);
      expect(["final", "error", "aborted"]).toContain(statusPayload.state);

      await vi.waitFor(
        async () => {
          const historyResponse = await fetch(
            `http://127.0.0.1:${port}/history?session_id=main&limit=10`,
            {
              headers: {
                authorization: `Bearer ${token}`,
              },
            },
          );
          expect(historyResponse.status).toBe(200);
          const historyBody = (await historyResponse.json()) as {
            ok?: boolean;
            session_key?: string;
            messages?: unknown[];
          };
          expect(historyBody.ok).toBe(true);
          expect(historyBody.session_key).toBe(sessionKey);
          const messages = historyBody.messages ?? [];
          const texts = messages.map((message) => extractMessageText(message));
          const matchingUserMessages = messages.filter((message) => {
            if (!message || typeof message !== "object") {
              return false;
            }
            return (
              (message as { role?: unknown }).role === "user" &&
              extractMessageText(message).includes("hello from unified api")
            );
          });
          expect(matchingUserMessages).toHaveLength(1);
          expect(texts.some((text) => text.includes("assistant from unified api"))).toBe(true);
        },
        { timeout: 10_000, interval: 200 },
      );
    });
  });

  test("accepts and echoes fallback_models + relay_to_bindings without breaking primary path", async () => {
    mockGetReplyFromConfigOnce(async () => ({ text: "assistant from primary" }) as never);

    await withGatewayServer(async ({ port }) => {
      const token = resolveGatewayTestToken();
      const postResponse = await fetch(`http://127.0.0.1:${port}/chat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          session_id: "main",
          message: "fallback flag echo test",
          idempotency_key: "unified-http-fallback-echo",
          fallback_models: ["ollama/mock-fallback:latest"],
          fallback_wait_ms: 5000,
          relay_to_bindings: true,
        }),
      });
      expect(postResponse.status).toBe(200);
      const postBody = (await postResponse.json()) as {
        ok?: boolean;
        fallback_models?: string[];
        status?: string;
        run_id?: string | null;
      };
      expect(postBody.ok).toBe(true);
      expect(postBody.fallback_models).toEqual(["ollama/mock-fallback:latest"]);
      expect(postBody.status).toBe("started");
      expect(typeof postBody.run_id).toBe("string");
    });
  });
});
