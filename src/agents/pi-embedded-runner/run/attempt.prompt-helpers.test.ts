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
});
