import fs from "node:fs/promises";
import path from "node:path";
import type { CompactionEntry, SessionEntry } from "@mariozechner/pi-coding-agent";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  isHeartbeatOkResponse,
  isHeartbeatUserMessage,
  isMemoryFlushUserMessage,
  isNoReplyAckResponse,
} from "../../auto-reply/heartbeat-filter.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { log } from "./logger.js";

type MaintenancePairScanOptions = {
  ackMaxChars?: number;
  heartbeatPrompt?: string;
  memoryFlushPrompt?: string;
  danglingMaxAgeMs?: number;
  nowMs?: number;
};

const DEFAULT_DANGLING_MAINTENANCE_MAX_AGE_MS = 60_000;

function isMaintenanceUserEntry(
  entry: SessionEntry,
  options: MaintenancePairScanOptions,
): { heartbeat: boolean; memoryFlush: boolean } {
  if (entry.type !== "message") {
    return { heartbeat: false, memoryFlush: false };
  }
  const heartbeat = isHeartbeatUserMessage(entry.message, options.heartbeatPrompt);
  const memoryFlush = isMemoryFlushUserMessage(entry.message, options.memoryFlushPrompt);
  return { heartbeat, memoryFlush };
}

function resolveSessionEntryTimestampMs(entry: SessionEntry): number | undefined {
  const messageTimestamp =
    entry.type === "message" ? (entry.message as { timestamp?: unknown } | undefined)?.timestamp : undefined;
  if (typeof messageTimestamp === "number" && Number.isFinite(messageTimestamp)) {
    return messageTimestamp;
  }
  if (typeof messageTimestamp === "string") {
    const parsed = Date.parse(messageTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  const entryTimestamp = (entry as { timestamp?: unknown }).timestamp;
  if (typeof entryTimestamp === "number" && Number.isFinite(entryTimestamp)) {
    return entryTimestamp;
  }
  if (typeof entryTimestamp === "string") {
    const parsed = Date.parse(entryTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return undefined;
}

function collectMaintenancePairRemovalIds(params: {
  branch: SessionEntry[];
  options: MaintenancePairScanOptions;
  restrictToIds?: Set<string>;
}): Set<string> {
  const removedIds = new Set<string>();
  for (let i = 0; i < params.branch.length - 1; i++) {
    const userEntry = params.branch[i];
    const assistantEntry = params.branch[i + 1];
    if (
      userEntry.type !== "message" ||
      assistantEntry.type !== "message" ||
      (params.restrictToIds &&
        (!params.restrictToIds.has(userEntry.id) || !params.restrictToIds.has(assistantEntry.id)))
    ) {
      continue;
    }
    const isHeartbeatPair =
      isHeartbeatUserMessage(userEntry.message, params.options.heartbeatPrompt) &&
      isHeartbeatOkResponse(assistantEntry.message, params.options.ackMaxChars);
    const isMemoryFlushPair =
      isMemoryFlushUserMessage(userEntry.message, params.options.memoryFlushPrompt) &&
      isNoReplyAckResponse(assistantEntry.message);
    if (!isHeartbeatPair && !isMemoryFlushPair) {
      continue;
    }
    removedIds.add(userEntry.id);
    removedIds.add(assistantEntry.id);
    i++;
  }
  return removedIds;
}

function collectDanglingMaintenanceRemovalIds(params: {
  branch: SessionEntry[];
  options: MaintenancePairScanOptions;
}): Set<string> {
  const removedIds = new Set<string>();
  const nowMs = params.options.nowMs ?? Date.now();
  const danglingMaxAgeMs = Math.max(
    0,
    params.options.danglingMaxAgeMs ?? DEFAULT_DANGLING_MAINTENANCE_MAX_AGE_MS,
  );

  for (let i = 0; i < params.branch.length; i++) {
    const userEntry = params.branch[i];
    const { heartbeat, memoryFlush } = isMaintenanceUserEntry(userEntry, params.options);
    if (!heartbeat && !memoryFlush) {
      continue;
    }

    const assistantEntry = params.branch[i + 1];
    if (assistantEntry?.type === "message") {
      if (
        (heartbeat &&
          isHeartbeatOkResponse(assistantEntry.message, params.options.ackMaxChars)) ||
        (memoryFlush && isNoReplyAckResponse(assistantEntry.message))
      ) {
        continue;
      }
    }

    const timestampMs = resolveSessionEntryTimestampMs(userEntry);
    if (typeof timestampMs !== "number" || nowMs - timestampMs < danglingMaxAgeMs) {
      continue;
    }

    removedIds.add(userEntry.id);
  }

  return removedIds;
}

function isMaintenanceCustomEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "custom" &&
    (entry as { customType?: unknown }).customType === "openclaw:prompt-error"
  );
}

function collectOrphanedMaintenanceCustomRemovalIds(
  allEntries: SessionEntry[],
  removedIds: Set<string>,
): void {
  const childrenByParent = new Map<string, SessionEntry[]>();
  for (const entry of allEntries) {
    if (!entry.parentId) {
      continue;
    }
    const children = childrenByParent.get(entry.parentId) ?? [];
    children.push(entry);
    childrenByParent.set(entry.parentId, children);
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const entry of allEntries) {
      if (removedIds.has(entry.id) || !isMaintenanceCustomEntry(entry)) {
        continue;
      }
      const liveChildren = (childrenByParent.get(entry.id) ?? []).filter(
        (child) => !removedIds.has(child.id),
      );
      if (liveChildren.length === 0) {
        removedIds.add(entry.id);
        changed = true;
      }
    }
  }
}

function collectDanglingMetadataRemovalIds(allEntries: SessionEntry[], removedIds: Set<string>): void {
  for (const entry of allEntries) {
    if (entry.type === "label" && removedIds.has(entry.targetId)) {
      removedIds.add(entry.id);
      continue;
    }
    if (
      entry.type === "branch_summary" &&
      entry.parentId !== null &&
      removedIds.has(entry.parentId)
    ) {
      removedIds.add(entry.id);
    }
  }
}

function buildKeptEntriesAfterRemoval(allEntries: SessionEntry[], removedIds: Set<string>): SessionEntry[] {
  const entryById = new Map<string, SessionEntry>();
  for (const entry of allEntries) {
    entryById.set(entry.id, entry);
  }

  const keptEntries: SessionEntry[] = [];
  for (const entry of allEntries) {
    if (removedIds.has(entry.id)) {
      continue;
    }

    let newParentId = entry.parentId;
    while (newParentId !== null && removedIds.has(newParentId)) {
      const parent = entryById.get(newParentId);
      newParentId = parent?.parentId ?? null;
    }

    if (newParentId !== entry.parentId) {
      keptEntries.push({ ...entry, parentId: newParentId });
    } else {
      keptEntries.push(entry);
    }
  }

  return keptEntries;
}

async function rewriteSessionWithRemovedIds(params: {
  sessionFile: string;
  header: ReturnType<SessionManager["getHeader"]>;
  allEntries: SessionEntry[];
  removedIds: Set<string>;
  archivePath?: string;
  logPrefix: string;
}): Promise<TruncationResult> {
  if (!params.header) {
    return { truncated: false, entriesRemoved: 0, reason: "missing session header" };
  }

  const keptEntries = buildKeptEntriesAfterRemoval(params.allEntries, params.removedIds);
  const entriesRemoved = params.removedIds.size;
  const totalEntriesBefore = params.allEntries.length;

  let bytesBefore = 0;
  try {
    const stat = await fs.stat(params.sessionFile);
    bytesBefore = stat.size;
  } catch {
    // If stat fails, continue anyway.
  }

  if (params.archivePath) {
    try {
      const archiveDir = path.dirname(params.archivePath);
      await fs.mkdir(archiveDir, { recursive: true });
      await fs.copyFile(params.sessionFile, params.archivePath);
      log.info(`${params.logPrefix} Archived pre-rewrite file to ${params.archivePath}`);
    } catch (err) {
      const reason = formatErrorMessage(err);
      log.warn(`${params.logPrefix} Failed to archive: ${reason}`);
    }
  }

  const lines: string[] = [
    JSON.stringify(params.header),
    ...keptEntries.map((entry) => JSON.stringify(entry)),
  ];
  const content = lines.join("\n") + "\n";

  const tmpFile = `${params.sessionFile}.truncate-tmp`;
  try {
    await fs.writeFile(tmpFile, content, "utf-8");
    await fs.rename(tmpFile, params.sessionFile);
  } catch (err) {
    try {
      await fs.unlink(tmpFile);
    } catch {
      // Ignore cleanup errors.
    }
    const reason = formatErrorMessage(err);
    log.warn(`${params.logPrefix} Failed to write rewritten file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const bytesAfter = Buffer.byteLength(content, "utf-8");
  log.info(
    `${params.logPrefix} Rewrote session file: ` +
      `entriesBefore=${totalEntriesBefore} entriesAfter=${keptEntries.length} ` +
      `removed=${entriesRemoved} bytesBefore=${bytesBefore} bytesAfter=${bytesAfter} ` +
      `reduction=${bytesBefore > 0 ? ((1 - bytesAfter / bytesBefore) * 100).toFixed(1) : "?"}%`,
  );

  return { truncated: true, entriesRemoved, bytesBefore, bytesAfter };
}

export async function stripMaintenancePairsFromSession(params: {
  sessionFile: string;
  archivePath?: string;
  ackMaxChars?: number;
  heartbeatPrompt?: string;
  memoryFlushPrompt?: string;
  danglingMaxAgeMs?: number;
  nowMs?: number;
}): Promise<TruncationResult> {
  let sm: SessionManager;
  try {
    sm = SessionManager.open(params.sessionFile);
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`[session-maintenance-strip] Failed to open session file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const header = sm.getHeader();
  if (!header) {
    return { truncated: false, entriesRemoved: 0, reason: "missing session header" };
  }

  const branch = sm.getBranch();
  if (branch.length === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no maintenance entries to remove" };
  }

  const allEntries = sm.getEntries();
  const removedIds = collectMaintenancePairRemovalIds({
    branch,
    options: params,
  });
  for (const entryId of collectDanglingMaintenanceRemovalIds({ branch, options: params })) {
    removedIds.add(entryId);
  }
  collectOrphanedMaintenanceCustomRemovalIds(allEntries, removedIds);
  collectDanglingMetadataRemovalIds(allEntries, removedIds);

  if (removedIds.size === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no maintenance entries to remove" };
  }

  return await rewriteSessionWithRemovedIds({
    sessionFile: params.sessionFile,
    header,
    allEntries,
    removedIds,
    archivePath: params.archivePath,
    logPrefix: "[session-maintenance-strip]",
  });
}

/**
 * Truncate a session JSONL file after compaction by removing only the
 * message entries that the compaction actually summarized.
 *
 * After compaction, the session file still contains all historical entries
 * even though `buildSessionContext()` logically skips entries before
 * `firstKeptEntryId`. Over many compaction cycles this causes unbounded
 * file growth (issue #39953).
 *
 * This function rewrites the file keeping:
 * 1. The session header
 * 2. All non-message session state (custom, model_change, thinking_level_change,
 *    session_info, custom_message, compaction entries)
 *    Note: label and branch_summary entries referencing removed messages are
 *    also dropped to avoid dangling metadata.
 * 3. All entries from sibling branches not covered by the compaction
 * 4. The unsummarized tail: entries from `firstKeptEntryId` through (and
 *    including) the compaction entry, plus all entries after it
 *
 * Only `message` entries in the current branch that precede the compaction's
 * `firstKeptEntryId` are removed — they are the entries the compaction
 * actually summarized. Entries from `firstKeptEntryId` onward are preserved
 * because `buildSessionContext()` expects them when reconstructing the
 * session. Entries whose parent was removed are re-parented to the nearest
 * kept ancestor (or become roots).
 */
export async function truncateSessionAfterCompaction(params: {
  sessionFile: string;
  /** Optional path to archive the pre-truncation file. */
  archivePath?: string;
  ackMaxChars?: number;
  heartbeatPrompt?: string;
  memoryFlushPrompt?: string;
  danglingMaxAgeMs?: number;
  nowMs?: number;
}): Promise<TruncationResult> {
  const { sessionFile } = params;

  let sm: SessionManager;
  try {
    sm = SessionManager.open(sessionFile);
  } catch (err) {
    const reason = formatErrorMessage(err);
    log.warn(`[session-truncation] Failed to open session file: ${reason}`);
    return { truncated: false, entriesRemoved: 0, reason };
  }

  const header = sm.getHeader();
  if (!header) {
    return { truncated: false, entriesRemoved: 0, reason: "missing session header" };
  }

  const branch = sm.getBranch();
  if (branch.length === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "empty session" };
  }

  // Find the latest compaction entry in the current branch
  let latestCompactionIdx = -1;
  for (let i = branch.length - 1; i >= 0; i--) {
    if (branch[i].type === "compaction") {
      latestCompactionIdx = i;
      break;
    }
  }

  if (latestCompactionIdx < 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no compaction entry found" };
  }

  // Nothing to truncate if compaction is already at root
  if (latestCompactionIdx === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "compaction already at root" };
  }

  // The compaction's firstKeptEntryId marks the start of the "unsummarized
  // tail" — entries from firstKeptEntryId through the compaction that
  // buildSessionContext() expects to find when reconstructing the session.
  // Only entries *before* firstKeptEntryId were actually summarized.
  const compactionEntry = branch[latestCompactionIdx] as CompactionEntry;
  const { firstKeptEntryId } = compactionEntry;

  // Collect IDs of entries in the current branch that were actually summarized
  // (everything before firstKeptEntryId). Entries from firstKeptEntryId through
  // the compaction are the unsummarized tail and must be preserved.
  const summarizedBranchIds = new Set<string>();
  for (let i = 0; i < latestCompactionIdx; i++) {
    if (firstKeptEntryId && branch[i].id === firstKeptEntryId) {
      break; // Everything from here to the compaction is the unsummarized tail
    }
    summarizedBranchIds.add(branch[i].id);
  }

  // Operate on the full transcript so sibling branches and tree metadata
  // are not silently dropped.
  const allEntries = sm.getEntries();

  // Only remove message-type entries that the compaction actually summarized.
  // Non-message session state (custom, model_change, thinking_level_change,
  // session_info, custom_message) is preserved even if it sits in the
  // summarized portion of the branch.
  //
  // label and branch_summary entries that reference removed message IDs are
  // also dropped to avoid dangling metadata (consistent with the approach in
  // tool-result-truncation.ts).
  const removedIds = new Set<string>();
  for (const entry of allEntries) {
    if (summarizedBranchIds.has(entry.id) && entry.type === "message") {
      removedIds.add(entry.id);
    }
  }

  for (const entryId of collectMaintenancePairRemovalIds({
    branch,
    options: params,
    restrictToIds: summarizedBranchIds,
  })) {
    removedIds.add(entryId);
  }

  collectDanglingMetadataRemovalIds(allEntries, removedIds);

  if (removedIds.size === 0) {
    return { truncated: false, entriesRemoved: 0, reason: "no entries to remove" };
  }
  return await rewriteSessionWithRemovedIds({
    sessionFile,
    header,
    allEntries,
    removedIds,
    archivePath: params.archivePath,
    logPrefix: "[session-truncation]",
  });
}

export type TruncationResult = {
  truncated: boolean;
  entriesRemoved: number;
  bytesBefore?: number;
  bytesAfter?: number;
  reason?: string;
};
