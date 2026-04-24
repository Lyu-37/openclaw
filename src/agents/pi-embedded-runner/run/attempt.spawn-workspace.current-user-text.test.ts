import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  getHoisted,
  resetEmbeddedAttemptHarness,
} from "./attempt.spawn-workspace.test-support.js";

const hoisted = getHoisted();

describe("runEmbeddedAttempt bootstrap hook context", () => {
  const tempPaths: string[] = [];

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
  });

  it("forwards the current user prompt into bootstrap hook resolution", async () => {
    await createContextEngineAttemptRunner({
      sessionKey: "agent:main:guildchat:dm:test-current-user-text",
      tempPaths,
      contextEngine: {
        assemble: async ({ messages }) => ({
          messages,
          estimatedTokens: 1,
        }),
      },
      attemptOverrides: {
        prompt: "那你自己说点什么",
      },
    });

    expect(hoisted.resolveBootstrapContextForRunMock).toHaveBeenCalledOnce();
    expect(hoisted.resolveBootstrapContextForRunMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentUserText: "那你自己说点什么",
      }),
    );
  });
});
