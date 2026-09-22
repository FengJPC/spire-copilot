# Spire Copilot

Spire Copilot is a Codex plugin for playing and discussing a live modded
Slay the Spire run. It adds a compact, safety-aware bridge in front of the
`MCP The Spire` game mod.

## What it adds

- Compact and delta game-state responses to reduce context usage.
- Settled action responses that wait for animations and turn transitions.
- Guards for Normality, duplicate end turns, changing enemy targets, and shop
  item reindexing.
- Consistent 1-based choice indices across state and action calls.
- A compact full route graph whenever the map screen is open.
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
- `STS_WAIT_TIMEOUT_MS` (default `20000`)

## License

MIT
