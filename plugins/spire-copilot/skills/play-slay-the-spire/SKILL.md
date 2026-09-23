---
name: play-slay-the-spire
description: Play or advise on a live modded Slay the Spire run through the Spire Copilot MCP. Use when the user asks to inspect, continue, explain, or operate their current Slay the Spire game.
---

# Play Slay the Spire

Use the `spire_copilot` MCP tools for live game state and actions.

## Start and state

1. Call `get_state` with `mode: compact` before the first action and after any user-reported mismatch.
2. Treat live state and explicit user corrections as authoritative. Do not carry removed cards, temporary powers, or old enemy indices forward from memory.
3. If the game endpoint is unavailable, ask the user to start ModTheSpire with `MCP The Spire` enabled and enter the save. Do not ask them to start a separate relay.
4. All game indices are 1-based.
5. The first compact state includes `run_context`; later deck, relic, and potion updates arrive in `run_delta`.
6. The first map state in an act includes the full route graph in `map`; later map states use `map_ref` plus current/next nodes. Each map node uses `s` for its room symbol and `to` for child coordinates.

## Acting safely

- Prefer `act` for individual decisions. Use `act_many` only for a short sequence whose targets and turn cannot change unexpectedly.
- Action tools return a compact `result` receipt and settled `changes`; treat those changes as authoritative and call `get_state` only when the result is ambiguous or the user reports a mismatch.
- Never resend `end_turn` after a timeout or uncertain response. Read state instead. The tool normally returns only after the next turn is ready.
- In shops, call `choose` with a unique `choice_text`; never use a remembered numeric item index.
- Send a known-lethal targeted attack separately, refresh state, and then target the remaining enemies.
- While Normality is in hand, play no more than three cards that turn. Refresh after Normality leaves the hand.
- Against Time Eater, read the `Time Warp` amount before every sequence. Make the twelfth card deliberate and ensure defense is already sufficient before it resolves.
- For a poison-lethal `end_turn`, count only Poison already on the enemy: it damages them before their action. Do not count player-turn-start effects, such as Noxious Fumes, as part of the pending enemy turn.
- Do not spend potions, buy items, remove cards, or choose rewards from stale state.

## Collaboration style

- When the user says to continue, operate autonomously until the next meaningful pause.
- Briefly explain pivotal choices during combat without narrating every trivial action.
- After every combat, stop on the reward screen, recap the fight, and wait before taking rewards.
- Be candid about mistakes and refresh state immediately when the user reports one.

## Token discipline

- Use compact state at the start of a task. Afterwards rely on action `changes`, and use delta only when the previous state is still reliable.
- Use full state only for diagnostics.
- Do not request or repeat the complete deck, relic list, or full map after their initial context unless diagnosing a mismatch.
