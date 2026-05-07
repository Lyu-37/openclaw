import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import {
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveSessionAgentId,
  resolveAgentSkillsFilter,
} from "../../agents/agent-scope.js";
import { resolveModelRefFromString } from "../../agents/model-selection.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import { DEFAULT_AGENT_WORKSPACE_DIR, ensureAgentWorkspace } from "../../agents/workspace.js";
import { resolveChannelModelOverride } from "../../channels/model-overrides.js";
import { type OpenClawConfig, loadConfig } from "../../config/config.js";
import { defaultRuntime } from "../../runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { normalizeStringEntries } from "../../shared/string-normalization.js";
import type { GetReplyOptions } from "../get-reply-options.types.js";
import type { ReplyPayload } from "../reply-payload.js";
import type { MsgContext } from "../templating.js";
import { normalizeVerboseLevel } from "../thinking.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";
import {
  CONVERSATION_ROUTER_LIGHT_MODEL_ID,
  CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER,
  appendConversationRouterV0DebugLog,
  auditLightModelCoherence,
  buildLightModelRewriteInstruction,
  resolveLightModelQuestionIntent,
  resolveConversationRouterV0ModelSelection,
  shouldAllowLightModelQuestion,
  shouldAllowSpecificLightModelQuestion,
  type LightModelCoherenceAuditOutput,
  type LightModelQuestionIntent,
  type ConversationRouterModelSelection,
  type ConversationRouterGenerationTrace,
  type ConversationRouterTraceTimings,
} from "./conversation-router-v0.js";
import { resolveDefaultModel } from "./directive-handling.defaults.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { resolveReplyDirectives } from "./get-reply-directives.js";
import {
  initFastReplySessionState,
  buildFastReplyCommandContext,
  shouldHandleFastReplyTextCommands,
  shouldUseReplyFastDirectiveExecution,
  resolveGetReplyConfig,
  shouldUseReplyFastTestBootstrap,
  shouldUseReplyFastTestRuntime,
} from "./get-reply-fast-path.js";
import { handleInlineActions } from "./get-reply-inline-actions.js";
import { runPreparedReply } from "./get-reply-run.js";
import { finalizeInboundContext } from "./inbound-context.js";
import { hasInboundMedia } from "./inbound-media.js";
import { emitPreAgentMessageHooks } from "./message-preprocess-hooks.js";
import { createFastTestModelSelectionState } from "./model-selection.js";
import { initSessionState } from "./session.js";
import { resolveStoredModelOverride } from "./stored-model-override.js";
import { createTypingController } from "./typing.js";

type ResetCommandAction = "new" | "reset";

type DiscordPretypingTraceContext = {
  PretypingTrace?: {
    traceId?: string | null;
    discordMessageCreatedMs?: number | null;
    discordEventReceivedMs?: number | null;
    replyGateStartMs?: number | null;
    replyGateEndMs?: number | null;
    replyJobEnqueuedMs?: number | null;
    replyJobStartedMs?: number | null;
    typingSendStartMs?: number | null;
    typingSendEndMs?: number | null;
    typingSendError?: string | null;
    discordReplySendStartMs?: number | null;
    discordReplySendEndMs?: number | null;
    queueName?: string | null;
    queueDepthAtEnqueue?: number | null;
    queueDepthAtStart?: number | null;
    activeJobs?: number | null;
    debounceBypassed?: boolean | null;
    debounceBypassReason?: string | null;
  };
};

let sessionResetModelRuntimePromise: Promise<
  typeof import("./session-reset-model.runtime.js")
> | null = null;
let stageSandboxMediaRuntimePromise: Promise<
  typeof import("./stage-sandbox-media.runtime.js")
> | null = null;
let mediaUnderstandingApplyRuntimePromise: Promise<
  typeof import("../../media-understanding/apply.runtime.js")
> | null = null;
let linkUnderstandingApplyRuntimePromise: Promise<
  typeof import("../../link-understanding/apply.runtime.js")
> | null = null;
let commandsCoreRuntimePromise: Promise<typeof import("./commands-core.runtime.js")> | null = null;

function loadSessionResetModelRuntime() {
  sessionResetModelRuntimePromise ??= import("./session-reset-model.runtime.js");
  return sessionResetModelRuntimePromise;
}

function loadStageSandboxMediaRuntime() {
  stageSandboxMediaRuntimePromise ??= import("./stage-sandbox-media.runtime.js");
  return stageSandboxMediaRuntimePromise;
}

function loadMediaUnderstandingApplyRuntime() {
  mediaUnderstandingApplyRuntimePromise ??= import("../../media-understanding/apply.runtime.js");
  return mediaUnderstandingApplyRuntimePromise;
}

function loadLinkUnderstandingApplyRuntime() {
  linkUnderstandingApplyRuntimePromise ??= import("../../link-understanding/apply.runtime.js");
  return linkUnderstandingApplyRuntimePromise;
}

function loadCommandsCoreRuntime() {
  commandsCoreRuntimePromise ??= import("./commands-core.runtime.js");
  return commandsCoreRuntimePromise;
}

let hookRunnerGlobalPromise: Promise<typeof import("../../plugins/hook-runner-global.js")> | null =
  null;
let originRoutingPromise: Promise<typeof import("./origin-routing.js")> | null = null;

function loadHookRunnerGlobal() {
  hookRunnerGlobalPromise ??= import("../../plugins/hook-runner-global.js");
  return hookRunnerGlobalPromise;
}

function loadOriginRouting() {
  originRoutingPromise ??= import("./origin-routing.js");
  return originRoutingPromise;
}

function mergeSkillFilters(channelFilter?: string[], agentFilter?: string[]): string[] | undefined {
  const normalize = (list?: string[]) => {
    if (!Array.isArray(list)) {
      return undefined;
    }
    return normalizeStringEntries(list);
  };
  const channel = normalize(channelFilter);
  const agent = normalize(agentFilter);
  if (!channel && !agent) {
    return undefined;
  }
  if (!channel) {
    return agent;
  }
  if (!agent) {
    return channel;
  }
  if (channel.length === 0 || agent.length === 0) {
    return [];
  }
  const agentSet = new Set(agent);
  return channel.filter((name) => agentSet.has(name));
}

