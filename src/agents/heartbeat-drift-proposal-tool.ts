import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { resolveOsHomeDir } from "../infra/home-dir.js";

const emitDriftProposalSchema = Type.Object({
  proposed_drift: Type.Object(
    {},
    {
      additionalProperties: true,
      description: "Structured drift proposal for StateEvolver to review.",
    },
  ),
  reason: Type.String({
    description: "Brief reason HEARTBEAT believes this drift should be considered.",
  }),
  conversation_id: Type.Optional(
    Type.Union([Type.String(), Type.Null()], {
      description: "Optional source conversation id if known.",
    }),
  ),
});

type EmitDriftProposalDetails = {
  path: string;
  status: "pending";
};

function defaultQueueDir() {
  const home = resolveOsHomeDir();
  if (!home) {
    throw new Error("Cannot resolve OS home directory for heartbeat proposal queue.");
  }
  return path.join(home, ".openclaw", "world", "heartbeat-proposals");
}

function jsonText(value: unknown) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function compactUtcIso(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`invalid proposal timestamp: ${JSON.stringify(iso)}`);
  }
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function shortHash(text: string) {
  return createHash("sha256").update(text).digest("hex").slice(0, 6);
}

function resolveQueueDir() {
  const override = process.env.OPENCLAW_HEARTBEAT_PROPOSAL_DIR?.trim();
  return path.resolve(override || defaultQueueDir());
}

async function writeProposalAtomic(queueDir: string, proposal: Record<string, unknown>) {
  await fs.mkdir(queueDir, { recursive: true });
  const content = jsonText(proposal);
  const compactTimestamp = compactUtcIso(String(proposal.timestamp));
  const hash = shortHash(content);
  const baseName = `${compactTimestamp}-${hash}`;

  for (let suffix = 0; ; suffix += 1) {
    const suffixText = suffix === 0 ? "" : `-${suffix}`;
    const proposalPath = path.resolve(queueDir, `${baseName}${suffixText}.json`);
    try {
      await fs.access(proposalPath);
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    try {
      await fs.writeFile(`${proposalPath}.tmp`, content, { flag: "wx" });
      await fs.rename(`${proposalPath}.tmp`, proposalPath);
      return proposalPath;
    } catch (error) {
      await fs.rm(`${proposalPath}.tmp`, { force: true }).catch(() => {});
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        continue;
      }
      throw error;
    }
  }
}

export function createHeartbeatDriftProposalTool(): AgentTool<
  typeof emitDriftProposalSchema,
  EmitDriftProposalDetails
> {
  return {
    name: "emit_drift_proposal",
    label: "emit_drift_proposal",
    description:
      "Queue a HEARTBEAT drift proposal for StateEvolver review. Use this instead of writing STATE.md directly.",
    parameters: emitDriftProposalSchema,
    execute: async (_toolCallId, args) => {
      const params = args as {
        proposed_drift?: unknown;
        reason?: unknown;
        conversation_id?: unknown;
      };
      if (
        !params.proposed_drift ||
        typeof params.proposed_drift !== "object" ||
        Array.isArray(params.proposed_drift)
      ) {
        throw new Error("proposed_drift must be an object.");
      }
      if (typeof params.reason !== "string" || !params.reason.trim()) {
        throw new Error("reason required.");
      }
      const timestamp = new Date().toISOString();
      const proposal = {
        version: 1,
        timestamp,
        source: "heartbeat",
        conversation_id:
          typeof params.conversation_id === "string" && params.conversation_id.trim()
            ? params.conversation_id.trim()
            : null,
        proposed_drift: params.proposed_drift,
        reason: params.reason.trim(),
        status: "pending",
        decided_at: null,
        decision_reason: null,
      };
      const proposalPath = await writeProposalAtomic(resolveQueueDir(), proposal);
      return {
        content: [
          {
            type: "text",
            text: `Queued heartbeat drift proposal: ${proposalPath}`,
          },
        ],
        details: {
          path: proposalPath,
          status: "pending",
        },
      };
    },
  };
}
