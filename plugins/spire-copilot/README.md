# Spire Copilot plugin

This directory is the installable plugin package. The repository-level README
contains requirements and installation instructions.

The plugin exposes four MCP tools:

- `get_state`: one-time run context, semantic delta, or diagnostic full state.
- `inspect_card`: one exact card definition and any matching live instance
  values, without expanding the complete game state.
- `act`: one settled, safety-checked action with a compact result and changes.
- `act_many`: a short serial sequence that stops when the target set or turn
  changes. If a later action fails, its normal result identifies completed,
  failed, and remaining actions together with the refreshed game state.

Choice screens expose consistent 1-based indices plus stable card identities.
Use `choice_text` for unique names or `choice_uuid` for an exact card instance;
hand selections reject stale numeric-only choices. Stable choices can be sent
through `act_many`; the runtime executes them serially and resolves every item
against the refreshed list. The full route graph is sent once per act and later
map screens reuse `map_ref`; each node uses `s` for its room symbol and `to` for
child coordinates. Deck, relic, potion, stance, and player-power changes are
reported explicitly. Card effects are emitted once in `card_defs`, newly seen
cards arrive in `card_defs_added`, and later choices retain only stable refs and
live values. Stance and debuff changes update matching hand refs in place rather
than resending whole cards. Target-only modifiers add `ed`, a compact estimated
damage-per-hit value for the affected enemy or enemies. Transient combat frames
with incomplete data are filtered.

The in-game `MCP The Spire` mod must remain enabled because it provides the
downstream game endpoint.
