---
summary: "Metric-only validation for a local qwen daily fast path"
read_when:
  - You are validating a low-risk local model fast path
  - You need no-raw-text eval and Discord smoke categories
title: "Qwen Fast Path Validation"
---

# Qwen Fast Path Validation

This page tracks the local qwen daily fast-path validation work and keeps the related
artifacts out of the repository root.

## Categories

### Runtime and routing

- `src/auto-reply/reply/conversation-router-v0.ts`
- `src/auto-reply/reply/conversation-router-v0.test.ts`
- `src/auto-reply/reply/get-reply.ts`
- `src/auto-reply/reply/get-reply-run.ts`

These files cover model selection, L0-L8 routing, light-model guardrails,
question-shape repair, and no-raw-text router telemetry.

### Evaluation harnesses

- `scripts/ai-end-v0-8-longrun-eval.ts`
- `scripts/ai-end-v0-8-songfast-comparison.ts`
- `scripts/eval-private-derived-generic-behavior-v0-2.ts`

These scripts run metric-only local checks. They must not be used as training
pipelines and must not write raw private chat, raw Discord text, raw prompts, or raw
model outputs.

### Controlled Discord smoke

- `scripts/dev/discord-long-theme-no-raw-smoke.ts`

This runner is intended for a controlled self-DM or private test channel. Reports
must stay metric-only. The v0.9 webhook driver attempt did not enter the production
OpenClaw inbound route, so that result is a driver blocker rather than a model
quality result.

### Reports

- `docs/diagnostics/fast-path-validation-reports/v0-3/`
- `docs/diagnostics/fast-path-validation-reports/v0-9/`

Reports are sanitized summaries only. They record aggregate metrics, hashes, pass/fail
states, and blockers. They do not contain raw transcripts or raw model responses.

## Current v0.9 status

- Local qwen long-run eval: pass.
- qwen vs song-fast low-risk comparison: approaches baseline.
- L4-L8 route-away: contained.
- Privacy counters: no raw text/output/prompt, no memory write, no callback/EventGen/P2.
- Controlled Discord smoke: blocked by webhook inbound-driver behavior.

## Guardrails

- Do not read raw private chat or real friend chat for this validation.
- Do not use review-only synthetic eval as training data.
- Do not train, fine-tune, start adapters, or replace model aliases from this path.
- Do not let the qwen fast path generate L4-L8 substantive replies.
- Do not commit raw Discord transcripts, raw prompts, raw model outputs, or memory dumps.
