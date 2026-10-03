# Changelog

All notable changes to Spire Copilot are documented here.

## [0.2.29] - 2026-10-03

### Added

- The once-per-connection orb hint and reference explain that vanilla channeling
  with all available slots occupied evokes slot 1 before inserting the new orb;
  count that evoke rather than only the new orb's passive effect. Zero capacity,
  unavailable data and Mod rules must not be treated as a full occupied queue.

### Changed

- Development checks continue through independent scripts after a failure and
  print every result, returning nonzero if any check failed. Stateful scripts
  retain first-assertion failure; spawn errors and timeouts are not green results.
- Runner regression tests exercise real nonzero exits, missing executables,
  syntax errors, timeout closure, later-check execution and parent-visible status.
  Gameplay settlement, safety guards and mutation retry policy are unchanged.

## [0.2.28] - 2026-10-03

### Fixed

- Incoming-damage advisory and references explicitly identify enemy Weak,
  player Vulnerable and stance as already included in displayed per-hit atk.
  Do not apply these twice; intent remains before Block, not guaranteed HP loss.
  Refresh after power/stance changes and account separately for later mitigation,
  other damage sources and Mod mechanics. No execution or damage formula changed.
- Regression coverage preserves upstream multi-hit intent with Weak/Vulnerable/
  Wrath and checks the existing once-per-encounter delivery and reconnect reset.

## [0.2.27] - 2026-10-03

### Fixed

- Shop receipt and settlement identities reuse the compact choice name+price
  match, never a mixed purchase index into the pure card list. Non-card or
  unmatched choices do not acquire an unrelated card UUID. Known purchases
  require item acquisition or canonical stock removal, not affordability changes.

### Added

- Explicit support and guidance for ordered shop purchase batches via act_many.
  Planned full text/price/known identities are bound once, each item is resolved
  against settled state and verified before the next; ordinary reindexing is
  safe. Price/identity changes, missing or ambiguous items, insufficient funds,
  new screens and unknown outcomes halt without replay, substitution or rollback.
- Compact purchases summaries list verified items only, including partial
  completion. Skill, references, MCP descriptions and first-shop advisory agree.
- Regression coverage for mixed/filtered lists, repeated buys and reindexing,
  free/non-card identities, changed prices/UUIDs, funds, selection screens,
  missing/ambiguous items and lost replies with no replay/continuation.

## [0.2.26] - 2026-10-03

### Fixed

- Preserve combat orb slots in compact state and action/delta receipts, including
  queue order, duplicate IDs, empty/unknown entries and supplied passive/evoke
  amounts. Orb deltas replace the whole small ordered list rather than merging
  by type; missing upstream data stays null instead of inventing an empty list.
- Expose current signed Focus at player level (zero when absent on an available
  player; null when unavailable). Preserve upstream empty-slot objects without
  fabricating an orb type. Vanilla slot 1 is rightmost/first to evoke, not leftmost.
- Add a once-per-connection orb interface hint and field documentation. Current
  amounts must not receive Focus twice; omitted upstream amounts remain unknown.
- Cover upstream enrichment, public compact/delta reads, action receipts,
  rotation/evocation, Dark-value changes, slot resize, missing/empty data and
  advisory deduplication/reconnect in regression tests.

## [0.2.25] - 2026-10-03

### Added

- Connection-scoped interface hints for card targeting, current potion slots,
  fresh shop choices and on-demand pile inspection. State/action responses
  trigger observable contexts; card/pile queries attach their own hints without
  advancing hand/run deltas or consuming unseen combat advisories. Invalid
  queries and incomplete context frames do not consume the relevant hint.
- Regression coverage for targeting aliases and full-snapshot/patch omission,
  first-context delivery, deduplication across turns/floors/query paths,
  reconnect re-emission, and retained turn-scoped safety warnings.

### Clarified

- Document `t: true` (hand/choices/piles) versus `target: true` (other instances
  and definitions). Normal upstream live/definition conversion emits
  `has_target` only for ENEMY/SELF_AND_ENEMY; other modes intentionally omit it.
  Compression also collapses false/missing data, so conflicting Mod effects
  require inspection, not an ATTACK/SKILL-based targeting guess.
- Targeted plays supply a fresh 1-based `target_index`; choosing a card is
  different from playing it. Delta omission retains `t`, explicit null clears
  it, and targeting does not establish playability. Potion targets remain
  governed by their separate `requires_target` flag.
- Skill routing accepts adequately explained, retained interface hints for
  routine operations; the mandatory first-action contract and mismatch/unknown
  action recovery rules remain. Execution, settlement and guards are unchanged.

