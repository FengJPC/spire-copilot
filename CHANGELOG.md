# Changelog

All notable changes to Spire Copilot are documented here.

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
