# Spire Copilot

Spire Copilot is a Codex plugin for playing and discussing a live modded
Slay the Spire run. It adds a compact, safety-aware bridge in front of the
`MCP The Spire` game mod.

## What it adds

- One-time run context plus semantic state deltas to reduce context usage.
- In-place hand-stat deltas for stance, Weak, and other live value changes,
  avoiding remove-and-add churn for cards that remain in hand.
- Multiplicity-safe repeated-card deltas with an absolute post-change hand
  count, so generated Shivs and similar cards cannot collapse into one entry.
- Target-adjusted per-hit damage estimates only when enemy Vulnerable, Slow,
  Flight, or Intangible changes the displayed card damage.
- One-time card-effect definitions with incremental definitions for newly seen
  cards, plus an `inspect_card` lookup for targeted verification.
- On-demand `inspect_pile` composition queries for draw, discard, and exhaust
  piles, preserving quantities and live variants without exposing draw order
  or expanding ordinary state receipts beyond pile counts.
- Screen-aware GRID compaction that keeps stable identities and live values
  without repeating every full card object.
- Settled action responses that wait for animations and turn transitions.
- Explicit execution certainty: response loss is never reported as non-execution,
  uncertain actions stop batches, and pending end turns survive reconnections.
- Animation-aware action pacing that prevents batches from advancing while a
  visible card, potion, or stance effect is still catching up.
- Guards for Normality, duplicate end turns, changing enemy targets, shop item
  reindexing, and card-selection reindexing.
- Consistent 1-based choice indices across state and action calls.
- Stable `choice_text` / `choice_uuid` resolution for changing card lists.
- A compact full route graph once per act, followed by a small map reference.
- Automatic reporting of deck, relic, and potion changes such as newly acquired
  relics.
- Filtering of transient combat frames with incomplete hands or `DEBUG`
  intents.
- Identity-aligned shop choices that never attach a positional card ID to
  purge, relic, or potion items; ambiguous matches omit identity enrichment.
- Current potion slots in every in-game compact snapshot, including empty
  slots, and explicit Neutral/Wrath/Calm stance with small action/delta echoes.
- Compact Watcher stance and complete player-power metadata, including
  negative amounts and newly applied statuses.
- A Codex skill that explains pivotal decisions and pauses after each combat.

## Requirements

- Codex desktop or Codex CLI with plugin support.
- Node.js 18 or newer available as `node` on `PATH`.
- Slay the Spire launched through ModTheSpire.
- The in-game `MCP The Spire` mod enabled and listening at
  `http://127.0.0.1:8080/mcp`.

Spire Copilot is an independent companion project. It does not bundle Slay the
Spire, ModTheSpire, or MCP The Spire.

## Install from GitHub

```powershell
codex plugin marketplace add FengJPC/spire-copilot
codex plugin add spire-copilot@spire-copilot
```

Restart the desktop app and start a new task. You can then ask:

> Use Spire Copilot to inspect my Slay the Spire state.

## Local development

```powershell
codex plugin marketplace add .
codex plugin add spire-copilot@spire-copilot
```

The MCP process starts with Codex, but it connects to the game lazily on the
first tool call. Codex can therefore start while the game is closed.

## Configuration

The default game endpoint is `http://127.0.0.1:8080/mcp`. Override it with the
`STS_MCP_URL` environment variable if your game mod uses another address.

Optional timing variables:

- `STS_POLL_MS` (default `180`)
- `STS_SETTLE_MS` (default `250`)
- `STS_VISUAL_SETTLE_MS` (default `600`)
- `STS_WAIT_TIMEOUT_MS` (default `20000`)
- `STS_BATCH_TIMEOUT_MS` (default `20000`, applied once per batched action)

`act` and `act_many` also accept a per-call `timeout_ms` override from
1,000 to 120,000 milliseconds. Mutation responses and verification reads share
one per-action deadline; it never causes an uncertain action to be resent.
`visual_wait` only changes minimum visual pacing. Legacy `wait` is its
deprecated alias: `wait: false` still verifies the action.

For `act_many`, the timeout is one deadline per action. The runtime polls every
180 ms by default and immediately continues once the action exposes an
action-specific result and its minimum animation pacing has elapsed. Pre-send
errors, uncertain transport/downstream errors, and verification timeouts are
reported separately. Only pre-send failures mean `not_executed`.

A confirmed same-floor combat completion stops verification polling and all
remaining batch steps. If the final hand was omitted, the receipt reports
`combat_completed: true`, `settlement: "combat_completed"`, and
`action_status: "outcome_unknown"`, retaining `execution_certainty: "accepted"`.
This confirms the combat ended, not that the exact card caused it or that the
run was won. The unverified action is excluded from `completed_actions` and is
never retried. When exact action evidence remains, normal `verified` receipts
are retained, while later batch steps still stop at the combat boundary.

Action and delta receipts carry `current.stance` independently of semantic
changes. Unchanged stance is still observable without replaying the whole
combat state; `null` means unavailable or outside combat. An available combat
player with omitted neutral stance is explicitly `Neutral`. Compact snapshots
also repeat current `potions` by slot (`empty: true` for empty slots); missing
upstream inventory is `null`, not an invented empty array. Existing run context
and potion deltas remain compatible, with duplicate potions keyed by slot.

Shop `choices` are matched to canonical `details.cards/relics/potions` by type,
name and price, not array offset or affordability-filtered position. Only unique
card matches expose `card_id`, `ref`, and `choice_uuid`; other recognized items
expose `kind` and, when matched, `item_id`. Ambiguous or unfamiliar formatting
keeps text/index without invented identity. Purchases still require fresh,
unique `choice_text` and retain all existing shop reindex guards.

Enemy `atk` is upstream displayed intent damage per hit, already stance-adjusted
(including Wrath), before player Block. `AxN` means A on each of N hits, not a
total or guaranteed HP loss. A one-shot runtime advisory makes this explicit;
Copilot never applies a second Wrath multiplier to the upstream intent.

`act_many` sends and verifies each action separately. Whole-batch preflight can
reject a predictable safety violation before any action is sent; runtime halts
occur after individual actions, not after blindly executing the entire batch.
Group already-decided actions, but inspect new draws/choices before planning
the next decision. This release does not loosen guards, change mutation retry
policy, or broaden transition verification to avoid animation timeouts.

Development checks:

```powershell
node plugins/spire-copilot/scripts/test-all.mjs
```

The complete check includes syntax validation, safety self-tests, runtime
isolation, HTTP/stdio integration, execution-certainty fault injection, and the
synthetic byte benchmark. Individual checks remain available:

```powershell
node plugins/spire-copilot/scripts/server.mjs --self-test
node plugins/spire-copilot/scripts/tests/runtime-isolation.mjs
node plugins/spire-copilot/scripts/tests/observability.mjs
node plugins/spire-copilot/scripts/test-hand-actions.mjs
node plugins/spire-copilot/scripts/test-shop-observability.mjs
node plugins/spire-copilot/scripts/test-execution-certainty.mjs
node plugins/spire-copilot/scripts/server.mjs --benchmark
```

See [runtime architecture](docs/runtime-architecture.md) for module boundaries
and session ownership. The packaged entry remains `scripts/server.mjs`; no MCP
configuration changes are needed after the modular refactor.

The benchmark is a synthetic regression fixture for comparing response shapes;
it is not presented as a real-run token reduction claim.

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for release notes and compatibility changes.

## License

MIT