## [0.2.24] - 2026-10-03

### Added

- An independent `hand-playability` advisory at the first nonempty combat hand,
  once per connection and re-emitted after reconnect. It does not require a
  cost mismatch or Confusion, and does not repeat each turn or combat.
- Unit and stdio/HTTP regressions for negative-only markers, missing upstream
  flags, false-to-candidate/candidate-to-false transitions, delta omission vs
  explicit null clearing, and delayed/deduplicated advisory delivery.

### Clarified

- Mandatory contract and detailed reference keep sentinel exceptions adjacent
  to live playability semantics: `p: false` blocks play, while omission in a
  full hand/choice snapshot is a candidate, not positive authoritative evidence.
  Upstream true and missing flags compress alike; delta omission retains the
  previous marker, and `p: null` clears it.
- Other instance payloads use `playable: false`. `inspect_pile` exposes neither
  playability marker and cannot establish whether an off-hand card can be played.
- Action selection, guards, execution and settlement behavior are unchanged.

## [0.2.23] - 2026-10-03

### Clarified

- First-action contract, detailed state reference and live-cost advisory now
  explicitly identify `c: -1` as X-cost and `c: -2` as the unplayable marker.
  Keep special card/free-play exceptions and live playability checks explicit;
  neither sentinel is negative energy spending or proof of current playability.
- Put `ed` shape in the mandatory contract: scalar for a sole enemy, sparse
  1-based enemy-index object for multiple enemies. Missing entries fall back to
  known `d`, never invented zero; explicit zero and unknown damage stay distinct.
  Distinguish reconstructed-state absence from patch omission (retain) and
  explicit `null` (clear the old field or map entry).
- Add regression coverage for sparse/scalar/zero/unknown damage, roster
  reindexing, and preservation of negative costs with live playability flags.
- Damage estimation and action execution are unchanged.

## [0.2.22] - 2026-10-03

### Added

- A short first-action interface contract, reused while retained, with
  operation-triggered routing to detailed references instead of relying on an
  agent to realize it is confused.
- One-shot combat advisories for observed Poison/Noxious Fumes timing and live
  costs differing from known card definitions (or observed Confusion). Compare
  the matching upgraded baseline; missing data and negative sentinels do not
  invent a numeric mismatch or identify its cause.
- Unit and stdio/HTTP regression coverage for delayed triggers, deduplication,
  unavailable definitions, upgraded and special costs, and separate live vs
  definition values without changing action execution.

### Clarified

- Default battle-by-battle pauses yield to explicit continuous-run authorization,
  including reward and route decisions, without adding forced shop/Boss pauses
  or weakening safety, later stop requests, or authority boundaries.
- Hand `c` is current-turn cost, not the cached printed/upgraded baseline.
- Shop text selection exists because upstream purchases use a filtered mixed
  list, not a universal UUID selector; ambiguity must fail closed before spend.
- Execution, settlement, no-retry rules and target/Normality guards are unchanged.

## [0.2.21] - 2026-10-03

### Fixed

- Match shop choice identity to the correct item type, unique name and price
  rather than zipping affordable mixed choices with the complete card list.
  Purge/relic/potion choices never inherit card IDs or refs; ambiguous matches
  keep authoritative text without guessed identities. Preserve purchase guards.
- Include current potion slots on every in-game compact reread, preserve empty
  slots and supplied availability flags, and distinguish unknown inventory from
  zero slots. Key same-ID potion deltas by slot instead of collapsing copies.
- Report omitted upstream neutral stance explicitly when combat player data is
  available; action/delta receipts echo `current.stance` even when unchanged.
  Missing data and non-combat states remain null instead of invented Neutral.

### Added

- One-shot incoming-damage advisory explaining that `atk` is per-hit displayed
  intent already adjusted for stance including Wrath, not guaranteed HP loss.
  Preserve explicit zero-damage values without doubling upstream damage again.
- Unit and isolated stdio/HTTP tests for shop filtering/reordering, ambiguous
  identities, repeated compact potion reads, duplicate slots, stance transitions,
  unchanged stance snapshots, and unchanged action safety protections.
- Synthetic byte overhead measurements for the small stance echo and inventory
  snapshot; these are not token estimates or measured real-run savings.

### Documentation

- Clarify per-action execution/verification versus whole-batch safety preflight.
  Group already-decided actions rather than imposing a fixed batch length; keep
  observation boundaries, no-blind-retry rules and all existing safety guards.
  Keep MCP tool descriptions and initialization guidance aligned with the Skill.
