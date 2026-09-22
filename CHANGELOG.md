# Changelog

All notable changes to Spire Copilot are documented here.

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
