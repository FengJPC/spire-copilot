# Conditional combat safety

Read this reference only when a special mechanic is absent from, or not fully explained by, runtime `advisories`.

- **Incoming damage:** enemy `atk` is the current displayed intent per hit, already adjusted for stance including Wrath; never multiply it by two again. `38x3` means three 38-damage hits before Block. Refresh after stance changes and check additional powers rather than treating intent as guaranteed HP loss.

- **Normality:** while it remains in hand, play no more than three cards that turn. After removing or exhausting it, refresh state before continuing.
- **Time Eater:** read the current `Time Warp` amount before every sequence. Make the twelfth card deliberate and establish defense before it resolves.
- **Thorns and similar retaliation:** retaliation triggers once per damage hit, not once per attack card. Multi-hit attacks repeat it; at low HP, prefer one large hit and build block before attacking.
- **Poison lethal:** for `end_turn`, count only Poison already on the enemy; it damages before the enemy acts. Do not include player-turn-start effects such as Noxious Fumes.
- **Coffee Dripper:** Rest sites cannot heal. Treat campfires as upgrades or other non-healing actions and seek recovery elsewhere.
- **Bosses:** apply the encounter-specific runtime advisory at combat start. If a Mod boss is unrecognized, do not invent mechanics; inspect live powers, intents, and relevant cards, then act conservatively.
