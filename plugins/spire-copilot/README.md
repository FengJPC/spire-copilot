# Spire Copilot plugin

This directory is the installable plugin package. The repository-level README
contains requirements and installation instructions.

The stdio entry remains `scripts/server.mjs`. Internals live in
`scripts/runtime/`, assembled by `runtime/index.mjs`; fixtures in
`scripts/tests/` load only for development checks. Run `node scripts/test-all.mjs`
to validate the complete installed package. Runtime splitting does not change
the five tools, game endpoint, settings, or 0.2.18 safety semantics.

The plugin exposes five MCP tools:

- `get_state`: one-time run context, semantic delta, or diagnostic full state.
- `inspect_card`: one exact card definition and any matching live instance
  values, without expanding the complete game state.
- `inspect_pile`: on-demand composition of `draw`, `discard`, or `exhaust`,
  grouped by equivalent live values with `qty` and cached effects. The list is
  unordered, never actual draw order; unknown data is distinct from empty.
- `act`: one settled, safety-checked action with a compact result and changes.
- `act_many`: a short serial sequence that stops when the target set or turn
  changes. If a later action fails, its normal result identifies completed,
  failed, and remaining actions together with the refreshed game state.

Both action tools share the same action-specific verifier and optional
`timeout_ms` limit (20 seconds by default). Mutation HTTP responses and
verification reads share one deadline; a hanging response is aborted without
resending the action. `visual_wait` controls minimum animation pacing only;
legacy `wait` is a deprecated alias and never disables verification.

Execution certainty is `not_sent`, `sent_unknown`, `accepted`, or `verified`.
Only failures before action dispatch report `not_executed`; lost/malformed
responses and generic downstream errors report `outcome_unknown` or
`timeout_unknown` and stop the remaining batch. End-turn fences persist across
transport reconnects and duplicate attempts until fresh state resolves them.
These fences are in-memory, not durable across a runtime process restart.
Unrelated state changes do not verify card or potion actions; immediate-return
cards without richer upstream evidence may conservatively time out.
Normality's local `trackedCardsPlayed` is not an authoritative game count;
uncertain sends block limited plays unless a reliable count becomes available.

For example, `inspect_pile({"pile":"draw"})` returns the current draw-pile
composition with floor/turn context. It exposes no UUIDs or hand indices and
does not advance the hand/delta baseline. Query only when draw, recovery, or
cycle planning needs it; normal compact states and receipts retain counts only.
Pile costs and stats are snapshot values, not guaranteed after the next draw.

Choice screens expose consistent 1-based indices plus stable card identities.
Use `choice_text` for unique names or `choice_uuid` for an exact card instance;
hand selections reject stale numeric-only choices. Stable choices can be sent
through `act_many`; the runtime executes them serially and resolves every item
against the refreshed list. The full route graph is sent once per act and later
map screens reuse `map_ref`; each node uses `s` for its room symbol and `to` for
child coordinates. Deck, relic, potion, stance, and player-power changes are
reported explicitly. Card effects are emitted once in `card_defs`, newly seen
cards arrive in `card_defs_added`, and later choices retain only stable refs and
live values. Stance and debuff changes update matching hand instances in place rather
than resending whole cards. Target-only modifiers add `ed`, a compact estimated
damage-per-hit value for the affected enemy or enemies. Batched actions poll a
fresh state until an observable result appears and also retain minimum
animation-aware pacing, so a logical `ready_for_command` frame cannot make a
batch outrun visible card and stance effects. Transient combat frames with
incomplete data are filtered.
Semantic hand changes preserve repeated identical cards and include the
absolute post-change `count`, allowing clients to verify hand size without a
second full-state request.
Each physical hand card has a short handle `k` and actual position `i`; deltas
use handles rather than shared effect refs. `card_name` automatically chooses
the cheapest playable same-effect copy. Use `card: "h7"` for one exact copy.
The runtime binds numeric indices to the last observed hand and sends UUIDs
to the game's single-action batch endpoint for game-thread resolution. Missing
copies, ambiguous effects, increased exact-copy costs, or insufficient energy
halt before execution. No long UUID bookkeeping is required of the caller.
Compact reads and action receipts also emit deduplicated `advisories` when a
relevant special mechanic first appears, including supported boss openings,
per-hit retaliation, Normality, unsafe Wrath turns, and Coffee Dripper at Rest
sites. Unknown Mod encounters remain state-driven rather than guessed.

The in-game `MCP The Spire` mod must remain enabled because it provides the
downstream game endpoint.
