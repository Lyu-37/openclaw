# AI-end v0.9 Controlled Discord Smoke Blocker Report

Status: CONTROLLED_DISCORD_SMOKE_BLOCKED_BY_WEBHOOK_INBOUND_DRIVER

## Scope

- Controlled work-server test channel smoke was attempted with synthetic daily long-theme messages.
- Test channel: work server controlled test channel.
- Driver: temporary Discord webhook.
- No broader Discord smoke, no real user group, no private chat, no raw logging, no memory write, no callback/EventGen/P2.

## What Happened

- The webhook successfully posted synthetic test messages to the test channel.
- The OpenClaw gateway stayed running.
- The bot did not produce replies to webhook-originated test messages.
- Router trace did not advance for those messages.
- Temporarily allowing bot/webhook messages did not resolve inbound delivery.

## Metrics

- Preflight planned_turns: 3
- Preflight executed_turns: 3
- reply_timeout: 3
- qwen35_daily_rate: 0
- qwen35_on_L4_L8: 0
- qwen35_on_L6: 0
- raw_text_logged: false
- raw_output_logged: false
- prompt_dumped: false
- memory_written: false
- callback/EventGen/P2_triggered: false

## Cleanup

- Temporary Discord config changes were restored.
- Current openclaw.json hash matches the pre-smoke backup.
- Temporary webhook runner processes were stopped.
- Temporary test webhook was removed.
- Gateway remains running on the existing active runtime.

## Interpretation

- This is not a qwen35 behavior failure.
- This is not an L4-L8 routing failure.
- This is not a privacy failure.
- The blocker is the controlled test driver: webhook-originated messages are not entering the production OpenClaw inbound route in the same way as a real user message.

## Next Safe Options

- Use a real controlled self-DM/private channel message from the authorized user, with metric-only observation.
- Or build a dedicated no-raw Discord test driver that is explicitly supported by the gateway and does not use hidden metadata or raw transcript logs.
- Do not treat webhook timeout runs as model-quality evidence.
