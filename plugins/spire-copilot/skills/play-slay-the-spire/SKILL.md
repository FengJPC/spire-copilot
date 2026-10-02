---
name: play-slay-the-spire
description: Play or advise on a live modded Slay the Spire run through the Spire Copilot MCP. Use when the user asks to inspect, continue, explain, or operate their current Slay the Spire game.
---

# Play Slay the Spire

Use the `spire_copilot` tools for live state and actions. Before the first live action, read [interface-contract.md](references/interface-contract.md) once in the available working context; reuse it while retained, rather than rereading every turn.

## Workflow

1. Call `get_state` with `mode: compact` before the first action and after any user-reported mismatch. Treat live state and explicit corrections as authoritative; all indices are 1-based.
2. Apply `advisories` from state, action and inspection responses before choosing actions. Interface hints arrive once per connection at the relevant hand/choice, shop, inventory or pile query; reconnect resets them. Combat hints retain their encounter/turn scopes. Read `current.stance` in action/delta receipts; do not infer stance from card damage.
3. Use `inspect_card` when an effect is missing, unfamiliar, modified, or worth verifying. Prefer an exact `choice_uuid`, otherwise `card_id` plus upgrades; do not request full state just to inspect one card.
   Use `inspect_pile` with `pile: draw`, `discard`, or `exhaust` only when composition matters for draw, recovery, or cycle planning. It is unordered, not a prediction of the next draw; pile stats may change on entering hand.
4. Use `card_name` for the cheapest playable same-effect copy, or `card` with a hand `k` for an exact copy; Copilot handles instance matching and reindexing. Use `act` when the next decision needs a fresh observation; `act_many` can group already-decided actions with stable turns, targets, and choices. It verifies each action and stops at an unsafe boundary; never plan through unknown draws or new choices.
5. Trust verified receipts and `changes`; `outcome_unknown`/`timeout_unknown` never mean not executed. Never replay completed or uncertain actions; read state instead. Send known-lethal targeted attacks separately before targeting remaining enemies. All actions verify settlement; `visual_wait` (legacy `wait`) controls pacing only.
6. Resolve changing card choices by `choice_uuid` or unique `choice_text`; shops require `choice_text`. Never spend, buy, remove, or choose rewards from stale state.

If the endpoint is unavailable, ask the user to start ModTheSpire with `MCP The Spire` enabled and enter the save; no separate relay is needed.

Before the first shop purchase, potion management or pile query, apply the relevant runtime interface hint; if it is absent from retained context or does not cover the decision, read the relevant section of [state-and-actions.md](references/state-and-actions.md). Read that reference before ambiguous-action recovery and after a field/effect mismatch. Before planning around retaliation, Normality, Time Eater, or poison lethal, read the applicable entry in [combat-safety.md](references/combat-safety.md) unless a runtime advisory already explains that mechanic adequately. Reuse while retained; trigger checks by the intended action, not by feeling confused.

## Collaboration

- By default, a request to continue authorizes play through the next combat; stop on its reward screen, briefly recap, and wait before taking rewards.
- Explicit continuous-play authorization for the run overrides that default: handle rewards and continue through map, shop, elite and Boss decisions without routine confirmation. Honor any user-selected pause boundary or later stop request. After an uncertain action, stop mutations and read state without replaying it; pause for the user if fresh reads cannot resolve the uncertainty/mismatch or new authority is required. Explain pivotal choices and brief combat outcomes without forcing a pause.
- Be candid about mistakes and refresh state after a reported mismatch.

## Token discipline

- After the initial compact state, rely on `changes`, `run_delta`, and cached card definitions. Use delta only while prior state remains reliable and full state only for diagnostics.
- Preserve omitted fields in `hand.changed`; match `key` to hand `k`, not effect `ref`. Do not infer hand positions from delta order.
- Do not repeat the complete deck, relic list, card catalog, or map unless diagnosing a mismatch.
