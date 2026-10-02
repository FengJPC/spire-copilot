# Runtime architecture

The public entry is still `plugins/spire-copilot/scripts/server.mjs`. It owns
stdin/stdout and selects normal MCP operation, `--self-test`, or `--benchmark`.
It does not own game state or implement decisions. No external runtime packages
are required; the refactor uses native Node.js ES modules.

## Domains

Each mutable domain is a factory with an explicit dependency list. Only
`scripts/runtime/index.mjs` wires factories together. Forward callbacks handle
lifecycle feedback without circular ES-module imports or importing the stdio
entry. No factory performs I/O during construction.

| File in `scripts/runtime/` | Responsibility |
| --- | --- |
| `index.mjs` | Build one runtime and connect its domain dependencies |
| `config.mjs` | Read the established environment variables and defaults |
| `session.mjs` | Allocate independent mutable state for each runtime |
| `shared.mjs` | Pure parsing, identity, and error helpers; no session singleton |
| `transport.mjs` | HTTP/MCP initialization, dispatch certainty, deadlines, schemas |
| `state.mjs` | Read/enrich stable decision state; act-aware map caching |
| `cards.mjs` | Definitions, live card identities, equivalent-copy resolution |
| `safety.mjs` | Counts, end-turn fences, target/choice guards, contextual advisories |
| `settlement.mjs` | Action-specific postconditions and verification polling |
| `compaction.mjs` | Compact state, semantic deltas, definitions/run-context emission |
| `execution.mjs` | Serial action orchestration, receipts, halts, no mutation retry |
| `inspection.mjs` | Read-only on-demand card and unordered pile queries |
| `protocol.mjs` | Existing five tool schemas, dispatch, and MCP response envelopes |

Dependencies may be injected when testing a domain in isolation. The
composition root exposes `modules`, `session`, and `config` as internal
development interfaces, not extra MCP tools. `handleMcpMessage` is the entry's
protocol interface.

## Ownership and lifecycle

`createRuntime()` allocates a fresh session. Tool/session IDs, observed hand
baselines, UUID-to-handle maps, card definitions, semantic/run baselines, map
emission state, advisories, local card counts, and pending turn fences belong
to that session. Constructing a second runtime never shares these mutable
objects with the first. Configuration can use an injected environment for
tests without changing global environment variables.

A transport reconnect is **not** a game reset. `resetGameConnection()`
invalidates connection-dependent caches and observed baselines but preserves
pending end-turn fences, uncertain local counts, and live hand identities.
Fresh observed game lifecycle/turn boundaries resolve safety state through the
existing guards. Safety state remains in-memory; process restart is not a
persistent transaction recovery mechanism.

## Verification

Run from the repository root:

```powershell
node plugins/spire-copilot/scripts/test-all.mjs
```

The runner resolves paths relative to itself, not the working directory. It
checks every packaged `.mjs` file, runs the extracted safety tests, verifies
instance isolation and reconnect invariants, exercises the real stdio runtime
against mock HTTP game endpoints, injects execution-certainty faults, and runs
the existing synthetic byte benchmark. It does not operate a live game.

`server.mjs --self-test` and `server.mjs --benchmark` remain compatible. Test
fixtures are dynamically imported only when these flags are used. Normal
gameplay imports only runtime modules. Synthetic byte results are regression
indicators, not measured real-run token savings.

When changing behavior, test the owning domain plus the end-to-end fault
suite. Keep safety changes separate from mechanical module moves so regressions
have a small review surface.
