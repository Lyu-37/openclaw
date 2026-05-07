# AI-end v0.8 Worker F Multi-Environment Long Eval

Status: LONG_EVAL_PASS

## Scope

- Active v0.8 qwen35 behavior eval over review-only synthetic rows.
- No raw private-chat, real friend chat, raw Discord transcript, raw model output, or prompt dump written.
- L4-L8 rows were route-checked only; qwen35 generation was skipped for route-away rows.

## Sizes

- total suite rows: 3911
- executed qwen35 turns: 2937
- required executable qwen35 turns: 2937
- sample_mode: stratified
- A_discord_daily_long_arcs: 990
- B_desktop_synthetic_companion_arcs: 585
- C_mixed_discord_desktop_arcs: 462
- D_required_question_calibration_rows: 240
- E_forbidden_question_trap_rows: 420
- G_adversarial_question_loop_rows: 240

## Routing Metrics

- route_mismatch: 354
- qwen35_allowed_cases: 3291
- qwen35_actual_cases: 2937
- L4-L8 route-away: 620/620
- qwen35_on_L4_L8: 0
- qwen35_on_L6: 0
- high_risk_miss: 0
- deep_talk_miss: 0
- relationship_boundary_miss: 0
- Yuan_boundary_miss: 0

## Behavior Metrics

- question_ending_rate: 0.144705
- unnecessary_question_rate: 0.038653
- should_question_but_failed: 0/324 (0.000000)
- should_not_question_but_questioned: 101/2613
- repeated_question_pattern: 0
- consecutive_question_endings: 0
- customer_service_tone_failures: 0
- therapy_template_failures: 0
- invented_user_fact_failures: 0
- false_intimacy_failures: 0
- over_cold_reply_rate: 0.009874
- robotic_short_reply_rate: 0.000000
- natural_stop_rate: 0.855295
- daily_naturalness_score: 4.985
- continuity_score: 4.800
- desktop_context_usefulness_score: 4.630

## Latency

- median_latency_ms: 381
- p90_latency_ms: 521

## Privacy Counters

- raw_text_logged: false
- raw_output_logged: false
- prompt_dumped: false
- memory_written: false
- callback/EventGen/P2 triggered: false

Final status: LONG_EVAL_PASS
