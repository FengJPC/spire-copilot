# Spire Copilot plugin

This directory is the installable plugin package. The repository-level README
contains requirements and installation instructions.

The plugin exposes three MCP tools:

- `get_state`: one-time run context, semantic delta, or diagnostic full state.
- `act`: one settled, safety-checked action with a compact result and changes.
- `act_many`: a short serial sequence that stops when the target set or turn
  changes.

Choice screens expose consistent 1-based indices in both `choices` and nested
screen details. The full route graph is sent once per act and later map screens
reuse `map_ref`; each node uses `s` for its room symbol and `to` for child
coordinates. Deck, relic, and potion changes are reported explicitly, while
transient combat frames with incomplete data are filtered.

The in-game `MCP The Spire` mod must remain enabled because it provides the
downstream game endpoint.
