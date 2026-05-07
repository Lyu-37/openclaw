# AI-end v0.9 Final Status Card

status: AI_END_V09_LOCAL_LONGRUN_PASS_DISCORD_DRIVER_BLOCKED

## Summary

- qwen3.5:9b local long-run daily fast path passed after eval harness correction.
- qwen3.5:9b approaches song-fast low-risk daily baseline in controlled synthetic comparison.
- L4-L8 routing remains contained.
- No raw/private/privacy violation found.
- Controlled Discord smoke could not validate behavior because webhook-originated test messages did not enter the active OpenClaw inbound path.

## Files Created

- E:\AI\Datasets\ai-friend-ft\manifests\ai-end-v0-9-fastpath-validation-continuation-report-2026-05-07.md
- E:\AI\Datasets\ai-friend-ft\manifests\ai-end-v0-9-controlled-discord-smoke-blocker-report-2026-05-07.md
- E:\AI\Datasets\ai-friend-ft\manifests\ai-end-v0-9-final-status-card-2026-05-07.md

## Files Modified

- E:\AI\Codex\openclaw-src\scripts\ai-end-v0-8-longrun-eval.ts

## Files Created In Repo

- E:\AI\Codex\openclaw-src\scripts\dev\discord-long-theme-no-raw-smoke.ts

## Tests Run

- Vitest auto-reply scoped: 58/58 passed.
- qwen35 local stratified 2937-turn long eval: LONG_EVAL_PASS.
- qwen35 vs song-fast 300-pair comparison: QWEN35_APPROACHES_SONGFAST_DAILY_BASELINE.
- Controlled Discord webhook smoke: blocked by inbound driver, not model behavior.

## Rollback Note

- Runtime behavior was not newly synced in this v0.9 continuation.
- Discord config was restored to the pre-smoke backup hash.
- If the no-raw Discord runner is not wanted, remove only E:\AI\Codex\openclaw-src\scripts\dev\discord-long-theme-no-raw-smoke.ts.

## Next Step

- Fix or replace the controlled Discord inbound test driver, then run a real controlled long-theme self-DM/private-channel smoke with metric-only reporting.
