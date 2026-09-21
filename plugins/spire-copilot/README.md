# Spire Copilot plugin

This directory is the installable plugin package. The repository-level README
contains requirements and installation instructions.

The plugin exposes three MCP tools:

- `get_state`: compact, delta, or diagnostic full game state.
- `act`: one settled, safety-checked game action.
- `act_many`: a short serial sequence that stops when the target set or turn
  changes.

The in-game `MCP The Spire` mod must remain enabled because it provides the
downstream game endpoint.


