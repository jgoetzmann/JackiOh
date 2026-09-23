# JackiOh — Master Game Specification

2026-09-16, revision 5 of 2026-09-17 · @Someone

## 1. Overview

JackiOh is a 1v1 collectible card game: a Hearthstone-style mana curve, combat math and keyword vocabulary, played on Yu-Gi-Oh-style lanes with a hidden backrow of traps. This document is the complete specification: the rules, all 100 Core cards and 9 tokens described by what they do to game state, and the architecture and engine they run on.

Design pillars:

- Short, sharp games: 20-card decks with no duplicates, 4 max mana, 30 hero health, a 30-turn cap.
- Two combat axes: Attack/Defense position (Defense = Taunt + Armor) layered over Hearthstone-style free-target attacking.
- Radiant: every card has an upgraded form, and upgrading cards mid-game is a core resource loop (the Glowy Jelly Bean family, Radiant Saintess, Gifted Program, Eugenics).
- Lanes matter: 5 shared lanes give adjacency (Cleave, Hit Job, Collateral Damage), rotation (Silly Silas) and per-lane traps (Zoomerbin Oomen).
- Chaos is a feature: coin flips, random keywords, Call to Chaos, Pocket Chaos, Transmogulate. All of it must run on a seeded RNG so any match replays exactly.

How to read this spec: sections 2 to 7 are the rules; 8 is the card catalog (mechanics, not flavor text), with each card's rarity assigned by mechanical complexity; 9 and 10 are the architecture and the engine design; 11 collects every ruling this spec makes where the source was silent or ambiguous, with the ones still open marked decide.

Source material: the original JackiOh design notes (a mechanics sheet, the Core card list and a CCG architecture document), referred to below as "the source". Wherever this spec goes beyond them it is marked **Ruling:** in place, and the same item appears in section 11 so it can be confirmed or overturned in one place.

## 2. Core systems

A game is two players with 30-health heroes and 20-card decks, alternating turns until a hero hits 0 or the turn cap ends it in a draw.

### 2.1 Setup

1. Both decks are shuffled with the match seed.
2. Player 1 draws 3, Player 2 draws 4 (the Nth player draws N+2, so the engine should treat this as a table, not two constants). Any Quickdraw card in a deck replaces one of these draws (section 6).
3. Mulligan: each player sees their opening hand, marks any subset to return, draws that many replacements from the top of the library, then the returned cards are shuffled back in. **Ruling:** replacements are drawn before the returned cards go back, which is what "without replacement" means in the source.
4. Start-of-game effects resolve: every Heroic Power in either player's hand or library picks its random power, including one the mulligan returned (R43).
5. Player 1 takes the first turn and does draw on turn 1 (**Ruling**, Hearthstone convention).

### 2.2 Turn loop

```mermaid
flowchart LR
  A[Start of turn] --> B[Refresh mana]
  B --> B2[Start-of-turn delayed effects]
  B2 --> C[Start-of-turn triggers]
  C --> D[Draw 1]
  D --> E[Main phase]
  E --> F[End-of-turn triggers]
  F --> F2[End-of-turn trap window]
  F2 --> F3[End-of-turn delayed effects]
  F3 --> G[Cleanup]
  G --> H{Turn cap hit?}
  H -- no --> I[Opponent's turn]
  H -- yes --> J[Game is a draw]
```

This is the only turn sequence; §6.2 and §10.3 follow it (R62). Start-of-turn delayed effects (Kpop Fanatic's steal) resolve first, then start-of-turn triggers in queue order (R68), then the draw, so start-of-turn triggers fire before the draw. At the end of the turn, end-of-turn triggers resolve first (Combo-Index and the "add this back to your hand" spells included); then the end-of-turn trap window, where the Field Traps that watch turn ends (Bread and Butter, Intern Stimmy) fire on both sides; then end-of-turn delayed effects (Recycling Initiative, /fullsend's exile); then cleanup. Main-phase actions are: play a card (pay cost, pick modes and targets), attack with a unit, switch a unit's position, activate Heroic Power, offer or answer a draw, concede, end turn. Actions resolve one at a time; the engine never has two in flight. Cleanup expires every "this turn" effect (the Lunar Eclipse discount, /fullsend's modifiers, Professor Curvature's discount on its turn); Twinspell's pending Echo is not turn-scoped and survives cleanup.

### 2.3 Mana

