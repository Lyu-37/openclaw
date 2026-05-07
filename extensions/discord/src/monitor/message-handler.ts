import type { Client } from "@buape/carbon";
import crypto from "node:crypto";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/config-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  buildDiscordInboundReplayKey,
  claimDiscordInboundReplay,
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { buildDiscordInboundJob } from "./inbound-job.js";
import {
  createDiscordInboundWorker,
  type DiscordInboundWorkerTestingHooks,
} from "./inbound-worker.js";
import type { DiscordMessageEvent, DiscordMessageHandler } from "./listeners.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import { preflightDiscordMessage } from "./message-handler.preflight.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import type { DiscordPretypingTraceMeta } from "./message-handler.preflight.types.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  workerRunTimeoutMs?: number;
  __testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordInboundWorkerTestingHooks & {
  preflightDiscordMessage?: typeof preflightDiscordMessage;
};

export type DiscordMessageHandlerWithLifecycle = DiscordMessageHandler & {
  deactivate: () => void;
};

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function hashDiscordTraceText(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function resolveDiscordMessageCreatedMs(data: DiscordMessageEvent): number | null {
  const timestamp = data.message?.timestamp;
  if (typeof timestamp !== "string" || !timestamp) {
    return null;
  }
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : null;
}

function createDiscordPretypingTrace(data: DiscordMessageEvent): DiscordPretypingTraceMeta {
  const baseText = resolveDiscordMessageText(data.message, { includeForwarded: false }) ?? "";
  return {
    traceId: crypto.randomUUID(),
    messageHash: hashDiscordTraceText(baseText),
    discordMessageCreatedMs: resolveDiscordMessageCreatedMs(data),
    discordEventReceivedMs: Date.now(),
  };
}

function shouldBypassDebounceForDirectQwenCandidate(data: DiscordMessageEvent): boolean {
  const message = data.message;
  if (!message) {
    return false;
  }
  const text = (resolveDiscordMessageText(message, { includeForwarded: false }) ?? "").trim();
  if (!text || text.length > 180) {
    return false;
  }
  if (message.attachments?.length || hasDiscordMessageStickers(message)) {
    return false;
  }
  if (/^[/!$]/.test(text) || /\bhttps?:\/\/\S+/i.test(text)) {
    return false;
  }
  const boundaryPattern =
    /不想活|想死|活不下去|自杀|自伤|伤害自己|没有位置|她.*保持距离|保持距离.*她|现实朋友|朋友边界|亲密关系|替代感|太依赖|你真的懂我|敷衍|你会不会离开|Yuan|宋予安|persona|SOUL\.md|private-chat|private chat|P2|memory|记忆|训练|LoRA|QLoRA|fine[- ]?tune|主模型|轻模型|router|路由/i;
  if (boundaryPattern.test(text)) {
    return false;
  }
  return (
    text.length <= 80 ||
    /问问|吃|饭|书|小说|游戏|消遣|复习|学校|作业|歌|洗澡|忙|轻松|不费脑|架空|冒险|悲剧|改自然|整理/.test(
      text,
    )
  );
}

export function createDiscordMessageHandler(
  params: DiscordMessageHandlerParams,
): DiscordMessageHandlerWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const preflightDiscordMessageImpl =
    params.__testing?.preflightDiscordMessage ?? preflightDiscordMessage;
  const replayGuard = createDiscordInboundReplayGuard();
  const inboundWorker = createDiscordInboundWorker({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    runTimeoutMs: params.workerRunTimeoutMs,
    replayGuard,
    __testing: params.__testing,
  });

  const { debouncer } = createChannelInboundDebouncer<{
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    replayKey?: string;
    pretypingTrace: DiscordPretypingTraceMeta;
  }>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: (entry) => {
      const message = entry.data.message;
      const authorId = entry.data.author?.id;
      if (!message || !authorId) {
        return null;
      }
      const channelId = resolveDiscordMessageChannelId({
        message,
        eventChannelId: entry.data.channel_id,
      });
      if (!channelId) {
        return null;
      }
      return `discord:${params.accountId}:${channelId}:${authorId}`;
    },
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia: Boolean(
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
        ),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      const replayKeys = entries.map((entry) => entry.replayKey).filter(isNonEmptyString);
      const abortSignal = last.abortSignal;
      if (abortSignal?.aborted) {
        releaseDiscordInboundReplay({
          replayKeys,
          error: abortSignal.reason,
          replayGuard,
        });
        return;
      }
      try {
        const replyGateStartMs = Date.now();
        if (entries.length === 1) {
          const ctx = await preflightDiscordMessageImpl({
            ...params,
            ackReactionScope,
            groupPolicy,
            abortSignal,
            data: last.data,
            client: last.client,
          });
          if (!ctx) {
            await commitDiscordInboundReplay({ replayKeys, replayGuard });
            return;
          }
          applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
          ctx.pretypingTrace = {
            ...last.pretypingTrace,
            replyGateStartMs,
            replyGateEndMs: Date.now(),
            replyJobEnqueuedMs: Date.now(),
          };
          inboundWorker.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
          return;
        }
        const combinedBaseText = entries
          .map((entry) =>
            resolveDiscordMessageText(entry.data.message, { includeForwarded: false }),
          )
          .filter(Boolean)
          .join("\n");
        const syntheticMessage = {
          ...last.data.message,
          content: combinedBaseText,
          attachments: [],
          message_snapshots: (last.data.message as { message_snapshots?: unknown })
            .message_snapshots,
          messageSnapshots: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
          rawData: {
            ...(last.data.message as { rawData?: Record<string, unknown> }).rawData,
          },
        };
        const syntheticData: DiscordMessageEvent = {
          ...last.data,
          message: syntheticMessage,
        };
        const ctx = await preflightDiscordMessageImpl({
          ...params,
          ackReactionScope,
          groupPolicy,
          abortSignal,
          data: syntheticData,
          client: last.client,
        });
        if (!ctx) {
          await commitDiscordInboundReplay({ replayKeys, replayGuard });
          return;
        }
        applyImplicitReplyBatchGate(ctx, params.replyToMode, true);
        if (entries.length > 1) {
          const ids = entries.map((entry) => entry.data.message?.id).filter(isNonEmptyString);
          if (ids.length > 0) {
            const ctxBatch = ctx as typeof ctx & {
              MessageSids?: string[];
              MessageSidFirst?: string;
              MessageSidLast?: string;
            };
            ctxBatch.MessageSids = ids;
            ctxBatch.MessageSidFirst = ids[0];
            ctxBatch.MessageSidLast = ids[ids.length - 1];
          }
        }
        ctx.pretypingTrace = {
          ...last.pretypingTrace,
          replyGateStartMs,
          replyGateEndMs: Date.now(),
          replyJobEnqueuedMs: Date.now(),
        };
        inboundWorker.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
      } catch (error) {
        if (error instanceof DiscordRetryableInboundError) {
          releaseDiscordInboundReplay({ replayKeys, error, replayGuard });
        } else {
          await commitDiscordInboundReplay({ replayKeys, replayGuard });
        }
        throw error;
      }
    },
    onError: (err) => {
      params.runtime.error?.(danger(`discord debounce flush failed: ${String(err)}`));
    },
  });

  const handler: DiscordMessageHandlerWithLifecycle = async (data, client, options) => {
    try {
      if (options?.abortSignal?.aborted) {
        return;
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return;
      }
      const replayKey = buildDiscordInboundReplayKey({
        accountId: params.accountId,
        data,
      });
      if (
        !(await claimDiscordInboundReplay({
          replayKey,
          replayGuard,
        }))
      ) {
        return;
      }

      const pretypingTrace = createDiscordPretypingTrace(data);
      if (shouldBypassDebounceForDirectQwenCandidate(data)) {
        const replayKeys = replayKey ? [replayKey] : [];
        try {
          const replyGateStartMs = Date.now();
          const ctx = await preflightDiscordMessageImpl({
            ...params,
            ackReactionScope,
            groupPolicy,
            abortSignal: options?.abortSignal,
            data,
            client,
          });
          if (!ctx) {
            await commitDiscordInboundReplay({ replayKeys, replayGuard });
            return;
          }
          applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
          ctx.pretypingTrace = {
            ...pretypingTrace,
            replyGateStartMs,
            replyGateEndMs: Date.now(),
            replyJobEnqueuedMs: Date.now(),
            debounceBypassed: true,
            debounceBypassReason: "DIRECT_QWEN_FAST_PATH_CANDIDATE",
          };
          inboundWorker.enqueue(buildDiscordInboundJob(ctx, { replayKeys }));
        } catch (error) {
          if (error instanceof DiscordRetryableInboundError) {
            releaseDiscordInboundReplay({ replayKeys, error, replayGuard });
          } else {
            await commitDiscordInboundReplay({ replayKeys, replayGuard });
          }
          throw error;
        }
        return;
      }

      await debouncer.enqueue({
        data,
        client,
        abortSignal: options?.abortSignal,
        replayKey: replayKey ?? undefined,
        pretypingTrace,
      });
    } catch (err) {
      params.runtime.error?.(danger(`handler failed: ${String(err)}`));
    }
  };

  handler.deactivate = inboundWorker.deactivate;

  return handler;
}
