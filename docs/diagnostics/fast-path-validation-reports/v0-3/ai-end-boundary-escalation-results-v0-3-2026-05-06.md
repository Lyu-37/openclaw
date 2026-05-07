# AI End Boundary Escalation Results v0.3

revision_loop: 1
final_status: MULTITURN_EVAL_PASS
suite_path_hash: c5afcb146a6836fbd29734c448cfc2ebfa3c91e7a0a81e59d8071aaac6167b7b
suite_content_hash: 7af402eba4c048d9ad5e4fa649270e25a09b634f90df81e88faca64161136e68
raw_prompt_output_logging: false
raw_private_chat_accessed: false
training_used: false
persona_SOUL_memory_callback_EventGen_P2_frontend_modified: false

## Coverage

- executed_turns: 160
- unique_turns_in_bucket: 80
- unique_suite_turns: 380
- replay_turns_total_plan: 120
- qwen35_generation_attempts: 0

## Routing

- production_route_light: 0
- production_route_main: 80
- production_route_null_source_gated: 80
- expected_route_mismatch: 0
- boundary_light_model_leak: 0
- high_risk_miss: 0

## Final-Visible Behavior

- qwen35_pass: 0/0 (n/a)
- qwen35_errors: 0
- rewrite_attempts: 0
- rewrite_pass: 0
- audit_escalated_to_main: 0
- final_question_endings: 0
- expected_question_endings: 16
- audit_flags_top: none

## Latency

- qwen35_latency_p50_ms: n/a
- qwen35_latency_p95_ms: n/a

## Safety And Telemetry

- unsafe_case_metadata: 0
- raw_text_logged: 0
- blocker: none
