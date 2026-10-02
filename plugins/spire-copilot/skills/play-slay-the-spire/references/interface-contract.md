# First-action interface contract

Read before the first live action in an available working context. Reuse while retained; if lost after a context reset, reread before acting. This is tool semantics, not a complete game-mechanics guide.

- Indices and potion `slot` are 1-based. Use hand `k` for an exact card; `ref` is an effect definition, not a copy. Use current inventory: `potions: null` is unknown, `[]` is zero slots, and `empty: true` marks an empty slot.
- Read combat `stance` or receipt `current.stance`: `Neutral` is explicit neutrality; `null` is unknown/non-combat. An unchanged receipt still echoes stance. Never infer it from damage.
- Hand `c` is the live per-instance, current-turn cost; cached definition `c` is the printed/upgraded baseline. Differences can be legitimate cost modification, not automatically a Mod bug. Budget live costs and playability; negative sentinels are not ordinary numeric costs.
- Enemy `atk` already includes current stance, including Wrath: do not double it again. `AxN` means N hits of A before Block; missing `atk` does not prove zero. Refresh after stance changes. Hand `d` is per hit before target-only modifiers; `ed` is an estimate, not guaranteed HP damage.
- Shop purchases require a unique, fresh `choice_text`. The upstream purchase selector is a filtered mixed-item list; card UUIDs are inspection identities, not a universal purchase selector. Ambiguity must stop an irreversible spend, not choose a positional fallback.
- `act_many` verifies each already-decided action before the next; preflight can reject the entire batch. Stop at unknown draws/new choices. Completed or uncertain actions must never be replayed; read state after `outcome_unknown`/`timeout_unknown`, especially `end_turn`.
- In deltas, omitted fields retain their prior values. Match `hand.changed.key` to `k`, not `ref`; duplicate cards stay separate. Runtime advisories are decision inputs; read them before acting.

For operation-specific details, follow the action-triggered reference routing in SKILL.md. User-authorized continuous play overrides the default battle-by-battle pause, not safety or authorization boundaries.
