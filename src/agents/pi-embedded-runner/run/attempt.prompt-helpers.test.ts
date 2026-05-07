import { describe, expect, it, vi } from "vitest";

const musicGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveMusicGenerationTaskPromptContextForSession: vi.fn(),
}));

const videoGenerationTaskStatusMocks = vi.hoisted(() => ({
  buildActiveVideoGenerationTaskPromptContextForSession: vi.fn(),
}));

vi.mock("../../music-generation-task-status.js", () => musicGenerationTaskStatusMocks);
vi.mock("../../video-generation-task-status.js", () => videoGenerationTaskStatusMocks);

import {
  resolveAttemptPrependSystemContext,
  rewriteInternalUserMessageForTranscript,
} from "./attempt.prompt-helpers.js";

describe("resolveAttemptPrependSystemContext", () => {
  it("prepends active video task guidance ahead of hook system context", () => {
    videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(
      "Active task hint",
    );
    musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(
      "Music task hint",
    );

    const result = resolveAttemptPrependSystemContext({
      sessionKey: "agent:main:discord:direct:123",
      trigger: "user",
      hookPrependSystemContext: "Hook system context",
    });

    expect(
      videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession,
    ).toHaveBeenCalledWith("agent:main:discord:direct:123");
    expect(
      musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession,
    ).toHaveBeenCalledWith("agent:main:discord:direct:123");
    expect(result).toBe("Active task hint\n\nMusic task hint\n\nHook system context");
  });

  it("skips active video task guidance for non-user triggers", () => {
    videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReset();
    videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession.mockReturnValue(
      "Should not be used",
    );
    musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReset();
    musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession.mockReturnValue(
      "Should not be used",
    );

    const result = resolveAttemptPrependSystemContext({
      sessionKey: "agent:main:discord:direct:123",
      trigger: "heartbeat",
      hookPrependSystemContext: "Hook system context",
    });

    expect(
      videoGenerationTaskStatusMocks.buildActiveVideoGenerationTaskPromptContextForSession,
    ).not.toHaveBeenCalled();
    expect(
      musicGenerationTaskStatusMocks.buildActiveMusicGenerationTaskPromptContextForSession,
    ).not.toHaveBeenCalled();
    expect(result).toBe("Hook system context");
  });
});

describe("rewriteInternalUserMessageForTranscript", () => {
  it("normalizes internal shared-session user turns to raw text plus idempotency key", () => {
    const rewritten = rewriteInternalUserMessageForTranscript({
      message: {
        role: "user",
        content:
          'Sender (untrusted metadata):\n```json\n{"label":"OpenClaw UI"}\n```\n\n[Thu 2026-03-12 07:00 UTC] hello from unified api',
      },
      prompt:
        'Sender (untrusted metadata):\n```json\n{"label":"OpenClaw UI"}\n```\n\n[Thu 2026-03-12 07:00 UTC] hello from unified api',
      currentMessageId: "unified-http-send-1",
      runId: "unified-http-send-1",
      trigger: "user",
    });

    expect(rewritten).toEqual({
      role: "user",
      content: "hello from unified api",
      idempotencyKey: "unified-http-send-1",
    });
  });

  it("preserves external-channel transcript turns", () => {
    const original = {
      role: "user",
      content:
        'Sender (untrusted metadata):\n```json\n{"label":"Alice"}\n```\n\n[Thu 2026-03-12 07:00 UTC] hi',
    };

    expect(
      rewriteInternalUserMessageForTranscript({
        message: original,
        prompt: String(original.content),
        currentMessageId: "discord-msg-1",
        runId: "run-1",
        trigger: "user",
      }),
    ).toBe(original);
  });

  it("rewrites queued memory-flush user turns to the final human-visible text", () => {
    const originalText = `[Queued user message that arrived while the previous turn was still active]
Pre-compaction memory flush. Store durable memories only in memory/2026-04-24.md.
If nothing to store, reply with NO_REPLY.
Current time: Friday, April 24th, 2026 - 10:18 (America/Toronto) / 2026-04-24 14:18 UTC

Conversation info (untrusted metadata):
\`\`\`json
{"sender":"lyuzhangkai"}
\`\`\`

你在南京大学上什么专业的课啊`;

    const rewritten = rewriteInternalUserMessageForTranscript({
      message: {
        role: "user",
        content: originalText,
      },
      prompt: originalText,
      currentMessageId: "run-queued-user-1",
      runId: "run-queued-user-1",
      trigger: "user",
    });

    expect(rewritten).toEqual({
      role: "user",
      content: "你在南京大学上什么专业的课啊",
      idempotencyKey: "run-queued-user-1",
    });
  });
});
