# AI-end v0.9 Fastpath Validation Continuation Report

Status: AI_END_V09_LOCAL_LONGRUN_PASS_DISCORD_DRIVER_BLOCKED

## Scope

- AI-end only: qwen3.5:9b daily fast path, routing, local eval, and controlled Discord smoke preparation.
- No takeover of persona, frontend, or data ownership.
- No training, LoRA, QLoRA, SFT, DPO, Axolotl, adapter, model download, alias change, or song-fast replacement.
- No raw private-chat or real friend chat was read, even with user authorization.
- No SOUL, persona, memory semantics, callback, EventGen, or P2 modification.
- No raw Discord transcript, raw model output, or prompt dump written.

## Boundary Decision

- User authorized reading real friend chat logs, but this run did not use them.
- Reason: the AI-end governance boundary forbids reading or absorbing real friend/private chat for runtime, eval, training, memory, or imitation.
- Replacement approach: use generic daily conversation structure, synthetic long-theme arcs, and no-raw-text metrics.

## Local Long Eval

- Report: ai-end-v0-9-fastpath-validation-stratified-full-longrun-rechecked-2026-05-07.md
- Status: LONG_EVAL_PASS
- Total suite rows: 3911
- Executed qwen35 turns: 2937
- Required executable qwen35 turns: 2937
- Discord daily turns: 990
- Desktop synthetic turns: 585
- Mixed synthetic turns: 462
- Required-question calibration turns: 240
- Forbidden-question trap turns: 420
- Adversarial question-loop turns: 240

## Local Metrics

- question_ending_rate: 0.144705
- unnecessary_question_rate: 0.038653
- should_question_but_failed: 0/324
- should_not_question_but_questioned: 101/2613
- repeated_question_pattern: 0
- consecutive_question_endings: 0
- customer_service_tone_failures: 0
- therapy_template_failures: 0
- invented_user_fact_failures: 0
- false_intimacy_failures: 0
- over_cold_reply_rate: 0.009874
- robotic_short_reply_rate: 0
- natural_stop_rate: 0.855295
- daily_naturalness_score: 4.985
- continuity_score: 4.800
- desktop_context_usefulness_score: 4.630
- median_latency_ms: 381
- p90_latency_ms: 521

## Routing And Privacy

- L4-L8 route-away: 620/620
- qwen35_on_L4_L8: 0
- qwen35_on_L6: 0
- high_risk_miss: 0
- deep_talk_miss: 0
- relationship_boundary_miss: 0
- Yuan_boundary_miss: 0
- raw_text_logged: false
- raw_output_logged: false
- prompt_dumped: false
- memory_written: false
- callback/EventGen/P2_triggered: false

## qwen35 vs song-fast

- Report: ai-end-v0-9-qwen35-vs-songfast-long-comparison-2026-05-07.md
- Status: QWEN35_APPROACHES_SONGFAST_DAILY_BASELINE
- Paired low-risk turns: 300
- qwen35 median_latency_ms: 4231
- qwen35 p90_latency_ms: 4431
- song-fast median_latency_ms: 7343
- song-fast p90_latency_ms: 8251
- qwen35_naturalness_score: 4.993
- song_fast_naturalness_score: 4.954
- song_fast_similarity_on_low_risk_daily: 0.992
- qwen35_customer_service_tone_failures: 0
- qwen35_therapy_template_failures: 0

## Notes

- The 900-turn stratified probe showed behavior revision needed because required-question rows were overweighted.
- The full stratified run used the available production-equivalent qwen35 rows and passed.
- The eval harness was corrected so pass gating uses actual executable qwen35 rows rather than a fixed 3000-row assumption.