- Max mana = min(number of turns you have started, 4), plus persistent modifiers. It refreshes to max at the start of your turn. Turn 1: 1 mana; turn 4 onward: 4.
- Temporary mana (Mana Well, Fed Fauci, Efficiency Dividend, /fullsend, Genn's Greed, Call to Chaos) adds to current mana and can exceed 4. GIGA Glowy Jelly Bean costs 6 and is castable only after such gains.
- Hinder subtracts from the opponent's next refresh. Mana never goes below 0.
- X-cost cards: X is chosen at play time, 0 ≤ X ≤ current mana, and is stored on the played instance. Heroic Power is the exception: its X is fixed by its power (R43). Cost modifiers never apply to an X-cost card (R65). Embiggen cards offer two prices; the choice is stored the same way and drives the card's effect.
- Cost modifiers stack additively and floor at 0, in the order given by Cost in §6.3 (R65); a temporary modifier ("this turn", "next turn") is stored with an expiry turn number.

### 2.4 Drawing, fatigue, hand size

- One draw at the start of every turn. Cast-on-draw cards resolve immediately and the draw repeats, which can chain (CN-Virus into CN-Virus). A cast-on-draw card is cast even when the hand is full, since it never enters the hand. **Ruling (R58):** one draw casts at most `CAST_ON_DRAW_CHAIN_CAP` (20) cast-on-draw cards; the next cast-on-draw card drawn in that chain goes to the hand uncast (burned if the hand is full), which ends the chain. "Draw N" is N separate draws, each with its own chain, and "draw your whole library" draws the library size as it was when the effect started.
- Fatigue: the source names it but not its effect. **Ruling:** the Nth draw from an empty library deals N damage to your hero (Hearthstone). Infinite Reserves replaces each such draw with a Rush Token card.
- Hand size: unspecified. **Ruling:** 10. A card drawn or added to a full hand is sent to the graveyard ("burned"), and Call to Chaos's "draw your deck" respects this.
- Decks may exceed 20 during play (Unstable Clone Machine, CN-Virus); 20 is a deckbuilding limit only. **Ruling (R80):** a library holds at most `LIBRARY_CAP` (60) cards; a card that would be shuffled into a full library is not created, and an existing card goes to its owner's graveyard instead.

### 2.5 Ending the game

| Condition | Result |
| --- | --- |
| A hero at 0 or less health at a state check | That player loses |
| Both heroes at 0 or less in the same check | Draw |
| Concede | That player loses |
| Disconnect grace period expires | That player loses (section 9.5) |
| Draw offered and accepted | Draw |
| End of the 30th turn | Draw ("auto-draw") |
| Hard match ceiling reached (60 minutes) | Draw (R79) |

**Ruling:** the cap counts player-turns, so 30 means 15 turns each; that lines up with a 20-card deck (3 or 4 opening cards plus 15 draws) and keeps fatigue rare. Draw offers: once per player per turn, and a declined offer blocks that player from offering again for 3 of their turns; both numbers are config values. If at any point in their main phase a player's only legal actions are ending the turn, conceding and draw offers, the turn auto-ends (R82). Only the active player offers a draw, during their main phase; the opponent answers it (R36). When the active player's turn clock runs out, their open prompts are answered by the AI policy and the turn ends. A prompt held by the non-active player has its own clock, which on expiry answers only that prompt (R79).

### 2.6 Deckbuilding

Exactly 20 cards, no duplicate card ids, no Token-tagged cards. With the architecture's three-deck loadout rule (section 9), a player needs 60 distinct cards across their loadout; Core has 100 non-token cards, so this is satisfiable.

## 3. Zones and board layout

Each player owns a hand, a library, a graveyard, an exile pile, a hero, 5 unit zones and 5 backrow zones; a lane is a column of four zones, two yours and two the opponent's.

| Zone | Holds | Visible to | Ordering | Engine notes |
| --- | --- | --- | --- | --- |
| Hand | Any card | Owner | Index order for triggers (R68); random picks are uniform | Cap 10 (ruling) |
| Library | Any card | Nobody; count is public | Top to bottom | Recruit scans top down; "bottom card" = last |
| Graveyard (GY) | Cards that were destroyed, discarded or resolved, except unit tokens (R11) | Both | Chronological | Unit tokens never enter it; spell tokens do |
| Exile | Exiled cards | Both | Chronological | Count feeds Echoes of the Forgotten and Spiteful Stab |
| Unit zone x5 | Units, or a Stack pile | Both | Lane 1 to 5, left to right from the owner's seat | Lock flag per zone |
| Backrow zone x5 | Field Spells, Traps, Field Traps | Field Spells: both; Traps: the controller only, and the other player sees a face-down card even if they own it (R33) | Lane 1 to 5 | Lock flag per zone; traps hidden until they fire |
| Hero | Health, hero armor, Heroic Power | Both |  | Health has no upper cap |

### 3.1 Lanes and adjacency

Your lane N faces the opponent's lane N. "This lane" (Zoomerbin Oomen) means the backrow zone in the same column as the unit. Adjacent means index N-1 and N+1 on the same side and same row: Cleave hits the units beside the target, radiant Hit Job destroys the units beside the target, radiant Collateral Damage exiles the permanents beside the target in its row.

**Ruling:** attacks are not lane-restricted. Any unit may attack any enemy unit or the enemy hero, subject to Taunt. Lanes only matter for adjacency, lane-targeted summons, and Silly Silas's rotation.

**Ruling (rotation topology):** for Silly Silas the ten unit zones form a ring: your lane 1 to 5, then the opponent's lane 5 down to 1, and back to your lane 1; the backrow forms a second ring the same way. "Rotate right" moves every card one step around its ring, so your lane-5 card becomes the opponent's lane-5 card and changes control. Both rings rotate together.

### 3.2 Zone rules

- A summon with no named zone goes to the leftmost empty, unlocked zone of the right row (R64). A summon into a full row fails silently and the effect that summoned it continues. A summon aimed at a specific zone ("this lane", Reborn's original zone) fails if that zone is occupied or Locked. A zone reserved for a dying Reborn unit (§4.5) counts as occupied for every other card that would enter it.
- Playing a Unit, Field Spell or Trap from hand requires an empty, unlocked zone in the right row; the player picks the zone.
- Lock: the zone accepts no summons until the game ends (nothing in Core unlocks). The current occupant is unaffected and the lock persists after it leaves.
- Stack: a Stack card may be played onto an occupied zone of the right row. The zone becomes an ordered pile whose top card is the only active one: it attacks, is targeted, and projects auras. Cards underneath are dormant: not "on the field" for effects, not targetable, keep their damage. When the top card leaves, the next card resumes. **Ruling:** Felinor Fiender's "including those under a Stack" is the one exception where dormant cards count.
- Unit tokens cease to exist when they leave the field for any reason (bounce, destroy, exile, transform), so "Bounce all units" clears them; a unit-token card in hand or library (Infinite Reserves, or a copy made by Unstable Clone Machine, Recycling Initiative or Combo-Index) ceases to exist if it leaves that zone other than by being drawn or played, burning included (R11). Spell tokens (section 7) behave as ordinary hand and library cards. Sheep Tokens are worth 2 Tributes while on the field, and a Radiant one is worth 3 (section 7), so the value is read off the face that is up rather than off the definition.
- Control vs ownership: Steal and rotation change the controller of a card on the field. Off the field a card always goes to its owner's hand, library, graveyard or exile; Pocket Chaos's library swap is the one effect that changes owners (R73). **Ruling:** a stolen unit that dies goes to its owner's graveyard.
- Backrow cards go to the owner's graveyard when their effect ends (Twinspell after it fires, traps after firing unless Field Trap).

## 4. Combat

A unit has Attack, Max Health and Damage; current health = max health minus damage, and a unit at 0 or less is destroyed at the next state check. Damage stays on a unit between turns: no phase and no cleanup step clears it, and only a heal (§6.3) or leaving the field (R78) takes it off.

### 4.1 Positions and exertion

- Units enter in Attack Position. Defense Position grants Taunt and Armor +1, stacking with printed Armor and Big D-fender's aura.
- Each unit has one exertion per turn: one attack or one position switch. Deft Duelist may do both.
- **Ruling:** only Attack-Position units may attack. A unit that switched to Attack this turn has spent its exertion and cannot attack (except Deft Duelist).
- Summoning sickness: a unit cannot attack the turn it entered the field. Rush lifts this for unit targets only; Charge lifts it for units and the hero. A sick unit may still switch to Defense. A unit that enters the field again, a Reborn body included, entered it on that turn like any other (R83).
- **Ruling:** a unit with 0 attack cannot declare an attack; it still deals 0 back when attacked. Spikey Pillow cannot be switched to Defense.

### 4.2 Declaring an attack

1. Choose an attacker that can attack (exertion unspent, Attack Position, not sick or has Rush/Charge, attack above 0, no "can't attack").
2. Choose a target: an enemy unit, or the enemy hero (not with Rush on the summon turn).
3. Taunt check: if any enemy unit has Taunt (printed, granted, or from Defense Position), the target must be one of them.
4. Declaring the attack has now spent the attacker's exertion, before any damage. Trap window: My Pawn checks whether the hit would be lethal and, if so, cancels the attack; the exertion is not given back, so the attack is gone either way (R44).
5. Resolve combat, then run the state check.

Forced attacks (Moths to the Flame, Bear Honeypot) skip steps 1 to 3: the named units attack the named target in lane order, regardless of position or sickness, without spending their exertion, and stop when the target is gone. Each forced attack is a separate combat followed by its own state check (R53).

### 4.3 Combat resolution

```mermaid
sequenceDiagram
  participant A as Attacker
  participant D as Defender
  Note over A,D: Step 1, First Strike
  A->>D: A's attack, if A has First Strike and D does not
  D->>A: D's attack, if D has First Strike and A does not
  Note over A,D: Whichever is destroyed here deals nothing
  Note over A,D: Step 2, simultaneous
  A->>D: A's attack
  D->>A: D's attack
  Note over A,D: Step 3, state check, Death triggers, Reborn
```

First Strike moves **that unit's** strike into step 1, on whichever side of the combat it is: an attacker with it hits a defender without it before that defender answers, and a defender with it hits an attacker without it before that attacker's blow lands. Either way the unit that struck in step 1 takes nothing back if its target falls there — §6.1's "deals damage before non-First-Strike units", stated as a sequence. Both units with First Strike strike simultaneously in step 1. When the defender is a hero, only the attacker deals damage. A defender in Defense Position still strikes back with its full attack.

### 4.4 One damage instance

Every point of damage in the game (combat, Cry, spell, end-of-turn, fatigue) goes through this pipeline, in this order. A hit whose amount is 0 before step 1, such as a 0-attack unit striking back, is not a damage instance: nothing happens and Divine Shield stays (R63).

1. Divine Shield: if the target has it, negate the whole hit and remove the shield. Stop.
2. Armor: subtract the target's total Armor (printed + Defense +1 + auras; hero uses Going Long's value). "Ignores armor" (True Strike) skips this. Floor at 0.
3. Hero cap: if the target is a hero with Anti-oneshot Armor, clamp to 5 (radiant 3).
4. Indestructible: takes no damage; stop.
5. Apply damage; emit `damage` with source, target and amount dealt. The amount dealt is not capped at the target's health, except that a Trample source's damage to a unit counts only up to that unit's health, the rest being the step 9 instance (R63).
6. On-damage triggers (Fed Fauci gains a Plague Token, Corpse Eater does not, that is a GY trigger).
7. Poisonous: if the source is a unit with Poisonous, the target is a unit, and 1 or more was dealt, mark the target destroyed.
8. Lifesteal: if the source has Lifesteal, or the effect stated that its own damage has Lifesteal (R85), heal the source's controller's hero by the amount dealt.
9. Trample: if the source is a unit with Trample and the target is a unit, the amount dealt beyond the target's health before this hit goes to the target's controller's hero as a new damage instance. This applies to any damage the unit deals, not only combat (R63).
10. Cleave (combat only): if the attacker has Cleave, deal its attack to each unit adjacent to the target as separate instances.

If the amount is 0 after step 3, the hit stops there: no `damage` event and none of steps 5 to 9, so Fed Fauci gains no Plague Token. Cleave belongs to the attack rather than to the hit, so it still happens when step 1, step 4 or this zero rule stopped the hit on the defender (R63).

### 4.5 Deaths and the state check

The check runs after every resolved action, every fully resolved effect or trigger (a card's whole Cry, spell, trap or triggered script, or one cast-on-draw cast), and every combat (Trample and Cleave hits included; each forced attack is its own combat, R53). It never runs between the damage instances of a single effect, so every hit of Jlockeed Shredder lands before anything dies (R59).

1. Collect units with health 0 or less or marked destroyed, and backrow cards marked destroyed; move them all to their owners' graveyards at once (tokens vanish). A collected unit with Reborn reserves its zone until step 4 (R64). Indestructible units take no damage and ignore destroy marks; a marked Indestructible unit instead switches to Attack Position and loses Taunt until end of turn (R46). An Indestructible unit whose max health is 0 or less (Suppressive Aura) is collected like any other unit; one at 0 or less health whose max health is still above 0 stays (R69).
2. Check heroes: 0 or less health ends the game (both = draw).
3. Fire Death triggers of the collected units in R68 order; each reads its unit's last-known state from just before it left (R78); every other trigger reads the `destroyed` event instead, which carries what the unit was as it died (R89).
4. Reborn: each collected unit that had Reborn returns to its reserved zone (unless the zone was Locked meanwhile) at 1 health without Reborn, as a reset instance (R78); its Cry does not fire, and because it has entered the field again it is summoning sick for the rest of that turn (R83).
5. Repeat until nothing changes, and at most `STATE_CHECK_PASS_CAP` (100) times. A check still finding work on the hundredth pass is an engine bug rather than a game state, so the engine throws there instead of returning a state no rule produced.

**Ruling:** Death triggers fire on both deaths of a Reborn unit, so radiant Right-house defender summons a base copy on its first death and again on its second.

## 5. Card anatomy and card types

A card is a definition in the catalog plus an instance in a game; the definition carries both the base form and the Radiant form, and the instance carries a `radiant` flag.

Every card carries the fields below; the catalog stores the base and Radiant forms under one id, and the Radiant form always has the same cost.

| Field | Values in Core | Catalog field |
| --- | --- | --- |
| Cost | 0 to 6, 100 (Ceaseless Void), X, or "A embiggen B" | `cost: number or 'X' or {base, embiggen}` |
| Type | Unit, Spell, Field Spell, Trap, Field Trap | `type` |
| Tribes and tags | Human, Felinor, KY, CN, Fruit, Call to Chaos, Quickdraw, Token | `tags: string[]` |
| Rarity | Common, Rare, Epic, Legendary, Mythic; Token for every token | `rarity` |
| Set | Core (Classic, Boss, Boss-X reserved) | `set` |
| Index | 1 to 100; tokens N.1 when card N defines them, T-name when shared (Rush, Sheep, Felinor, Bread) | `index: string` |
| Stats | Attack/Health, base and radiant | `base.stats`, `radiant.stats` |
| Text | keywords + scripted effects, base and radiant | `base.script`, `radiant.script` |

### 5.1 Types

- Unit: a permanent in a unit zone with stats; does combat.
- Spell: one-shot. Resolves, then goes to the graveyard, or to exile when it says "exile this". Spells with "End of turn: add this back to your hand" are flagged `returnToHandAtEndOfTurn` when played and return from the graveyard at the end of that turn, as graveyard triggers (R68).
- Field Spell: a permanent in the backrow with a lasting effect. May have a Cry (Anti-oneshot Armor), start/end-of-turn triggers, or an activated ability (Heroic Power).
- Trap: paid for and placed face-down in the backrow. Fires automatically the moment its condition is met, on either player's turn, then goes to the graveyard. Only its controller sees its identity before it fires; the other player sees a face-down card, even if they own it (R33).
- Field Trap: a Trap that stays after firing and can fire again.
- Permanent = anything occupying a unit or backrow zone.
- Token: generated only when a card names it. Random pools ("a random card", "Discover a (2) cost card") never include Token-tagged cards, and never include the generating card's own definition, unless the card names the pool itself (Call to Chaos's "cast a random Call to Chaos" draws from the Call to Chaos tag, which includes #95).

Rarity, tribe and set are pure filter tags. The catalog needs one query function, `catalog.query({type, cost, costRange, tags, notTags, rarity, set, excludeIndex})`, that every random-generation and Discover effect uses.

### 5.2 Radiant

The source defines Radiant only as "upgraded versions of normal cards". Rulings that make it implementable (R74):

- Radiant is a boolean on an instance, never a separate card id. Making a card Radiant sets it; nothing in Core un-sets it.
- In hand or library: cost unchanged, stats and text swap to the radiant form.
- On the field (Radiant Saintess, Knockoff Temu Glowy Jelly Bean, radiant GIGA Glowy Jelly Bean, Snom Bunny Mind Control): the base-stat layer swaps immediately, damage taken and buffs are kept, newly gained keywords apply at once, ongoing triggers use the radiant text from then on, and Cry does not re-fire.
- A copy of a Radiant card is Radiant. A card an effect generates "Radiant" is Radiant. Tokens can be Radiant (Radiant CN-Virus, Radiant Reminisce).
- Cards with no listed Radiant form (Quickstriker, Zao Gao, Combo-Fodder, Chaos Golem and My Pawn) are unchanged by becoming Radiant; the flag still sets so counting effects behave. The four unit tokens are NOT in that list any more — §7 gives each of them a Radiant face, so making a token Radiant now changes it.

### 5.3 Catalog data decisions

Places where the source card list was inconsistent, with the value the catalog uses; section 11 records them together as R75, and #94's reading as R26.

| Card | Issue in source | Catalog value used here |
| --- | --- | --- |
| #2 Bigot | No set listed | Core |
| #15 Me and Mr Token, #16 Hit Job | Radiant separator is `~~` | Treated as `~~~` |
| #12, #31, #51 | Header typos: tag "Felinors", name "KY’s, …" | Tag Felinor; names as in section 8 |
| #68 Twisted Sorcerer | Listed as "Spell, Unit" with stats | Unit |
| #90.1 | Named "CN-Viral Injection" like #90 | Named CN-Virus |
| #94 Genn's Greed | "exile all cost cards" is garbled | Exile all odd-cost cards (Genn Greymane reference) |
| #29 GIGA Glowy Jelly Bean | Cost 6 exceeds max mana 4 | Kept at 6; only castable with mana gain |
| #15, #34, #66, #86, #99, #100 | No card type in the header | Unit, Spell, Unit, Unit, Spell, Unit, from stats and text |

## 6. Keyword glossary

Every keyword below maps to one engine primitive; a card script only ever composes these primitives.

### 6.1 Unit keywords (computed as a set per unit)

| Keyword | Rule | Engine semantics | Core cards |
| --- | --- | --- | --- |
| Taunt | Enemies must attack Taunt units first | Attack-target validator; Defense Position adds it | #19, #55, #56, all units in Defense |
| Armor X | Reduce each damage instance by X | Pipeline step 2; stacks (printed + Defense 1 + auras); "Armor 1" when unnumbered | #1 aura, #9r, #25, #45r, #55, #84 (hero) |
| Rush | May attack units, not heroes, on summon turn | Sickness exemption for unit targets | #11, #14, #32, #56, #89, #91, Rush Token, Chaos Golem |
| Charge | May attack units and heroes on summon turn | Full sickness exemption | #11r, #45, #56r, #92r, #100r |
| First Strike | Deals damage before non-First-Strike units | Combat step 1 | #11, #14, #20, Chaos Golem |
| Poisonous | Destroys any unit it damages | Pipeline step 7 | Random-keyword pool only |
| Lifesteal | Damage dealt heals your hero | Pipeline step 8; also on spells (#93 A, Combo-Fodder) | #56, #93, #93.1, Chaos Golem |
| Reborn | First death: return at 1 health without Reborn | State check step 4 | #3, #81r |
| Divine Shield | Negate the first damage instance, then lose it | Pipeline step 1 | #3, #20r, #50r, #56, #89r, Chaos Golem |
| Trample | Excess damage hits the hero | Pipeline step 9; any damage the unit deals (R63) | Random-keyword pool only |
| Cleave | Also damages units adjacent to the target | Pipeline step 10, combat only, belongs to the attack (R63) | #32r |
| Indestructible | Can't be destroyed or damaged; can be exiled or sacrificed | Pipeline step 4; state check skips it unless its max health is 0 or less (R69); on would-destroy: Attack Position, lose Taunt this turn | #25r, #55r, #56r, #66, #98 |
| Immutable | Text can't be changed or transformed | Blocks Transform, Vanilla, Fuse-onto, Silence-like effects; Radiant still allowed (it is the card's own text) | #8, #19r, #66r |
| Stack | May be played onto an occupied zone | Zone becomes a pile; only the top is active (section 3.2) | #92 |
| Lucky X | Repeat a luck-based roll X extra times, keep the best | RNG helper `lucky(x, roll, better)` with a per-effect comparator | #23r, #42r |
| Can't attack | Cannot declare attacks | Attack validator flag | #86 |

**Ruling (random keyword pool):** Plastic Surgery and Zao Gao draw from Taunt, Armor 1, Rush, Charge, First Strike, Poisonous, Lifesteal, Reborn, Divine Shield, Trample, Cleave. Indestructible, Immutable, Stack and Lucky are excluded as too swingy or meaningless on a token. A unit never gets a keyword it already has.

### 6.2 Triggers and timing words

| Keyword | Rule | Engine semantics |
| --- | --- | --- |
| Cry | When a card enters the field for the first time | **Ruling:** fires only when played from hand (or by Cast on draw / Echo / Call to Chaos casting). Copies, Recruit, Reborn, tokens and Transform results do not fire it; otherwise Duplicating Felinors fills the board for 2 mana. Targets are chosen at play time. |
| Death | When sent from the field to the GY | Fires on destroy, sacrifice or combat death; not on bounce, exile, transform or steal. A token with Death would still fire it after vanishing (none in Core). |
| Cry and Death | Both hooks share one script | #81 |
| Start of turn | Controller's turn start, before the draw | Delayed effects first (Kpop Fanatic's steal), then the trigger queue in R68 order (§2.2, R62) |
| End of turn | Controller's turn end, before cleanup | Same queue; "add this back to hand" spells and Combo-Index resolve here; then the end-of-turn trap window (Bread and Butter, Intern Stimmy), then end-of-turn delayed effects (§2.2, R62) |
| Start of Game | After mulligan, before turn 1 | Only Heroic Power |
| Once per Turn | Activated ability limit | The instance stores the turn it was last used (`memory.usedTurn`, R43) |
| Aura | Effect while in play | Static modifier layer, recomputed on every state change (section 10.4) |
| Combo X | Extra effect if X or more cards were played earlier this turn | `turnLog.cardsPlayed` counter checked at play time; X defaults to 1 |
| Echo X | Recast this card X more times | Play resolves, then the same instance re-resolves X times with fresh mode/target prompts; Twinspell grants Echo +1 to the next spell. The repeats outstanding live in `state.echoQueue` and resolve one at a time in the resolution loop, so a prompt inside one repeat pauses the rest until it is answered (§10.5 step 6) |
| Cast on draw | Plays itself on draw, then draw again | Draw pipeline hook; a Cast (§6.3): costs nothing, counts as played (R40, R70); chains capped by R58 |
| Targets chosen randomly | The effect picks its own target | Random target from the legal set (used by AI turns and My Pawn) |
| Quickdraw | Starts in your opening hand instead of a draw | Setup step 2 |
| Fatigue | Drawing from an empty library | Nth fatigue draw deals N damage (ruling) |

### 6.3 Actions and verbs

| Verb | Rule | Engine semantics |
| --- | --- | --- |
| Summon | Put onto the field from anywhere else | `summon(card, controller, zone?)`; with no zone named, the leftmost empty unlocked zone of its row (R64); fails if there is none; no Cry |
| Play | Pay cost and cast from hand | `play(instance, X?, embiggen?, targets, modes)`; increments play counters; fires Cry |
| Destroy | Field to GY | Marks destroyed; state check moves it; Indestructible ignores |
| Sacrifice | Your own card (or an enemy unit a Tribute allows, #55), field to GY, bypasses Indestructible | `sacrifice(instance)`; counts as a death |
| Exile | To the exile pile from anywhere | Increments the game exile counter; no Death trigger |
| Bounce | Return to owner's hand | Tokens vanish; hand cap applies; the instance resets per R78 (buffs and damage included) |
| Discard | Hand to GY, except a unit-token card, which ceases to exist instead (§3.2, R11) | **Ruling:** the player chooses unless "random" is stated (Zao Gao is chosen) |
| Counter | Cancel a summoned card entirely | Card goes to GY, no Cry, no Death, and is treated as never played (the source's reading; no Core card counters) |
| Steal | Take control | Moves the card to the stealer's side, same lane if free else first free zone (ruling); excess stay put |
| Transform | Replace a card with another in place | New instance in the same zone, no Cry; blocked by Immutable |
| Vanilla | Remove a unit's text | Clears printed keywords and scripts; keeps stats, buffs and damage |
| Heal X | Remove up to X damage from a unit, or give a hero X health with no cap | `heal(target, x)`; "Heal to full" removes all damage; "Heal up to 30" sets health to max(current, 30) |
| Recruit | Summon from library, scanning top down | First permanent card (Unit, Field Spell, Trap, Field Trap) that matches the filter, summoned into its row per R64, traps face-down; then the library keeps its order |
| Discover | Choose 1 of 3 options | Pending choice; options drawn without replacement from the stated pool, shown only to the chooser. "Reveal N matching cards, then choose one" (KY's Private Tutor) is this same primitive with the library as the pool: the revealed cards are that prompt's options, so only the chooser ever sees them (§10.8) |
| Tribute X | As an additional cost of playing a card, sacrifice X of your units; a card whose own text tributes (Carnivorous Cube) sacrifices what that text names instead, which may be any of your other permanents, backrow included (R41) | The play-time cost is the play validator's, and the choice travels in the play action (R81); the Sheep Token counts as 2 toward that X while it is on the field, or 3 if it is Radiant (§3.2, §7), and Lava Golem may pick enemy units. A tribute written into a card's script is an ordinary Sacrifice of the permanent that script names, where the Sheep Token's 2 never applies |
| Fuse | Combine effects, stats and cost, cost capped at 4 | A new transient definition and instance per R77: summed stats, union of keywords, concatenated scripts, cost min(sum, 4); a target already on the field survives as the fused card and the other ingredients cease to exist |
| Embiggen | Two prices, bigger effect for the bigger one | Play-time choice stored on the instance; scripts read `instance.embiggened` |
| Lock | Zone can't be summoned into | Zone flag |
| Choose one | Modal effect | Pending choice with the listed modes |
| Plague Token | Counter on a permanent, any number, reset on leaving the field | `instance.counters.plague` |
| Mana / gain mana | Add to current mana this turn | May exceed 4; "next turn" mana is stored as a modifier for the next refresh |
| Damage | Deal X damage to a unit or hero | `damage(source, target, x)`: one instance through §4.4 |
| Lose health | A hero loses X health | Lowers hero health directly: no pipeline, no Armor, no cap, no on-damage effects (R18) |
| Draw | Take the top card of your library | §2.4: cast on draw, fatigue, hand cap, chain cap (R58) |
| Add to hand | Put a card into a hand | Creates or moves the card; a full hand burns it (§2.4), and a unit-token card burned that way ceases to exist instead of reaching the graveyard (§3.2, R11) |
| Shuffle into | Put a card into a library | Inserted at a uniformly random position drawn from the match rng |
| Make Radiant | Upgrade a card | Sets `radiant` (§5.2); no effect on a Radiant card; random picks follow R60 |
| Switch position | Flip Attack and Defense | As a player action it spends exertion (§4.1); as an effect it does not (R20); Spikey Pillow never enters Defense |
| Forced attack | Named units attack a named target, whether or not they could have declared it | `forceAttack` / `forceAttacksOn`: skips §4.2 steps 1 to 3, so position, summoning sickness and Taunt are all ignored and no exertion is spent; the target still strikes back; the named attackers go in lane order, each attack its own combat followed by its own state check, and the run stops once the target has left the field (R53); a card dormant under a Stack neither attacks nor is hit (R13) |
| Cancel an attack | Call off an attack already declared, before any damage | `cancelAttack`, inside §4.2 step 4's trap window: marks the open `declaredAttack` cancelled, so no combat resolves and `attackCancelled` is emitted in its place; the attacker's exertion was spent on the declaration, so the attack is gone either way (R44) |
| Cost | What a card costs to play now | `effectiveCost`: start from `costOverride`, else the printed cost (Ceaseless Void's computed cost, the chosen embiggen price); add the instance's `costMod`; add player discounts (this-turn, next-spell); then apply Professor Curvature if the result is 4; floor at 0. X-cost cards cost exactly X and ignore modifiers (R65) |
| Cast | Play a card without paying for it | Free; counts as a play for every rule that counts or reacts to plays, with cost paid 0; fires the Cry or spell script; the caster picks targets and modes (R70) |
| Swap | Exchange something between the two players | Pocket Chaos: hero health, board contents lane by lane, or library contents (R73) |
| Rotate | Move every card on the field one step around its ring | Silly Silas: the two rings of §3.1; control changes on crossing; damage and buffs travel; a Locked destination bounces the card to its owner's hand (R14), as it does for any effect that moves a whole board at once (R88) |
| Replace | Put a new card where an old one was | New instance in the same zone and position, with the old card's owner and controller; on the field this is a Transform; the old card's fate is per card (R31, R35) |

The source also defines Flicker; no Core card uses it, so the engine has no primitive for it.

## 7. Tokens

Nine token definitions cover every token any Core card can generate; a token is only ever created by an effect that names it, or as a copy of one. A unit token vanishes when it leaves the field; a spell token lives in hand and library like a real card and goes to the graveyard after it resolves.

| Token | Index | Cost | Type | Stats and text | Radiant form | Generated by |
| --- | --- | --- | --- | --- | --- | --- |
| Rush Token | T-rush | 1 | Unit | 3/3, Rush | 6/6, Rush | #15, #58, #60, #74 (X/X), #75, #80, #95 (Radiant), #98 |
| Sheep Token | T-sheep | 1 | Unit | 1/1, worth 2 Tributes | 2/2, worth 3 Tributes | #41 |
| Felinor Token | T-felinor | 1 | Unit, Felinor | 1/1 | 2/2 | #62, #98 |
| Bread Token | T-bread | 0 | Unit | Printed 0/0; always summoned as X/X through `statsOverride` (X = unspent mana, or 3X); no text | X/X, Armor X — the same X, carried as `armorOverride` beside the stats because the printed `n` can no more be known at print time than the printed 0/0 | #18 |
| KY's Empty Notebook | 51.1 | 1 | Spell, KY | Draw 1 | Draw 2 | #51 |
| Spikey Pillow | 65.1 | 1 | Unit | 0/2, cannot be in Defense Position, your units have -2 attack | 0/4, cannot be in Defense Position, your non-Spikey-Pillow units have -2 attack | #65 |
| CN-Virus | 90.1 | 1 | Spell, CN | Cast on draw: take 1 damage, shuffle 2 copies into your deck | 3 copies | #90, and itself on each draw |
| Combo-Fodder | 93.1 | 0 | Spell | Deal 2 damage, Lifesteal | none | #93 radiant |
| Chaos Golem | 95.1 | 4 | Unit | 10/10, Rush, Lifesteal, Divine Shield, First Strike | none | #95 |

Token rules:

- Stat overrides: Adaptive UI summons a Rush Token with X/X (or 3X/3X) instead of 3/3; Rush Token Farm radiant gives all your Rush Tokens +3/+3 as an aura. Implement as the Rush Token definition plus a `statsOverride` on summon. Call to Chaos is NOT one of these any more: it summons the token's own Radiant face (6/6) rather than a bespoke 5/5, so the only card that invented a Rush Token size no longer does.
- Bread Token has no name in the source ("a X/X Token"). **Ruling:** name it Bread Token, no keywords, cost 0, and it counts as a Token for every filter.
- Spell tokens (Notebook, CN-Virus, Combo-Fodder) live in hand and library like real cards and go to the graveyard after resolving; they are still excluded from random pools and from Discover unless named. **Ruling:** Reminisce can Discover a spell token from the graveyard because it discovers "a card in your GY", not from a pool.
- CN-Virus damage is a normal damage instance to your own hero (Armor and Anti-oneshot Armor apply). Its "shuffle copies" makes an opponent's deck grow without bound; the cast-on-draw chain cap (R58) keeps each draw finite and the turn cap keeps the game finite.
- "Fill your board" summons into every empty, unlocked unit zone left to right (R64).
- Zao Gao's Rush Tokens each roll 2 distinct keywords from the random-keyword pool (section 6.1).

## 8. Complete card catalog

All 100 Core cards plus the 5 tokens a card defines (index N.1), in index order (the 4 shared tokens are in section 7), described by what they do to the game state rather than by their printed text; stats read base → radiant, and the Engine column names the primitive from section 6 or the ruling from section 11 that the implementation depends on.

Conventions: "target" means the player picks at play time from all legal units and heroes on either side unless narrowed. "Your" means the controller. A Cry or spell whose target set is empty fizzles: the unit still enters, the spell still counts as played. Damage always goes through the pipeline in section 4.4; "lose health" does not. Reading a Radiant cell: a cell that lists keywords without "Plus" gives the radiant form's complete keyword list; "Plus X" adds keyword X to the base keywords; a cell that names no keywords keeps the base keywords. A clause the cell restates replaces the base version and every base clause it does not restate is kept; a cell that changes only a number ("+10 attack", "5 damage") changes only that number. "same" says so explicitly, and "Also" and "Then" add effects.

Rarity is assigned by mechanical complexity and game impact, and is the value the catalog's `rarity` field carries. Common: keywords only, one primitive with at most one target, or one fixed start-of-turn, end-of-turn or cast-on-draw effect. Rare: a trigger that reads state or asks for a choice, a modal choice or prompt, a cost or mana modifier, or a simple trap. Epic: chained prompts, delayed or cross-turn effects, traps that act on the opponent's turn, or effects that read several zones. Legendary: control changes across the board, zone-wide rewrites, recursion, or a stat layer that exists for one card. Mythic: a subsystem of its own. Distribution: 35 Common, 37 Rare, 16 Epic, 7 Legendary, 5 Mythic. This supersedes the rarities printed in the source list (#1–20 Common, #21–50 Rare, #51–80 Epic, #81–95 Legendary, #96–100 Mythic); a review comparing catalog to source should treat that difference as intended.

### 8.1 Cards #1–20

| # | Name | Rarity | Cost | Type, tags | Stats | Base effect | Radiant effect | Engine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Big D-fender | Common | 2 | Unit, Human | 0/8 → 0/16 | Aura: your units in Defense Position have +2 Armor | +4 Armor | Aura layer keyed on `position == DEF`; 0 attack so it never attacks |
| 2 | Bigot | Common | 2 | Unit, Human | 6/1 → 12/2 | Cry: destroy target enemy non-Human unit | Cry: destroy all enemy non-Human units | Targeted Cry with tag filter |
| 3 | Right-house defender | Common | 1 | Unit, Human | 1/1 → 2/2 | Taunt, Divine Shield, Reborn | Taunt, Divine Shield, Reborn; Death: summon a base Right-house defender | Death fires on both deaths (4.5); the summoned card is a new base Right-house defender (not a copy) with its own Reborn, so the chain ends; it is placed per R64 while the dying one's zone stays reserved |
| 4 | Gary the Gambler | Common | 1 | Unit, Human | 1/1 → 2/2 | Cry: flip 5 coins; +1 attack per heads, +1 max health per tails | 7 coins; +2 per heads, +2 per tails | 5 or 7 seeded rolls; permanent buff layer; Lucky has no defined "best" here so does not apply |
| 5 | Stockpile | Common | 1 | Spell |  | Draw 2; heal your hero 2 | Draw 5; heal 5 | Hand cap applies |
| 6 | Mana Well | Common | 3 | Field Spell |  | Start of turn: gain 1 mana | Gain 2 | Temporary mana, may exceed 4 |
| 7 | Jewelosco Scarab | Rare | 1 | Unit | 1/1 → 2/2 | Cry: Discover a 2-cost card | Cry: Discover a 3-cost card; it costs 1 less | `catalog.query({cost, notTags:[Token], excludeIndex:7})` with costs read per R65 (embiggen cards at their base price, X cards as 0); permanent −1 `costMod` on the chosen instance |
| 8 | Mr. Vanilla | Common | 1 | Unit, Human | 3/3 → 7/7 | Immutable | Immutable | Blocks Vanilla, Transform, Fuse-onto |
| 9 | Moths to the Flame | Rare | 2 | Unit | 1/14 → 2/28 | Start of turn: every enemy unit attacks this | Armor 1; same | Forced attacks in enemy lane order (4.2); stops when Moths dies |
| 10 | Rapid Replenish | Common | 0 | Spell |  | Combo 3: draw 3; otherwise nothing | Combo 3: draw 6 | Checks `turnLog.cardsPlayed >= 3`; always playable |
| 11 | Tempo Timmy | Common | 1 | Unit, Human | 3/3 → 6/6 | Rush, First Strike | Charge, First Strike | Keywords only |
| 12 | Duplicating Felinors | Rare | 2 | Unit, Felinor | 3/4 → 5/9 | Cry: summon a copy of this unit | Same | Copy per R57, placed per R64; the copy's Cry does not fire (6.2) |
| 13 | Jlockeed Shredder-10 | Common | 3 | Unit | 8/10 → 16/20 | End of turn: deal 2 damage to each enemy unit and the enemy hero | 5 damage | One damage instance per target, controller's end of turn |
| 14 | Jlockeed's Weapons | Common | 4 | Field Spell |  | Aura: your units have +4 attack, Rush, First Strike | +10 attack | Aura grants keywords; removed when it leaves |
| 15 | Me and Mr Token | Common | 1 | Unit, Human | 1/1 → 2/2 | Cry: summon a Rush Token | Cry: summon 3 Rush Tokens | Board full → fewer |
| 16 | Hit Job | Common | 2 | Spell |  | Destroy target unit | Destroy target unit and the units adjacent to it on its side | Adjacency 3.1; Indestructible survives |
| 17 | Flood | Rare | 3 | Spell |  | Bounce all units on both sides | Choose one: bounce all units, bounce all enemy units, destroy all enemy units; then draw 1 | Tokens vanish on bounce; hand cap burns extras |
| 18 | Bread and Butter | Epic | 1 | Field Trap |  | When any player ends a turn with unspent mana: summon a Bread Token X/X for the trap's controller, X = that player's unspent mana | X = 3 × unspent | Fires in the end-of-turn trap window of both players' turns (R62) |
| 19 | Midrange Menace | Common | 3 | Unit | 9/9 → 18/18 | Taunt; End of turn: heal to full | Taunt, Immutable; same | Heal removes all damage |
| 20 | Pointmaster | Common | 2 | Unit, Human | 7/2 → 14/4 | First Strike | First Strike, Divine Shield | Keywords only |

### 8.2 Cards #21–50

| # | Name | Rarity | Cost | Type, tags | Stats | Base effect | Radiant effect | Engine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 | Hinder | Common | 0 | Spell |  | Cast on draw: the opponent's next mana refresh is 1 lower | 2 lower | `mana.nextTurnMod` on the opponent, floors at 0 |
| 22 | Carnivorous Cube | Epic | 3 | Unit | 4/6 → 8/12 | Cry: Tribute one of your other permanents and remember it. Death: summon 2 copies of the remembered card | Death: fill your board with copies | `memory.eaten = {defId, radiant, statsOverride}`; backrow copies go to the backrow (R41); nothing to tribute → Cry fizzles and Death does nothing; cannot eat itself |
| 23 | Reoccurring Dream | Rare | 1 | Spell |  | 30% chance a random card in your hand becomes Radiant. End of turn: returns from the GY to your hand | Lucky 1 (two rolls, keep the success) at 40% | Random pick per R60; return-at-end-of-turn flag; hand full → burned |
| 24 | Efficiency Dividend | Epic | X | Spell |  | Choose one: deal X damage to a target; heal a target 2X; gain floor(X/2) mana next turn. End of turn: returns to hand | Uses X+1 | X chosen at play; positive `mana.nextTurnMod` |
| 25 | 4-mana 7/7 | Common | 4 | Unit | 7/7 → 7/7 | Armor 7 | Indestructible | Keywords only |
| 26 | Glowy Jelly Bean | Rare | 3 | Spell |  | Choose a card in your hand; it becomes Radiant | Choose 2 | A declared `hand` pick, so it travels in the play action's `targets` (R81); radiant takes both cards it can when the hand holds only one other |
| 27 | Blood Ridden Glowy Jelly Bean | Common | 1 | Spell |  | Cast on draw: a random card in your hand becomes Radiant; you lose 5 health | 2 random cards | "Lose health" bypasses Armor and the Anti-oneshot cap (R18); random picks per R60 |
| 28 | Knockoff Temu Glowy Jelly Bean | Common | 2 | Spell |  | 2 random cards among your library, hand and field become Radiant | 5 | Uniform over the union's non-Radiant cards, all different (R60); field cards convert in place (5.2) |
| 29 | GIGA Glowy Jelly Bean | Rare | 6 | Spell |  | Every card in your hand becomes Radiant | Hand and all your permanents | Cost 6 requires mana gain |
| 30 | Archivist | Rare | 2 | Unit | 4/5 → 8/10 | Cry: choose one: draw the highest-cost card in your library, or the lowest | Cry: draw both | Ties → nearest the top; costs per R65, so X-cost counts as 0 and embiggen cards as their base price (R24) |
| 31 | KY's Math Equation | Rare | 1 | Spell, KY |  | Deal Fib(cost+1) damage to a target. End of turn: return to hand with cost +1 | Fib(cost+2) | cost = printed + `costMod` (R67); the return adds +1 to the instance's permanent `costMod`; Fib = 0,1,1,2,3,5,8,13,21,34,55,89, index clamps at 11 (R25) |
| 32 | Prem Panther | Rare | 2 | Unit | 5/4 → 10/8 | Rush; whenever this destroys a unit, draw 2 | Rush, Cleave; same | "Destroys" = a death whose lethal damage came from this unit, Cleave hits included; per unit |
| 33 | Unstable Clone Machine | Rare | 2 | Field Spell |  | After you play a card, shuffle 3 copies of it into your library | One of the 3 is Radiant | Post-play trigger; copies are fresh instances with the played card's radiant flag; token cards get copied too (R34); nothing is added to a full library (R80) |
| 34 | Collateral Damage | Rare | 3 | Spell |  | Exile target permanent and a random card from the opponent's library | Also the permanents adjacent to the target in its row | Exile bypasses Indestructible; bumps the exile counter |
| 35 | Lunar Eclipse | Rare | 1 | Spell |  | Deal 3 damage to a target; the next Spell you play this turn costs 1 less | 6 damage; 2 less | Player-level "next spell" discount, consumed on use or at cleanup |
| 36 | Magic Jammed | Rare | 1 | Spell |  | Destroy target backrow card; Lock its zone | Steal target backrow card; Lock its original zone | Stolen backrow lands in your same-lane zone if free, else first free (6.3); you see a stolen trap's identity (ruling) |
| 37 | Gravedigger | Rare | 2 | Unit | 4/5 → 8/10 | Start of turn: add a random card from your GY to your hand | Discover one from your GY; it costs 1 less | Empty GY → nothing |
| 38 | Quickstriker | Epic | 3 | Field Spell |  | Your cards gain "Combo X: deal X damage to the enemy hero", X = cards you played earlier this turn | No radiant form | On each play except the one that put it on the field (R119): damage = `turnLog.cardsPlayed` before this card |
| 39 | Recycling Initiative | Epic | 0 | Spell |  | Exile this on play. End of turn: add a copy of every other card you played this turn to your hand | Copies cost 1 less | End-of-turn delayed effect: a fresh copy (radiant flag kept) of every card in `turnLog.playedIds` except this one, including cards played after it (R71); instances that no longer exist are skipped rather than fizzling (R86) |
| 40 | Echoes of the Forgotten | Common | 2 | Field Spell |  | Start of your turn: deal damage to the enemy hero equal to the cards in your exile; then exile the bottom card of your library | +3 damage | Counts your own exile pile (R72); empty library → no exile, no fatigue |
| 41 | Sheepish | Epic | 1 | Trap |  | When the opponent plays a Unit: Transform it into a Sheep Token | Also add a Lava Golem costing 0 to your hand | Fires on the play, before the Cry resolves (ruling), so the Cry is lost; Immutable target → trap still fires and is consumed with no effect (R17) |
| 42 | Eugenics | Common | 2 | Spell |  | Exile 8 random cards from your library; each remaining library card has a 30% chance to become Radiant | Lucky 1 at 40% | Fewer than 8 → exile all |
| 43 | Big Felinor | Rare | 3 | Unit, Felinor | 3/10 → 6/20 | Cry: destroy all non-Felinor units on both sides | Enemy non-Felinor units only | Simultaneous destroy, one state check |
| 44 | True Strike | Common | 1 | Spell |  | Deal 4 damage to a target, ignoring Armor; exile this | 9 | Skips pipeline step 2; Divine Shield still applies |
| 45 | Deft Duelist | Rare | 2 | Unit, Human | 4/3 → 8/6 | Charge; may attack and switch position in the same turn | Charge, Armor 1; same | Two exertions: one attack plus one switch |
| 46 | Suppressive Aura | Rare | 2 embiggen 4 | Field Spell |  | Aura: all units −2/−2 (paid 4: −5/−5) | Aura: enemy units −4/−4 (paid 4: −10/−10) | Aura lowers max health; units at 0 die at the state check; leaving restores them |
| 47 | Fig of Life | Common | 3 | Spell, Fruit |  | Heal a target 20 | 50 | Any unit or hero (ruling) |
| 48 | 5pek Controller | Common | 0 | Spell |  | Switch the position of every unit | Choose: all enemy units, or all units | Does not spend exertion (ruling) |
| 49 | Snom Bunny Mind Control | Rare | 3 | Spell |  | Steal target enemy permanent | It also becomes Radiant | Steal per 6.3 |
| 50 | Kpop Fanatic | Epic | 1 | Unit | 1/1 → 2/2 | Cry: choose an enemy permanent; at the start of your next turn, steal it | Divine Shield; same | Delayed effect (`state.delayed`) keyed to the target instance; fires even if Kpop Fanatic died; fizzles if the target left the field (R76) |

### 8.3 Cards #51–80

| # | Name | Rarity | Cost | Type, tags | Stats | Base effect | Radiant effect | Engine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 51 | KY's Private Tutor | Epic | 1 | Spell, KY |  | Choose a type (Spell, Unit, Field Spell, Trap), then a cost bracket (0–1, 2, 3, 4+), offering only options with a match in your library; reveal 3 random matching library cards; choose one to hand. No match at all → add a KY's Empty Notebook | Echo (resolves a second time) | Three chained pending choices; Field Trap counts as Trap; brackets read costs per R65 (X cards as 0, embiggen cards at their base price) |
| 51.1 | KY's Empty Notebook | Token | 1 | Spell, KY, Token |  | Draw 1 | Draw 2 | Token; section 7 |
| 52 | Silly Silas | Legendary | 3 | Unit, Human | 4/4 → 8/8 | Cry: choose left or right; rotate every card on the field one step around its ring (3.1); cards crossing sides change control | Cards that would move to the opponent are bounced to their owner's hand costing 0 instead | Silas rotates too; damage and buffs travel with the card; a Locked destination bounces the card (ruling) |
| 53 | Reno | Common | 3 | Unit, Human | 4/6 → 8/12 | Cry: if your hero is below 30, set it to 30 | 60 | `health = max(health, 30)` |
| 54 | Straaza | Common | 4 | Unit | 8/8 → 16/16 | Cry: add 2 random Units costing 3 or 4 to your hand; they cost 1 | They cost 0 | Non-token pool excluding #54; `costOverride` |
| 55 | Lava Golem | Rare | 3 | Unit | 10/5 → 20/10 | Tribute 3, Armor 3, Taunt; may tribute enemy units | Plus Indestructible | Validator counts both sides' units, Sheep = 2; tributed enemies are sacrificed; Sheepish's 0-cost copy still needs Tribute 3 |
| 56 | Jilliax | Common | 2 | Unit | 3/2 → 6/4 | Rush, Taunt, Lifesteal, Divine Shield | Charge, Taunt, Lifesteal, Indestructible | Keywords only |
| 57 | Conjure KY | Common | 2 | Spell, KY |  | Add 3 random KY cards to your hand | 2 random plus 2 random Radiant KY cards | KY pool = #31, #51, #82 (no tokens, not #57); repeats allowed |
| 58 | Rush Token Farm | Common | 2 | Field Spell |  | Start of turn: summon a Rush Token | Aura: your Rush Tokens +3/+3; same | Aura keyed on def T-rush |
| 59 | Unbiased Immigration | Rare | 2 embiggen 4 | Field Spell |  | Start of turn: add a random card to your hand (paid 4: it costs 0) | A random Radiant card (paid 4: it costs 0) | Non-token Core pool excluding #59 |
| 60 | Bear Honeypot | Epic | 1 | Trap |  | When the opponent plays a card costing 1 or less: summon 2 Rush Tokens; if it was a Unit, they attack it | Any card; fill your board with Rush Tokens; same | Fires after the played card resolves (ruling), so the unit is on the field; forced attacks per 4.2 during the opponent's turn; cost = cost paid |
| 61 | Prejudiced Postdoc | Rare | 2 | Unit, Human | 2/4 → 4/8 | Cry: choose a Human unit on the field; summon a Vanilla copy | Any unit | Copy per R57 with `vanilla` set and no granted keywords: the target's form, radiant flag and buffs, no damage; auras apply to it afresh; an Immutable target is legal (R23) |
| 62 | Friend of Felinors | Common | 1 | Spell |  | Fill your board with Felinor Tokens | Then your units get +2/+2 | Permanent buff on those instances |
| 63 | Plastic Surgery | Common | 1 | Spell |  | Target unit gets +3/+3 and 1 random keyword | +6/+6 and 2 random keywords | Pool in 6.1 |
| 64 | Gifted Program | Rare | 2 | Field Spell |  | The first card costing 1 or less you play each turn becomes Radiant as it is played | 2 or less | Pre-resolution hook; cost = cost paid; per-turn flag |
| 65 | Masochism Mask | Epic | 2 | Field Spell, Quickdraw |  | Start of turn: choose one: exile the bottom card of your library, lose 3 health, or summon a Spikey Pillow | Choose twice from: nothing, exile bottom, lose 3, summon Spikey Pillow | Two sequential pending choices; "lose" is not damage |
| 65.1 | Spikey Pillow | Token | 1 | Unit, Token | 0/2 → 0/4 | Cannot be in Defense Position. Aura: your units have −2 attack | Aura: your non-Spikey-Pillow units have −2 attack | Position validator flag; aura floors attack at 0 |
| 66 | The Rock | Common | 4 | Unit, Human | 10/10 → 20/20 | Tribute 1, Indestructible | Plus Immutable | Tribute validator; Indestructible per 6.1 |
| 67 | Zoomerbin Oomen | Rare | 1 | Unit, Human | 1/2 → 2/4 | Cry: summon a random 1-cost Trap face-down into your backrow zone in this lane | Any random Trap | All six Core traps cost 1, so both forms share the pool (#18, #41, #60, #71, #85, #96); zone occupied or Locked → fizzles |
| 68 | Twisted Sorcerer | Common | 2 | Unit | 5/5 → 10/10 | Cry: deal 4 damage to a target, 8 if your hero is below 10 | 6, or 12 | Threshold read at resolution |
| 69 | Call to Arms | Common | 2 | Spell |  | Recruit 3 Units costing 1 or less | 2 or less | Three top-down scans; stops when the board is full |
| 70 | Spiteful Stab | Common | 3 | Spell |  | Deal 2 damage to a target, +1 per full 5 health your hero is below 30, +1 per card in your exile | 4 base, per full 3 health | `missing = max(0, 30 − health)`, floor division; your own exile (R72) |
| 71 | Intern Stimmy | Rare | 1 | Field Trap |  | At the end of any turn, if your library has more cards than the opponent's: Recruit a Unit costing 1 or less | 2 or less | Fires at every qualifying turn end; never consumed |
| 72 | Reminisce | Rare | 1 | Spell |  | Discover a card from your GY; it costs 1 less; exile this | It costs 0 | Options drawn from the GY without replacement; chosen card moves GY → hand |
| 73 | Anti-oneshot Armor | Rare | 2 | Field Spell |  | Your hero can't take more than 5 damage in one instance. Cry: draw 1 | Cap 3 | Pipeline step 3; a Field Spell with a Cry |
| 74 | Adaptive UI | Rare | X | Spell |  | Deal X damage to a target, heal your hero X, draw X, summon an X/X Rush Token | 2X damage, heal 3X, draw 2X, a 3X/3X token | X = 0 does nothing but counts as played |
| 75 | Infinite Reserves | Rare | 0 | Field Spell |  | Draws from an empty library give you a Rush Token card instead of fatigue | Cry: draw 3; same | Draw hook; the token is a 1-cost hand card |
| 76 | Field of Dreams | Rare | 3 | Spell |  | Replace your hand with the same number of Reminisce; exile this | Radiant Reminisce | Replaced cards go to the GY (ruling), so Reminisce can find them |
| 77 | Professor Curvature | Rare | 2 | Unit, Human | 4/5 → 8/10 | Cry: during your next turn, cards whose cost is 4 cost 1 less | 2 less | Delayed player modifier, checked against current cost at play; expires at that turn's cleanup |
| 78 | /fullsend | Epic | 4 | Spell |  | Gain 4 mana; this turn your cards cost 1 less and gain "Combo: draw 1"; at end of turn, exile your hand | Cost 2 less | Turn-scoped player modifiers plus an end-of-turn delayed exile |
| 79 | Twinspell | Rare | 2 | Field Spell |  | The next Spell you play gains Echo +1 | Echo +2 | Consumed to the GY when it applies (ruling); survives cleanup |
| 80 | Zao Gao | Rare | 2 | Spell |  | Discard 2 cards of your choice; summon 2 Rush Tokens, each with 2 random keywords | No radiant form | Fewer than 2 in hand → discard what you have |

### 8.4 Cards #81–95

| # | Name | Rarity | Cost | Type, tags | Stats | Base effect | Radiant effect | Engine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 81 | Radiant Saintess | Epic | 1 | Unit, Human | 2/2 → 4/4 | Reborn; Death: all your other units become Radiant | Reborn; same | The Cry was cut: she used to radiate the board on arrival, herself included, so a 1-mana play landed a 4/4 Reborn and turned every other unit up at once. On Death alone the effect is paid for with her body. Reborn is printed on BOTH faces now — it used to be radiant-only, which her own Cry granted her for free, so cutting the Cry would otherwise have taken the Reborn with it and nerfed a second thing nobody asked to nerf. "other" is written on the card rather than left to R78: by the time Death runs she is already in the graveyard, so "your units" never included her — the text now says what the rule always did. Her Reborn body fires Death again |
| 82 | KY's Trial | Rare | 1 | Spell, KY |  | Discover among 3 distinct random numbers 1–100; add the Radiant Core card with that index to your hand | It costs 0 | Reroll 82; token indices are never rolled |
| 83 | Transmogulate | Legendary | 2 | Spell |  | Replace every card in your library, board, GY and exile with a random Legendary | Random Radiant Legendaries | Same counts per zone; board cards are replaced in place by a random Legendary of the same type (Field Trap counts as Trap; Immutable cards stay, since this is a Transform); other zones by any Legendary; replaced cards cease to exist (R35); pool = the non-token cards whose rarity above is Legendary, except #83: #52, #85, #87, #92, #93, #95 |
| 84 | Going Long | Rare | 2 embiggen 4 | Field Spell, Quickdraw |  | Your hero has Armor 2 (paid 4: 5) | Armor 4 (paid 4: 10) | Hero armor in pipeline step 2 |
| 85 | Unlicensed Experimentation | Legendary | 1 | Trap |  | When the opponent plays a permanent whose type matches one you control: Fuse it onto a random permanent of yours of that type | Onto every such permanent | Played or cast permanents only, after their Cry resolves (R17, R61); Field Trap counts as Trap; this trap is neither matched nor a Fuse target; Immutable permanents are never chosen (R23), and with no legal target the trap still fires and is consumed with no effect (R61); the opponent's card ceases to exist; Fuse per R77 |
| 86 | "Miss" Mrow | Epic | 1 | Unit, Felinor | 1/1 → 2/2 | Can't attack. Death: steal all enemy units | Can attack; same | Steals enemy units in lane order, each placed per R15; excess stay put |
| 87 | Pocket Chaos | Legendary | 2 | Spell |  | Choose one: swap hero health, swap boards (every zone, lane-preserving), or swap libraries with the opponent; then add a Pocket Chaos to the opponent's hand; exile this | You may skip adding it | Swaps per R73: the board swap changes control of everything including face-down traps, ownership unchanged; the library swap changes the owner of the swapped cards |
| 88 | Twisting Nether | Epic | 3 | Spell |  | Destroy all permanents | Choose: all enemy permanents, or all | Indestructibles survive; backrow included |
| 89 | Corpse Eater | Epic | 4 | Unit | 2/2 → 6/6 | Rush. While in your hand: whenever a unit on either side dies, this gains its attack and max health | Rush, Divine Shield; gains double | Hand-zone trigger reading the `destroyed` event (R89); a death is a unit going from the field to a graveyard, a sacrifice included (§6.2), and it counts the dying unit's current attack and max health (R38); a card that reaches a graveyard from a hand (#80's discard, #76's replaced hand) never died, so it does not count, and tokens never reach a GY at all (R11) |
| 90 | CN-Viral Injection | Rare | 1 | Spell, CN |  | Shuffle a CN-Virus into the opponent's library | A Radiant CN-Virus | The opponent owns the token, so its cast-on-draw chain runs on their draws; a full library refuses the shuffle (R80) |
| 90.1 | CN-Virus | Token | 1 | Spell, CN, Token |  | Cast on draw: take 1 damage; shuffle 2 copies of this into your library | 3 copies | Damage goes through the pipeline; cast-on-draw chains, capped by R58; copies stop at the library cap (R80) |
| 91 | Fed Fauci | Rare | 2 | Unit, Human | 1/6 → 2/12 | Rush. Whenever this takes damage, +1 Plague Token. Start of turn: +1 mana per Plague Token | Rush; +2 mana per token | Counters reset when it leaves the field |
| 92 | Felinor Fiender | Legendary | 2 | Unit, Human | 5/7 → 10/14 | Stack. Stats = printed plus the combined stats of all your Felinors, including ones under a Stack | Stack, Charge; same | Set-stat layer recomputed continuously; the one dormant-card exception (3.2) |
| 93 | Combo-Index | Legendary | 2 | Field Spell |  | Grade counter, starts at E (E,D,C,B,A,S = 1–6). End of turn: if cards played this turn ≥ grade, grade +1 and run every step from E up to the new grade. E: add a copy of a random card played this turn to your hand. D: 2 different random hand cards cost 1 less. C: opponent exiles a random hand card. B: a random hand card becomes Radiant. A: 8 damage to the enemy hero with Lifesteal. S: run E–A again | Start of turn: add a Combo-Fodder to your hand; same | `counters.grade`; nothing further at S; steps run in order (R27); random picks per R60 |
| 93.1 | Combo-Fodder | Token | 0 | Spell, Token |  | Deal 2 damage to a target, Lifesteal | No radiant form | Token; section 7 |
| 94 | Genn's Greed | Epic | 4 | Spell |  | Draw every 2-cost card from your library; exile every odd-cost card in your library, hand and GY (X-cost cards exempt); gain 2 mana | Gain 6 | Uses current cost (R66); hand cap applies |
| 95 | Call to Chaos (Core Edition) | Legendary | 4 | Spell, Call to Chaos |  | One random effect: summon 3 random 3-cost Units; heal your hero 30; draw your whole library and gain 4 mana; add 3 random cards to hand costing 0; your hand becomes Radiant; summon five Radiant Rush Tokens; every card in your hand and library costs 2 less; summon a Chaos Golem; summon 5 random Field Spells or Traps (Field Traps included, traps face-down) into your backrow; cast a random Call to Chaos | Two random effects: "cast a random Call to Chaos" plus one drawn from the other 9 | Only Core exists, so the recursive option casts base #95 (a Cast, R70); the engine caps the chain at 20 casts (R28); generated cards may repeat (R60); the radiant pair's order, a recursion roll made once the chain is at the cap, and where a cast card goes when it resolves are per R87 |
| 95.1 | Chaos Golem | Token | 4 | Unit, Token | 10/10 | Rush, Lifesteal, Divine Shield, First Strike | No radiant form | Token; section 7 |

### 8.5 Cards #96–100

| # | Name | Rarity | Cost | Type, tags | Stats | Base effect | Radiant effect | Engine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 96 | My Pawn | Mythic | 1 | Trap |  | When the opponent declares an attack that would be lethal to your hero: cancel it, and an AI plays the rest of their turn with random legal actions | No radiant form | Lethal = projected damage after Armor and cap ≥ health; the AI is the same random-legal-action policy as "Targets chosen randomly"; the opponent's client is locked out until end of turn (`aiTurn` on their PlayerState) |
| 97 | Zephyrs | Mythic | 0 | Spell |  | Discover the "perfect" card from the Core set; exile this | A perfect Radiant card | Scorer in 10.7 ranks every non-token Core card except #97 for the current state; Discover offers the top 3 (R29) |
| 98 | Heroic Power | Mythic | X | Field Spell, Quickdraw |  | Indestructible. Start of game: gain one of 7 random powers, each "Once per turn, spend X": (3) Recruit a permanent; (1) lose 2 health, draw 1; (1) deal 1 damage to a target; (1) deal 2 damage to each opposing hero; (2) summon a Rush Token; (1) summon a Felinor Token; (2) Discover a Unit. Playing it costs the power's X and activates it once | Powers become: Recruit and make it Radiant; lose 2, draw 2; deal 2; 4 to each opposing hero; two Rush Tokens; two Felinor Tokens; Discover a Radiant Unit | `memory.power` and `memory.usedTurn` (R43); `activatePower {instanceId, targets[]}`; "each opposing hero" future-proofs multiplayer |
| 99 | Craft a Card | Mythic | 3 | Spell |  | Discover a Unit, then Discover another; Fuse them; the result costs 0 and goes to your hand | Three Discovers | Fuse per 6.3 creates a transient definition stored in match state |
| 100 | Ceaseless Void | Mythic | 100 | Unit | 10/10 → 10/10 | Cry: exile all other permanents on both sides. Costs 1 less per card drawn, played, destroyed or exiled this game by either player | Plus Charge | Four game-level counters; cost recomputed on read; floor 0 |

## 9. Architecture

The match runs on the server as a pure, seeded reducer inside one actor per match; the client sends intent and receives a filtered view.

### 9.1 Trust model

| Domain | Truth lives | Client may | JackiOh specifics |
| --- | --- | --- | --- |
| Identity and entitlement | Server | Read a projection | Everyone owns every card at launch; keep the ledger anyway |
| Loadout | Server validates and stores | Propose | 3 decks, 20 cards each, no card in two decks |
| Match | Server | Read `viewFor(state, playerId)`, submit actions | Hidden: library order, opponent hand, face-down traps, the other player's pending-choice options |

One rule: the client sends intent ("play instance 7 in zone 3 with target 12"), never state.

### 9.2 Topology

```mermaid
flowchart TD
  B[Browser client] -->|HTTPS| A[Auth provider]
  B -->|HTTPS| F[API functions]
  F --> P[(Postgres)]
  B -->|WSS| M[Match actor]
  M --> P
  M --> E[Engine: reduce]
  E --> C[Card catalog + scripts]
```

The match actor (Durable Object or equivalent) is the only stateful component: it holds the state in memory, one WebSocket per player, an alarm for the turn clock, and it appends every resolved action to the log. Idle actors hibernate.

### 9.3 Engine requirements (binding on section 10)

- `reduce(state, action, rng)` is pure: no I/O, no clock reads, no framework. Timestamps arrive as action data.
- Seeded RNG only, `Math.random` banned by lint. `(seed, log)` reconstructs any match.
- Mid-action choices are state, not callbacks: a choice made during resolution (Discover, mulligan, chained steps, Echo repeats, triggered effects) sets `state.pending` and returns; the answer is another action. The choices a card declares for its own play (zone, X, embiggen, Tribute, targets, modes) travel in the `play` action instead (R81). This is what makes prompts identical in live play, replays and tests.
- Every action carries a client nonce, deduped server-side.
- `reduce` refuses illegal actions itself and returns the reason; client greying-out is UX only.
- Append-only action log per match; snapshots are a later optimisation.

### 9.4 Accounts, collection, loadouts

- Managed auth provider; `profiles.status` in pending, active, banned. A pending account can log in, verify its email and see the code screen, and nothing else: no collection, loadout, queue or match. Redeeming an invite code flips pending to active.
- Codes: 16 characters (80 bits) from a 32-symbol alphabet without 0/O/1/I/l, formatted `XXXX-XXXX-XXXX-XXXX`, stored hashed. Redemption is one server-side transaction: (1) reject unless the account is pending with a verified email; (2) reject if this profile made more than 5 attempts in the last hour; (3) reject if this IP hash made more than 20; (4) log the attempt either way; (5) look up by hash and reject if revoked, expired or exhausted; (6) increment uses and set the account active, atomically. Missing, expired and exhausted codes return an identical error in identical time. A global circuit breaker disables redemption and alerts when system-wide failures cross a threshold in a window. Trusted devices (a signed device token that skips the code screen after a reinstall) are optional and never authorise an account.
- Collection is an entitlement ledger (`collection` plus append-only `collection_grants`); catalog is static, versioned, shipped with the client; stale catalog version is rejected at save and queue. Every collection change writes `collection` and `collection_grants` in one transaction, and no client path writes either.
- Loadout rules, checked by one validator module shared by client and server, at save and again at queue: **L1** exactly 3 decks; **L2** exactly `DECK_SIZE` (20) cards per deck; **L3** at most `MAX_COPIES` (1) of a card per deck and no Token-tagged cards; **L4** a card id appears in at most one deck, also enforced by a unique index on `(profile_id, card_id)`; **L5** copies across the loadout never exceed the quantity owned; **L6** every card exists in the current catalog version and is not banned. Saving is `saveLoadout(profileId, catalogVersion, decks[3])`, which writes all three decks in one transaction or nothing; there is no per-deck save. A queue-time failure names the deck and the card. Decks are frozen into the queue ticket.

### 9.5 Matchmaking and lifecycle

- Direct challenge by room code (6 characters from the invite-code alphabet) ships before the ranked queue and is the primary mode while the player base is small. Enqueue asserts the account is active and not in a match, validates the loadout, freezes the chosen deck into the ticket and returns the ticket id. Pairing runs on enqueue plus a sweeper every few seconds; the window widens ±50 rating every 10 s from ±100 and is uncapped after 60 s; both tickets are claimed in one atomic statement. The client shows the queue population instead of an endless spinner.
- The turn clock (75 s) ends a stalled turn. A prompt held by the non-active player has its own 30 s clock. Disconnect grace (60 s) and concede end the match as a loss, and the hard wall-clock ceiling (60 minutes) ends it as a draw through the `ceilingReached` action. Every ending records a result and clears both players' in-match state, and a reaper resolves anything past the ceiling. Ratings use an Elo update (K = 32, starting at 1000). All of these are server config values (R79).
- Reconnect gets a fresh full view, never a log replay. The clock keeps running while a player is disconnected, and the grace countdown is stored on the match so both clients show it. A crashed actor rebuilds its state by folding `(seed, log)`.

### 9.6 Build order

| Step | Scope | Spec sections it needs |
| --- | --- | --- |
| 1 | Pure seeded `reduce`, local hotseat, every Core card | 2–8, 10 |
| 2 | Auth, profiles, invite gate | 9.4 |
| 3 | Collection ledger; grant everything to everyone | 9.4 |
| 4 | Loadout builder and shared validator with the unique index | 2.6, 9.4 |
| 5 | Match actor, WebSocket, `viewFor`, action log, room-code challenge | 9.1–9.3, 10.8 |
| 6 | Turn clock, disconnect grace, concede, results | 2.5, 9.5 |
| 7 | Ranked queue with frozen decks | 9.5 |
| 8 | Economy through `collection_grants` | out of scope |

Out of scope: spectating, tournaments, player-facing replays (the action log makes them cheap later), behavioural anti-cheat, economy design.

### 9.7 Suggested repository layout

```
packages/
  engine/      reduce, state, events, rng, combat, triggers, zones, viewFor
  cards/       catalog.json (100 defs + 9 tokens), scripts/<index>-<slug>.ts, one test per card
  validator/   loadout rules L1–L6, shared by client and server
  shared/      action and event types, catalog types
apps/
  web/         client (board, hand, prompts, animations driven by events)
  server/      API functions, match actor, matchmaking
e2e/           Cypress: hotseat games and networked room-code games
```

### 9.8 Abuse surface

| Vector | Mitigation |
| --- | --- |
| Claiming unowned cards | The collection is server-owned; loadouts are validated against it (9.4) |
| Deck swapped after matchmaking | Decks are frozen into the ticket (9.4) |
| Illegal actions | `reduce` rejects them; client checks are UX only (9.3) |
| Reading deck order or the opponent's hand | Never sent; `viewFor` sends counts (10.8) |
| Stalling | Server clock, disconnect grace, hard match ceiling (9.5) |
| Action flooding | Per-match rate limit in the actor, per-account rate limit at the API |
| Invite code brute force | 80-bit hashed codes, per-account and per-IP limits, verified email, circuit breaker (9.4) |
| Multi-accounting to farm rating | Invite codes; watch for clusters of accounts sharing an IP hash |

Every rejected action is logged with its reason, and accounts with an unusual rejection rate raise an alert.

### 9.9 Practice against the AI

Practice is a single-player game against a computer opponent, on the client's `/practice` route. It needs no account and no server. The engine and the AI run in the player's browser, in a Web Worker, and the page receives only `viewFor(state, human)`, the human's `legalActions` and whether the AI owes an action. The worker stands where §9.1 puts the server. A practice game records no result, no rating and no collection change, and it replays exactly from `(seed, decks, handicaps, log)` (R187).

The human always plays with this spec's resources. The AI seat gets a handicap (R180) by difficulty, held as `AI_DIFFICULTY` in `config.ts`:

| | Easy | Medium | Hard |
| --- | --- | --- | --- |
| Deck size | 20 | 25 | 30 |
| Max mana | min(turns, 4), as a human | min(turns + 1, 5) | min(turns + 1, 7) |
| Opening hand | as a human | +1 card | +1 card |
| Draws per turn | 1 | 1 | 2 |

"+1" means one more crystal than a human has on every turn, up to the tier's cap, with persistent and temporary mana modifiers on top exactly as for a human (R181). Hard includes Medium's extra opening card (R182), and its second draw is a separate draw (R183). An AI deck holds its tier's number of distinct, token-free Core cards (R184). The tiers change resources only: the AI's search, evaluation and budget are the same at every tier.

The AI (`packages/ai`) is pure and seeded like the engine.

- **Information.** It decides from what its seat may know and nothing else (R185). Before it simulates, it determinizes: the opponent's hand, the backrow it cannot read and the opponent's library are resampled from Core cards the opponent has not shown, its own library is shuffled, and the seed is its own.
- **Search.** Each action is chosen by a turn-level beam search over `legalActions` sequences played through `reduce` on several determinizations. The search starts with a lethal solver, a bounded search for a line that wins this turn on every determinization, answers the AI's prompts the same way, and re-plans after every action. The mulligan returns cards costing more than 3.
- **The opponent's reply.** The best lines are scored one turn deeper. On each determinization the opponent answers the line by a fixed rule and ends its turn, and the line is scored at the start of the AI's next turn. The opponent plays a card the line itself put in its hand (a Pocket Chaos handed back, units a Flood bounced), when that improves its position, because the AI watched that card arrive. Otherwise it swings with its board by static trade value: lethal first, then a kill it survives, a trade up, or the face. It plays none of the cards it held unseen, because those are samples. Every step is a real `reduce`, so traps, First Strike, Taunt and end-of-turn effects happen as they would in the game.
- **Evaluation.** Hero health (concave, so the last points weigh most), hero armor, board stats and keywords through §10.4's layers, cards in hand, library, unspent mana at the end of the turn, the enemy's face damage next turn against the AI's health and the reverse, and the enemy's face-down cards. A unit in Defense Position counts only part of its attack, since it cannot attack until it switches back, and the position's Taunt and Armor count only through the damage they stop (§4.1). Every point of damage on the enemy hero also counts at a flat rate, and more as the turn cap nears, because a game that reaches the cap is a draw (§2.5). A position scored after the opponent's reply counts the enemy's threat at a discount, because the AI moves first and can still answer it.
- **Budgets.** Budgets count `reduce` calls, so the same state and AI seed give the same decision. The browser adds a wall-clock cap. The quality gates and the shadow-ban sweep play at the browser's budget, and one decision at that budget takes under 1.5 s on the development machine.
- **Quality gates.** Three matchups measure the AI at the browser's budget on a frozen seed series that no tuning run plays, the subject alternating seats and every game folded back to its hash: the Easy AI against §10.7's random policy (100 games), the Easy AI against a one-ply greedy baseline at equal resources whose evaluation weights tuning never moves (50 games), and the Hard AI against the Easy AI (50 games). `pnpm test` plays the first 20 games of each. Only wins count; a draw at the turn cap is reported beside them. The brief asked for 95%, 70% and 80% wins. On fresh deals the AI wins 94.5% ± 0.7 of 1,000 against random and 68.0% ± 1.5 of 1,000 against greedy, and as Hard 91.3% ± 1.6 of 300 against Easy. Against greedy that is short of the brief, and no change tried moved it past noise (a four-times search, perfect information, weights tuned by paired self-play, a reply that plays the opponent's sampled hand, kills on the last turn): the dealt decks decide most of these games. **Proposed, pending the user's acceptance:** a run of n games needs the brief's share of them, or the count that an AI as strong as measured reaches in 95% of runs of n games, whichever is lower (`gateNeeded`). That asks for 91 of 100 and 17 of 20 wins against random, 28 of 50 and 10 of 20 against greedy, and the brief's 40 of 50 and 16 of 20 for Hard against Easy. An AI at the measured rates fails any one of these runs by chance at most once in twenty, and one of the three about once in thirteen. A gate of this size catches a broken AI, not a lost point or two: a run fails with 90% probability only once the win rate falls to 86% (full) or 70% (smoke) against random, 46% or 34% against greedy, and 71% or 64% for Hard against Easy. A 5-point loss against greedy fails the full run one time in eight. A claim about strength needs hundreds of fresh deals, not the gate. Until the user accepts this rule, the brief's counts stand as the target, and this AI does not reach them on the frozen series against random or greedy (docs/polish/3-ai.md, "Fix pass 2").
- **Decks.** An AI deck is a curve- and tag-aware random draw of distinct non-token cards, minus the shadow ban (R186). The shadow-ban sweep judges every card at the Easy and the Hard handicap, because the ban holds at every tier and a tier's mana decides what the AI can do with a card.
- **Draw offers.** The AI never concedes or offers a draw, and it declines every draw offer at once (R188). The practice page does not show the Offer draw control for that reason; the action itself stays legal.

The human's deck is a saved loadout deck (an active account's), a fresh random deck, or one of three named practice decks: Human Vanguard, Blitz and Fortress, each hand-built from Core cards outside the AI's shadow ban. Before the game starts the setup shows the chosen deck's cards and mana curve, read from the catalog the worker sends. The AI's turns are paced for the player to follow: each step waits while the board still animates the last one, or while the page marks a voice line as playing (`data-speaking`, capped so a mark nobody clears cannot stop the game). A practice game is not saved, so while one is in progress the page asks before a reload or a closed tab ends it.

## 10. Engine implementation guide

The engine is a pure reducer over an immutable state that emits an event list; every card is a small script composed from shared primitives; every random and every prompt goes through state so replays and tests are exact.

### 10.1 State model

```ts
type GameState = {
  seed: string; rngCursor: number;
  turn: number;                 // player-turn counter, 1-based, cap 30
  active: PlayerId; phase: 'setup'|'mulligan'|'start'|'main'|'end'|'over';
  players: Record<PlayerId, PlayerState>;
  pending: PendingChoice | null; // exactly one open prompt at a time
  triggerQueue: QueuedTrigger[];
  echoQueue: EchoRepeat[];      // Echo repeats a played card still owes (6.1, 10.5 step 6)
  declaredAttack: DeclaredAttack | null;  // the attack whose trap window is open (4.2 step 4, R44)
  dispatch: DispatchRecord[];   // events still owed to the traps and the trigger queue (10.3)
  work: WorkItem[];             // sequences a prompt interrupted, waiting to continue (9.3, 10.6, R113)
  workCursor: number;           // where the running pause cascade parks its next item (R113)
  delayed: DelayedEffect[];     // Kpop Fanatic steal, Recycling Initiative, /fullsend exile
  counters: { drawn: number; played: number; destroyed: number; exiled: number }; // Ceaseless Void
  transientDefs: Record<string, CardDef & { fusedFrom: string[] }>;  // Fuse and Craft a Card results, each with its ingredients' def ids (R77)
  reserved: ZoneRef[];          // zones a dying Reborn unit holds until it returns (R64)
  mulliganed: PlayerId[];       // who has answered their mulligan (2.1)
  result: null | { winner: PlayerId | 'draw'; reason: string };
  nextId: number; nextSeq: number;  // deterministic ids and R68's creation order
  applied: { nonce: string; events: GameEvent[] }[];  // nonce dedupe (9.3)
};
type PlayerState = {
  hero: { health: number; armor: number };  // Heroic Power lives on its instance (R43)
  mana: { current: number; max: number; nextTurnMod: number; permMod: number };
  hand: CardInstance[]; library: CardInstance[]; graveyard: CardInstance[]; exile: CardInstance[];
  units: (Pile | null)[5]; backrow: (CardInstance | null)[5];  // Pile = CardInstance[] top-first
  resolving: CardInstance[];    // cards mid-resolution: a Spell between its play and its GY (10.5 step 4)
  locks: { units: boolean[5]; backrow: boolean[5] };
  mods: PlayerModifier[];       // next-spell discount, this-turn discounts, Curvature, Twinspell echo, Gifted flag, /fullsend's Combo draw
  turnLog: { playedIds: string[]; cardsPlayed: number; unspentAtEnd?: number };
  drawOffer: { offeredTurn?: number; blockedUntil?: number }; fatigueCount: number;
  turnsStarted: number;         // drives the mana refresh (2.3)
  aiTurn: boolean;              // My Pawn: the AI policy plays out the rest of this turn
  handicap?: Handicap;          // an AI seat's resources in practice; absent = this spec's (9.9, R180)
};
type CardInstance = {
  id: string; defId: string; owner: PlayerId; controller: PlayerId; radiant: boolean;
  zone: Zone; position?: 'ATK'|'DEF'; summonedTurn?: number;
  damage: number; buffs: { attack: number; health: number }; grantedKeywords: Keyword[]; vanilla: boolean;
  costMod: number; costOverride?: number; x?: number; embiggened?: boolean;
  counters: { plague?: number; grade?: number }; memory: Record<string, unknown>;
  exertion: { attacked: boolean; switched: boolean }; statsOverride?: { attack: number; health: number };
  returnToHandAtEndOfTurn?: boolean;
  tauntSuppressedTurn?: number; // Indestructible would-destroy: no Taunt this turn (R46)
  faceUp?: boolean;             // backrow card revealed, e.g. a Field Trap that has fired (R33)
  lastDamagedBy?: string;       // instance id of the last damage source (R42)
  divineShieldSpent?: boolean;  // the shield absorbed a hit and is gone until granted again (6.1)
  markedDestroyed?: boolean;    // destroyed by an effect; the next state check collects it (4.5)
  rebornSpent?: boolean;        // came back through Reborn, so it no longer has it (4.5 step 4)
};
```

Everything a card needs to remember (Carnivorous Cube's meal, Heroic Power's chosen power, Combo-Index's grade) lives on the instance so cloning, Fuse and replay stay trivial. `Zone` names the pile or field slot a card sits in plus two states that are no pile: `{ z: 'resolving' }`, a Spell between its play and its graveyard (§10.5 step 4), and `{ z: 'gone' }`, a unit token that has ceased to exist and so is in no pile at all (§3.2, R11). Fused and crafted cards get a generated `defId` in `transientDefs`, and that def records the ids it was fused from (`fusedFrom`). The fused scripts are code, which state cannot hold, so the engine rebuilds them from `fusedFrom` into the process's script registry whenever `reduce`, `legalActions` or `viewFor` is entered with a state whose `t-<n>` the registry holds for another state: a `t-<n>` id is unique only within one match, and two matches in one server process, or the practice AI's simulated worlds beside the real game, would otherwise run each other's scripts.

### 10.2 Actions

`reduce(state, action, rng) → { state, events, error? }`. Action types: `mulligan {keep[]}`, `play {instanceId, zone?, x?, embiggen?, tributes[], targets[], modes[]}` (R81, its choices validated per R90), `attack {attackerId, targetId}`, `switchPosition {instanceId}`, `activatePower {instanceId, targets[]}`, `answer {choiceId, selection}`, `offerDraw`, `answerDraw {accept}`, `concede`, `endTurn`, plus server-only `timeout` (answers the open prompt of the player whose clock expired with the AI policy, and ends the turn only when that is the active player), `disconnectExpired` (that player loses) and `ceilingReached` (the match ends in a draw), all per R79. Every action carries `playerId` and `nonce`. `legalActions(state, playerId)` is exported and is what both the client UI and the My Pawn AI consume.

### 10.3 Events and triggers

Every visible state change emits an event. This is the complete list, and BUILD's animation table has one row for each: `cardPlayed`, `cardResolved`, `summoned`, `damage`, `healthLost`, `healed`, `divineShieldLost`, `destroyed`, `enteredGraveyard`, `exiled`, `bounced`, `burned`, `discarded`, `drawn`, `addedToHand`, `shuffledIn`, `buffed`, `keywordGranted`, `counterChanged`, `costChanged`, `modifierChanged`, `radiantSet`, `transformed`, `fused`, `positionSwitched`, `controlChanged`, `rotated`, `swapped`, `locked`, `trapFired`, `attackDeclared`, `attackCancelled`, `manaChanged`, `turnStarted`, `turnEnded`, `turnAutoEnded`, `promptOpened`, `promptAnswered`, `drawOffered`, `drawAnswered`, `gameOver`. A new event type is added here and to BUILD M5-T4 together. Triggers are functions `(event, state) → Effect[]` registered by card scripts and by zone (hand triggers for Corpse Eater, backrow triggers for traps).

Resolution loop after any action or answer:

```mermaid
flowchart TD
  A[Apply effect] --> B[Emit events]
  B --> C[Traps check events, fire immediately]
  C --> D[Queue other triggers in R68 order]
  D --> E[State check: deaths, Reborn, Death triggers, hero check]
  E --> F{Queue empty and no prompt?}
  F -- no --> G[Pop next trigger or wait for answer]
  G --> A
  F -- yes --> H[Return state + events]
```

"Apply effect" means a whole script's effect list, so the state check never splits one effect (R59). Traps are checked before other triggers because they are responses (the end-of-turn trap window of §2.2 is the one scheduled exception, R62); a trap that fires during the opponent's turn resolves to completion (including forced attacks and prompts for the trap's owner) before the opponent's action continues. Start-of-turn and end-of-turn are events too, so Mana Well, Moths and Combo-Index are ordinary triggers, and Bread and Butter and Intern Stimmy fire in the end-of-turn trap window.

### 10.4 Stat and keyword layers

Compute a unit's view on every read, never store totals:

1. Base: printed stats of the base or radiant form (per `radiant`), or `statsOverride` for tokens summoned with X/X.
2. Set-stat: Felinor Fiender adds the sum of your Felinors' layer-4 stats.
3. Fused stats: part of the transient definition's printed stats (R77), so no separate layer at runtime.
4. Permanent buffs: `buffs` (Gary, Plastic Surgery, Friend of Felinors, Corpse Eater).
5. Auras: Jlockeed's Weapons, Suppressive Aura, Big D-fender, Spikey Pillow, Rush Token Farm. Attack floors at 0; max health can fall to 0, which the state check turns into a death.
6. Current health = max health − damage.

Keywords = printed (unless `vanilla`) ∪ `grantedKeywords` ∪ aura grants ∪ position grants (Defense: Taunt, Armor +1), minus Taunt while `tauntSuppressedTurn` is the current turn (R46). Armor is summed across all sources.

### 10.5 Playing a card

1. Validate: legal zone, cost ≤ current mana after all modifiers, Tribute available, X or embiggen chosen, targets legal — every choice the play carried is checked against what the card declared and what the board allows (R90).
2. Pay: mana, Tributes (sacrifice), and consume the next-spell discount if used.
3. Gifted Program hook may set `radiant` now.
4. Move the card to the field (Units, Field Spells, Traps) or to a resolving state (Spells); emit `cardPlayed`; increment `turnLog.cardsPlayed` and the game `played` counter; Sheepish fires here for Units.
5. Resolve Combo checks, Quickstriker, /fullsend's Combo draw, then the card's own Cry or spell script (targets already chosen).
6. Echo: repeat step 5 with fresh prompts N times.
7. Spells go to the GY or exile; Unstable Clone Machine and Bear Honeypot fire after resolution; Unlicensed Experimentation fires after a played permanent's Cry (R61).
8. Run the resolution loop.

### 10.6 Prompts (`state.pending`)

`PendingChoice = { id, playerId, kind: 'discover'|'target'|'mode'|'mulligan'|'hand'|'zone'|'tribute'|'direction'|'x'|'embiggen', options, min, max, resume }`. `resume` names the script continuation and its captured data, so the reducer is re-entrant: `answer` re-invokes the script with the selection. Multi-step effects (Private Tutor, Craft a Card, Masochism Mask radiant) chain prompts. The opponent's view shows only that a prompt is open, never its options. A card's own play choices (zone, X, embiggen, Tribute, declared targets and modes) are not prompts; they travel in the `play` action, and the client builds them with the same pickers (R81). No Core card opens an `x`, `embiggen`, `zone`, `tribute` or `direction` prompt, since all five are play choices; the kinds stay for later sets. `hand` is reachable: Zao Gao's chosen discard is a prompt, and an Echo repeat of Glowy Jelly Bean reopens its hand pick.

### 10.7 Randomness, pools, scorers

- One PRNG (xoshiro128\*\* or mulberry32) seeded per match; `rng.next()` advances `rngCursor`, which is stored so replay resumes mid-log.
- `rng.pick(list)`, `rng.shuffle(list)`, `rng.coin()`, `rng.chance(p)`, `rng.lucky(x, roll, better)`.
- `catalog.query` (5.1) is the single source of random pools; it never returns tokens or the requesting def unless the effect names its pool (5.1).
- Copy semantics: `cloneInstance(inst)` for "copy of this unit" keeps radiant, buffs, granted keywords, vanilla and `statsOverride`; resets damage, exertion, counters and summonedTurn (R57).
- Zephyrs scorer: for each candidate, simulate a dry-run score: lethal available → max; can clear the enemy board → high; hero below 10 and card heals → high; otherwise stats-per-mana plus draw value. Deterministic, ranks all non-token Core cards except Zephyrs itself, Discover offers the top 3. The weights are engine constants, tested against fixed states.
- AI policy (My Pawn, "Targets chosen randomly"), described here once and only pointed at from R44 and R84: draw uniformly from `legalActions` minus the three action types the policy never takes — `concede`, `offerDraw` and `answerDraw`, held as one named constant (R84) — ending the turn when nothing else is left on that set and otherwise with probability 0.1 (`AI_END_TURN_PROBABILITY`); with a prompt open `legalActions` offers only that prompt's answers, which is what answering prompts uniformly means (R44).

### 10.8 `viewFor(state, playerId)`

Returns the full public board, the viewer's hand and pending options, counts for the opponent's hand and both libraries, face-down markers for the opponent's backrow (traps show as unknown, Field Spells are public), both graveyards and exile piles in full, mana, health, armor, clocks and the last N events for animation. A trap that changes control becomes visible to its new controller only (R33); a Field Trap that has fired is public. A card revealed out of a library (KY's Private Tutor) is revealed only as an option of the prompt that reveals it: the chooser sees it in full, the opponent sees only that a prompt is open (§10.6), and the rest of the library stays hidden from both.

### 10.9 Card scripts and tests

Each card is one file exporting `{ def, base: Script, radiant: Script }` where `Script = { cost?, cry?, death?, startOfGame?, resume?, delayed?, setStat?, startOfTurn?, endOfTurn?, aura?, triggers?, activate?, onPlayHook?, handTriggers?, staticFlags?, targets?, modes? }` (`cost` is Ceaseless Void's computed cost, R55; `startOfGame` is Heroic Power's roll, R43) (`resume` is the named-continuation step table a prompt answer or a delayed effect re-enters, §10.6, R81, R113; `delayed` is the hook a scheduled delayed effect lands on unless the card names another key, resolved at its R62 point, and R126 is the rule that one reader resolves either spelling; `setStat` is §10.4 layer 2's hook, returning a delta added to the printed face, R116, summed across a Fuse's ingredients, R102) (`targets` and `modes` declare the card's play-time choices, R81) and every hook returns `Effect[]` built from the primitives in section 6. A card never mutates state directly. Tests per card: one fixture per listed behaviour in section 8 (base and radiant), plus a replay test that folds the recorded log and compares the final state hash. Property test: 1,000 random-policy games per seed set must never throw, never desync between two folds, and always terminate within the cap.

Catalog test: exactly 100 cards and 9 tokens, with the indices, costs, types, tags, stats and rarities in section 8. End-to-end (Cypress) scope: a hotseat game to completion; each prompt kind exercised once; a trap firing on the opponent's turn; a reconnect mid-game restoring the same view; a room-code match between two browsers; a My Pawn turn played by the AI; the turn cap ending a game as a draw.

### 10.10 Client rendering

The client renders `viewFor` and animates from the event stream: `summoned` → card flies to zone; `damage` → number pops, shake; `destroyed` → dissolve; `radiantSet` → glow; `attackDeclared` → lunge; `promptOpened` → modal; `controlChanged` → slide across the centre line; `positionSwitched` → rotate 90°. Keep a table `eventType → animation` so each animation has an acceptance criterion.

## 11. Open rules questions and recommended rulings

Every place this spec decided something the source left open is listed here; each row is a config value or a named test in the engine. Rows marked decide change gameplay materially and are still open: R1, R2, R4, R5, R14, R26 and R39. The spec reviews of 2026-09-17 added R58 to R90: R58–R75 in the first round, R76–R81 in the second, R82 and the refinements to R33, R43, R61, R64, R73, R76, R77, R79, R80 and R81 in the third and fourth, and R83–R90 in the milestone reviews of the same day, along with edits to §2.5, §3, §4, §4.4, §4.5, §5.1, §6.3, §8, §9.5, §10.1, §10.2, §10.6, §10.7 and §10.8: the designer chose R59, R60, R61 and the Transmogulate pool in R35, and the rest follow the source text or Hearthstone.

**R91 to R170 were added on 2026-09-18**, and this paragraph did not name them until it was corrected — which is why the provenance is now stated as a rule rather than a list: every row from R91 on was added by the milestone work or by a review of it, in the same change as the code it describes and the `it("R<n> …")` test that pins it, and `pnpm rulings:coverage` fails if either is missing. The sections they edit, beyond those above, are §4.3 (R93's First Strike, stated attacker-only against §6.1 until Part A r5 caught it), §9.1, §9.3, §9.4, §9.5, §10.3, §10.4, §10.5, §10.9 (R102, R113, R116, R126 and R153 all needed `resume`, `delayed` and `setStat`, which its `Script` listing omitted) and §10.8 (R168, R169). None of these is a designer choice: they are rulings the code had to make to run, written down after the fact where the spec was silent, and where one contradicted working code — R93, R119 — the code was right and the text was the defect.

| # | Topic | Recommended ruling | Cards affected |
| --- | --- | --- | --- |
| R1 | When does Cry fire? (decide) | Only when played from hand or cast by an effect. Copies, Recruit, Reborn, tokens, Transform never fire it | #12 would fill the board for 2 mana otherwise; #3, #22, #61, #69 |
| R2 | 30-turn cap unit (decide) | 30 player-turns, 15 each | Turn cap, fatigue frequency |
| R3 | Fatigue effect | Nth empty draw deals N damage to your hero | #75 replaces it; #40 exiles bottom without fatigue |
| R4 | Hand size (decide) | 10; extra draws and adds are burned to the GY | #5, #17, #94, #95 draw-your-deck |
| R5 | Lane-restricted attacks? (decide) | No; any unit may attack any enemy unit or hero | All combat; lanes only for adjacency and rotation |
| R6 | Attacking from Defense | Not allowed; switching to Attack spends the turn's exertion | #45 is the exception |
| R7 | 0-attack units | Cannot declare attacks | #1, #65.1 |
| R8 | Reborn and Death | Death fires on both deaths | #3 radiant, #81 radiant |
| R9 | Mulligan order | Draw replacements, then shuffle returned cards in | Setup |
| R10 | First player's turn-1 draw | Yes, draws | Setup |
| R11 | Tokens leaving the field | Unit tokens cease to exist when they leave the field and never enter a GY or exile. A unit-token card can sit in hand or library (Infinite Reserves, copies) and ceases to exist if it leaves that zone other than by being drawn or played, burning included. Spell tokens go to the GY like any spell. A card that has ceased to exist is in no pile and its zone says so, tagged `gone` (§10.1), so nothing can reach it again | #17, #33, #39, #75, #86, #89 (tokens never feed Corpse Eater), #93 |
| R12 | Ownership off the field | Hand, library, GY, exile always belong to the owner; control matters only on the field. The one exception: Pocket Chaos's library swap changes the owner of the swapped cards (R73) | #36, #49, #50, #52, #86, #87 |
| R13 | Stack dormancy | Cards under a Stack are not on the field except for Felinor Fiender's count | #92 |
| R14 | Silly Silas topology (decide) | Two rings (units, backrow): your lane 1→5, opponent's 5→1; a Locked destination bounces the card, and radiant bounces go to the card's owner's hand (R12); damage and buffs travel with a rotated card | #52 |
| R15 | Steal placement | Same lane if free, else first free zone; excess remain with the opponent | #36, #49, #50, #86 |
| R16 | Discard choice | Player's choice unless "random" | #80 |
| R17 | Trap timing | Sheepish fires before the Cry (Cry lost); Bear Honeypot, Unstable Clone Machine, Unlicensed Experimentation fire after the card resolves (Unlicensed Experimentation only for played permanents, R61). Sheepish on an Immutable unit still fires and is consumed with no effect | #41, #60, #33, #85 |
| R18 | "Lose health" | Not damage: no Armor, no Anti-oneshot cap, no Fed Fauci tokens | #27, #65, #98 |
| R19 | Heal targets | Fig of Life may target any unit or hero | #47 |
| R20 | Position switches from spells | Do not spend exertion | #48 |
| R21 | Random keyword pool | Taunt, Armor 1, Rush, Charge, First Strike, Poisonous, Lifesteal, Reborn, Divine Shield, Trample, Cleave; no repeats on one unit | #63, #80 |
| R22 | Radiant on the field | Base layer swaps, damage and buffs stay, Cry does not re-fire. The Saintess used to be the example that a card's own effect includes itself; her Cry is gone, so the rule is now carried by the others and by her Death, which R78 keeps her out of for the opposite reason — she is already in the graveyard | #28, #29, #49, #81 |
| R23 | Immutable scope | Blocks Vanilla, Transform (Transmogulate on the board included) and Fuse-onto on the Immutable card itself; Radiant still allowed; Prejudiced Postdoc may copy an Immutable unit because the Vanilla applies to the copy | #8, #19, #66 vs #41, #83, #85; #61 |
| R24 | Archivist and X-cost | Costs per R65 (X counts as 0, embiggen cards as their base price) for highest/lowest; ties go to the card nearest the top | #30 |
| R25 | Fib index overflow | Clamp at Fib(11) = 89 | #31 |
| R26 | Genn's Greed text (decide) | "Exile all odd-cost cards" (the source line is garbled) | #94 |
| R27 | Combo-Index details | E adds a fresh copy (radiant flag kept) of a random card played this turn to your hand; D picks 2 different random hand cards; grade S is terminal; steps run E→new grade in order | #93 |
| R28 | Call to Chaos recursion | Chain capped at 20 casts; radiant rolls "cast a random Call to Chaos" plus one of the other 9 effects | #95 |
| R29 | Zephyrs | Scorer ranks non-token Core cards except #97; Discover shows the top 3 | #97 |
| R30 | Twinspell lifetime | Stays until a spell is played, then goes to the GY | #79 |
| R31 | Field of Dreams | Replaced hand goes to the GY | #76, #72 synergy |
| R32 | Lucky on coin-stat effects | No effect where "best" is undefined | #4 |
| R33 | Face-down traps changing control | Only the current controller sees a face-down trap's identity: after a steal, board swap or rotation the new controller sees it and the previous one stops seeing it, even though ownership is unchanged. A Field Trap that has fired is face-up to both | #36 radiant, #52, #87 board swap |
| R34 | Unstable Clone Machine and tokens | Token cards are copied too, spell tokens and unit-token cards alike (R11) | #33 |
| R35 | Transmogulate | Board cards: same-type replacement in place, Field Trap counts as Trap, Immutable cards stay (R23). Other zones: any card from the pool, same counts. Replaced cards cease to exist. Pool: the §8 Legendary-rarity cards except #83, which is #52, #85, #87, #92, #93, #95; the source's #81–95 grouping no longer applies (designer, 2026-09-17) | #83 |
| R36 | Draw offers | Only the active player offers, during their main phase (the source said "at any time"); one offer per turn; a declined offer blocks that player for 3 of their turns | Draw offers |
| R37 | Unnamed X/X token | Named Bread Token, cost 0, no text | #18 |
| R38 | Corpse Eater stat source | The dying unit's current attack and max health | #89 |
| R39 | Felinor Fiender stats (decide) | Printed plus the combined Felinor stats, never below printed | #92 |
| R40 | Cast on draw and Combo | Counts as a card played this turn (a Cast, R70) | #21, #27, #90.1 with #10, #38, #93 |
| R41 | Carnivorous Cube | Cannot eat itself; must eat if able; nothing eaten → Death does nothing. Copies of an eaten backrow card go to the backrow, and copies keep the eaten card's radiant flag and `statsOverride` | #22 |
| R42 | "Destroys a unit" | A death whose lethal damage instance came from this unit, Cleave included | #32 |
| R43 | Heroic Power | The power is stored on the instance (`memory.power`, `memory.usedTurn`). At start of game every Heroic Power in either player's hand or library rolls its power, including one the mulligan returned; one created later rolls when it is created, and one that ends up in a hand or library with no `memory.power` (a bounced or reset instance, R78) rolls as it arrives. Its cost is always the power's X, never chosen by the player. Playing it pays X and activates the power once, which is that turn's use; afterwards `activatePower` uses it once per turn for X. "Recruit a card" recruits a permanent | #98 |
| R44 | My Pawn and the AI policy | Lethal = projected damage to the hero after Armor and the cap, Trample excess from an attack on a unit included, ≥ health; the trap then cancels the attack. The AI policy is the one §10.7 describes and is not restated here; it plays out the turn while the opponent is locked out | #96 |
| R45 | Multiplayer | Engine keeps players as a map and "each opposing hero" iterates; only 1v1 ships | #98, setup draw table |
| R46 | Indestructible would-destroy | A unit switches to Attack Position and loses Taunt this turn; an Indestructible Field Spell (Heroic Power) simply stays | #25r, #55r, #56r, #66, #98 |
| R47 | Lane-targeted summon into an occupied or Locked zone | Fizzles. A dying Reborn unit's zone is reserved for it (R64), so Reborn fails only if the zone was Locked meanwhile | #67, Reborn |
| R48 | Professor Curvature | Applies to cards whose current cost is 4 at play time, and only during that player's own next turn: the discount is inert on the turn it was created and on the opponent's turn in between, and expires at the cleanup of that player's next turn | #77 |
| R49 | Deft Duelist | Two exertions: one attack and one switch per turn | #45 |
| R50 | Reminisce and spell tokens | Discovers from the actual GY, so tokens there are eligible | #72, #51.1, #93.1 |
| R51 | "All enemies" | Every enemy unit plus the enemy hero, one damage instance each | #13 |
| R52 | Bread and Butter's beneficiary | The token always goes to the trap's controller, whichever player ended the turn with unspent mana | #18 |
| R53 | Forced attacks | Skip the attack validator, ignore position and sickness, spend no exertion; the target still strikes back. Each forced attack is its own combat followed by a state check, and the next forced attacker attacks only if the target is still on the field | #9, #60 |
| R54 | KY's Trial indices | Rolls 1–100 only, rerolls its own index, never a token index | #82 |
| R55 | Ceaseless Void counters | Count both players' draws, plays, destructions and exiles from the start of the game | #100 |
| R56 | Cost thresholds | "Costing 1 or less" and similar checks use the cost actually paid after modifiers | #60, #64 |
| R57 | Copy semantics | A copy of a unit on the field keeps its radiant flag, buffs, granted keywords, Vanilla state and `statsOverride` and resets damage, exertion and counters; copies shuffled into a library are fresh instances carrying only the radiant flag and `statsOverride` | #12, #22, #33 |
| R58 | Cast-on-draw chains | One draw casts at most 20 cast-on-draw cards (`CAST_ON_DRAW_CHAIN_CAP`); the next one goes to the hand uncast (burned if the hand is full) and ends the chain. A cast-on-draw card is cast even with a full hand. "Draw N" is N draws; "draw your whole library" uses the library size when the effect starts | #21, #27, #33, #90.1, #95 |
| R59 | When the state check runs | After each action, each whole effect or trigger, each cast-on-draw cast and each combat (each forced attack counts as one, R53); never between the hits of one effect. Two heroes at 0 or less in that check is a draw (designer, 2026-09-17) | #13, #86, all combat |
| R60 | Random picks | A random "becomes Radiant" pick chooses among non-Radiant cards and does nothing if none are left; a random pick of N existing cards picks N different cards, or all of them if fewer exist (designer, 2026-09-17). Cards generated from the catalog may repeat unless the card says "different"; Discover options are always different | #23, #27, #28, #54, #57, #93, #95 |
| R61 | Unlicensed Experimentation trigger | Fires only when the opponent plays or casts a permanent from hand, after its Cry (a cast is a play, R70); tokens, Recruit, copies, Reborn and Transform results never set it off. Field Trap counts as Trap, and the firing trap is neither matched nor fused onto. Immutable permanents are never chosen as the Fuse target (R23); when no legal target of that type remains, the trap fires, is consumed and does nothing, and the played permanent stays (designer, 2026-09-17) | #85 |
| R62 | Turn sequence | Refresh → start-of-turn delayed effects → start-of-turn triggers → draw → main → end-of-turn triggers (Combo-Index and "add back to hand" spells included) → end-of-turn trap window (Bread and Butter and Intern Stimmy on both sides, in R68 order) → end-of-turn delayed effects → cleanup → turn-cap check | #18, #23, #24, #31, #39, #50, #71, #78, #93 |
| R63 | Trample, Cleave and zero hits | Trample applies to any damage a Trample unit deals to a unit: the amount beyond the target's health before the hit goes to the target's controller's hero (the source's "maximum health" and "owner" are read as current health and controller). Cleave is combat-only and belongs to the attack, so it happens even when the hit on the defender was stopped. A hit whose amount is 0 before step 1 (a 0-attack unit striking back) is not a damage instance, so Divine Shield stays; a hit that is 0 after Armor and the cap emits no `damage` event and triggers nothing. A Trample source's damage to a unit counts only up to the unit's health and the rest is the Trample instance, so Lifesteal heals the total once. Poisonous only affects units | #32, #63, #80, #91 |
| R64 | Summon placement and Reborn | A summon with no named zone takes the leftmost empty, unlocked zone of its row, and "fill your board" summons into every empty, unlocked unit zone left to right. A unit collected with Reborn reserves its zone until it returns, and nothing else may enter that zone meanwhile | #3, #12, #15, #22, #62, #69, #81 |
| R65 | Cost calculation | Start from `costOverride`, else the printed cost (Ceaseless Void's computed cost, the chosen embiggen price); add `costMod`; add player discounts; apply Professor Curvature if the result is then 4; floor at 0. Outside play (library, hand, GY, pools, filters, comparisons) an embiggen card's printed cost is its base price and an X-cost card's is 0. An X-cost card being played costs exactly X: `costMod` and discounts don't change it, and a `costOverride` makes it free while X is still chosen up to current mana. Heroic Power's X is its power's X (R43) | #7, #31, #35, #54, #77, #78, #100 |
| R66 | Genn's Greed costs | Both the 2-cost draw and the odd-cost exile read each card's cost per R65 at resolution; X-cost cards are exempt from both | #94 |
| R67 | KY's Math Equation cost | Fib index = printed cost + `costMod` + 1 (radiant + 2); player discounts and the cost paid are ignored | #31 |
| R68 | Trigger order | Delayed effects due now resolve at their R62 point (at start of turn before any trigger; at end of turn after the trap window), in the order they were created. Other triggers: the active player's cards, then the opponent's; within a side, unit zones by lane 1–5, then backrow by lane 1–5, then hand triggers in hand order, then graveyard triggers (the `returnToHandAtEndOfTurn` spells) in graveyard order. Death triggers use the same side and lane order (§4.5) | All triggers |
| R69 | Indestructible at 0 max health | An Indestructible unit whose max health falls to 0 or less (Suppressive Aura) is collected like any other unit, because no destroy effect is involved: it dies, fires Death, may Reborn and counts toward Ceaseless Void's destroyed counter (Hearthstone). An Indestructible unit at 0 or less health whose max health is still above 0 (damage taken before it became Indestructible) stays | #25, #46, #55, #56, #66 |
| R70 | Cast | A cast is free and counts as a play for every rule that counts or reacts to plays, with cost paid 0 (Combo, Quickstriker, Unstable Clone Machine, Gifted Program, Bear Honeypot, Ceaseless Void); it fires the card's Cry or spell script; the caster picks its targets and modes. A cast never uses a cost discount, since it pays nothing, but a cast Spell does use Twinspell's Echo | #21, #27, #90.1, #95 |
| R71 | Recycling Initiative | At end of turn it copies every other card played this turn, including cards played after it | #39 |
| R72 | Exile and missing health | "Cards in exile" means your own exile pile; missing health counts from 30 even when the hero has more | #40, #70 |
| R73 | Pocket Chaos swaps | Health: the two values swap and armor stays. Board: zone contents swap lane by lane, locks stay with their zones, control changes, ownership doesn't, and a face-down trap stays face-down but is now readable by its new controller only (R33). Libraries: contents swap, and each swapped card's owner becomes the player whose library now holds it (the exception in R12); fatigue counters stay | #87 |
| R74 | Radiant model | The five §5.2 bullets: an instance flag that is never unset, the in-hand swap, the on-field layer swap without a Cry, copies and generated Radiant cards, and cards with no radiant form still setting the flag | All cards |
| R75 | Catalog data corrections | The §5.3 table: missing set and types filled in, `~~` read as `~~~`, #68 is a Unit, #90.1 is CN-Virus, #29 keeps cost 6, header typos normalised | #2, #12, #15, #16, #29, #31, #34, #51, #66, #68, #86, #90.1, #99, #100 |
| R76 | Kpop Fanatic's delayed steal | Fires at your next start of turn even if Kpop Fanatic has died; fizzles if the target has left the field or is already under your control | #50 |
| R77 | Fuse | Fuse creates a transient definition. Its base form sums the ingredients' base attack and health, unions their base keywords and tags, and concatenates their base scripts; its radiant form does the same with their radiant forms. Its cost is min(sum of the printed costs per R65, 4). Its type is the target's, or the ingredients' shared type when there is no target on the field (Field Trap if any ingredient is one). Radiant Unlicensed Experimentation fuses the played permanent onto each matching permanent separately, one fusion at a time. One ingredient may be a target already on the field: the result then keeps that instance, with its zone, position, damage, exertion, summonedTurn, counters, memory and radiant flag, and only the other ingredients cease to exist, without a Death trigger and without counting as destroyed. The result's buffs are the sum of every ingredient's buffs and its granted keywords their union; every other field of the kept instance is unchanged, `statsOverride` and the Vanilla flag included. A fused trap has every ingredient's trigger condition, runs only the script whose condition was met, and is consumed unless it is a Field Trap. Craft a Card fuses two or three cards with no target on the field, and its result is a fresh, non-Radiant hand card with `costOverride` 0 | #85, #99 |
| R78 | Leaving the field | Leaving the field resets an instance's damage, buffs, granted keywords, Vanilla flag, counters, memory, exertion, position, summonedTurn, `statsOverride`, `tauntSuppressedTurn` and controller; `costMod`, `costOverride` and `radiant` persist in every zone. Effects that react to a card leaving (Death, Corpse Eater, Carnivorous Cube's meal) read its last-known state from just before it left. A Reborn unit returns reset, at 1 health, without Reborn | #3, #22, #31, #37, #54, #72, #81, #89 |
| R79 | Match lifecycle defaults | Server config: turn clock 75 s, disconnect grace 60 s, hard match ceiling 60 minutes, room codes of 6 characters from the invite-code alphabet, Elo ratings with K = 32 starting at 1000. The turn clock belongs to the active player and pauses while a prompt is open for the non-active player (a trap firing on the opponent's turn), which runs its own prompt clock of 30 s. `timeout` answers only the prompts of the player whose clock ran out, using the AI policy, and ends the turn only when that is the active player. `disconnectExpired` is a loss; reaching the ceiling is a draw | Match lifecycle |
| R80 | Library cap | A library holds at most 60 cards (`LIBRARY_CAP`); a card that would be shuffled into a full library is not created, and an existing card goes to its owner's graveyard instead, or ceases to exist if it is a unit-token card (R11) | #33, #90, #90.1 |
| R81 | Play-time choices | Zone, X, embiggen, Tribute and the targets and modes a card's script declares travel in the `play` action, which `legalActions` enumerates; the client builds them with the prompt pickers. A declared `hand` or `zone` pick travels in `targets` and a declared `direction` pick in `modes`, so Glowy Jelly Bean's hand card and Silly Silas's direction are chosen with the play and never pause resolution. Every choice made during resolution (Discover, chained steps, Echo repeats, casts, triggers, mulligan) opens a `PendingChoice` | #2, #17, #22, #24, #26, #30, #46, #48, #52, #55, #59, #66, #74, #84, #87, #88 |
| R82 | Automatic turn end | A turn ends by itself when the active player's only legal actions are ending the turn, conceding and offering a draw; the engine emits `turnAutoEnded` and ends the turn. A draw offer does not hold the turn open, so a player with nothing else to do cannot offer on that turn (R36) | Turn loop |
| R83 | Reborn re-entry | A unit that returns through Reborn enters the field again and takes that turn as its `summonedTurn`, so it is summoning sick exactly as a unit summoned this turn is: with neither Rush nor Charge it cannot attack at all for the rest of that turn, Rush lets it attack a unit and Charge lets it attack a unit or the hero (§4.1). A second attack in that turn follows the same enumeration rather than a rule of its own: the attack validator checks the spent exertion first and the fresh `summonedTurn` after (`isSick` and `whyCannotAttack` in `combat.ts`), so a Reborn body with neither keyword cannot attack again because it is sick, while one the board has granted Rush (#14 Jlockeed's Weapons) or Charge may attack again within that keyword's limits. R78 has already cleared its exertion, so it may still switch position that turn, exactly as a unit summoned that turn may. A unit that returns during the opponent's turn attacks freely on its controller's next turn | #3, #81r, any granted Reborn (R21) |
| R84 | What the AI policy never picks | The policy of §10.7 and R44 never picks `concede`, `offerDraw` or `answerDraw`: those three are always on offer, so a literal uniform draw would have My Pawn resign or draw the game it is playing out, and §10.7's uniform draw and its 0.1 end-turn rule both read on the set with these three removed. The skipped set is a named constant (`AI_SKIPPED_ACTIONS`), and the engine's own random-game harness and fuzz runs use the same one, so a fuzz game ends by hero death or the turn cap rather than by a conceding robot | #96, §10.7 |
| R85 | Lifesteal stated by an effect | §4.4 step 8 reads Lifesteal off the source's keywords, but an effect whose own text says its damage has Lifesteal heals its controller's hero all the same, without granting the source the keyword. The heal is the amount actually dealt, so Armor, the Anti-oneshot cap and R63's zero rule apply to it exactly as they do to the hit | #93 grade A |
| R86 | Pools of cards played this turn | A pool built from the cards a player played this turn skips instances that no longer exist — a unit token that left the field (R11), a card that ceased to exist — rather than fizzling at random on them. A card that merely moved zone is still in the pool | #93 grade E, #39 |
| R87 | Call to Chaos details | The radiant pair resolves in the order §8 writes it: the recursion and its whole chain first, then the effect drawn from the other nine. A roll that lands on the recursion once the chain is at `CALL_TO_CHAOS_CHAIN_CAP` resolves into nothing and no substitute effect is rolled, so a radiant Call at the cap runs only its partner. A card cast from no zone is generated from the catalog and goes to the caster's graveyard when it resolves (§10.5 step 7), so a long chain does feed Gravedigger and Reminisce; a cast Spell never feeds Corpse Eater, which reads unit deaths only (§8 #89, R38). "Draw your whole library" reads the library size when the effect starts (R58), so an empty library draws nothing and takes no fatigue | #95 |
| R88 | A whole-board move into a closed zone | R14 rules that a rotation bounces a card whose destination is Locked to its owner's hand; a board swap (#87) does the same, and so does any other effect that moves a whole board at once. A zone reserved for a dying Reborn unit (R64) counts as closed the same way. The bounce is an ordinary return to the hand: R78 resets the instance, the hand cap applies (R4) and a unit token ceases to exist (R11) | #52, #87 |
| R89 | What a death tells a trigger | R78 resets an instance as it leaves the field, and every trigger but the Death hook is queued and runs after that, so the `destroyed` event carries what the card was: its owner, its attack and max health as the layers computed them at the moment it died, and `killerId`, the unit whose damage instance was lethal (R42), or null. A Death hook still reads the whole snapshot (R78); every other trigger reads the event | #32, #89 |
| R90 | Validating a play's choices | The engine checks the choices a play carried against what the card declared and what the board allows, so a client can never name a card it may not see or reach: a unit pick offers the top of a Stack pile and never a dormant card (R13), a hand pick offers only the chooser's own hand (§9.1), and a card that declared nothing takes nothing. Several declarations read the flat `targets` list in order, each taking its own minimum, so a card that asks twice asks for a fixed number each time and the last declaration takes the remainder. One declaration may not pick the same card twice, and each declaration is checked on its own, so two different declarations may both name the same card. A declaration the board cannot satisfy does not refuse the play: the play is legal with the answers that exist and the effect fizzles on resolution (§8's conventions). `legalActions` enumerates every legal combination, bounded by `MAX_CHOICE_COMBINATIONS` | #2, #17, #22, #24, #26, #30, #46, #48, #52, #55, #59, #66, #74, #84, #87, #88 |
| R91 | Switching to the position a unit already holds | Does nothing: no error, no event and no exertion spent. §4.1 describes a flip, and 5pek Controller's "switch every unit" (#48) reaches units already in the position it would set | #48, #65.1 |
| R92 | Only a card on the field has a position | A card dormant under a Stack, or off the field, cannot be switched at all, the same way R13 stops it being attacked | #92 |
| R93 | A First Strike unit strikes once | §4.3's step 1 is when its strike happens, not an extra one: each unit deals its damage once per combat, and First Strike only moves **that unit's** strike earlier — on whichever side of the combat it is, since §6.1 says "deals damage before non-First-Strike units" without naming a side. A defender with First Strike therefore hits a plain attacker first and takes nothing back if that attacker falls: #20 Pointmaster, a 7/2, kills a 3/3 that attacks into it and survives. Two First Strikers trade in step 1 | §4.3, §6.1, #11, #14, #20 |
| R94 | Attack values are read once per combat | Both units' attack is read at the start of the combat, which is what makes the simultaneous step simultaneous (R59). A First Strike survivor is struck back with the attack the defender had before the hit landed | All combat |
| R95 | Where Cleave lands | Cleave rides the attacker's own hit, immediately after it, never the defender's strike-back, and a hero target cleaves nothing, since no unit is adjacent to a hero (§4.4 step 10, R63) | #32 |
| R96 | A forced attacker that is already gone | It is skipped in silence, with no `attackDeclared`, and the sequence also stops once the game has a result — R53 states only that it stops when the target is gone | #9, #60 |
| R97 | Hidden information in the event stream | A view's event list is redacted, not truncated: an event that names a card the viewer may not read keeps its type and every field the animation table needs (§10.10) and shows the sentinel `"hidden"` in place of that card's `instanceId` and `defId`. Readability is judged by where the card sits **now**, not where it was: in a library never, in a hand only for its owner, in the backrow by §10.8's trap rule, and anywhere else public. So a card drawn last turn and played this turn reads openly in both events, and a unit bounced into the enemy hand stops reading the moment it lands. `shuffledIn.position` is blanked for both players, since §9.1 makes library order hidden without qualifying by player `trapFired` is the one exception: its `instanceId` and `defId` are keyed to the trap's **controller** rather than to the card's current zone, because firing the trap consumes it into a public graveyard and the event is what animates the flip (R154). The identity is not thereby concealed — the graveyard shows it — the event simply does not name it. | All hidden zones |
| R98 | A card that asks a question while it resolves | It is still itself: the resolving zone (§10.5 step 4) is searched like any other, so a continuation resumed after the prompt finds the card as `ctx.self` with its counters, its X and its radiant face, and a step that says "this unit" means the card that asked. A card that has left the resolving zone before its own prompt is answered resumes with no self, and a step that needs anything about the card must have captured it in `resume.data` | #22, #26, #74 |
| R99 | A trap's condition | A trap fires when its trigger's `on` matches the event **and** its `when` predicate admits it. The predicate is separate from the effect list on purpose: R61 makes `run` returning nothing mean "fired, consumed, did nothing", so a trap whose condition simply was not met cannot say so through `run` and would be spent by an event it should ignore. With the predicate satisfied, an empty effect list still spends the trap (R61). A trap that declares no predicate answers every event it names, whichever side caused it | #52, #56, #67, #85 |
| R100 | The trap window's events are its alone | An event the §2.2 end-of-turn trap window is scheduled to deliver is not also offered to the immediate trap check, so a `turnEnded` trap fires once per turn end rather than twice. R62's order for the end of a turn is therefore exactly end-of-turn triggers, then the window (active player's traps, then the opponent's), then delayed effects, then cleanup | #52, #62 |
| R101 | Paying a Tribute | The tributed set must meet the printed X and be minimal — no unit could be dropped from it and still pay — because the Sheep Token counts 2, or 3 Radiant (§3.2, §7) makes overshooting unavoidable while wasted sacrifices are not what "sacrifice X" asks for. Unlike a target, a Tribute the board cannot pay makes the play illegal rather than fizzling on resolution (message `<name> needs Tribute N`), and only a card that says so may tribute the opponent's units | #55, #66 |
| R102 | What a Fuse composes (extends R77) | The fused def is built member by member, so nothing about an ingredient is silently dropped. Stats sum; keywords dedupe; tags union literally, so a `Token` tag can outlive `token: false`. Identity: `token` only when **every** ingredient is one, rarity the rarest, name `"A + B"`, text both texts joined, index the generated `t-<n>` id. Cost is the capped sum of the printed costs and any ingredient `cost` hook is dropped, so R77's cap wins over a cost-rewriting hook. Type is the target's, else the shared type, else the first ingredient's, promoted to `Field Trap` only when the result is already a trap type and some ingredient was one. Scripts concatenate by shape: hooks into one hook returning both effect lists, arrays appended, `staticFlags` OR'd with `tribute` taking the **max** rather than the sum, layer-2 `setStat` summed, declared `targets`/`modes` (R81) concatenated in ingredient order, and `resume` step tables merged so a step name both ingredients use runs both. Triggers concatenate with ids namespaced `<ingredientDefId>:<id>`, each keeping its own `on` and its own R99 predicate, so a fused trap holds every ingredient's condition and only the one that fired runs. A Fuse into a hand (Craft a Card) consumes its ingredients too, and every consumed ingredient ceases to exist per R86 — no graveyard, no Death trigger, no destroyed counter. The whole verb does nothing at all, leaving state untouched, with fewer than two ingredients, with an Immutable target (R23), with a target that is not on the field, or with neither a target nor a destination hand A Fuse with several targets resolves its ingredients **once** and reuses those same resolved instances for every fusion: an ingredient that has ceased to exist is held by no pile at all (R86's `gone`), so it contributes only its definition and cannot be found again by id. That is what lets radiant #85 fuse one played permanent onto every matching permanent in turn, and why the repetition belongs inside the one effect rather than in a card looping over it. | #85, #99 |
| R103 | The Heroic Power surface (extends R43) | The seven stored power names are `recruit`, `draw`, `ping`, `burn`, `rush`, `felinor` and `discover`; they are state, so they stay stable across versions. A Heroic Power that has not yet rolled costs 0, and the printed `X` is answered by the card's `cost` hook rather than by a special case in the cost rules. Once-per-turn is checked **before** mana, turn and phase, so a player who has already used the power is told that and not that they cannot afford it, and the use is marked before the effects run, so a power that pauses on a prompt cannot be spent twice. "Discover a Unit" adds the pick to the hand, Radiant when the power is. A ping reaches any unit or hero on either side, taking its target from the action (R81) when one is given and prompting otherwise. A power that summons a token resolves it by catalog index and fizzles in silence if that token is absent | #98 |
| R104 | The code alphabet, written out | `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`. §9.4's "32-symbol alphabet without 0, O, 1, I or l" cannot be met as written: removing `0`, `1`, `I`, `O` and `L` from the 36 alphanumerics leaves 31 symbols, not 32. Codes are therefore upper-case only and drop `0`, `1`, `I` and `O`, which leaves exactly 32, so a 16-character code carries exactly 80 bits and a 6-character room code 30. A lower-case `l` cannot occur because input is normalised to upper case before it is read | §9.4 |
| R105 | Catalog version format | A short opaque string stamped on every `cards` row and mirrored in the server's settings; the Core set is `core-1`. §9.5 requires a version and a rejection when it is stale but never says what a version looks like, so nothing may parse or order it — it is compared for equality only | §9.4 |
| R106 | Circuit-breaker threshold and window | 100 failures system-wide in 600 seconds opens the breaker. §9.8 asks for "a threshold in a window" and names neither number | §9.4, §9.8 |
| R107 | The constant-time failure floor | Every redemption response is padded to 250 ms, which is what makes §9.4's "identical time" for a wrong and a revoked code observable rather than aspirational. It is a server responsibility: SQL alone cannot deliver it | §9.4 |
| R108 | Sweeper and reaper cadence | The sweeper runs every 3 seconds (§9.5's "every few seconds") and the reaper every 30 | §9.5 |
| R109 | Action-flooding limits | 5 actions per second per match and 300 requests per minute per account. §9.8 requires both limits and names no numbers | §9.8 |
| R110 | Room-code reuse | A room code is unique among matches that are not yet `over`, so a finished match releases its code back into the pool rather than burning it for ever | §9.5, R79 |
| R111 | The launch grant | Becoming `active` grants one copy of every non-token card, written by a trigger on the `pending → active` transition and idempotent, so a repeated redemption cannot double a collection | §9.4, §9.5 |
| R112 | A match the reaper resolves | The reaper finishes a stuck match itself rather than flagging it for a server that may be the very component that crashed. The consequence is deliberate and visible: a reaper-resolved ceiling draw records `turns = 0` and leaves both ratings unchanged, where the same draw resolved by a live match actor records the real turn count and applies the ordinary Elo move | §9.5, R79, R2 |
| R113 | The order paused sequences resume in | `state.work` is neither a plain queue nor a plain stack, because both give a wrong answer. When a scope pauses it parks its remainder at `workCursor` and advances the cursor, so the sequences parked by one pause land innermost-first; taking an item resets the cursor to 0, so a pause that happens *during* a resumption is inserted ahead of everything still owed. A Cry's parked tail therefore runs before the play steps that follow it (those steps come after the Cry, not inside it), while a prompt opened inside that tail runs before both. Resuming an item resolves its `hook` against the engine's sequence handlers **and** the card's script table, and **raises** when neither knows it: a work item that cannot be resumed is a lost sequence — a Spell that never reaches the graveyard, an Echo repeat that never happens — and must never be dropped in silence | §9.3, §10.5, §10.6 |
| R114 | Trample into a unit with no health left | A Trample source's hit on a unit already at 0 or less health deals nothing to that unit: no `damage` event, no on-damage trigger, no Poisonous mark and no Lifesteal off it, exactly as R63's zero rule. The whole amount becomes the step 9 Trample instance on the target's controller's hero, where Lifesteal heals it once, so the total healed is unchanged (§4.4 step 5, R63) | #21, #32 |
| R115 | Vanilla and a card's own projected text | Vanilla clears a card's scripts, and both an aura and a set-stat hook are scripts, so a Vanilla'd permanent stops projecting its aura at §10.4 layer 5 and stops setting its own stats at layer 2, keeping its printed face. It still *receives* aura grants from other cards, because another card's aura is that card's text and not this one's | #92, all auras |
| R116 | What a set-stat hook returns | A delta, not a total: §10.4 layer 2 **adds** the hook's result to the printed face of layer 1, each component floored at 0, before layer-4 buffs and layer-5 auras. Returning an absolute total would double-count the printed stats, and a Fuse sums its ingredients' `setStat` returns (R102), which only composes for deltas. The hook measures other units at layers 1 to 4 (printed plus permanent buffs, before auras), which excludes layer 2 itself, so two set-stat cards on one board never read each other and the layers cannot recurse | #92 |
| R117 | Who owns a paused sequence's remaining steps | A sequence owes its remainder to `state.work` only at the moment it pauses, never in advance. While its driver is on the stack those steps belong to the driver alone, so a resolution loop running *inside* one of them — §10.5 step 4's own `settle`, which drains work before popping a trigger — can neither take nor re-run the steps it is standing in. Pre-parking the remainder makes a played card's Cry fire twice. R113's order follows from this rule rather than being separate: the tail parked by the pausing step lands ahead of the sequence's own remainder | §9.3, §10.3, §10.5, R1, R113 |
| R118 | A trap's prompt does not eat the play's Cry | A trap that interrupts a play resolves to completion first (§10.3), and the play then resumes at the step after the one that paused, so the Cry still fires — exactly once (R1). R17's "the Cry is lost" applies only where the trap has taken the card off the field, as Sheepish does, which the resolving check already covers | #41, #85, all Cry units |
| R119 | A permanent does not answer its own arrival | A permanent whose trigger watches card plays does not fire on the play that put it onto the field: it starts counting from the next play. This is a deliberate exclusion, not a consequence of timing — §10.5 step 4 places the card **before** it emits `cardPlayed` and only then runs the resolution loop, so the arriving card is already a registered watcher when §10.3 dispatches its own arrival, and something has to take it out. For traps the engine does it, in `traps.ts`'s `isOwnArrival`: a trap is never offered the `cardPlayed`, `summoned` or `cardResolved` event naming the trap itself, which is where R17's two moments both land, and a trap is itself a card someone plays. A permanent that is **not** a trap gets no such filter and owes the check inside its own trigger, comparing the event's `instanceId` against `ctx.self` — #33 does this and #38 did not, which is the divergence this row was rewritten to settle. A granted Combo answers by ordering instead: §10.5 step 5 resolves `quickstriker` and `comboDraw` before the played card's own `cry`, so a card that installs such a modifier has not installed it yet when its own play is counted | §10.3, §10.5, R17, #33, #38, #78 |
| R120 | An "Also" clause stands on its own | §8's conventions make a sentence beginning "Also" an independent clause, so it resolves even when the clause before it did not. A Transform refused by an Immutable target (R23) therefore still delivers the rest of the card's text, and the trap is still consumed (R61) — the refusal is not a fizzle of the whole card | #41, #53 |
| R121 | A forced attack is declared by the effect, not the player | §4.2 and R53: a forced attack skips declaration steps 1 to 3, spends no exertion, and may happen on the compelling player's own turn, so it is not "the opponent declaring an attack". The `forced` flag on the event exists for exactly this distinction, and a trap or trigger keyed to an opponent's declaration does not arm on one | #9, #60, #96 |
| R122 | Who continues an interrupted sequence | The action that answers a prompt finishes what the prompt interrupted: `answer` re-enters the step its `resume` names and then drains `state.work` in R113's order, stopping at the next prompt, which parks its own tail. The state check and the trigger queue stay with the resolution loop, which drains again and finds nothing owed. So a sequence is completed by the action that answered it and never by whatever happens to run next — which matters for any caller driving the engine directly rather than through the reducer, since otherwise a Spell stops short of its graveyard | §9.3, §10.5, §10.6, R113 |
| R123 | How a declared Tribute travels | A `tribute` declaration is two things at once. Its chosen permanents travel in `targets`, like every other declared pick, which is where the script reads them (#22 reads `ctx.targets[0]`). Its `amount`, when it has one, is §6.3's Tribute **cost**, which travels in the play's `tributes`, counts a Sheep Token as 2 (§3.2) and refuses the play outright when the board cannot pay it (R101). A card that declares both therefore names its units in both lists, and `legalActions` enumerates them that way | #22, #55, #66 |
| R124 | Hero Armor from several sources | It adds up. §4.4 step 2 says "hero uses Going Long's value" in the singular because one copy is the ordinary case, but §6.2 already makes Armor stack (printed + Defense +1 + auras), so a second granting card contributes like any other layer: two Going Longs paid 2 give the hero Armor 4, plus any Armor written on the hero itself. This is the opposite of the Anti-oneshot cap of step 3, which takes the smallest cap any such card provides, because a cap is a ceiling and Armor is a reduction | #84, #73 |
| R125 | Armor and fatigue | Fatigue (§2.4, R3) is an ordinary damage instance on its own hero, so it takes the whole §4.4 pipeline including Armor and the Anti-oneshot cap — the same treatment §5.3 already gives CN-Virus's damage to its own controller. Only "lose health" bypasses the pipeline (R18). So a hero behind Going Long draws through the early fatigue steps unharmed, and the escalating Nth-draw damage is what eventually beats the Armor | #84, #90 |
| R126 | Which `Script` key a delayed continuation lands on | A delayed effect is re-entered exactly the way a prompt answer is: `resume.hook` names a key of the card's `Script`, which may be a hook (`delayed`) or the step table (`resume`, where `resume.step` picks the entry), and the engine resolves **both** shapes through one reader. §10.6 never said which, so the two readers in the engine disagreed and three cards each guessed differently — a card whose continuation sat only in `resume` resolved to nothing at all, with no error. A card must never have to register one continuation under two keys | #39, #50, #78 |
| R127 | A continuation with no instance still resolves | A parked continuation names its script by stored def id, so it re-enters even when the instance is gone — with `ctx.self === null`, and whatever the step needs carried in `resume.data`. Dropping such an item would silently lose a sequence, which R113 forbids; a delayed effect scheduled by a Spell that has since left play is the ordinary case, not an error | #39, #50, #78 |
| R128 | Hero order in a two-sided sweep | An effect that hits every unit and both heroes resolves the units in R68 order, then one damage instance per scoped side's hero in that same order. The target list is fixed when the effect begins, so a unit summoned by an earlier hit in the same sweep is not struck and one destroyed by it is still struck (R59: the state check waits for the whole effect) | #13, #17, #88, #100 |
| R129 | A fizzle takes no randomness | An effect that finds nothing to do draws no random numbers, so `rngCursor` never depends on the board at that moment. This is what lets a replay stay in step with a game whose boards diverged only in ways the effect ignored, and it is why a whole-hand discard is its own verb rather than a random discard repeated by hand size | #76, §10.7 |
| R130 | Lucky X needs a better outcome to improve (extends R32) | R32 already rules that Lucky has "no effect where best is undefined"; this records why that matters mechanically. A re-roll draws again, and `rngCursor` is part of state (§10.7), so a Lucky that rolled twice and then discarded a draw would desynchronise a replay against a game that never had Lucky at all. So a verb either offers Lucky or does not, and a coin paying on both faces takes exactly one draw per coin (R129) | #4, #23, #42 |
| R131 | Felinor Fiender never counts itself | Not even when Fuse has given it the `Felinor` tag (R77 unions an ingredient's tags): "all your Felinors" means every **other** Felinor you control, matched by instance rather than by tag. And because layer 2 reads each Felinor's layer-4 stats (R116), a second Felinor Fiender contributes only its printed and buffed stats and never its own layer-2 total — the layer cannot recurse | #92 |
| R132 | Where R39's floor applies | The "never below printed" floor of R39 applies to the combined total of each stat separately — not per Felinor, and not to the two stats together. So a Felinor carrying a negative permanent buff can pull the attack sum toward 0 without touching the health sum, and neither sum can go below 0 | #92 |
| R133 | A card played twice in one turn is one entry in a play pool | `turnLog.playedIds` records one entry per play, so a card played, bounced and replayed appears twice. A random pick over "a card you played this turn" weights it once: the pool is the set of cards played, not the list of plays. R86 already drops an id whose card has ceased to exist | #93, #39 |
| R134 | A grade counter through a change of control | Combo-Index's grade stays on the instance when control changes (#87's board swap, #36 radiant, #49), and its end-of-turn check then reads its **current** controller's turn log. The counter is the card's, the threshold is the controller's | #93, #87, #49 |
| R135 | The order Genn's Greed exiles in | Library, then hand, then graveyard — the order §8 names — and each card is its own exile, so R55's counter moves once per card and anything watching an exile sees them one at a time rather than as a batch. The draw clause runs first, so a card drawn by it is never exiled by the same play | #94 |
| R136 | A per-script event window | A card that asks "what did I just do" reads only the events its own script emitted, not every event of the action. Without that window a second copy of a card, or a trap firing mid-action, feeds the first card's own condition. The context therefore records where the script's events begin | #24, #31, #33, #38 |
| R137 | The scope of the action flood limit | Per seat, not per match. §9.8 asks for "a per-match rate limit" and R109 names 5 actions per second, but a single shared counter lets a flooding player spend the **opponent's** budget so the victim's legitimate clicks are refused — turning an anti-abuse limit into the abuse. Each socket therefore gets R109's allowance, the match's aggregate ceiling is twice it, and neither player can consume the other's | §9.8, R109 |
| R138 | A cast permanent with no zone to enter | A cast cannot be refused the way a play can (R70), so a cast permanent that finds no free unlocked zone of its row (R64) still counts as played and still resolves its script; the card is then in no zone, and §10.5 step 7 sends it to its owner's graveyard. It never becomes a summon that "fails if there is none" (§6.3), because it was played | §6.3, §10.5, R64, R70 |
| R139 | Once per turn across a turn boundary | "Once per turn" is stored as the turn number the ability was last used on, so it is spent only while the game is still on that turn. A player asking about the ability on a later turn is therefore told whose turn it is, not that the ability is spent: R103's priority puts the per-turn limit ahead of mana, turn and phase, but the limit has already lapsed by the time the turn check could lose to it | #98, R43, R103 |
| R140 | A Stack card played with no named zone | It still takes the leftmost empty, unlocked zone (R64). Stack lifts the occupancy refusal only for a zone the play **names**, so a full row refuses a zone-less Stack play even though every lane would accept a named one. The asymmetry is confined to the convenience path; a named zone answers the same in both directions, which is what R81 and R90 govern | §3.2, #92, R64 |
| R141 | L5 is never a sole failure | With R111's launch grant of one copy of every non-token card and a one-copy limit, no loadout can break L5 without also breaking L3, L4 or L6: using more copies than are owned requires a second copy of a card, a Token, or an id outside the catalog. A test for L5 therefore asserts it alongside the rule that made it reachable | §9.4, R111 |
| R142 | Where R110 is verified | R110's reuse is not observable from a client, because nothing lets a caller ask for a specific room code. It is proved by a server test that mints a code, finishes its match and re-mints the same code; the end-to-end suite asserts only the consequence — once the match is `over`, both players' in-match state is cleared and both are queue-eligible | §9.5, R110 |
| R143 | Who chooses a match's seed | The server mints it; a client never supplies one. In end-to-end mode the room and queue endpoints accept an optional seed and use it verbatim so a networked spec can be seeded, and outside that mode the field is rejected. §9.3 makes `(seed, log)` the truth without saying who picks the seed, and BUILD requires every spec to set one, so the exception is confined to the test mode | §9.3, §9.5 |
| R144 | Fixture accounts are reseeded per run | In end-to-end mode the server reseeds its fixture accounts and invite codes at boot, so a spec that activates the pending account or spends an invite code is repeatable. Without this the invite-gate spec passes once and fails on every later run, which is indistinguishable from a regression | §9.4 |
| R145 | The scope of the identical error | The identical redemption error covers every outcome that depends on the **code** — missing, revoked, expired, exhausted and malformed. A refusal that depends on neither — R106's circuit breaker, which depends on the service — is its own 503 and is not covered by the identical error either, from whichever breaker answers it. Outcomes that depend only on the caller's own account, such as already active, banned or an unverified email, are reported distinctly, because they leak nothing about the code space. §9.4 names only the first three, and this settles the rest on the same principle | §9.4, R107 |
| R146 | Seat attribution for a lifecycle result | A result that ends a match is stamped with the seat it belongs to rather than whoever happened to be active, so folding the log never has to guess: a disconnect timeout belongs to the player who disconnected, because the loss is theirs, while reaching the turn ceiling belongs to neither and is stamped with the active seat as a convention. R79 makes the ceiling a draw and R112 covers the reaper's version; neither settles the seat | §9.5, R79, R112 |
| R147 | A grace window cannot be extended | A second disconnect grace starting before the first is cleared keeps the first deadline, so a socket that flaps cannot extend its own grace indefinitely and stall the match | §9.5, R79 |
| R148 | WebSocket close codes | 4401, 4403 and 4404 are private-use mirrors of the HTTP statuses the REST side returns for the same three refusals, with 1011 for an internal fault, so a client reuses one table. Every refusal answers with the same error code and only the close code varies, which is what §9.1 requires — a socket learns that it may not have this match, never which check said so | §9.1, §9.2 |
| R149 | Room-code collision retries | A room code is minted by retrying a bounded number of times against the codes still in use and then reporting that no code is available, rather than retrying without limit. R110 settles code reuse; this settles the mint | §9.5, R110 |
| R150 | Where a stat floor lives in a summing read | A read that sums other units' stats must not floor each contributor at 0 before adding, or a negative buff contributes nothing instead of pulling the total down, which is what R132 requires. The layer-4 reading has no per-unit floor, so the summing read must not invent one; a floor belongs where the value is finally used — on the combined total for R132, and at the point of display for a card's own stats | #92, R39, R116, R132 |
| R151 | When a Heroic Power rolls | A Heroic Power rolls its power as it **arrives** anywhere a card can be looked at — the opening hand, a draw, a return from the graveyard — not only at the start of the game. R43 says it rolls as it arrives, and a copy that reached a hand some other way would otherwise carry no power and cost 0 for ever | #98, R43, R78 |
| R152 | How long an AI turn lasts | The lockout that hands a turn to the AI policy is cleared at the end of the turn it was set for, not at that player's next turn start. §8 says "until end of turn", and clearing it later leaves a player locked out of a turn that is no longer the one the effect took | #96, R44, R84 |
| R153 | Which hooks a card answers from each zone | **This row is the trigger registry and nothing else** — `triggers.ts`'s `cardsInTriggerOrder` and `triggerHoldersWithHook`, which serve §10.3's event triggers and exactly three hooks: `startOfTurn` and `endOfTurn`, queued in R68's order (§6.2, R62), and `onPlayHook`, enumerated in the same order at §10.5 step 3. Within that registry: on the field or in the backrow a card answers its `triggers` and all three of those hooks; in a hand only its `handTriggers` (#89) and no hook at all; in a graveyard only the `endOfTurn` of a Spell its own play flagged `returnToHandAtEndOfTurn` (R155), so no `triggers` and no other hook (#23, #24, #31); in a library, in exile, in the resolving zone, or dormant under a Stack it registers nothing (R13). `aura` and `setStat` are field-and-backrow for the same reason, though §10.4's layers read them off the board rather than queueing them. A hook the zone does not register does not fire from it, which is the bug this row fixes: a Field Spell held in hand was taking a turn and summoning tokens onto a board it had never been on (#58), and #64 made a play Radiant from a hand. **The registry is not the whole of a script**: four hooks reach a card at their own moment, are never registered, and this row neither grants nor withholds them — `startOfGame`, which §2.1 step 4 runs over both players' hands **and libraries**, so a library card does answer that one and R43 is not narrowed here (R151); `cry`, which §10.5 step 5 runs on the Spell in the resolving zone or on the unit step 4 has just placed; `death`, which §4.5's state check runs off the snapshot of the card as it left the field, so it belongs to no zone at all (R89); and `activate`, which nothing dispatches today — it is in the `Script` type and in `TRIGGER_HOOKS`, one card exports it, and `activatePower` applies #98's power directly without running it (R103), so no zone rule can be read off its absence. The readers that are not triggers at all — `cost` (R55, R65, R103), `staticFlags`, `targets`, `modes`, `resume` and `delayed` — are answered wherever the card is | §10.3, §10.5, #23, #24, #31, #58, #64, #89, #98, R43, R103, R151, R155 |
| R154 | What a `trapFired` event carries | The trap's `row` and `lane` alongside its controller, so a client can point at the zone that flipped without being told which card it was. Its `instanceId` and `defId` follow §10.8's redaction (R97): the controller reads them and the other player reads the sentinel, while the flip still animates in the right lane for both. Without the lane the opponent's face-down trap has nothing to animate on, since a face-down card is given no instance id | §10.8, §10.10, R33, R97 |
| R155 | When the return-to-hand flag is set | §10.5's play pipeline sets it as step 7 sends a Spell whose resolving face declares an end-of-turn return to the graveyard, and cleanup clears it at the end of that turn. §5.1 says such spells "are flagged when played" but names no step that does the flagging, so the flag was declared on the instance and written by nothing: the three cards and the graveyard's R153 gate both fell back on reading the turn log, which cannot distinguish a spell that asked to return from a unit that merely died on the turn it was played Two Core cases show why the turn log cannot stand in for it: a Spell that exiled itself (#39) is never in the graveyard at step 7 and so is never flagged, and a Unit with an end-of-turn hook (#13) that died on the turn it was played is in the log and in the graveyard but is not a Spell. R70 makes a cast flag the same way a play does. | #23, #24, #31 |
| R156 | A state check that begins while a prompt is open | It fires no Death hook. §4.5 steps 1 and 2 still run — the collected cards move (a token vanishes rather than reaching a graveyard, R11, R86), a marked Indestructible unit is resolved as R46 says, and the heroes are checked, because those are the board settling and not a choice — and steps 3, 4 and 5 are then owed together, as one continuation that runs when the answer drains `state.work` (R122). Step 3 is owed in full, in R68's order; step 4 waits behind it, so while the question stands a collected Reborn unit sits in its owner's graveyard with its zone reserved and empty (R64) rather than back on the board, and it returns only once the last Death hook has run. No turn can pass while a prompt is open, so R83 still gives it the turn it died on as its `summonedTurn`. Step 5 waits too: the check goes round again from the action that answered, and a collected card's `enteredGraveyard` is reported there rather than at step 1, so a Reborn that came straight back is never reported at all (R47). Firing a Death hook into an open prompt would silently discard whatever that hook asks, because a second prompt can never overwrite an unanswered one; this is the same treatment R62 and R100 give the end-of-turn trap window | §4.5, §9.3, §10.6, R11, R46, R47, R64, R83, R86, R113, R117, R122 |
| R157 | What an API request with no account is counted against | R109's 300 requests a minute are per account, which an open endpoint and a request whose token did not verify do not have. Such a request is counted against its IP hash instead, in a namespace of its own, so an anonymous flood is bounded without ever sharing a bucket with a signed-in one. A single shared counter would let one caller spend everybody else's budget, which is the abuse R137 refuses for the per-match half — and the account is keyed on the profile id rather than the auth user or the bearer token, either of which one account may hold several of | §9.8, R109, R137 |
| R158 | A draw interrupted by a prompt | §2.4's Cast on draw fires a whole play, and a play can ask, so both of §2.4's loops stop at the prompt and owe their remainder to `state.work`. The cast-on-draw chain owes one more draw **together with the chain count it had**, so R58's cap bounds a chain a pause split in half exactly as it bounds an uninterrupted one and a chain can never resume at zero; a "draw N" owes the whole draws it has not made, each of which still starts its own chain. The answering action makes those draws (R122), so R4's hand cap and R3's fatigue apply to them normally and the draw the chain paused on is counted once. A prompt that was **already open** when the draw began is not the draw's own pause and does not stop it — §2.1's mulligan answer draws its replacements underneath the very prompt it is answering, because R9 puts them before the shuffle-back | §2.1, §2.4, R3, R4, R9, R58, R113, R117, R122 |
| R159 | How long a verified email stays verified | §9.4 step 1's "verified email" is read from the auth provider, and only the **positive** answer may be remembered, briefly and per user id. Caching the yes is safe because confirmation does not go backwards in normal use; refusing to cache the no is what lets an account that has just clicked its link see the code screen unlock at once rather than after a cache window. Asking the provider on every request would put a round trip in front of every authenticated call. A provider that cannot be reached fails closed — the identity stands and the email counts as unverified — so the cache can only ever shorten the path to a yes the provider already gave | §9.2, §9.4 |
| R160 | The scope of the identical sign-up and sign-in error (extends R145) | Sign-up and sign-in answer identically for every outcome that depends on **whether an account exists** — no such account, wrong password, already registered — so neither becomes an account-enumeration oracle. This is R145's principle one door earlier: R145 makes the redemption error identical for everything that depends on the code and distinct for what depends only on the caller's own account, and an email address is exactly the fact an unauthenticated caller must not be able to probe. §9.8 asks the invite gate to resist enumeration, which a sign-up endpoint answering "that address is taken" undoes. One error per endpoint, not one shared between them, since the route already distinguishes them | §9.2, §9.4, §9.8, R145 |
| R161 | How many accounts one invite code activates | One, unless its mint says otherwise. §9.4 gives a code a `uses` counter and an "exhausted" state but fixes no default, and one use is what makes the counter worth having: a code that activates a single account is a unit of invite an operator can hand out and account for, while a multi-use default silently turns one leaked code into an open door — the same failure §9.8's brute-force row guards at the other end. A larger maximum stays available to whoever mints deliberately | §9.4, §9.8, R106, R107 |
| R162 | The CORS contract for the REST surface | The API answers a browser from an allowed origin by echoing **that one origin**, never `*`, and never sends `Access-Control-Allow-Credentials`: §9.1's client authenticates with a bearer token in a header, so no cookie is in play and a response carrying credentials would let every allowed origin act as the player. Every response the layer touches carries `Vary: Origin`, because the answer depends on the request's origin and a shared cache must not serve one origin's answer to another. An unlisted origin is **not** an error — it gets the ordinary response with no CORS headers, which is what the browser needs in order to refuse it; a 403 would tell a page nothing it could not already tell and would change the answer a non-browser caller gets, and §9.1 puts the rules in the server, so CORS must never be load-bearing for a refusal. The list is the same one §9.2's WebSocket origin check reads, so the two doors cannot diverge | §9.1, §9.2, §9.8 |
| R163 | The catalog a client that ships none can read | §9.4's "static, versioned, shipped with the client" describes the end state; until the client ships one the server serves the same bytes, whole and unprojected. Whole, because §9.4 requires one validator module shared by client and server and the validator's snapshot **is** the card definitions: a trimmed card would be a second, weaker copy of the catalog, and the deckbuilder's verdict (UX) would stop being the verdict the save runs (law). Unauthenticated, like the file it stands in for — the same bytes for everybody, naming no profile, and §9.4's gate on a pending account is about collection, loadout, queue and match, which card data is not. It carries R105's version, so a stale client learns it is stale before it builds a deck rather than at save time. It is transport, never a second source of truth: the day the client ships its own catalog this route may go away without a rule changing | §9.1, §9.4, R105 |
| R164 | Where L6's ban list lives | A ban is server state, not catalog data. Nothing in §8 is banned at launch and a card definition carries no ban flag, so L6's two halves are answered from two places: catalog membership from the catalog both sides ship, and the ban list from the server alone. A flag on the card would put the ban inside the catalog data, so banning one card would mean a new R105 version and §9.4's stale-version rejection would invalidate every saved loadout in the game at once; it would also hand the client a copy of a list it has no business being able to disagree with. The shared validator therefore reads bannedness through the catalog handle and never off a card definition | §9.4, R105 |
| R165 | Queueing with no loadout at all | A profile that has never saved a loadout fails the queue-time check as a **loadout** failure, not a missing resource. §9.4's L1 assumes a loadout exists and so cannot state the case, but the player is in exactly the position L1 describes — they do not have three decks — and the remedy is the same: go and build one. A 404 would say the endpoint found nothing, sending a client looking for a route that is working correctly, and it is not a staleness problem either. The rule generalises: a queue-time refusal the player fixes in the deckbuilder reports as a loadout failure, and only a catalog mismatch reports as stale | §9.4, §9.5, R141 |
| R166 | Which qualifying opponent a sweep pairs | The oldest ticket is paired first, and against the oldest opponent its window admits — not the closest in rating. §9.5 fixes the window and says nothing about the choice inside it, and the window **is** the rating rule: picking the closest rating inside a window that was widened precisely because nobody closer was there applies the same criterion twice and leaves the player who has waited longest waiting again. Wait time is also the one thing a queued player can watch going up, which is what §9.5's queue population is for. Ties break on ticket id, so a sweep is deterministic and a replay of the same open set pairs the same way | §9.5, R108 |
| R167 | How a player leaves the queue | A queued player may cancel, and cancelling is idempotent: a client that cancels twice, or whose ticket was paired a moment earlier, is told nothing was cancelled rather than given an error it cannot act on. §9.5 describes enqueue and pairing and never says how a player leaves, but its own enqueue condition — active and **not in a match** — has no other way to become satisfiable again: without cancel, a player who queued by mistake is held until somebody pairs with them. It must be idempotent because the race is unavoidable and one-sided: the sweeper can pair a ticket between the client deciding to cancel and the request arriving, and at that point the match exists and the player belongs in it. So cancel never unmakes a pairing; it only closes a ticket that is still open | §9.5, R108, R143 |
| R168 | The view's event window is a floor, not a cap | §10.8's "last N events" never ends **inside** the newest action: the window is at least N, and at least the whole of the action that has just been applied. BUILD M5-T4 gives every §10.3 event an animation and the view's event list is the client's only channel for them, so a fixed length silently drops the **front** of any single action that emits more — the client then animates the tail of something whose beginning it was never told about. One #96 My Pawn cancel plus the §10.7 AI turn it hands over is 38 events in one reduction, and the three the cancel is made of (`attackDeclared`, `trapFired`, `attackCancelled`) were precisely the ones lost, which made M5-T4's `attackCancelled` row unreachable | §10.8, §10.10, #96, R44, R84 |
| R169 | The player modifiers travel in the view, on both seats | §10.8 lists what each side of a `PlayerView` carries and does not mention §10.1's `mods`, so a modifier could be active with nothing on screen saying so — which is what happened: BUILD M5-T4 gives `modifierChanged` an animation whose target is `modifiers-<side>`, and no component rendered that element, so #77 Professor Curvature and #78 /fullsend changed the game invisibly. The list travels as `{ id, label }` on **both** seats, because every modifier in the Core set is installed by a card played **face-up** (#35 and #78 are Spells, #79 and #64 install theirs without a Cry, and only #77 is a Cry — what they share is the public play, not the hook) and `modifierChanged` already names the player and the modifier id to both players unredacted; the caption is built from the modifier's own kind and numbers and never from its `sourceId`, so no card identity leaves through a badge (§9.1, §10.8). Per R48 a modifier that covers its controller's *next* turn is installed at once and bites later, so its caption says so while it is not yet live — a badge that claimed #77's discount on the turn the discount does nothing would be worse than no badge | §10.1, §10.3, §10.8, #35, #77, #78, #79, R48, R97 |
| R170 | A profile that vanishes mid-redemption is a conflict, not an unauthorized caller | §9.4's redemption resolves the caller, then runs the transaction; SPEC does not say what happens if the profile row is gone between the two. It is a **409 conflict**, not a 401: the caller's token was valid and was verified, so nothing about their authorization failed — what changed is the state the request was about, which is what a conflict means. The race does not date from making the redemption one database call: `resolveCaller` has always read the profile before the transaction, and the six-step version re-read it inside and could answer "no such profile" itself. What one call changes is that the re-read now happens inside `app.redeem_invite_code`, whose `select … for update` answers `not_pending` for a missing row, a banned row and an already-active one alike — so the three collapse into one result the server must name, and it names the case that dominates them. 401 is owned a layer earlier by token verification, which already returns nothing for a user the auth server says is gone; a handler answering 401 after authorization has passed is re-answering a settled question. Rare rather than unreachable: `profiles.id` is `references auth.users(id) on delete cascade`, so an account deletion removes the row, and R159's 30-second positive-email cache leaves a window in which that account's unexpired token still verifies. The refusal is logged like the other two, which is to say not at all — §9.4 rejects at steps 1 to 3, before step 4 writes anything | §9.4, R106, R145, R159 |
| R180 | Handicaps | A game's setup may give each seat a handicap: `deckSize`, `manaBonus`, `manaCap`, `extraOpeningCards` and `extraDrawsPerTurn` (§9.9). A seat without one plays with this spec's resources (`HUMAN_HANDICAP`: 20, 0, 4, 0, 0), and a handicap equal to that is not stored, so a game with none hashes and replays exactly as before. The handicap lives on the seat's `PlayerState`, and `fold` takes the handicaps `createGame` took, so a handicapped game replays from `(seed, decks, handicaps, log)`. Only practice sets one; the server never does. The three practice tiers are `AI_DIFFICULTY` in `config.ts` and differ in the handicap alone: the AI's search, evaluation and budget are the same at every tier | §2.1, §2.3, §2.4, §2.6, §9.9 |
| R181 | Max mana under a handicap | Max mana = min(turns started + `manaBonus`, `manaCap`), plus persistent and next-turn modifiers, floored at 0. With no handicap that is §2.3's min(turns, 4). Temporary mana, Hinder and every cost rule apply on top exactly as for a human: Medium refreshes to 2 on its first turn and 5 from its fourth, and Hard to 7 from its sixth | §2.3, #6, #21, #24 |
| R182 | Opening hand under a handicap | The opening draw is §2.1's table entry plus `extraOpeningCards`, so a Medium or Hard AI seated second draws 5 and seated first draws 4. Quickdraw cards replace draws out of that total, and the mulligan works on the whole hand as §2.1 says. Hard carries Medium's extra card rather than adding a second one | §2.1, #65, #84, #98 |
| R183 | Extra draws per turn | A seat's start-of-turn draw is `DRAWS_PER_TURN` + `extraDrawsPerTurn` separate draws, each exactly a §2.4 draw. Each has its own cast-on-draw chain under R58 and its own hand-cap check, and from an empty library each is its own fatigue step, so a Hard seat with an empty library takes N and then N + 1. A prompt opened inside the first draw owes the rest to `state.work` like any "draw N" (R158) | §2.4, R3, R58, R158 |
| R184 | Deck size for a handicapped seat | A seat's deck holds exactly its handicap's `deckSize` cards (25 for Medium, 30 for Hard) and still obeys §2.6's other rules: no duplicate ids and no Token cards. §2.6's 20 and §9.4's loadout rules govern a player's loadout. An AI deck is never a loadout, so the validator is unchanged and a 30-card deck never reaches a server match | §2.6, §9.4 L2, L3 |
| R185 | What the AI may know | The AI decides from what its seat may know: everything `viewFor(state, seat)` shows, plus the public history the state records about face-up cards (damage and buffs, exertion, summoning turn, turn logs, modifiers, delayed effects, game counters). Everything else is redacted before the AI reads the state: the opponent's hand and library, the backrow cards the seat cannot read (R33), cards in its own library that came from the opponent's deck (R73), the order of its own library, the match seed and the event history. Every simulation runs on a determinization, in which those hidden cards are resampled from non-token Core cards the opponent has not shown (face-down backrow from Traps and Field Traps) under a seed of the AI's own, so no simulation can foresee a real draw or a real coin flip. Two states that differ only in hidden cards give the same decision under the same AI rng | §9.1, §9.9, §10.8, R33, R73 |
| R186 | The AI's shadow ban | `packages/ai`'s shadow ban lists the cards the AI never puts in its own decks, each with the reason a sweep flagged: an engine or search error, a decision over time, a card drawn and affordable but never played, or plays that lowered the AI's own evaluation. The sweep forces each card into AI decks at the Easy and at the Hard handicap; a flag at either tier bans the card at every tier, and its reason names the tier. A card that was never affordable at any tier has given no evidence either way, so the sweep reports it as unswept rather than clearing it. It governs AI deck-building and nothing else. A banned card stays legal for every player, a human may play it against the AI, and the AI must still answer it. It is not §9.4 L6's ban, which is server state (R164) | §9.9, R164 |
| R187 | Practice games | A practice game (§9.9) needs no account and no server. The engine and the AI run in a Web Worker in the player's browser, and the page receives only `viewFor(state, human)`, the human's `legalActions` and whether the AI owes an action, with the worker standing where §9.1 puts the server. It records no result, no rating and no collection change, and it replays exactly from `(seed, decks, handicaps, log)` | §9.1, §9.9, R180 |
| R188 | The AI and draw offers | The AI never concedes and never offers a draw (the action types R84 skips), and it declines every draw offer at once: when the human offers, the AI answers `answerDraw` with `accept: false`, which blocks the human's next offers as R36 says. An AI that let offers stand would leave the human with an unanswered offer and no way to tell a refusal from a hang | §2.5, R36, R84 |
