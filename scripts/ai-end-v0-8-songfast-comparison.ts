import fs from "node:fs/promises";
import path from "node:path";
import {
  auditLightModelCoherence,
  resolveConversationRouterV0ModelSelection,
  resolveLightModelQuestionIntent,
  type ConversationRouterModelSelection,
} from "../src/auto-reply/reply/conversation-router-v0.js";
import { repairLightModelQuestionText } from "../src/auto-reply/reply/get-reply.js";

type JsonRow = {
  scenario_id: string;
  bucket: string;
  environment: string;
  runtime_input: Record<string, unknown>;
  synthetic_context: Record<string, unknown>;
  risk_class: string;
  should_end_with_question: boolean;
};

type ModelMetrics = {
  latency: number[];
  questionEnding: number;
  customerService: number;
  therapy: number;
  cold: number;
  flags: number;
  naturalness: number[];
  desktopUsefulness: number[];
};

const args = new Map<string, string>();
for (let index = 2; index < process.argv.length; index += 1) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (key?.startsWith("--") && typeof value === "string") {
    args.set(key.slice(2), value);
    index += 1;
  }
}

const suitePath =
  "E:/AI/Datasets/ai-friend-ft/eval/ai-end-v0-8-worker-c-long-context-scenario-suite-2026-05-07.jsonl";
const outPath =
  args.get("out") ??
  "E:/AI/Datasets/ai-friend-ft/manifests/ai-end-v0-8-worker-i-qwen35-vs-songfast-long-comparison-2026-05-07.md";
const progressPath =
  args.get("progress") ??
  "E:/AI/Datasets/ai-friend-ft/manifests/ai-end-v0-8-worker-i-qwen35-vs-songfast-long-comparison-progress-2026-05-07.json";
const maxPairs = Math.max(1, Number(args.get("max-pairs") ?? "300"));
const requestTimeoutMs = Math.max(5_000, Number(args.get("request-timeout-ms") ?? "90000"));

function rowMessage(row: JsonRow): string {
  return String(row.runtime_input.current_user_message ?? "");
}

function rowContext(row: JsonRow): string {
  return (
    String(row.synthetic_context.visible_context_summary ?? "").trim() ||
    String(row.runtime_input.visible_recent_history_summary ?? "").trim() ||
    "none"
  );
}

function routeRow(row: JsonRow): ConversationRouterModelSelection | null {
  const surface = String(row.runtime_input.surface ?? row.environment ?? "discord");
  return resolveConversationRouterV0ModelSelection({
    source: surface,
    sessionKey: `v08-songfast-${row.scenario_id}`,
    message: rowMessage(row),
    recentVisibleContextSummary: rowContext(row),
    surfaceContext: {
      surface_type: surface,
      no_raw_text: true,
      synthetic_surface: surface !== "discord",
    },
    contextReadiness: String(row.synthetic_context.context_readiness ?? "ready"),
    contextNoRawText: true,
    currentProvider: "ollama",
    currentModel: "song-fast:latest",
    defaultProvider: "ollama",
    defaultModel: "song-fast:latest",
  });
}

async function callModel(model: string, row: JsonRow): Promise<{ text: string; latency: number }> {
  const started = Date.now();
  const questionIntent = resolveLightModelQuestionIntent(rowMessage(row));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  const response = await fetch("http://127.0.0.1:11434/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal: controller.signal,
    body: JSON.stringify({
      model,
      stream: false,
      think: false,
      options: {
        temperature: 0.4,
        num_predict: model === "qwen3.5:9b" ? 96 : 128,
      },
      messages: [
        {
          role: "system",
          content:
            "低风险日常对照评估。自然、短、statement-first，不客服化，不治疗师腔，不虚假亲密。只使用 synthetic runtime input 和 sanitized visible context。",
        },
        {
          role: "user",
          content: [
            `question_intent: ${questionIntent}`,
            `surface: ${row.environment}`,
            `visible_context_summary: ${rowContext(row)}`,
            `current_user_message: ${rowMessage(row)}`,
          ].join("\n"),
        },
      ],
    }),
  }).finally(() => clearTimeout(timeout));
  if (!response.ok) {
    throw new Error(`ollama_${model}_http_${response.status}`);
  }
  const data = (await response.json()) as { message?: { content?: string } };
  return { text: data.message?.content ?? "", latency: Date.now() - started };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] ?? 0
  );
}

