# AI-end v0.8 Worker I qwen35 vs song-fast Long Comparison

Status: QWEN35_APPROACHES_SONGFAST_DAILY_BASELINE

## Scope

- 300 paired low-risk synthetic turns only.
- No qwen35 generation for L4-L8.
- No raw private-chat, real friend chat, raw Discord transcript, raw model output, prompt dump, memory, callback, EventGen, P2, training, adapter, LoRA, QLoRA, SFT, DPO, or Axolotl.

## Metrics

- paired_turns: 300
- qwen35_median_latency_ms: 4231
- qwen35_p90_latency_ms: 4431
- song_fast_median_latency_ms: 7343
- song_fast_p90_latency_ms: 8251
- qwen35_question_ending_rate: 0.000000
- song_fast_question_ending_rate: 0.053333
- qwen35_naturalness_score: 4.993
- song_fast_naturalness_score: 4.954
- song_fast_similarity_on_low_risk_daily: 0.992
- qwen35_customer_service_tone_failures: 0
- song_fast_customer_service_tone_failures: 0
- qwen35_therapy_template_failures: 0
- song_fast_therapy_template_failures: 0
- qwen35_over_cold_reply_rate: 0.010000
- song_fast_over_cold_reply_rate: 0.113333
- qwen35_desktop_context_usefulness_score: 4.800
- song_fast_desktop_context_usefulness_score: 4.800

## Privacy Counters

- raw_text_logged: false
- raw_output_logged: false
- prompt_dumped: false
- memory_written: false
- callback/EventGen/P2 triggered: false

Final status: QWEN35_APPROACHES_SONGFAST_DAILY_BASELINE
