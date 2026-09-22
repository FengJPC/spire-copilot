# Spire Copilot plugin

This directory is the installable plugin package. The repository-level README
contains requirements and installation instructions.

The plugin exposes three MCP tools:

- `get_state`: compact, delta, or diagnostic full game state.
- `act`: one settled, safety-checked game action.
- `act_many`: a short serial sequence that stops when the target set or turn
  changes.

Choice screens expose consistent 1-based indices in both `choices` and nested
screen details. Map screens automatically include a compact full route graph;
each node uses `s` for its room symbol and `to` for child coordinates.

The in-game `MCP The Spire` mod must remain enabled because it provides the
downstream game endpoint.
