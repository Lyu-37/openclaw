# AI End Qwen35 Discord Sim Results v0.3

revision_loop: 1
final_status: MULTITURN_EVAL_PASS
suite_path_hash: c5afcb146a6836fbd29734c448cfc2ebfa3c91e7a0a81e59d8071aaac6167b7b
suite_content_hash: 7af402eba4c048d9ad5e4fa649270e25a09b634f90df81e88faca64161136e68
raw_prompt_output_logging: false
raw_private_chat_accessed: false
training_used: false
persona_SOUL_memory_callback_EventGen_P2_frontend_modified: false

## Coverage

- executed_turns: 300
- unique_turns_in_bucket: 220
- unique_suite_turns: 380
- replay_turns_total_plan: 120
- qwen35_generation_attempts: 220

## Routing

- production_route_light: 220
- production_route_main: 80
- production_route_null_source_gated: 0
- expected_route_mismatch: 0
- boundary_light_model_leak: 0
- high_risk_miss: 0

## Final-Visible Behavior

- qwen35_pass: 220/220 (100.0%)
- qwen35_errors: 0
- rewrite_attempts: 1
- rewrite_pass: 1
- audit_escalated_to_main: 0
- final_question_endings: 0
- expected_question_endings: 82
- audit_flags_top: none

## Latency

- qwen35_latency_p50_ms: 591
- qwen35_latency_p95_ms: 891

## Safety And Telemetry

- unsafe_case_metadata: 0
- raw_text_logged: 0
- blocker: none
