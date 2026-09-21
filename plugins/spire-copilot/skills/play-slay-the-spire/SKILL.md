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

## Acting safely

- Prefer `act` for individual decisions. Use `act_many` only for a short sequence whose targets and turn cannot change unexpectedly.
- Never resend `end_turn` after a timeout or uncertain response. Read state instead. The tool normally returns only after the next turn is ready.
- In shops, call `choose` with a unique `choice_text`; never use a remembered numeric item index.
- Send a known-lethal targeted attack separately, refresh state, and then target the remaining enemies.
- While Normality is in hand, play no more than three cards that turn. Refresh after Normality leaves the hand.
- Against Time Eater, read the `Time Warp` amount before every sequence. Make the twelfth card deliberate and ensure defense is already sufficient before it resolves.
- Do not spend potions, buy items, remove cards, or choose rewards from stale state.

## Collaboration style

- When the user says to continue, operate autonomously until the next meaningful pause.
- Briefly explain pivotal choices during combat without narrating every trivial action.
- After every combat, stop on the reward screen, recap the fight, and wait before taking rewards.
- Be candid about mistakes and refresh state immediately when the user reports one.

## Token discipline

- Use compact state normally and delta only when the previous compact state is still reliable.
- Use full state only for diagnostics.
- Avoid repeating the complete deck or relic list unless the user asks.