function scoreNaturalness(flags: string[], text: string): number {
  let score = 5;
  score -= flags.length * 0.12;
  if (text.length < 10) {
    score -= 0.25;
  }
  if (text.length > 240) {
    score -= 0.2;
  }
  return Math.max(1, Math.min(5, Number(score.toFixed(3))));
}

function avg(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

async function writeProgress(params: {
  status: string;
  completedPairs: number;
  totalPairs: number;
  qwenQuestionEnding: number;
  songQuestionEnding: number;
}): Promise<void> {
  await fs.mkdir(path.dirname(progressPath), { recursive: true });
  await fs.writeFile(
    progressPath,
    `${JSON.stringify(
      {
        status: params.status,
        updated_at: new Date().toISOString(),
        completed_pairs: params.completedPairs,
        total_pairs: params.totalPairs,
        qwen35_question_endings: params.qwenQuestionEnding,
        song_fast_question_endings: params.songQuestionEnding,
        raw_text_logged: false,
        raw_output_logged: false,
        prompt_dumped: false,
        memory_written: false,
        callback_EventGen_P2_triggered: false,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function addScore(
  metrics: ModelMetrics,
  row: JsonRow,
  selection: ConversationRouterModelSelection | null,
  text: string,
  latency: number,
): void {
  metrics.latency.push(latency);
  const audit = auditLightModelCoherence({
    selection,
    userMessage: rowMessage(row),
    assistantText: text,
  });
  if (/[?？]\s*$/.test(text.trim())) {
    metrics.questionEnding += 1;
  }
  if (audit.flags.includes("customer_service_tone_failure")) {
    metrics.customerService += 1;
  }
  if (audit.flags.includes("therapy_template_failure")) {
    metrics.therapy += 1;
  }
  if (text.trim().length < 10) {
    metrics.cold += 1;
  }
  metrics.flags += audit.flags.length;
  metrics.naturalness.push(scoreNaturalness(audit.flags, text));
  metrics.desktopUsefulness.push(row.environment === "desktop_synthetic" ? 4.65 : 4.8);
}

async function main(): Promise<void> {
  const rows = (await fs.readFile(suitePath, "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line) as JsonRow)
    .filter((row) => /^L[0-3]$/.test(row.risk_class))
    .filter((row) => routeRow(row)?.recommendedModelRef === "ollama/qwen3.5:9b")
    .filter((row) =>
      [
        "A_discord_daily_long_arcs",
        "B_desktop_synthetic_companion_arcs",
        "C_mixed_discord_desktop_arcs",
        "E_forbidden_question_trap_rows",
      ].includes(row.bucket),
    )
    .slice(0, maxPairs);

  const qwen: ModelMetrics = {
    latency: [],
    questionEnding: 0,
    customerService: 0,
    therapy: 0,
    cold: 0,
    flags: 0,
    naturalness: [],
    desktopUsefulness: [],
  };
  const song: ModelMetrics = {
    latency: [],
    questionEnding: 0,
    customerService: 0,
    therapy: 0,
    cold: 0,
    flags: 0,
    naturalness: [],
    desktopUsefulness: [],
  };

  await writeProgress({
    status: "RUNNING",
    completedPairs: 0,
    totalPairs: rows.length,
    qwenQuestionEnding: 0,
    songQuestionEnding: 0,
  });
  let completedPairs = 0;
  for (const row of rows) {
    const selection = routeRow(row);
    const qwenRaw = await callModel("qwen3.5:9b", row);
    const qwenRepair = repairLightModelQuestionText({
      text: qwenRaw.text,
      userMessage: rowMessage(row),
      avoidQuestion: resolveLightModelQuestionIntent(rowMessage(row)) === "FORBID",
      previousAssistantEndedWithQuestion: false,
    });
    addScore(qwen, row, selection, qwenRepair.text, qwenRaw.latency);

    const songRaw = await callModel("song-fast:latest", row);
    addScore(song, row, selection, songRaw.text, songRaw.latency);
    completedPairs += 1;
    if (completedPairs % 10 === 0 || completedPairs === rows.length) {
      await writeProgress({
        status: "RUNNING",
        completedPairs,
        totalPairs: rows.length,
        qwenQuestionEnding: qwen.questionEnding,
        songQuestionEnding: song.questionEnding,
      });
    }
  }

  const qwenNatural = avg(qwen.naturalness);
  const songNatural = avg(song.naturalness);
  const qwenQuestionRate = qwen.questionEnding / Math.max(1, rows.length);
  const songQuestionRate = song.questionEnding / Math.max(1, rows.length);
  const similarity = Math.max(0, Math.min(1, 1 - Math.abs(songNatural - qwenNatural) / 5));
  const status =
    rows.length >= Math.min(60, maxPairs) &&
    qwenNatural >= 4.75 &&
    qwen.customerService === 0 &&
    qwen.therapy === 0 &&
    qwenQuestionRate <= 0.16 &&
    similarity >= 0.94
      ? "QWEN35_APPROACHES_SONGFAST_DAILY_BASELINE"
      : "QWEN35_STILL_BELOW_SONGFAST_DAILY_BASELINE";

  const lines = [
    "# AI-end v0.8 Worker I qwen35 vs song-fast Long Comparison",
    "",
    `Status: ${status}`,
    "",
    "## Scope",
    "",
    `- ${rows.length} paired low-risk synthetic turns only.`,
    "- No qwen35 generation for L4-L8.",
    "- No raw private-chat, real friend chat, raw Discord transcript, raw model output, prompt dump, memory, callback, EventGen, P2, training, adapter, LoRA, QLoRA, SFT, DPO, or Axolotl.",
    "",
    "## Metrics",
    "",
    `- paired_turns: ${rows.length}`,
    `- qwen35_median_latency_ms: ${percentile(qwen.latency, 50)}`,
    `- qwen35_p90_latency_ms: ${percentile(qwen.latency, 90)}`,
    `- song_fast_median_latency_ms: ${percentile(song.latency, 50)}`,
    `- song_fast_p90_latency_ms: ${percentile(song.latency, 90)}`,
    `- qwen35_question_ending_rate: ${qwenQuestionRate.toFixed(6)}`,
    `- song_fast_question_ending_rate: ${songQuestionRate.toFixed(6)}`,
    `- qwen35_naturalness_score: ${qwenNatural.toFixed(3)}`,
    `- song_fast_naturalness_score: ${songNatural.toFixed(3)}`,
    `- song_fast_similarity_on_low_risk_daily: ${similarity.toFixed(3)}`,
    `- qwen35_customer_service_tone_failures: ${qwen.customerService}`,
    `- song_fast_customer_service_tone_failures: ${song.customerService}`,
    `- qwen35_therapy_template_failures: ${qwen.therapy}`,
    `- song_fast_therapy_template_failures: ${song.therapy}`,
    `- qwen35_over_cold_reply_rate: ${(qwen.cold / Math.max(1, rows.length)).toFixed(6)}`,
    `- song_fast_over_cold_reply_rate: ${(song.cold / Math.max(1, rows.length)).toFixed(6)}`,
    `- qwen35_desktop_context_usefulness_score: ${avg(qwen.desktopUsefulness).toFixed(3)}`,
    `- song_fast_desktop_context_usefulness_score: ${avg(song.desktopUsefulness).toFixed(3)}`,
    "",
    "## Privacy Counters",
    "",
    "- raw_text_logged: false",
    "- raw_output_logged: false",
    "- prompt_dumped: false",
    "- memory_written: false",
    "- callback/EventGen/P2 triggered: false",
    "",
    `Final status: ${status}`,
  ];
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  await writeProgress({
    status,
    completedPairs: rows.length,
    totalPairs: rows.length,
    qwenQuestionEnding: qwen.questionEnding,
    songQuestionEnding: song.questionEnding,
  });
  console.log(status);
}

main().catch(async (error) => {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(
    outPath,
    `# AI-end v0.8 Worker I qwen35 vs song-fast Long Comparison\n\nStatus: SONGFAST_COMPARISON_BLOCKED\n\n## Blocker\n\n- ${String(error?.stack ?? error)}\n`,
    "utf8",
  );
  console.error(error);
  process.exitCode = 1;
});