function collectReplyText(reply: ReplyPayload | ReplyPayload[] | undefined): string {
  if (!reply) {
    return "";
  }
  const parts = Array.isArray(reply) ? reply : [reply];
  return parts
    .map((part) => (part && !part.isReasoning && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function auditReplyForLightModelCoherence(params: {
  reply: ReplyPayload | ReplyPayload[] | undefined;
  selection: ConversationRouterModelSelection | null;
  userMessage: string;
}): LightModelCoherenceAuditOutput {
  return auditLightModelCoherence({
    selection: params.selection,
    userMessage: params.userMessage,
    assistantText: collectReplyText(params.reply),
  });
}

export type LightModelQuestionRepair = {
  reply: ReplyPayload | ReplyPayload[] | undefined;
  text: string;
  applied: boolean;
  reason: string;
  questionIntent: LightModelQuestionIntent;
  rawQuestionCount: number;
  rawEndedWithQuestion: boolean;
  internalQuestionCountAfterRepair: number;
};

function buildRequiredLightModelQuestion(userMessage: string): string {
  if (/口语|正式|tone|version|draft|phrase|措辞|话术|草稿|版本/i.test(userMessage)) {
    return /[A-Za-z]/.test(userMessage)
      ? "Do you want the casual version or the formal version?"
      : "你想要口语版，还是正式一点的版本？";
  }
  if (/file|文件/i.test(userMessage)) {
    return /[A-Za-z]/.test(userMessage)
      ? "Which file should we check first?"
      : "你现在要先确认哪个文件？";
  }
  if (
    /priority|choose between|A\s*(?:\/|or)\s*B|report and debug|优先级|二选一|报告.*debug|debug.*报告/i.test(
      userMessage,
    )
  ) {
    return /[A-Za-z]/.test(userMessage)
      ? "Which one is more urgent right now, report work or debugging?"
      : "你现在更急的是报告，还是 debug？";
  }
  if (/code|bug|报错|代码/i.test(userMessage)) {
    return /[A-Za-z]/.test(userMessage)
      ? "Which part is failing right now, the input, the branch, or the output?"
      : "你现在卡在输入、分支判断，还是输出结果？";
  }
  if (/report|materials?|材料|报告/i.test(userMessage)) {
    return /[A-Za-z]/.test(userMessage)
      ? "What part is missing right now, the outline or the materials?"
      : "你现在缺的是提纲，还是材料顺序？";
  }
  if (
    /context|visible state|stale|invalid|missing|mismatch|not visible|上下文|看不到|不可见|不清楚/i.test(
      userMessage,
    )
  ) {
    return /[A-Za-z]/.test(userMessage)
      ? "Which visible item should I use now?"
      : "你现在要我按哪个可见项继续？";
  }
  return /[A-Za-z]/.test(userMessage)
    ? "Which concrete part should we choose first?"
    : "你现在要先定哪一个具体部分？";
}

function replacementForFinalLightQuestion(params: {
  finalSentence: string;
  userMessage: string;
}): string {
  const sentence = params.finalSentence
    .trim()
    .replace(/[?？]\s*$/, "")
    .trim();
  if (!sentence) {
    return "";
  }
  if (/^(?:你觉得呢|你呢|怎么样|可以吗|好吗|行吗|对吗)$/.test(sentence)) {
    return "";
  }
  const directSuggestion = sentence.match(/^(?:你)?要不要(.+)$/);
  if (directSuggestion?.[1]?.trim()) {
    return `可以${directSuggestion[1].trim()}。`;
  }
  const canSuggestion = sentence.match(/^(?:你)?可以(.+)吗$/);
  if (canSuggestion?.[1]?.trim()) {
    return `可以${canSuggestion[1].trim()}。`;
  }
  if (hasDirectPreferenceOrRecommendationShape(params.userMessage)) {
    return "先按你说的偏好来就行。";
  }
  if (/没事|随口|就是问问|只是问问|先不聊|先走|我先去|先睡|算了|不重要/.test(params.userMessage)) {
    return "先这样就好。";
  }
  return `${sentence.replace(/[吗呢吧啊呀]$/u, "").trim()}。`;
}

function stripQuestionSentencesForLightModel(text: string, userMessage: string): string {
  const sentences = text.match(/[^。！？!?]+[。！？!?]?/g) ?? [text];
  const kept = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map((sentence) => {
      if (!/[?？]/.test(sentence)) {
        return sentence;
      }
      return replacementForFinalLightQuestion({ finalSentence: sentence, userMessage });
    })
    .filter(Boolean);
  return (kept.join(" ").replace(/\s+/g, " ").trim() || "先这样就行。").trim();
}

function stripCustomerServiceClosersForLightModel(text: string): string {
  const sentences = text.match(/[^。！？!?.]+[。！？!?.]?/g) ?? [text];
  const kept = sentences
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .filter(
      (sentence) =>
        !/(?:希望.*对你有帮助|请问还(?:有|需要).{0,12}帮(?:你|您)|还有(?:什么|其他).{0,12}(?:可以|需要).{0,12}(?:帮(?:你|您)|帮忙|帮助|协助)|(?:如果|如有|若有).{0,10}(?:需要|其他问题).{0,12}(?:帮忙|帮助|协助|告诉我)|\b(?:anything else|any other questions?)\b.{0,24}\b(?:help|assist)\b|\b(?:anything else|anything more)\b.{0,24}\b(?:i can|can do|need)\b|\b(?:let me know|tell me)\b.{0,24}\b(?:if you need|if there'?s anything|anything else|if you want|if you would like)\b|\bif you(?:'d| would)? like\b.{0,24}\bi can\b|\bhope (?:this|that) helps\b|\b(?:happy|glad) to help\b)/i.test(
          sentence,
        ),
    );
  return (kept.join(" ").replace(/\s+/g, " ").trim() || text.trim()).trim();
}

function appendRequiredLightModelQuestion(params: { text: string; userMessage: string }): string {
  const base = stripQuestionSentencesForLightModel(params.text, params.userMessage)
    .replace(/[?？]\s*$/u, "。")
    .trim();
  const question = buildRequiredLightModelQuestion(params.userMessage);
  const prefix = base || "先把缺口压到一个具体点上。";
  return `${prefix}${/[。！？.!?]$/.test(prefix) ? "" : "。"}${question}`.trim();
}

export function repairLightModelQuestionText(params: {
  text: string;
  userMessage: string;
  avoidQuestion: boolean;
  previousAssistantEndedWithQuestion?: boolean;
}): Omit<LightModelQuestionRepair, "reply"> {
  const originalRaw = params.text.trim();
  const raw = stripCustomerServiceClosersForLightModel(originalRaw);
  const questionIntent = resolveLightModelQuestionIntent(params.userMessage);
  const rawQuestionCount = countDirectQuestions(raw);
  const rawEndedWithQuestion = endsWithDirectQuestion(raw);
  const questionAllowed = shouldAllowSpecificLightModelQuestion({
    userMessage: params.userMessage,
    assistantText: raw,
  });
  if (raw && questionIntent === "FORBID" && rawQuestionCount > 0) {
    const repaired = stripQuestionSentencesForLightModel(raw, params.userMessage);
    const repairedQuestionCount = countDirectQuestions(repaired);
    return {
      text: repaired,
      applied: repaired !== raw,
      reason: "question_intent_forbid_question_repair",
      questionIntent,
      rawQuestionCount,
      rawEndedWithQuestion,
      internalQuestionCountAfterRepair: Math.max(
        0,
        repairedQuestionCount - (endsWithDirectQuestion(repaired) ? 1 : 0),
      ),
    };
  }
  if (
    raw &&
    questionIntent === "REQUIRE_ONE_CONCRETE" &&
    !params.previousAssistantEndedWithQuestion &&
    !questionAllowed
  ) {
    const repaired = appendRequiredLightModelQuestion({
      text: raw,
      userMessage: params.userMessage,
    });
    const repairedQuestionCount = countDirectQuestions(repaired);
    return {
      text: repaired,
      applied: repaired !== raw,
      reason: "question_intent_required_concrete_question_repair",
      questionIntent,
      rawQuestionCount,
      rawEndedWithQuestion,
      internalQuestionCountAfterRepair: Math.max(
        0,
        repairedQuestionCount - (endsWithDirectQuestion(repaired) ? 1 : 0),
      ),
    };
  }
  const mustAvoidQuestion =
    params.avoidQuestion || !questionAllowed || params.previousAssistantEndedWithQuestion === true;
  if (!raw || !rawEndedWithQuestion || !mustAvoidQuestion) {
    return {
      text: raw,
      applied: raw !== originalRaw,
      reason: raw !== originalRaw ? "customer_service_closer_repair" : "",
      questionIntent,
      rawQuestionCount,
      rawEndedWithQuestion,
      internalQuestionCountAfterRepair: Math.max(
        0,
        rawQuestionCount - (rawEndedWithQuestion ? 1 : 0),
      ),
    };
  }

  const sentences = raw.match(/[^。！？!?]+[。！？!?]?/g) ?? [raw];
  const last = sentences[sentences.length - 1] ?? raw;
  const replacement = replacementForFinalLightQuestion({
    finalSentence: last,
    userMessage: params.userMessage,
  });
  const prefix = sentences.length > 1 ? sentences.slice(0, -1).join("").trim() : "";
  const repaired =
    (prefix ? `${prefix}${replacement ? ` ${replacement}` : ""}` : replacement || "先这样就行。")
      .replace(/\s+/g, " ")
      .trim() || "先这样就行。";
  const repairedQuestionCount = countDirectQuestions(repaired);
  const reason = params.previousAssistantEndedWithQuestion
    ? "previous_question_no_consecutive_question_ending"
    : params.avoidQuestion || questionAllowed
      ? "question_throttle_final_visible_repair"
      : "question_permission_gate_final_visible_repair";
  return {
    text: repaired,
    applied: repaired !== raw,
    reason,
    questionIntent,
    rawQuestionCount,
    rawEndedWithQuestion,
    internalQuestionCountAfterRepair: Math.max(
      0,
      repairedQuestionCount - (endsWithDirectQuestion(repaired) ? 1 : 0),
    ),
  };
}

function repairReplyQuestionShape(params: {
  reply: ReplyPayload | ReplyPayload[] | undefined;
  userMessage: string;
  avoidQuestion: boolean;
  previousAssistantEndedWithQuestion?: boolean;
}): LightModelQuestionRepair {
  const currentText = collectReplyText(params.reply);
  const repair = repairLightModelQuestionText({
    text: currentText,
    userMessage: params.userMessage,
    avoidQuestion: params.avoidQuestion,
    previousAssistantEndedWithQuestion: params.previousAssistantEndedWithQuestion,
  });
  if (!repair.applied || !params.reply) {
    return {
      ...repair,
      reply: params.reply,
    };
  }
  if (Array.isArray(params.reply)) {
    return {
      ...repair,
      reply: { text: repair.text },
    };
  }
  if (!params.reply.isReasoning && typeof params.reply.text === "string") {
    return {
      ...repair,
      reply: { ...params.reply, text: repair.text },
    };
  }
  return {
    ...repair,
    reply: { text: repair.text },
  };
}

type PreparedReplyRunParams = Parameters<typeof runPreparedReply>[0];

function mergeAuditForMainEscalation(params: {
  first: LightModelCoherenceAuditOutput;
  second?: LightModelCoherenceAuditOutput;
  repeatedFailure?: boolean;
}): LightModelCoherenceAuditOutput {
  const flags = Array.from(
    new Set([
      ...params.first.flags,
      ...(params.second?.flags ?? []),
      ...(params.repeatedFailure ? ["repeated_coherence_failure"] : []),
    ]),
  );
  const status =
    params.first.audit_status === "SAFETY_ESCALATE" ||
    params.second?.audit_status === "SAFETY_ESCALATE"
      ? "SAFETY_ESCALATE"
      : "ESCALATE_MAIN_MODEL";
  return {
    audit_status: status,
    flags,
    reason: flags,
    forbidden_patterns_detected: flags,
    no_raw_text_logged: true,
  };
}

async function runPreparedReplyWithCoherenceGuard(params: {
  runParams: PreparedReplyRunParams;
  selection: ConversationRouterModelSelection | null;
  userMessage: string;
  defaultProvider: string;
  defaultModel: string;
  traceTimings?: ConversationRouterTraceTimings;
  generationTrace?: ConversationRouterGenerationTrace;
}): Promise<{
  reply: ReplyPayload | ReplyPayload[] | undefined;
  audit: LightModelCoherenceAuditOutput;
  actualProvider: string;
  actualModel: string;
  rewriteAttempted: boolean;
  escalated: boolean;
  questionRepair: LightModelQuestionRepair;
  questionPermissionGranted: boolean;
  previousAssistantEndedWithQuestion: boolean;
}> {
  const trace =
    params.traceTimings && params.generationTrace
      ? { timings: params.traceTimings, generation: params.generationTrace }
      : undefined;
  const questionState = resolveLightModelQuestionState({
    ctx: params.runParams.ctx,
    sessionKey: params.runParams.sessionKey,
    text: params.userMessage,
    enabled: params.selection?.route.recommended_model === "light_model",
  });
  const firstRawReply = await runPreparedReply({ ...params.runParams, trace });
  const firstRepair = repairReplyQuestionShape({
    reply: firstRawReply,
    userMessage: params.userMessage,
    avoidQuestion: questionState.avoidQuestion,
    previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
  });
  params.traceTimings && (params.traceTimings.auditStartMs ??= Date.now());
  const firstAudit = auditReplyForLightModelCoherence({
    reply: firstRepair.reply,
    selection: params.selection,
    userMessage: params.userMessage,
  });
  params.traceTimings && (params.traceTimings.auditEndMs = Date.now());
  if (firstAudit.audit_status === "PASS") {
    updateDirectQuestionState(questionState.key, firstRepair.text);
    return {
      reply: firstRepair.reply,
      audit: firstAudit,
      actualProvider: params.runParams.provider,
      actualModel: params.runParams.model,
      rewriteAttempted: false,
      escalated: false,
      questionRepair: firstRepair,
      questionPermissionGranted: questionState.questionPermissionGranted,
      previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
    };
  }
  if (firstAudit.audit_status === "REWRITE_LIGHT_MODEL") {
    params.traceTimings && (params.traceTimings.rewriteStartMs = Date.now());
    const rewriteRawReply = await runPreparedReply({
      ...params.runParams,
      trace,
      lightModelRewriteInstruction: buildLightModelRewriteInstruction({
        failedAssistantText: collectReplyText(firstRepair.reply),
        flags: firstAudit.flags,
      }),
    });
    const rewriteRepair = repairReplyQuestionShape({
      reply: rewriteRawReply,
      userMessage: params.userMessage,
      avoidQuestion: questionState.avoidQuestion,
      previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
    });
    params.traceTimings && (params.traceTimings.rewriteEndMs = Date.now());
    params.traceTimings && (params.traceTimings.auditStartMs ??= Date.now());
    const rewriteAudit = auditReplyForLightModelCoherence({
      reply: rewriteRepair.reply,
      selection: params.selection,
      userMessage: params.userMessage,
    });
    params.traceTimings && (params.traceTimings.auditEndMs = Date.now());
    if (rewriteAudit.audit_status === "PASS") {
      updateDirectQuestionState(questionState.key, rewriteRepair.text);
      return {
        reply: rewriteRepair.reply,
        audit: rewriteAudit,
        actualProvider: params.runParams.provider,
        actualModel: params.runParams.model,
        rewriteAttempted: true,
        escalated: false,
        questionRepair: rewriteRepair,
        questionPermissionGranted: questionState.questionPermissionGranted,
        previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
      };
    }
    const mainReply = await runPreparedReply({
      ...params.runParams,
      trace,
      provider: params.defaultProvider,
      model: params.defaultModel,
      modelState: createFastTestModelSelectionState({
        agentCfg: params.runParams.agentCfg,
        provider: params.defaultProvider,
        model: params.defaultModel,
      }),
      lightModelRewriteInstruction: undefined,
    });
    updateDirectQuestionState(questionState.key, collectReplyText(mainReply));
    return {
      reply: mainReply,
      audit: mergeAuditForMainEscalation({
        first: firstAudit,
        second: rewriteAudit,
        repeatedFailure: true,
      }),
      actualProvider: params.defaultProvider,
      actualModel: params.defaultModel,
      rewriteAttempted: true,
      escalated: true,
      questionRepair: rewriteRepair,
      questionPermissionGranted: questionState.questionPermissionGranted,
      previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
    };
  }
  const mainReply = await runPreparedReply({
    ...params.runParams,
    trace,
    provider: params.defaultProvider,
    model: params.defaultModel,
    modelState: createFastTestModelSelectionState({
      agentCfg: params.runParams.agentCfg,
      provider: params.defaultProvider,
      model: params.defaultModel,
    }),
    lightModelRewriteInstruction: undefined,
  });
  updateDirectQuestionState(questionState.key, collectReplyText(mainReply));
  return {
    reply: mainReply,
    audit: firstAudit,
    actualProvider: params.defaultProvider,
    actualModel: params.defaultModel,
    rewriteAttempted: false,
    escalated: true,
    questionRepair: firstRepair,
    questionPermissionGranted: questionState.questionPermissionGranted,
    previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
  };
}

function hasLinkCandidate(ctx: MsgContext): boolean {
  const message = ctx.BodyForCommands ?? ctx.CommandBody ?? ctx.RawBody ?? ctx.Body;
  if (!message) {
    return false;
  }
  return /\bhttps?:\/\/\S+/i.test(message);
}

function buildConversationRouterRouteContext(params: {
  ctx: MsgContext;
  finalized: MsgContext;
  source?: string;
}): {
  recentVisibleContextSummary?: string;
  surfaceContext?: Record<string, unknown>;
  contextReadiness?: string;
  contextNoRawText: true;
} {
  const source = (params.source ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  const contextEntries = [
    ...normalizeStringEntries(params.ctx.UntrustedContext),
    ...normalizeStringEntries(params.finalized.UntrustedContext),
  ]
    .map((entry) => entry.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-4)
    .map((entry) => entry.slice(0, 320));
  const recentVisibleContextSummary = [...new Set(contextEntries)].join("\n");
  const syntheticSurface = source === "desktop_synthetic" || source === "mixed_synthetic";
  return {
    recentVisibleContextSummary: recentVisibleContextSummary || undefined,
    surfaceContext: source
      ? {
          surface_type: source,
          synthetic_surface: syntheticSurface,
        }
      : undefined,
    contextReadiness: recentVisibleContextSummary
      ? "ready"
      : syntheticSurface
        ? "missing"
        : undefined,
    contextNoRawText: true,
  };
}

const DIRECT_QWEN_FAST_PATH_ESCALATE_TOKEN = "__ESCALATE_MAIN_MODEL__";
const directQwenQuestionState = new Map<
  string,
  { lastEndedWithQuestion: boolean; recentQuestionCount: number; updatedAt: number }
>();
const directQwenRecentVisibleContextState = new Map<
  string,
  { entries: Array<{ sender: string; body: string }>; updatedAt: number }
>();

type DirectQwenFastPathInput = {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  selection: ConversationRouterModelSelection | null;
  sessionKey: string;
  userMessage: string;
  resetTriggered: boolean;
  commandSource: string;
  allowTextCommands: boolean;
  skillCommands?: unknown[];
  inlineStatusRequested?: boolean;
  hasMedia: boolean;
  hasLink: boolean;
  earlyTypingMs?: number | null;
  traceTimings: ConversationRouterTraceTimings;
  generationTrace: ConversationRouterGenerationTrace;
};

type DirectQwenFastPathResult = {
  kind: "reply" | "reject" | "fallback_main";
  reason: string;
  reply?: ReplyPayload;
  audit?: LightModelCoherenceAuditOutput;
  rewriteAttempted?: boolean;
  escalated?: boolean;
  questionRepair?: LightModelQuestionRepair;
  questionPermissionGranted?: boolean;
  previousAssistantEndedWithQuestion?: boolean;
};

function rejectDirectQwenFastPath(params: {
  generationTrace: ConversationRouterGenerationTrace;
  reason: string;
}): DirectQwenFastPathResult {
  params.generationTrace.directFastPathUsed = false;
  params.generationTrace.fastPathRejectedReason = params.reason;
  return { kind: "reject", reason: params.reason };
}

function resolveDirectQwenFastPathRejection(params: DirectQwenFastPathInput): string | null {
  const selection = params.selection;
  if (!selection) {
    return "NO_ROUTER_SELECTION";
  }
  if (selection.source !== "discord") {
    return "NON_DISCORD_SOURCE";
  }
  if (
    selection.provider !== CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER ||
    selection.model !== CONVERSATION_ROUTER_LIGHT_MODEL_ID ||
    selection.route.recommended_model !== "light_model"
  ) {
    return "NOT_QWEN_LIGHT_MODEL";
  }
  if (selection.route.safety_risk !== "LOW") {
    return "SAFETY_NOT_LOW";
  }
  if (selection.route.escalation_reason.length > 0) {
    return "ROUTER_ESCALATION_REASON";
  }
  if (selection.route.requires_cooldown) {
    return "ROUTER_COOLDOWN";
  }
  if (selection.route.confidence < 0.7) {
    return "ROUTER_LOW_CONFIDENCE";
  }
  const casual = selection.route.mode === "CASUAL";
  const lowTask = selection.route.mode === "TASK" && selection.route.task_complexity === "LOW";
  if (!casual && !lowTask) {
    return "ROUTE_NOT_FAST_SAFE";
  }
  if (params.resetTriggered) {
    return "SESSION_RESET";
  }
  if (params.hasMedia) {
    return "MEDIA_REQUIRES_FULL_PATH";
  }
  if (params.hasLink) {
    return "LINK_REQUIRES_FULL_PATH";
  }
  if (params.inlineStatusRequested) {
    return "INLINE_STATUS_REQUIRES_FULL_PATH";
  }
  if (Array.isArray(params.skillCommands) && params.skillCommands.length > 0) {
    return "SKILL_COMMAND_REQUIRES_FULL_PATH";
  }
  const policySensitive =
    /(?:private-chat|private chat|memory|长期记忆|记忆里|记忆系统|上下文策略|历史记录|callback|eventgen|p2|persona|soul\.md|yuan|宋予安|主模型|轻模型|9b|router|路由|训练|lora|qlora)/i;
  if (policySensitive.test(params.userMessage)) {
    return "POLICY_SENSITIVE_REQUIRES_FULL_PATH";
  }
  return null;
}

function resolveDirectOllamaBaseUrl(cfg: OpenClawConfig): string | null {
  const configured = cfg.models?.providers?.[CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER]?.baseUrl;
  const raw = (configured?.trim() || "http://127.0.0.1:11434").replace(/\/v1\/?$/i, "");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    return null;
  }
  return raw.replace(/\/+$/, "");
}

function resolveDirectQuestionStateKey(ctx: MsgContext, fallbackSessionKey?: string): string {
  return (
    normalizeOptionalString(fallbackSessionKey) ??
    normalizeOptionalString(ctx.SessionKey) ??
    normalizeOptionalString(ctx.MessageSid) ??
    normalizeOptionalString(ctx.SenderId) ??
    "discord-default"
  );
}

function hasDirectPreferenceOrRecommendationShape(text: string): boolean {
  return /我一般|我比较|我喜欢|我不想|不想看|不太想|我偏|我吃|想找|想看|没书可看|书推荐|轻松|不费脑|架空|小说|游戏|消遣|放松|悲剧|冒险感|学院|设定|别太/.test(
    text,
  );
}

function countDirectQuestions(text: string): number {
  return (text.match(/[?？]/g) ?? []).length;
}

function endsWithDirectQuestion(text: string): boolean {
  return /[?？]\s*$/.test(text.trim());
}

function resolveDirectAvoidQuestion(
  ctx: MsgContext,
  text: string,
  fallbackSessionKey?: string,
): {
  key: string;
  avoidQuestion: boolean;
  questionPermissionGranted: boolean;
  questionIntent: LightModelQuestionIntent;
  previousAssistantEndedWithQuestion: boolean;
  reason: string;
} {
  const key = resolveDirectQuestionStateKey(ctx, fallbackSessionKey);
  const state = directQwenQuestionState.get(key);
  const softClose = /没事|随口|就是问问|只是问问|先不聊|先走|我先去|先睡|算了|不重要/.test(text);
  const preference = hasDirectPreferenceOrRecommendationShape(text);
  const questionIntent = resolveLightModelQuestionIntent(text);
  const questionPermissionGranted = questionIntent !== "FORBID";
  const previousAssistantEndedWithQuestion = state?.lastEndedWithQuestion === true;
  const throttleRequired =
    softClose ||
    preference ||
    previousAssistantEndedWithQuestion ||
    (state?.recentQuestionCount ?? 0) >= 2;
  return {
    key,
    avoidQuestion: throttleRequired || !questionPermissionGranted,
    questionPermissionGranted,
    questionIntent,
    previousAssistantEndedWithQuestion,
    reason: previousAssistantEndedWithQuestion
      ? "previous_question_no_consecutive_question_ending"
      : throttleRequired || !questionPermissionGranted
        ? "question_permission_gate"
        : "",
  };
}

function resolveLightModelQuestionState(params: {
  ctx: MsgContext;
  sessionKey?: string;
  text: string;
  enabled: boolean;
}): {
  key: string;
  avoidQuestion: boolean;
  questionPermissionGranted: boolean;
  questionIntent: LightModelQuestionIntent;
  previousAssistantEndedWithQuestion: boolean;
  reason: string;
} {
  const state = resolveDirectAvoidQuestion(params.ctx, params.text, params.sessionKey);
  if (params.enabled) {
    return state;
  }
  return {
    ...state,
    avoidQuestion: false,
    previousAssistantEndedWithQuestion: false,
    reason: "",
  };
}

function updateDirectQuestionState(key: string, text: string): void {
  const cleaned = text.trim();
  if (!cleaned) {
    return;
  }
  const questionEnding = endsWithDirectQuestion(cleaned);
  const previous = directQwenQuestionState.get(key);
  const recentQuestionCount = Math.max(
    0,
    Math.min(3, (previous?.recentQuestionCount ?? 0) + (questionEnding ? 1 : -1)),
  );
  directQwenQuestionState.set(key, {
    lastEndedWithQuestion: questionEnding,
    recentQuestionCount,
    updatedAt: Date.now(),
  });
  if (directQwenQuestionState.size > 500) {
    for (const [entryKey, entry] of directQwenQuestionState.entries()) {
      if (Date.now() - entry.updatedAt > 6 * 60 * 60 * 1000) {
        directQwenQuestionState.delete(entryKey);
      }
    }
  }
}

function getDirectRecentSessionContext(key: string): string[] {
  const state = directQwenRecentVisibleContextState.get(key);
  if (!state) {
    return [];
  }
  if (Date.now() - state.updatedAt > 6 * 60 * 60 * 1000) {
    directQwenRecentVisibleContextState.delete(key);
    return [];
  }
  return state.entries
    .slice(-4)
    .map((entry) => `${entry.sender}: ${entry.body.slice(0, 240)}`)
    .filter(Boolean);
}

function updateDirectRecentSessionContext(key: string, text: string): void {
  const body = text.replace(/\s+/g, " ").trim();
  if (!body) {
    return;
  }
  const previous = directQwenRecentVisibleContextState.get(key);
  const entries = [...(previous?.entries ?? []), { sender: "user", body }].slice(-6);
  directQwenRecentVisibleContextState.set(key, { entries, updatedAt: Date.now() });
  if (directQwenRecentVisibleContextState.size > 500) {
    for (const [entryKey, entry] of directQwenRecentVisibleContextState.entries()) {
      if (Date.now() - entry.updatedAt > 6 * 60 * 60 * 1000) {
        directQwenRecentVisibleContextState.delete(entryKey);
      }
    }
  }
}

function buildDirectQwenFastPathMessages(params: {
  ctx: MsgContext;
  userMessage: string;
  routeMode: string;
  avoidQuestion?: boolean;
  questionIntent?: LightModelQuestionIntent;
  rewriteInstruction?: string;
  previousAssistantText?: string;
  recentSessionContext?: string[];
}): Array<{ role: "system" | "user"; content: string }> {
  const recentHistory = Array.isArray(params.ctx.InboundHistory)
    ? params.ctx.InboundHistory.slice(-4)
        .map((entry) => {
          const sender = typeof entry.sender === "string" ? entry.sender.slice(0, 24) : "unknown";
          const body = typeof entry.body === "string" ? entry.body.replace(/\s+/g, " ").trim() : "";
          return body ? `${sender}: ${body.slice(0, 240)}` : "";
        })
        .filter(Boolean)
    : [];
  const recentSessionContext = Array.isArray(params.recentSessionContext)
    ? params.recentSessionContext
    : [];
  const recentVisibleContext = [...recentHistory, ...recentSessionContext]
    .filter(Boolean)
    .filter((entry, index, array) => array.indexOf(entry) === index)
    .slice(-4);
  const system = [
    "低风险日常快速回复约束：保持同一个宋予安/AI friend 语气；这不是新 persona，不改变关系、记忆或安全边界。",
    "按 question_intent 决定是否问：FORBID=不要出现任何问句；ALLOW_OPTIONAL=默认自然收住，只在当前缺口很明确时问一个具体问题；REQUIRE_ONE_CONCRETE=先给内容，最后问一个具体、低负担、能补齐缺口的问题。",
    "先给内容，再考虑轻问；不要为了保守而永远不问。用户明确要求提问，或当前请求缺少关键细节且一问能明显推进时，最后允许一个具体澄清问题。上一轮问过或用户已给偏好时，本轮不追问。",
    "允许的轻问必须具体，指向当前缺口，最好给出二选一或明确范围；不要用“你觉得呢/怎么样/要不要/什么类型/可以说一下”等泛泛问题收尾。",
    "不要只回“好/行/可以/嗯”这类短句；非琐碎 daily/desktop/mixed 通常用 2 个紧凑句子：先给贴当前话题的判断/措辞/下一步，再补一个具体细节或自然收住。",
    "desktop/mixed/task 行要带上可见对象词，例如 file、step、draft、version、tone、report、code、material、checklist；缺一个关键细节时，最后可以用 which/what/where/when/how many/how long 或 A/B 选项问一个具体问题。",
    "用户说喜欢/不想/想找某类东西时，直接给具体方向、判断或建议，不把球踢回去。",
    "Synthetic-only 低风险行只按可见文字回应；visible summary、grounded/supportive/practical response、asks for help、wants a、mentions a 这类泛化标签本身不允许追问。只有可见文字明确需要 how to phrase、choose/which/version、missing key constraints、code/report/materials stuck，或 desktop checklist 同时问 how/choose/which/where/what next 时，才可以用一个具体问题补齐缺口；不要提 scoring metadata。",
    "用户说没事、随口、先不聊、先走或先睡时，低压力收住，不再用问题把话题钩回来。",
    "轻松话题保持轻松，不心理化或沉重化；不要说“现实重担”“现实负担”“情绪负担”“心理负担”“你的感受是合理的”“我能理解你的感受”。",
    "不要客服化、治疗师化、恋爱依赖化；不用“您”“感谢分享”“这真是个好问题”“有什么可以帮您”“anything else I can help with”“hope this helps”。",
    "不编造用户现实事件；没有明确 world_state 时，不生成具体朋友、地点、项目、实验、午饭等自我世界细节。",
    "用户问你是否也被班群、老师、实验、项目等现实设定烦到时，不承认自己有这些具体外部事件；用“这类消息/这种事”低具体度接住，不复述成自己的设定。",
    "允许自然熟悉，但不要模仿现实朋友，不复制真人的语气、人格、角色或关系位置。",
    "日常 1-3 句，具体但不铺陈；深谈、高风险、关系边界、direct affect、Yuan/persona/朋友模仿边界或复杂任务交主模型。",
    `如果话题需要深谈、高风险、关系边界、direct affect、Yuan/persona/朋友模仿边界或复杂任务，只输出 ${DIRECT_QWEN_FAST_PATH_ESCALATE_TOKEN}。`,
  ].join("\n");
  const userParts = [
    `route_mode: ${params.routeMode}`,
    `question_intent: ${params.questionIntent ?? "ALLOW_OPTIONAL"}`,
    params.avoidQuestion
      ? "reply_shape: content_first_no_question_ending"
      : "reply_shape: content_first_one_specific_question_optional",
    recentVisibleContext.length > 0
      ? `recent_visible_context:\n${recentVisibleContext.join("\n")}`
      : "recent_visible_context: none",
    params.rewriteInstruction ? `rewrite_instruction:\n${params.rewriteInstruction}` : "",
    params.previousAssistantText
      ? `previous_failed_reply:\n${params.previousAssistantText.slice(0, 600)}`
      : "",
    `current_user_message:\n${params.userMessage}`,
  ].filter(Boolean);
  return [
    { role: "system", content: system },
    { role: "user", content: userParts.join("\n\n") },
  ];
}

function estimateDirectFastPathTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function stableDirectPacingJitter(text: string): number {
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc + text.charCodeAt(i) * (i + 17)) % 9973;
  }
  return acc % 450;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function resolveDirectQwenHumanPacing(params: {
  text: string;
  generationTrace: ConversationRouterGenerationTrace;
}): { delayMs: number; targetMs: number } {
  const trimmed = params.text.trim();
  const charCount = Math.min(80, Math.max(2, trimmed.length));
  const currentModelMs =
    typeof params.generationTrace.ollamaTotalMs === "number"
      ? params.generationTrace.ollamaTotalMs
      : typeof params.generationTrace.modelGenerationMs === "number"
        ? params.generationTrace.modelGenerationMs
        : 0;
  const targetMs = clampNumber(
    1_050 + charCount * 34 + stableDirectPacingJitter(trimmed),
    1_250,
    4_200,
  );
  return {
    targetMs,
    delayMs: clampNumber(targetMs - currentModelMs, 0, 3_400),
  };
}

async function applyDirectQwenHumanPacing(params: {
  text: string;
  generationTrace: ConversationRouterGenerationTrace;
}): Promise<void> {
  const pacing = resolveDirectQwenHumanPacing(params);
  params.generationTrace.humanPacingTargetMs = pacing.targetMs;
  params.generationTrace.humanPacingMs = pacing.delayMs;
  params.generationTrace.humanPacingApplied = pacing.delayMs > 0;
  params.generationTrace.humanPacingReason = "direct_qwen_fast_path_human_cadence";
  if (pacing.delayMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, pacing.delayMs));
}

async function callDirectQwenOllama(params: {
  cfg: OpenClawConfig;
  messages: Array<{ role: "system" | "user"; content: string }>;
  numPredict: number;
  timeoutMs?: number;
  temperature?: number;
  traceTimings: ConversationRouterTraceTimings;
  generationTrace: ConversationRouterGenerationTrace;
}): Promise<{ text: string; ollamaMs: number }> {
  const baseUrl = resolveDirectOllamaBaseUrl(params.cfg);
  if (!baseUrl) {
    throw new Error("direct_qwen_ollama_base_unavailable");
  }
  const started = Date.now();
  params.traceTimings.modelRequestStartMs = started;
  params.traceTimings.ollamaRequestSentMs = started;
  params.generationTrace.numPredict = params.numPredict;
  params.generationTrace.thinkEffective = false;
  params.generationTrace.qwenFastDeadlineMs = params.timeoutMs ?? 10_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 10_000);
  try {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: CONVERSATION_ROUTER_LIGHT_MODEL_ID,
        stream: false,
        think: false,
        keep_alive: "15m",
        messages: params.messages,
        options: {
          num_predict: params.numPredict,
          temperature: params.temperature ?? 0.55,
          top_p: 0.9,
        },
      }),
      signal: controller.signal,
    });
    params.traceTimings.ollamaResponseStartMs ??= Date.now();
    const data = (await response.json().catch(() => null)) as {
      message?: { content?: unknown };
      response?: unknown;
      done?: unknown;
    } | null;
    if (!response.ok) {
      throw new Error(`direct_qwen_ollama_http_${response.status}`);
    }
    const content =
      typeof data?.message?.content === "string"
        ? data.message.content
        : typeof data?.response === "string"
          ? data.response
          : "";
    const text = content.trim();
    if (!text) {
      throw new Error("direct_qwen_empty_response");
    }
    const ended = Date.now();
    params.traceTimings.ollamaResponseEndMs = ended;
    const ollamaMs = ended - started;
    params.generationTrace.modelGenerationMs = ollamaMs;
    params.generationTrace.ollamaTotalMs = ollamaMs;
    params.generationTrace.completionTokenEstimate = estimateDirectFastPathTokens(text);
    return { text, ollamaMs };
  } finally {
    clearTimeout(timeout);
  }
}

