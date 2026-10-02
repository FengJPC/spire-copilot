---
name: play-slay-the-spire
description: Play or advise on a live modded Slay the Spire run through the Spire Copilot MCP. Use when the user asks to inspect, continue, explain, or operate their current Slay the Spire game.
---

# Play Slay the Spire

Use the `spire_copilot` tools for live state and actions.

## Workflow

1. Call `get_state` with `mode: compact` before the first action and after any user-reported mismatch. Treat live state and explicit corrections as authoritative; all indices are 1-based.
2. Apply any `advisories` before choosing actions. They are context-sensitive and normally emitted once when a mechanic first matters.
3. Use `inspect_card` when an effect is missing, unfamiliar, modified, or worth verifying. Prefer an exact `choice_uuid`, otherwise `card_id` plus upgrades; do not request full state just to inspect one card.
   Use `inspect_pile` with `pile: draw`, `discard`, or `exhaust` only when composition matters for draw, recovery, or cycle planning. It is unordered, not a prediction of the next draw; pile stats may change on entering hand.
4. Use `card_name` for the cheapest playable same-effect copy, or `card` with a hand `k` for an exact copy; Copilot handles instance matching and reindexing. Prefer `act`; use `act_many` only for short sequences with stable turns, targets, and choices.
5. Trust settled action receipts and `changes`. Never replay completed actions or an uncertain `end_turn`; read state after ambiguity. Send known-lethal targeted attacks separately before targeting remaining enemies.
6. Resolve changing card choices by `choice_uuid` or unique `choice_text`; shops require `choice_text`. Never spend, buy, remove, or choose rewards from stale state.

If the endpoint is unavailable, ask the user to start ModTheSpire with `MCP The Spire` enabled and enter the save; no separate relay is needed.

Read [state-and-actions.md](references/state-and-actions.md) only when interpreting compact fields, diagnosing a mismatch, or recovering an ambiguous/failed action. Read [combat-safety.md](references/combat-safety.md) only when a special mechanic is not adequately covered by a runtime advisory.

## Collaboration

- When the user says to continue, operate autonomously until the next meaningful pause and explain only pivotal choices.
- After every combat, stop on the reward screen, briefly recap, and wait before taking rewards.
- Be candid about mistakes and refresh state after a reported mismatch.

## Token discipline

- After the initial compact state, rely on `changes`, `run_delta`, and cached card definitions. Use delta only while prior state remains reliable and full state only for diagnostics.
- Preserve omitted fields in `hand.changed`; match `key` to hand `k`, not effect `ref`. Do not infer hand positions from delta order.
- Do not repeat the complete deck, relic list, card catalog, or map unless diagnosing a mismatch.
