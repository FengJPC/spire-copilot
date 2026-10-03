# Conditional combat safety

Before planning an attack into retaliation, a Normality-limited sequence, Time Eater's twelfth card, or a poison-based end turn, read the relevant entry unless a runtime advisory already explains it adequately. Do not wait to feel uncertain; reuse entries while retained.

- **Incoming damage:** enemy `atk` is the current displayed intent per hit, including enemy Weak, player Vulnerable and stance (Wrath); do not apply these modifiers twice. `38x3` means three 38-damage hits before Block, not guaranteed HP loss. Refresh after power/stance changes; separately account for later damage mitigation, other damage sources and Mod mechanics.

- **Normality:** while it remains in hand, play no more than three cards that turn. After removing or exhausting it, refresh state before continuing.
- **Time Eater:** read the current `Time Warp` amount before every sequence. Make the twelfth card deliberate and establish defense before it resolves.
- **Thorns and similar retaliation:** retaliation triggers once per damage hit, not once per attack card. Multi-hit attacks repeat it; at low HP, prefer one large hit and build block before attacking.
- **Poison lethal:** for `end_turn`, count only Poison already on the enemy; it damages before the enemy acts. Do not include player-turn-start effects such as Noxious Fumes.
- **Modified costs:** use live hand `c` for energy planning, not cached definition cost. Confusion and other modifiers can change it; a mismatch alone does not identify the cause. Reobserve after draw or cost-changing actions before deciding new plays.
- **Coffee Dripper:** Rest sites cannot heal. Treat campfires as upgrades or other non-healing actions and seek recovery elsewhere.
- **Bosses:** apply the encounter-specific runtime advisory at combat start. If a Mod boss is unrecognized, do not invent mechanics; inspect live powers, intents, and relevant cards, then act conservatively.