async function callDirectQwenWithRetry(params: {
  cfg: OpenClawConfig;
  messages: Array<{ role: "system" | "user"; content: string }>;
  numPredict: number;
  traceTimings: ConversationRouterTraceTimings;
  generationTrace: ConversationRouterGenerationTrace;
}): Promise<{ text: string; ollamaMs: number; source: "first_call" | "retry_call" }> {
  params.generationTrace.timeoutTriggered = false;
  params.generationTrace.retryAttempted = false;
  params.generationTrace.retrySuccess = false;
  params.generationTrace.retryCount = 0;
  params.generationTrace.finalResponseSource = "first_call";
  try {
    const first = await callDirectQwenOllama({
      ...params,
      timeoutMs: 10_000,
    });
    return { ...first, source: "first_call" };
  } catch {
    params.generationTrace.timeoutTriggered = true;
    params.generationTrace.retryAttempted = true;
    params.generationTrace.retryModel = CONVERSATION_ROUTER_LIGHT_MODEL_ID;
    params.generationTrace.retryNumPredict = 64;
    params.generationTrace.retryCount = 1;
    const retry = await callDirectQwenOllama({
      ...params,
      numPredict: 64,
      timeoutMs: 6_000,
      temperature: 0.45,
    });
    params.generationTrace.retrySuccess = true;
    params.generationTrace.finalResponseSource = "retry_call";
    return { ...retry, source: "retry_call" };
  }
}

