# Changelog

All notable changes to Spire Copilot are documented here.

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