- Synchronize the skill's focused state/safety references. General reward/GRID
  animation timeouts need traces and are not claimed fixed by this release.

## [0.2.20] - 2026-10-02

### Fixed

- Stop settlement polling promptly when the same combat reaches COMPLETE and
  the game omits hand/combat fields after a final hit. Preserve an accepted but
  unverified action as outcome-unknown instead of waiting for the full timeout
  or inferring exact-card execution from an unrelated state change.
- Halt every remaining batch step at the combat boundary, including untargeted
  cards and navigation. Preserve normal verification when exact evidence is
  available; never retry an uncertain mutation or equate completion with victory.

### Added

- Regression coverage for missing/null/retained terminal hands, verified terminal
  actions, partial batches, reward/Boss/death screens, response loss, and false
  completion cues during combat or on another floor.
- Document the compact combat-completion receipt and its unverified-action
  accounting in the README and the skill's conditional recovery reference.

## [0.2.19] - 2026-10-02

### Changed

- Split the runtime into explicit transport, state, cards, safety, settlement,
  compaction, execution, inspection, and protocol domains, with a single
  composition root and instance-owned configuration/session state.
- Keep the stdio entry path, five MCP tools, environment variables, response
  shapes, legacy `wait` alias, and all 0.2.18 execution-certainty safeguards.
  This is a structural release, not a gameplay or transport behavior change.
- Move embedded safety fixtures and the synthetic benchmark into test-only
  modules loaded on demand; retain `server.mjs --self-test` and `--benchmark`.

### Added

- Runtime isolation tests for independent configuration, caches, hand identities,
  local counts, and pending end-turn fences. Importing or constructing a runtime
  and reading protocol metadata do not contact the game.
- One `test-all.mjs` command for recursive syntax checks and all existing/new
  regressions, runnable from any working directory without new dependencies.
- Developer architecture notes covering domain responsibilities, composition,
  session ownership, and the transport-reset/game-reset boundary.

## [0.2.18] - 2026-10-02

### Fixed

- Distinguish `not_sent`, `sent_unknown`, `accepted`, and `verified` execution
  certainty. Only pre-dispatch failures mean `not_executed`; lost, malformed,
  HTTP-error, or generic MCP-error replies remain outcome-unknown. Never retry
  mutations or execute remaining batch actions after an uncertain result.
- Retain pending end-turn fences across transport resets, duplicate requests,
  and incomplete/backward metadata; resolve them only through fresh game state.
  Set fences at dispatch, not before validation. Safeguards are in-memory and
  do not claim durability across runtime process restarts.
- Verify all public single/batch actions with specific card, potion-slot,
  chosen-card/option, control-screen, and turn postconditions. Unrelated state
  changes cannot prove card/potion success. Halt on room/screen boundaries too.
- Bound mutation HTTP responses and verification reads under a shared deadline.
  A stalled or aborted response is uncertain, not proof of non-execution.

### Changed

- Add `visual_wait` for animation pacing; retain `wait` as a deprecated alias.
  Neither disables action verification or enables fire-and-forget execution.
- Rename local Normality accounting to `trackedCardsPlayed`, increment only
  verified plays, preserve uncertain counts over reconnects, and prefer an
  upstream authoritative count when supplied. Current MCP The Spire supplies
  no such counter; the runtime does not invent it.
- Add protocol fault-injection tests for lost/error/malformed replies, hanging
  writes/reads, partial batches, reconnects, duplicate fences, strict
  postconditions, wait compatibility, and uncertain/authoritative card counts.
  Keep module splitting separate from this safety release.

## [0.2.17] - 2026-10-02

### Added

- Add read-only `inspect_pile` for current draw, discard, and exhaust piles.
  Compact groups preserve multiplicity, upgrades, costs, and live stat variants;
  effect definitions reuse the existing cache and only queried pending refs are
  emitted. Normal state/action receipts still carry pile counts only.
- Canonically sort pile groups and their new definitions without exposing the
  game's internal draw order, UUIDs, hand handles, or playable indices.
- Distinguish empty piles from unavailable data or non-combat states and flag
  unknown definitions. Inspection does not advance hand/delta baselines or
  consume run/map/advisory changes.
- Document on-demand use and snapshot-value limitations; add regression and
  stdio/HTTP integration checks for all piles, repeated/variant cards, hidden
  order, cached effects, invalid arguments, and unchanged action safety.

## [0.2.16] - 2026-10-02

### Fixed