async function tryDirectQwenCasualFastPath(
  params: DirectQwenFastPathInput,
): Promise<DirectQwenFastPathResult> {
  const rejection = resolveDirectQwenFastPathRejection(params);
  if (rejection) {
    return rejectDirectQwenFastPath({
      generationTrace: params.generationTrace,
      reason: rejection,
    });
  }
  const numPredict = params.selection?.route.mode === "TASK" ? 224 : 128;
  const questionState = resolveDirectAvoidQuestion(
    params.ctx,
    params.userMessage,
    params.sessionKey,
  );
  const recentSessionContext = getDirectRecentSessionContext(questionState.key);
  const contextStarted = Date.now();
  params.traceTimings.contextStartMs = contextStarted;
  const messages = buildDirectQwenFastPathMessages({
    ctx: params.ctx,
    userMessage: params.userMessage,
    routeMode: params.selection?.route.mode ?? "CASUAL",
    avoidQuestion: questionState.avoidQuestion,
    questionIntent: questionState.questionIntent,
    recentSessionContext,
  });
  const contextText = messages.map((message) => message.content).join("\n\n");
  const contextEnded = Date.now();
  params.traceTimings.contextEndMs = contextEnded;
  params.generationTrace.directFastPathUsed = true;
  params.generationTrace.fastPathRejectedReason = "";
  params.generationTrace.activeSessionPromptBypassed = true;
  params.generationTrace.piRuntimeBypassed = true;
  params.generationTrace.toolRegistryLoaded = false;
  params.generationTrace.pluginRuntimeLoaded = false;
  params.generationTrace.fullMemoryBlockingRead = false;
  params.generationTrace.fastContextMs = contextEnded - contextStarted;
  params.generationTrace.contextCharCount = contextText.length;
  params.generationTrace.promptTokenEstimate = estimateDirectFastPathTokens(contextText);
  params.generationTrace.memoryItemCount = Array.isArray(params.ctx.InboundHistory)
    ? Math.min(params.ctx.InboundHistory.length, 4)
    : 0;
  params.generationTrace.generationCallCount = 1;
  params.generationTrace.piRuntimePrepCacheHit = null;
  params.generationTrace.piRuntimePrepCacheKey = "direct-qwen35-casual-v2-persona-pack";
  params.generationTrace.piRuntimePrepMs = 0;
  params.generationTrace.pluginDepsLoadMs = 0;
  params.generationTrace.toolRegistryMs = 0;
  params.generationTrace.systemPromptScaffoldMs = params.generationTrace.fastContextMs;
  params.generationTrace.cacheInvalidationReason = "";

  try {
    const first = await callDirectQwenWithRetry({
      cfg: params.cfg,
      messages,
      numPredict,
      traceTimings: params.traceTimings,
      generationTrace: params.generationTrace,
    });
    if (first.text.includes(DIRECT_QWEN_FAST_PATH_ESCALATE_TOKEN)) {
      return { kind: "fallback_main", reason: "MODEL_REQUESTED_ESCALATION", escalated: true };
    }
    const firstTextRepair = repairLightModelQuestionText({
      text: first.text,
      userMessage: params.userMessage,
      avoidQuestion: questionState.avoidQuestion,
      previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
    });
    const firstReply: ReplyPayload = { text: firstTextRepair.text };
    params.traceTimings.auditStartMs = Date.now();
    const firstAudit = auditReplyForLightModelCoherence({
      reply: firstReply,
      selection: params.selection,
      userMessage: params.userMessage,
    });
    params.traceTimings.auditEndMs = Date.now();
    if (firstAudit.audit_status === "PASS") {
      updateDirectQuestionState(questionState.key, firstTextRepair.text);
      updateDirectRecentSessionContext(questionState.key, params.userMessage);
      await applyDirectQwenHumanPacing({
        text: firstTextRepair.text,
        generationTrace: params.generationTrace,
      });
      return {
        kind: "reply",
        reason: "NONE",
        reply: firstReply,
        audit: firstAudit,
        rewriteAttempted: false,
        escalated: false,
        questionRepair: { ...firstTextRepair, reply: firstReply },
        questionPermissionGranted: questionState.questionPermissionGranted,
        previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
      };
    }
    if (firstAudit.audit_status === "REWRITE_LIGHT_MODEL") {
      params.generationTrace.generationCallCount = 2;
      params.traceTimings.rewriteStartMs = Date.now();
      const rewriteMessages = buildDirectQwenFastPathMessages({
        ctx: params.ctx,
        userMessage: params.userMessage,
        routeMode: params.selection?.route.mode ?? "CASUAL",
        questionIntent: questionState.questionIntent,
        recentSessionContext,
        rewriteInstruction:
          buildLightModelRewriteInstruction({
            failedAssistantText: firstTextRepair.text,
            flags: firstAudit.flags,
          }) + (questionState.avoidQuestion ? "\n不要以问题结尾；先给具体内容或建议。" : ""),
        previousAssistantText: firstTextRepair.text,
      });
      const rewritten = await callDirectQwenWithRetry({
        cfg: params.cfg,
        messages: rewriteMessages,
        numPredict: 64,
        traceTimings: params.traceTimings,
        generationTrace: params.generationTrace,
      });
      params.traceTimings.rewriteEndMs = Date.now();
      if (rewritten.text.includes(DIRECT_QWEN_FAST_PATH_ESCALATE_TOKEN)) {
        return {
          kind: "fallback_main",
          reason: "AUDIT_REWRITE_MODEL_REQUESTED_ESCALATION",
          audit: firstAudit,
          rewriteAttempted: true,
          escalated: true,
        };
      }
      const rewriteTextRepair = repairLightModelQuestionText({
        text: rewritten.text,
        userMessage: params.userMessage,
        avoidQuestion: questionState.avoidQuestion,
        previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
      });
      const rewriteReply: ReplyPayload = { text: rewriteTextRepair.text };
      params.traceTimings.auditStartMs = Date.now();
      const rewriteAudit = auditReplyForLightModelCoherence({
        reply: rewriteReply,
        selection: params.selection,
        userMessage: params.userMessage,
      });
      params.traceTimings.auditEndMs = Date.now();
      if (rewriteAudit.audit_status === "PASS") {
        updateDirectQuestionState(questionState.key, rewriteTextRepair.text);
        updateDirectRecentSessionContext(questionState.key, params.userMessage);
        await applyDirectQwenHumanPacing({
          text: rewriteTextRepair.text,
          generationTrace: params.generationTrace,
        });
        return {
          kind: "reply",
          reason: "NONE",
          reply: rewriteReply,
          audit: rewriteAudit,
          rewriteAttempted: true,
          escalated: false,
          questionRepair: { ...rewriteTextRepair, reply: rewriteReply },
          questionPermissionGranted: questionState.questionPermissionGranted,
          previousAssistantEndedWithQuestion: questionState.previousAssistantEndedWithQuestion,
        };
      }
      return {
        kind: "fallback_main",
        reason: "AUDIT_REWRITE_FAILED",
        audit: mergeAuditForMainEscalation({
          first: firstAudit,
          second: rewriteAudit,
          repeatedFailure: true,
        }),
        rewriteAttempted: true,
        escalated: true,
      };
    }
    return {
      kind: "fallback_main",
      reason: "AUDIT_ESCALATED",
      audit: firstAudit,
      rewriteAttempted: false,
      escalated: true,
    };
  } catch {
    params.generationTrace.directFastPathUsed = false;
    params.generationTrace.fastPathRejectedReason = "DIRECT_QWEN_ERROR";
    return { kind: "fallback_main", reason: "DIRECT_QWEN_ERROR", escalated: true };
  }
}

