# State and action details

Read this reference only when compact fields are unclear, a state mismatch is reported, or an action result needs recovery.

## Compact state

- The first compact state includes `run_context`; later deck, relic, and potion changes arrive in `run_delta`.
- The first map state in an act includes the complete graph. Later states use `map_ref` plus current and next nodes; map nodes use `s` for the room symbol and `to` for child coordinates.
- Initial cached card effects arrive in `card_defs`; newly encountered generated, rewarded, or Mod cards arrive once in `card_defs_added`. Hand and choice entries use `ref` plus live values.
- In hand entries, `d` is current per-hit damage before target-only modifiers. `ed` is a target-adjusted per-hit estimate: a number for the sole enemy or an enemy-index map for multiple targets. Multiply by the hit count and still account for block and unusual Mod mechanics.
- Hand cards have a short instance handle `k` and their actual 1-based position `i`; `ref` identifies the shared effect definition, not a physical copy.
- `hand.changed.key` identifies `k`; preserve omitted fields, remove by `removed[].k`, insert `added` cards, and order by `i`. Duplicate names and same-effect refs remain distinct.

## On-demand piles

- Call `inspect_pile` with `pile: "draw"`, `"discard"`, or `"exhaust"` when composition changes a decision; ordinary state still reports only pile counts.
- The response gives `floor`, `turn`, total `count`, and unordered `cards` groups. `qty` is multiplicity; upgraded or numerically different copies remain separate. Names, effect `ref`s, and current instance stats reuse cached `card_defs`/`card_defs_added`; `inspect_card` remains available for a specific effect.
- The display is canonically sorted, not the actual draw/discard order. No pile UUIDs, hand handles, or playable indices are exposed. Off-hand costs and stats describe the snapshot, not guaranteed values after drawing (e.g. Snecko rerolls costs).
- `NOT_IN_COMBAT` or `UNAVAILABLE` is not an empty pile; only `status: "ok", count: 0, cards: []` confirms empty. `definitions_unavailable` flags missing effect definitions instead of inventing them.
- Queries neither act nor replace the hand/delta baseline; any other state changes still arrive on the next state/action receipt. Refresh state before acting if the returned floor/turn no longer matches the observed hand.

## Settled actions

- Action tools return a compact `result` plus `changes`. Only `settlement: "verified"` confirms the postcondition; a failed receipt may still show effects of an uncertain action.
- `execution_certainty` distinguishes `not_sent`, `sent_unknown`, `accepted`, and `verified`. Only `not_sent` produces `not_executed`; after dispatch, response loss, malformed replies, or generic downstream errors produce `outcome_unknown`/`timeout_unknown`. The runtime never retries mutations and stops the remaining batch.
- `visual_wait` controls visual pacing only. Legacy `wait` is its deprecated alias; even `wait: false` still waits for action-specific verification. One mutation-response/verification deadline includes HTTP waits and polling reads.
- End-turn fences survive transport reconnects, duplicate attempts, and missing/backward turn metadata. A fresh later turn, changed floor, confirmed combat completion, or menu state resolves the fence. They are in-memory runtime safeguards, not a persistent cross-process transaction log.
- Verification requires exact card departure, selected potion-slot identity/emptiness changes, the chosen card/option's selection/removal, or expected control-screen/turn transitions. Unrelated HP, block, energy, or playability changes cannot independently verify a card/potion action. Immediate-return cards without richer upstream evidence may conservatively time out.
- Normality uses an upstream `cards_played_this_turn` count when available. Otherwise `trackedCardsPlayed` counts locally verified plays, not manual/automatic game plays; after a sent uncertain card it blocks Normality-limited plays until a reliable counter or a new turn is observed.
- Use `card_name` (or `card` with a name) for automatic cheapest-playable selection among same-effect copies. Use `card: "h7"` for the exact handle exposed as `k`. Different-effect same-name copies are rejected rather than guessed.
- Copilot checks current playability/cost and sends the underlying UUID for game-thread resolution. Missing copies and increased costs on exact selections halt before execution; there is no name fallback.
- Legacy `card_index` refers to the last observed hand, including throughout a batch; Copilot binds it to the instance, never an intermediate shifting position. Prefer handles so the agent need not track positions.
- The runtime applies a short visual cooldown and then rereads state. Do not add manual delays unless the user still reports that the visible game lags behind the returned state.
- Never resend `end_turn` after a timeout or uncertain response. Read state; the original command may already have executed.
- On card-selection screens, use the latest `choice_uuid` when names can repeat, otherwise a unique `choice_text`. Numeric indices can change after every selection. Shops always require `choice_text`.
- Stable `choice_text` or `choice_uuid` actions may appear in `act_many`; the runtime resolves each against fresh state.
- If a batch returns `halted: true`, trust its completed count and refreshed changes. Do not replay completed actions; inspect `failed_action_status` before handling the failed item.