- Track physical hand copies with short stable `k` handles and actual `i`
  positions. Semantic deltas update and remove exact copies, preserving
  different Snecko costs, live effects, multiplicity, and reordered hands.
- Bind legacy numeric card selections to UUIDs from the last observed hand,
  including every item in a batch. Never downgrade an exact copy to a name.
- Send one UUID-bound action at a time through MCP The Spire's game-thread
  batch endpoint, closing the read-to-send position-reordering window.
- Check affordability/playability at each step and halt on missing copies or
  increased costs for exact selections. Failed/uncertain actions never cause
  an automatic retry or execution of the remaining batch, including end-turn.

### Added

- Keep the simple `card_name` interface: choose the cheapest playable copy
  with equivalent effects. Use `card: "h7"` only when a particular copy is
  intended; same-name copies with different effects require an exact handle.
- Add unit regressions and an isolated stdio/HTTP integration fixture covering
  duplicate costs, external reorders, initial-hand batch indices, spent or
  missing copies, increased cost, partial failure, timeout, and turn changes.
- Update gameplay guidance for instance-keyed deltas and runtime-owned
  selection/reindexing. Restart the client after installing the update.

## [0.2.15] - 2026-09-27

### Fixed

- Preserve the multiplicity of identical cards in semantic hand deltas and add
  the absolute post-change `count` as a compact consistency check.
- Keep an explicitly empty live hand in compact state so the final copies of a
  repeated card produce a complete removal delta instead of a bare `null`.
- Add regressions for adding three identical Shivs, removing all three, and
  adding two copies while one identical Shiv is already present.

## [0.2.14] - 2026-09-27

### Changed

- Verify every `act_many` step by polling for an observable action result under
  one 20-second per-action deadline. Successful verification returns as soon as
  the result and minimum animation pacing are satisfied instead of performing
  two independently timed full-state reads.
- Classify batch failures as `action_error`, `verification_error`, or
  `verification_timeout`; a command accepted before timeout is reported as
  `timeout_unknown` and is never resent.
- Avoid a second long refresh after an expired verification deadline. Explicit
  non-timeout errors receive only one bounded five-second recovery read.

## [0.2.13] - 2026-09-27

### Added

- Allow `act` and `act_many` callers to override settlement with
  `timeout_ms`; batched actions default to `STS_BATCH_TIMEOUT_MS` or 45 seconds.

### Fixed

- Recognize act-start maps whose stale boss-row sentinel is `x=-1` instead of
  `y=-1`, and refuse to cache an upstream map whose nodes do not contain the
  currently visible route choices.
- Reuse the last confirmed enemy intent only within the same floor, turn, and
  roster when MCP The Spire transiently reports `DEBUG`, while preserving the
  newest HP, block, powers, hand, and relic counters. This prevents completed
  multi-attack batches from timing out after Shuriken, Ornamental Fan, or
  similar animation-heavy triggers.

## [0.2.12] - 2026-09-27

### Added

- Emit concise, deduplicated contextual advisories when relevant combat
  mechanics, supported bosses, Wrath risk, Normality, or Coffee Dripper at a
  Rest site first appear.
- Add conditional references for compact-state recovery and uncommon combat
  safety details.

### Changed

- Reduce the always-loaded gameplay skill while preserving its full guidance
  through runtime advisories and progressively disclosed references.

## [0.2.11] - 2026-09-27

### Changed

- Teach the gameplay skill that Thorns and similar retaliation trigger once
  per damage hit, so multi-hit attacks must be evaluated per hit rather than
  per card.

## [0.2.10] - 2026-09-27

### Fixed

- Add animation-aware pacing after cards, potions, turn transitions, and
  screen choices, followed by a refreshed state read. This prevents a logical
  `ready_for_command` response from letting `act_many` outrun visible effects
  such as Miracle's full-screen color overlay.
- Expose `STS_VISUAL_SETTLE_MS` for machines or Mod combinations that need a
  longer or shorter visual cooldown; the default is 600 ms.

## [0.2.9] - 2026-09-27

### Added

- Add compact target-adjusted per-hit damage estimates when enemy Vulnerable,
  Slow, Flight, or Intangible changes a targeted attack's live damage.

### Changed

- Match cards by stable refs in hand deltas so stance, Weak, cost, block, and
  other live-value updates are emitted as small `changed` records instead of
  removing and re-adding complete card objects.

## [0.2.8] - 2026-09-27

### Added

- Cache localized card definitions from MCP The Spire's native
  `get_card_info` endpoint. The first compact state emits `card_defs`; newly
  encountered generated, rewarded, or Mod cards emit `card_defs_added` once.