async function applyMediaUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentDir?: string;
  activeModel: { provider: string; model: string };
}): Promise<boolean> {
  if (!hasInboundMedia(params.ctx)) {
    return false;
  }
  const { applyMediaUnderstanding } = await loadMediaUnderstandingApplyRuntime();
  await applyMediaUnderstanding(params);
  return true;
}

async function applyLinkUnderstandingIfNeeded(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
}): Promise<boolean> {
  if (!hasLinkCandidate(params.ctx)) {
    return false;
  }
  const { applyLinkUnderstanding } = await loadLinkUnderstandingApplyRuntime();
  await applyLinkUnderstanding(params);
  return true;
}

export async function getReplyFromConfig(
  ctx: MsgContext,
  opts?: GetReplyOptions,
  configOverride?: OpenClawConfig,
): Promise<ReplyPayload | ReplyPayload[] | undefined> {
  const pretypingTrace = (ctx as MsgContext & DiscordPretypingTraceContext).PretypingTrace;
  const routerTraceId =
    typeof pretypingTrace?.traceId === "string" && pretypingTrace.traceId
      ? pretypingTrace.traceId
      : randomUUID();
  const routerTraceTimings: ConversationRouterTraceTimings = {
    discordMessageCreatedMs: pretypingTrace?.discordMessageCreatedMs ?? null,
    discordEventReceivedMs: pretypingTrace?.discordEventReceivedMs ?? Date.now(),
    replyGateStartMs: pretypingTrace?.replyGateStartMs ?? null,
    replyGateEndMs: pretypingTrace?.replyGateEndMs ?? null,
    replyJobEnqueuedMs: pretypingTrace?.replyJobEnqueuedMs ?? null,
    replyJobStartedMs: pretypingTrace?.replyJobStartedMs ?? null,
    typingSendStartMs: pretypingTrace?.typingSendStartMs ?? null,
    typingSendEndMs: pretypingTrace?.typingSendEndMs ?? null,
    typingSendError: pretypingTrace?.typingSendError ?? null,
    discordSendStartMs: pretypingTrace?.discordReplySendStartMs ?? null,
    discordSendEndMs: pretypingTrace?.discordReplySendEndMs ?? null,
    queueName: pretypingTrace?.queueName ?? null,
    queueDepthAtEnqueue: pretypingTrace?.queueDepthAtEnqueue ?? null,
    queueDepthAtStart: pretypingTrace?.queueDepthAtStart ?? null,
    activeJobs: pretypingTrace?.activeJobs ?? null,
  };
  const routerGenerationTrace: ConversationRouterGenerationTrace = {};
  const isFastTestEnv = process.env.OPENCLAW_TEST_FAST === "1";
  const cfg = resolveGetReplyConfig({
    loadConfig,
    isFastTestEnv,
    configOverride,
  });
  const useFastTestBootstrap = shouldUseReplyFastTestBootstrap({
    isFastTestEnv,
    configOverride,
  });
  const useFastTestRuntime = shouldUseReplyFastTestRuntime({
    cfg,
    isFastTestEnv,
  });
  const targetSessionKey =
    ctx.CommandSource === "native"
      ? normalizeOptionalString(ctx.CommandTargetSessionKey)
      : undefined;
  const agentSessionKey = targetSessionKey || ctx.SessionKey;
  const agentId = resolveSessionAgentId({
    sessionKey: agentSessionKey,
    config: cfg,
  });
  const mergedSkillFilter = mergeSkillFilters(
    opts?.skillFilter,
    resolveAgentSkillsFilter(cfg, agentId),
  );
  const resolvedOpts =
    mergedSkillFilter !== undefined ? { ...opts, skillFilter: mergedSkillFilter } : opts;
  const agentCfg = cfg.agents?.defaults;
  const sessionCfg = cfg.session;
  const { defaultProvider, defaultModel, aliasIndex } = resolveDefaultModel({
    cfg,
    agentId,
  });
  let provider = defaultProvider;
  let model = defaultModel;
  let hasResolvedHeartbeatModelOverride = false;
  if (opts?.isHeartbeat) {
    // Prefer the resolved per-agent heartbeat model passed from the heartbeat runner,
    // fall back to the global defaults heartbeat model for backward compatibility.
    const heartbeatRaw =
      normalizeOptionalString(opts.heartbeatModelOverride) ??
      normalizeOptionalString(agentCfg?.heartbeat?.model) ??
      "";
    const heartbeatRef = heartbeatRaw
      ? resolveModelRefFromString({
          raw: heartbeatRaw,
          defaultProvider,
          aliasIndex,
        })
      : null;
    if (heartbeatRef) {
      provider = heartbeatRef.ref.provider;
      model = heartbeatRef.ref.model;
      hasResolvedHeartbeatModelOverride = true;
    }
  }

  const workspaceDirRaw = resolveAgentWorkspaceDir(cfg, agentId) ?? DEFAULT_AGENT_WORKSPACE_DIR;
  const workspace = useFastTestBootstrap
    ? (await fs.mkdir(workspaceDirRaw, { recursive: true }), { dir: workspaceDirRaw })
    : await ensureAgentWorkspace({
        dir: workspaceDirRaw,
        ensureBootstrapFiles: !agentCfg?.skipBootstrap && !isFastTestEnv,
      });
  const workspaceDir = workspace.dir;
  const agentDir = resolveAgentDir(cfg, agentId);
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: opts?.timeoutOverrideSeconds });
  const configuredTypingSeconds =
    agentCfg?.typingIntervalSeconds ?? sessionCfg?.typingIntervalSeconds;
  const typingIntervalSeconds =
    typeof configuredTypingSeconds === "number" ? configuredTypingSeconds : 6;
  const typing = createTypingController({
    onReplyStart: opts?.onReplyStart
      ? async () => {
          routerTraceTimings.typingSendStartMs ??= Date.now();
          try {
            await opts.onReplyStart?.();
          } finally {
            routerTraceTimings.typingSendEndMs = Date.now();
          }
        }
      : undefined,
    onCleanup: opts?.onTypingCleanup,
    typingIntervalSeconds,
    silentToken: SILENT_REPLY_TOKEN,
    log: defaultRuntime.log,
  });
  opts?.onTypingController?.(typing);

  const finalized = finalizeInboundContext(ctx);
  const finalizedText = finalized as MsgContext & { BodyStripped?: string };
  let directFastPathEarlyTypingMs: number | null = null;
  const directFastPathEarlyText =
    normalizeOptionalString(finalizedText.BodyStripped) ??
    normalizeOptionalString(finalizedText.CommandBody) ??
    normalizeOptionalString(finalizedText.RawBody) ??
    normalizeOptionalString(finalizedText.Body) ??
    "";
  const directFastPathEarlySource = [
    finalized.Provider,
    finalized.OriginatingChannel,
    finalized.Surface,
  ]
    .map((value) => normalizeOptionalLowercaseString(value))
    .filter((value): value is string => typeof value === "string")
    .some((value) => value.includes("discord"));
  if (
    directFastPathEarlySource &&
    directFastPathEarlyText.trim() &&
    !hasInboundMedia(finalized) &&
    !hasLinkCandidate(finalized)
  ) {
    const typingStartedAt = Date.now();
    try {
      await (typing as { onReplyStart?: () => Promise<void> | void }).onReplyStart?.();
      directFastPathEarlyTypingMs = Date.now() - typingStartedAt;
    } catch {
      directFastPathEarlyTypingMs = Date.now() - typingStartedAt;
    }
  }

  if (!isFastTestEnv) {
    await applyMediaUnderstandingIfNeeded({
      ctx: finalized,
      cfg,
      agentDir,
      activeModel: { provider, model },
    });
    await applyLinkUnderstandingIfNeeded({
      ctx: finalized,
      cfg,
    });
  }
  emitPreAgentMessageHooks({
    ctx: finalized,
    cfg,
    isFastTestEnv,
  });

  const commandAuthorized = finalized.CommandAuthorized;
  routerTraceTimings.memoryStartMs = Date.now();
  const sessionState = useFastTestBootstrap
    ? initFastReplySessionState({
        ctx: finalized,
        cfg,
        agentId,
        commandAuthorized,
        workspaceDir,
      })
    : await initSessionState({
        ctx: finalized,
        cfg,
        commandAuthorized,
      });
  routerTraceTimings.memoryEndMs = Date.now();
  let {
    sessionCtx,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    sessionId,
    isNewSession,
    resetTriggered,
    systemSent,
    abortedLastRun,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    bodyStripped,
  } = sessionState;
  if (resetTriggered && normalizeOptionalString(bodyStripped)) {
    const { applyResetModelOverride } = await loadSessionResetModelRuntime();
    await applyResetModelOverride({
      cfg,
      agentId,
      resetTriggered,
      bodyStripped,
      sessionCtx,
      ctx: finalized,
      sessionEntry,
      sessionStore,
      sessionKey,
      storePath,
      defaultProvider,
      defaultModel,
      aliasIndex,
    });
  }

  const channelModelOverride = cfg.channels?.modelByChannel
    ? resolveChannelModelOverride({
        cfg,
        channel:
          groupResolution?.channel ??
          sessionEntry.channel ??
          sessionEntry.origin?.provider ??
          (typeof finalized.OriginatingChannel === "string"
            ? finalized.OriginatingChannel
            : undefined) ??
          finalized.Provider,
        groupId: groupResolution?.id ?? sessionEntry.groupId,
        groupChatType: sessionEntry.chatType ?? sessionCtx.ChatType ?? finalized.ChatType,
        groupChannel:
          sessionEntry.groupChannel ?? sessionCtx.GroupChannel ?? finalized.GroupChannel,
        groupSubject: sessionEntry.subject ?? sessionCtx.GroupSubject ?? finalized.GroupSubject,
        parentSessionKey: sessionCtx.ParentSessionKey,
      })
    : null;
  const hasSessionModelOverride = Boolean(
    normalizeOptionalString(sessionEntry.modelOverride) ||
    normalizeOptionalString(sessionEntry.providerOverride),
  );
  const storedModelOverride = resolveStoredModelOverride({
    sessionEntry,
    sessionStore,
    sessionKey,
    parentSessionKey: sessionEntry.parentSessionKey ?? sessionCtx.ParentSessionKey,
    defaultProvider,
  });
  if (storedModelOverride?.model && !hasResolvedHeartbeatModelOverride) {
    provider = storedModelOverride.provider ?? defaultProvider;
    model = storedModelOverride.model;
  }
  if (!hasResolvedHeartbeatModelOverride && !hasSessionModelOverride && channelModelOverride) {
    const resolved = resolveModelRefFromString({
      raw: channelModelOverride.model,
      defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      provider = resolved.ref.provider;
      model = resolved.ref.model;
    }
  }
  const conversationRouterMessage =
    sessionCtx.BodyForAgent ??
    sessionCtx.BodyStripped ??
    sessionCtx.CommandBody ??
    sessionCtx.RawBody ??
    sessionCtx.Body ??
    finalized.BodyForAgent ??
    finalized.CommandBody ??
    finalized.RawBody ??
    finalized.Body ??
    "";
  const conversationRouterSource =
    groupResolution?.channel ??
    sessionEntry.channel ??
    sessionEntry.origin?.provider ??
    (typeof finalized.OriginatingChannel === "string" ? finalized.OriginatingChannel : undefined) ??
    finalized.Provider ??
    finalized.Surface;
  const conversationRouterRouteContext = buildConversationRouterRouteContext({
    ctx,
    finalized,
    source: conversationRouterSource,
  });
  routerTraceTimings.routerStartMs = Date.now();
  const conversationRouterSelection: ConversationRouterModelSelection | null =
    !hasResolvedHeartbeatModelOverride && !hasSessionModelOverride
      ? resolveConversationRouterV0ModelSelection({
          source: conversationRouterSource,
          sessionKey,
          message: conversationRouterMessage,
          ...conversationRouterRouteContext,
          currentProvider: provider,
          currentModel: model,
          defaultProvider,
          defaultModel,
        })
      : null;
  routerTraceTimings.routerEndMs = Date.now();
  if (conversationRouterSelection) {
    provider = conversationRouterSelection.provider;
    model = conversationRouterSelection.model;
  }

  if (
    shouldUseReplyFastDirectiveExecution({
      isFastTestBootstrap: useFastTestRuntime,
      isGroup,
      isHeartbeat: opts?.isHeartbeat === true,
      resetTriggered,
      triggerBodyNormalized,
    })
  ) {
    const fastCommand = buildFastReplyCommandContext({
      ctx,
      cfg,
      agentId,
      sessionKey,
      isGroup,
      triggerBodyNormalized,
      commandAuthorized,
    });
    const routerReplyStartedAt = Date.now();
    const guardedReply = await runPreparedReplyWithCoherenceGuard({
      selection: conversationRouterSelection,
      userMessage: conversationRouterMessage,
      defaultProvider,
      defaultModel,
      traceTimings: routerTraceTimings,
      generationTrace: routerGenerationTrace,
      runParams: {
        ctx,
        sessionCtx,
        cfg,
        agentId,
        agentDir,
        agentCfg,
        sessionCfg,
        commandAuthorized,
        command: fastCommand,
        commandSource:
          finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
        allowTextCommands: shouldHandleFastReplyTextCommands({
          cfg,
          commandSource: finalized.CommandSource,
        }),
        directives: clearInlineDirectives(
          finalized.BodyForCommands ?? finalized.CommandBody ?? finalized.RawBody ?? "",
        ),
        defaultActivation: "always",
        resolvedThinkLevel: "off",
        resolvedVerboseLevel: normalizeVerboseLevel(agentCfg?.verboseDefault),
        resolvedReasoningLevel: "off",
        resolvedElevatedLevel: "off",
        execOverrides: undefined,
        elevatedEnabled: false,
        elevatedAllowed: false,
        blockStreamingEnabled: false,
        blockReplyChunking: undefined,
        resolvedBlockStreamingBreak: "text_end",
        modelState: createFastTestModelSelectionState({
          agentCfg,
          provider,
          model,
        }),
        provider,
        model,
        perMessageQueueMode: undefined,
        perMessageQueueOptions: undefined,
        typing,
        opts: resolvedOpts,
        defaultProvider,
        defaultModel,
        timeoutMs,
        isNewSession,
        resetTriggered,
        systemSent,
        sessionEntry,
        sessionStore,
        sessionKey,
        sessionId,
        storePath,
        workspaceDir,
        abortedLastRun,
      },
    });
    await appendConversationRouterV0DebugLog({
      selection: conversationRouterSelection,
      message: conversationRouterMessage,
      responseText: collectReplyText(guardedReply.reply),
      actualProvider: guardedReply.actualProvider,
      actualModel: guardedReply.actualModel,
      ollamaModelSent: `${guardedReply.actualProvider}/${guardedReply.actualModel}`,
      latencyMs: Date.now() - routerReplyStartedAt,
      coherenceAudit: guardedReply.audit,
      rewriteAttempted: guardedReply.rewriteAttempted,
      escalated: guardedReply.escalated,
      traceId: routerTraceId,
      turnId: sessionKey,
      traceTimings: routerTraceTimings,
      generationTrace: routerGenerationTrace,
      defaultProvider,
      defaultModel,
      modelPickerCurrent: `${defaultProvider}/${defaultModel}`,
      globalDefaultModel: `${defaultProvider}/${defaultModel}`,
      overrideRequested: conversationRouterSelection !== null,
      overrideAccepted:
        conversationRouterSelection === null ||
        `${guardedReply.actualProvider}/${guardedReply.actualModel}` ===
          conversationRouterSelection.recommendedModelRef,
      rewriteReason: guardedReply.audit.reason.join(","),
      rewriteModel: guardedReply.rewriteAttempted
        ? (conversationRouterSelection?.recommendedModelRef ?? "")
        : "",
      rewritePassed: guardedReply.rewriteAttempted ? guardedReply.escalated === false : null,
      questionRepairApplied: guardedReply.questionRepair.applied,
      questionRepairReason: guardedReply.questionRepair.reason,
      questionPermissionGranted: guardedReply.questionPermissionGranted,
      previousAssistantEndedWithQuestion: guardedReply.previousAssistantEndedWithQuestion,
      rawResponseQuestionCount: guardedReply.questionRepair.rawQuestionCount,
      rawResponseEndedWithQuestion: guardedReply.questionRepair.rawEndedWithQuestion,
      internalQuestionCountAfterRepair:
        guardedReply.questionRepair.internalQuestionCountAfterRepair,
    });
    return guardedReply.reply;
  }

  const directiveResult = await resolveReplyDirectives({
    ctx: finalized,
    cfg,
    agentId,
    agentDir,
    workspaceDir,
    agentCfg,
    sessionCtx,
    sessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    groupResolution,
    isGroup,
    triggerBodyNormalized,
    commandAuthorized,
    defaultProvider,
    defaultModel,
    aliasIndex,
    provider,
    model,
    hasResolvedHeartbeatModelOverride,
    typing,
    opts: resolvedOpts,
    skillFilter: mergedSkillFilter,
  });
  if (directiveResult.kind === "reply") {
    return directiveResult.reply;
  }

  let {
    commandSource,
    command,
    allowTextCommands,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    execOverrides,
    blockStreamingEnabled,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    provider: resolvedProvider,
    model: resolvedModel,
    modelState,
    contextTokens,
    inlineStatusRequested,
    directiveAck,
    perMessageQueueMode,
    perMessageQueueOptions,
  } = directiveResult.result;
  provider = resolvedProvider;
  model = resolvedModel;

  const maybeEmitMissingResetHooks = async () => {
    if (!resetTriggered || !command.isAuthorizedSender || command.resetHookTriggered) {
      return;
    }
    const resetMatch = command.commandBodyNormalized.match(/^\/(new|reset)(?:\s|$)/);
    if (!resetMatch) {
      return;
    }
    const { emitResetCommandHooks } = await loadCommandsCoreRuntime();
    const action: ResetCommandAction = resetMatch[1] === "reset" ? "reset" : "new";
    await emitResetCommandHooks({
      action,
      ctx,
      cfg,
      command,
      sessionKey,
      sessionEntry,
      previousSessionEntry,
      workspaceDir,
    });
  };

  const inlineActionResult = await handleInlineActions({
    ctx,
    sessionCtx,
    cfg,
    agentId,
    agentDir,
    sessionEntry,
    previousSessionEntry,
    sessionStore,
    sessionKey,
    storePath,
    sessionScope,
    workspaceDir,
    isGroup,
    opts: resolvedOpts,
    typing,
    allowTextCommands,
    inlineStatusRequested,
    command,
    skillCommands,
    directives,
    cleanedBody,
    elevatedEnabled,
    elevatedAllowed,
    elevatedFailures,
    defaultActivation: () => defaultActivation,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    blockReplyChunking,
    resolvedBlockStreamingBreak,
    resolveDefaultThinkingLevel: modelState.resolveDefaultThinkingLevel,
    provider,
    model,
    contextTokens,
    directiveAck,
    abortedLastRun,
    skillFilter: mergedSkillFilter,
  });
  if (inlineActionResult.kind === "reply") {
    await maybeEmitMissingResetHooks();
    return inlineActionResult.reply;
  }
  await maybeEmitMissingResetHooks();
  directives = inlineActionResult.directives;
  abortedLastRun = inlineActionResult.abortedLastRun ?? abortedLastRun;

  const directFastPathStartedAt = Date.now();
  const directFastPath = await tryDirectQwenCasualFastPath({
    ctx: finalized,
    cfg,
    selection: conversationRouterSelection,
    sessionKey,
    userMessage: conversationRouterMessage,
    resetTriggered,
    commandSource,
    allowTextCommands,
    skillCommands,
    inlineStatusRequested,
    hasMedia: hasInboundMedia(finalized),
    hasLink: hasLinkCandidate(finalized),
    earlyTypingMs: directFastPathEarlyTypingMs,
    traceTimings: routerTraceTimings,
    generationTrace: routerGenerationTrace,
  });
  if (directFastPath.kind === "reply") {
    await appendConversationRouterV0DebugLog({
      selection: conversationRouterSelection,
      message: conversationRouterMessage,
      responseText: collectReplyText(directFastPath.reply),
      actualProvider: CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER,
      actualModel: CONVERSATION_ROUTER_LIGHT_MODEL_ID,
      ollamaModelSent: `${CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER}/${CONVERSATION_ROUTER_LIGHT_MODEL_ID}`,
      latencyMs: Date.now() - directFastPathStartedAt,
      coherenceAudit: directFastPath.audit,
      rewriteAttempted: directFastPath.rewriteAttempted === true,
      escalated: directFastPath.escalated === true,
      traceId: routerTraceId,
      turnId: sessionKey,
      traceTimings: routerTraceTimings,
      generationTrace: routerGenerationTrace,
      defaultProvider,
      defaultModel,
      modelPickerCurrent: `${defaultProvider}/${defaultModel}`,
      globalDefaultModel: `${defaultProvider}/${defaultModel}`,
      overrideRequested: conversationRouterSelection !== null,
      overrideAccepted:
        conversationRouterSelection === null ||
        `${CONVERSATION_ROUTER_LIGHT_MODEL_PROVIDER}/${CONVERSATION_ROUTER_LIGHT_MODEL_ID}` ===
          conversationRouterSelection.recommendedModelRef,
      fallbackReason: "NONE",
      rewriteReason: directFastPath.audit?.reason.join(",") ?? "",
      rewriteModel: directFastPath.rewriteAttempted
        ? (conversationRouterSelection?.recommendedModelRef ?? "")
        : "",
      rewritePassed: directFastPath.rewriteAttempted ? directFastPath.escalated === false : null,
      questionRepairApplied: directFastPath.questionRepair?.applied === true,
      questionRepairReason: directFastPath.questionRepair?.reason ?? "",
      questionPermissionGranted:
        directFastPath.questionPermissionGranted ??
        shouldAllowLightModelQuestion(conversationRouterMessage),
      previousAssistantEndedWithQuestion: directFastPath.previousAssistantEndedWithQuestion,
      rawResponseQuestionCount: directFastPath.questionRepair?.rawQuestionCount,
      rawResponseEndedWithQuestion: directFastPath.questionRepair?.rawEndedWithQuestion,
      internalQuestionCountAfterRepair:
        directFastPath.questionRepair?.internalQuestionCountAfterRepair,
    });
    return directFastPath.reply;
  }
  if (directFastPath.kind === "fallback_main") {
    routerGenerationTrace.directFastPathUsed = false;
    routerGenerationTrace.fastPathRejectedReason = directFastPath.reason;
    routerGenerationTrace.activeSessionPromptBypassed = false;
    routerGenerationTrace.piRuntimeBypassed = false;
    routerGenerationTrace.toolRegistryLoaded = null;
    routerGenerationTrace.pluginRuntimeLoaded = null;
    routerGenerationTrace.fullMemoryBlockingRead = null;
  }

  // Allow plugins to intercept and return a synthetic reply before the LLM runs.
  if (!useFastTestBootstrap) {
    const { getGlobalHookRunner } = await loadHookRunnerGlobal();
    const hookRunner = getGlobalHookRunner();
    if (hookRunner?.hasHooks("before_agent_reply")) {
      const { resolveOriginMessageProvider } = await loadOriginRouting();
      const hookMessageProvider = resolveOriginMessageProvider({
        originatingChannel: sessionCtx.OriginatingChannel,
        provider: sessionCtx.Provider,
      });
      const hookResult = await hookRunner.runBeforeAgentReply(
        { cleanedBody },
        {
          agentId,
          sessionKey: agentSessionKey,
          sessionId,
          workspaceDir,
          messageProvider: hookMessageProvider,
          trigger: opts?.isHeartbeat ? "heartbeat" : "user",
          channelId: hookMessageProvider,
        },
      );
      if (hookResult?.handled) {
        return hookResult.reply ?? { text: SILENT_REPLY_TOKEN };
      }
    }
  }

  if (!useFastTestBootstrap && sessionKey && hasInboundMedia(ctx)) {
    const { stageSandboxMedia } = await loadStageSandboxMediaRuntime();
    await stageSandboxMedia({
      ctx,
      sessionCtx,
      cfg,
      sessionKey,
      workspaceDir,
    });
  }

  const routerReplyStartedAt = Date.now();
  const guardedReply = await runPreparedReplyWithCoherenceGuard({
    selection: conversationRouterSelection,
    userMessage: conversationRouterMessage,
    defaultProvider,
    defaultModel,
    traceTimings: routerTraceTimings,
    generationTrace: routerGenerationTrace,
    runParams: {
      ctx,
      sessionCtx,
      cfg,
      agentId,
      agentDir,
      agentCfg,
      sessionCfg,
      commandAuthorized,
      command,
      commandSource,
      allowTextCommands,
      directives,
      defaultActivation,
      resolvedThinkLevel:
        conversationRouterSelection?.route.recommended_model === "light_model"
          ? "off"
          : resolvedThinkLevel,
      resolvedVerboseLevel,
      resolvedReasoningLevel,
      resolvedElevatedLevel,
      execOverrides,
      elevatedEnabled,
      elevatedAllowed,
      blockStreamingEnabled,
      blockReplyChunking,
      resolvedBlockStreamingBreak,
      modelState,
      provider,
      model,
      perMessageQueueMode,
      perMessageQueueOptions,
      typing,
      opts: resolvedOpts,
      defaultProvider,
      defaultModel,
      timeoutMs,
      isNewSession,
      resetTriggered,
      systemSent,
      sessionEntry,
      sessionStore,
      sessionKey,
      sessionId,
      storePath,
      workspaceDir,
      abortedLastRun,
    },
  });
  await appendConversationRouterV0DebugLog({
    selection: conversationRouterSelection,
    message: conversationRouterMessage,
    responseText: collectReplyText(guardedReply.reply),
    actualProvider: guardedReply.actualProvider,
    actualModel: guardedReply.actualModel,
    ollamaModelSent: `${guardedReply.actualProvider}/${guardedReply.actualModel}`,
    latencyMs: Date.now() - routerReplyStartedAt,
    coherenceAudit: guardedReply.audit,
    rewriteAttempted: guardedReply.rewriteAttempted,
    escalated: guardedReply.escalated,
    traceId: routerTraceId,
    turnId: sessionKey,
    traceTimings: routerTraceTimings,
    generationTrace: routerGenerationTrace,
    defaultProvider,
    defaultModel,
    modelPickerCurrent: `${defaultProvider}/${defaultModel}`,
    globalDefaultModel: `${defaultProvider}/${defaultModel}`,
    overrideRequested: conversationRouterSelection !== null,
    overrideAccepted:
      conversationRouterSelection === null ||
      `${guardedReply.actualProvider}/${guardedReply.actualModel}` ===
        conversationRouterSelection.recommendedModelRef,
    rewriteReason: guardedReply.audit.reason.join(","),
    rewriteModel: guardedReply.rewriteAttempted
      ? (conversationRouterSelection?.recommendedModelRef ?? "")
      : "",
    rewritePassed: guardedReply.rewriteAttempted ? guardedReply.escalated === false : null,
    questionRepairApplied: guardedReply.questionRepair.applied,
    questionRepairReason: guardedReply.questionRepair.reason,
    questionPermissionGranted: guardedReply.questionPermissionGranted,
    previousAssistantEndedWithQuestion: guardedReply.previousAssistantEndedWithQuestion,
    rawResponseQuestionCount: guardedReply.questionRepair.rawQuestionCount,
    rawResponseEndedWithQuestion: guardedReply.questionRepair.rawEndedWithQuestion,
    internalQuestionCountAfterRepair: guardedReply.questionRepair.internalQuestionCountAfterRepair,
  });
  return guardedReply.reply;
}
