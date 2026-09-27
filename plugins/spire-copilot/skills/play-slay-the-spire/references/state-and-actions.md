# State and action details

Read this reference only when compact fields are unclear, a state mismatch is reported, or an action result needs recovery.

## Compact state

- The first compact state includes `run_context`; later deck, relic, and potion changes arrive in `run_delta`.
- The first map state in an act includes the complete graph. Later states use `map_ref` plus current and next nodes; map nodes use `s` for the room symbol and `to` for child coordinates.
- Initial cached card effects arrive in `card_defs`; newly encountered generated, rewarded, or Mod cards arrive once in `card_defs_added`. Hand and choice entries use `ref` plus live values.
- In hand entries, `d` is current per-hit damage before target-only modifiers. `ed` is a target-adjusted per-hit estimate: a number for the sole enemy or an enemy-index map for multiple targets. Multiply by the hit count and still account for block and unusual Mod mechanics.
- `hand.changed` updates the matching `ref` in place. Preserve omitted fields instead of treating the card as removed and redrawn.

## Settled actions

- Action tools return a compact `result` receipt plus settled `changes`; these are authoritative.
- The runtime applies a short visual cooldown and then rereads state. Do not add manual delays unless the user still reports that the visible game lags behind the returned state.
- Never resend `end_turn` after a timeout or uncertain response. Read state; the original command may already have executed.
- On card-selection screens, use the latest `choice_uuid` when names can repeat, otherwise a unique `choice_text`. Numeric indices can change after every selection. Shops always require `choice_text`.
- Stable `choice_text` or `choice_uuid` actions may appear in `act_many`; the runtime resolves each against fresh state.
- If a batch returns `halted: true`, trust its completed count and refreshed changes. Do not replay completed actions; inspect `failed_action_status` before handling the failed item.