- Add `inspect_card` for targeted lookup by live UUID, internal card ID and
  upgrade level, or an unambiguous live/cached name.

### Changed

- Compact GRID screens into stable choice refs, live card values, and selection
  rules instead of repeating the complete card array in both `choices` and
  `details`.
- Extend the synthetic benchmark with a 20-card GRID fixture.

## [0.2.7] - 2026-09-27

### Fixed

- Return a settled, non-error `act_many` receipt when a later action fails
  after earlier actions have already completed. The receipt identifies the
  completed actions, failed action, execution certainty, unexecuted remainder,
  and refreshed post-failure state.
- Preserve ordinary tool errors for single actions while preventing partial
  batch side effects from being hidden behind a generic MCP error.

## [0.2.6] - 2026-09-27

### Added

- Expose stable card IDs and UUIDs on live choice entries.
- Include Watcher stance and preserve non-zero negative power amounts,
  `misc`, and `just_applied` metadata in compact combat state.

### Changed

- Resolve `choice_text` and `choice_uuid` against a fresh state immediately
  before sending the downstream numeric choice.
- Reject numeric-only `HAND_SELECT` actions. Batched stable choices are executed
  serially, with every `choice_text` or `choice_uuid` re-resolved after the
  preceding selection settles.

### Fixed

- Prefer the inferred act on an act-start map when MCP The Spire still reports
  the previous act, preventing a fresh map from receiving a stale `map_ref`.
- Add regression coverage for reordered hand choices, duplicate card UUIDs,
  stale act metadata, and compact player statuses.

## [0.2.5] - 2026-09-27

### Fixed

- Ignore transient empty `COMBAT_REWARD` frames while enriched combat state
  still contains live enemies. This prevents Scry and Meditate card-selection
  grids from being reported as completed combats.
- Add regression coverage that rejects the contradictory in-combat reward
  frame while continuing to accept a real post-combat reward screen.

## [0.2.4] - 2026-09-27

### Fixed

- Infer the current act from floor and act-start map state when MCP The Spire
  omits `game.act`, preventing the next act from reusing a stale route graph.
- Include a topology fingerprint in map versions so distinct maps with the
  same node count cannot share a compact `map_ref`.
- Add regression checks for the Act 1 to Act 2 transition and same-size map
  version collisions.

## [0.2.3] - 2026-09-23

### Fixed

- Wait for a combat hand-selection choice to expose its selected card and
  `confirm` action before returning. Transient `COMBAT_REWARD` and `NONE`
  frames are ignored instead of being reported as settled game state.
- Add a regression test covering the transient frames observed after choosing
  an Acrobatics discard.

## [0.2.2] - 2026-09-23

### Fixed

- Clarify the poison-lethal end-turn rule: count existing Poison before the
  enemy acts, but not Noxious Fumes or other future player-turn-start effects.

## [0.2.1] - 2026-09-23

### Fixed

- Retry the brief `get_screen_state: Internal error: null` response that can
  occur after entering an event room. Only the read is retried; the game
  action is never sent again.
- Add a regression check for the event transition and ensure unrelated read
  errors still surface immediately.

## [0.2.0] - 2026-09-22

### Added

- One-time `run_context` containing the current deck, relics, and potions.
- `run_delta` updates for acquired or removed cards, relics, and potions.
- Semantic array deltas for hands, enemies, powers, choices, and run data.
- Compact action receipts through `result` plus settled `changes`.
- A synthetic response-size regression benchmark via
  `node scripts/server.mjs --benchmark`.
- Self-tests for semantic deltas, relic acquisition, and unstable combat frames.

### Changed

- `act` and `act_many` now return an action receipt and semantic changes instead
  of repeating the entire compact state after every action.
- The complete route graph is sent once per act; later map states reuse
  `map_ref` while retaining current and next-node choices.
- Card-reward, shop, event, and hand-selection details use smaller schemas that
  omit duplicated UUID and hand data.

### Fixed

- Wait for a stable opening combat frame instead of exposing zero-energy,
  incomplete-hand, or `DEBUG`-intent states.
- Report newly acquired relics, including event rewards that were previously
  absent from compact state.
- Normalize displayed choice indices to 1-based values throughout nested
  screen details.
- Include the full route graph for reliable path planning.

## [0.1.0] - 2026-09-22

### Added

- Initial compact MCP bridge for MCP The Spire.
- Guards for Normality, duplicate end turns, changing enemy targets, and shop
  item reindexing.
- Settled action responses and a Slay the Spire collaboration skill.
