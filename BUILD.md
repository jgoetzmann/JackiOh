# JackiOh — Build File

Work order for implementing JackiOh from `SPEC.md` (the master game specification). `§` references point at SPEC.md sections. This file says what to build, where it lives, in what order, and what "done" means. SPEC.md is the only source of rules; if this file and SPEC.md disagree, SPEC.md wins and this file gets fixed.

## 0. How to work this file

- Read SPEC.md end to end before writing code. Re-read the relevant section before each task.
- Tasks are `M<milestone>-T<n>`. Each lists **Files** and **Acceptance**. A task is done when every acceptance item is a green automated test (or a lint rule), not when the code exists.
- Milestones are gates. Do not start M(n+1) until the M(n) gate passes.
- Rulings: every SPEC §11 row (R1–R168 as of 2026-09-17) is implemented exactly as written. Rows marked "decide" (R1, R2, R4, R5, R14, R26, R39) live behind named constants in `packages/engine/src/config.ts` so a designer can flip them in one line. Every ruling has a test whose name starts with its id, e.g. `it("R8 Death fires on both deaths of a Reborn unit")`.
- If SPEC.md is silent on something you hit, follow Hearthstone semantics, add a row to SPEC §11 (next R-number) in the same PR, and name the test after it.
- M1–M3 acceptance items that name a card (Gravedigger, Hinder, CN-Virus, Twinspell, Mana Well, Jlockeed Shredder, Big D-fender, Moths to the Flame, Big Felinor, Hit Job, Right-house defender and others) are tested with a test-only fixture script under `packages/engine/test/fixtures/` that reproduces just that behaviour; the real card test in M4 covers the same case again.
- Stack: TypeScript strict; pnpm workspaces; vitest; eslint with `no-restricted-properties` banning `Math.random`, `Date.now`, `new Date()` inside `packages/engine` and `packages/cards`; React + Vite for `apps/web`; Cypress for `e2e`; Postgres for `apps/server`; one stateful actor per match (Cloudflare Durable Objects or an equivalent single-threaded actor runtime).
- No card script mutates state directly. Scripts return `Effect[]` built from `packages/engine/src/effects/*`. A PR that adds a primitive to a card file instead of the effects library is rejected.

## 1. Repository layout

```
jackioh/
  package.json                 pnpm workspaces, root scripts: lint, test, test:e2e, typecheck
  pnpm-workspace.yaml
  tsconfig.base.json           strict, noUncheckedIndexedAccess
  eslint.config.js             flat config (ESLint 10); bans Math.random / Date in engine + cards
  SPEC.md  BUILD.md  REVIEW.md CLAUDE.md
  JackiOh_Mechanics.md  JackiOh_Core_Cards.md  ARCHITECTURE-CCG.md   source design notes (REVIEW Part A inputs)
  packages/
    shared/                    types shared by engine, server, web
      src/actions.ts           Action union (§10.2) with playerId + nonce
      src/events.ts            GameEvent union (§10.3)
      src/catalog-types.ts     CardDef, Script hook types, Keyword enum
      src/view.ts              PlayerView type returned by viewFor
    engine/                    pure rules engine, zero I/O
      src/config.ts            all constants (section 2 below)
      src/catalog.ts           static catalog registry: registerCatalog, defOf, defByIndex (§5.1)
      src/script.ts            Effect, EffectContext, Script and hook types (§10.9)
      src/scripts.ts           script registry: registerScripts, scriptOf, flagsOf
      src/resolve.ts           run a hook, apply effects, cast a card (R70)
      src/state.ts             GameState, PlayerState, CardInstance (§10.1); createGame()
      src/rng.ts               seeded PRNG + helpers (§10.7)
      src/reduce.ts            reduce(state, action, rng) -> {state, events, error?}; legalActions()
      src/zones.ts             zone moves, lanes, adjacency, ring rotation, locks, stack piles
      src/mana.ts              refresh, temporary mana, cost calculation with modifiers
      src/draw.ts              draw, cast-on-draw, fatigue, hand cap, Infinite Reserves hook
      src/setup.ts             shuffle, opening draw table, Quickdraw, mulligan, start-of-game
      src/turn.ts              phases, start/end-of-turn trigger dispatch, cleanup, turn cap
      src/combat.ts            attack validation, forced attacks, combat resolution (§4.2–4.3)
      src/damage.ts            the 10-step damage pipeline (§4.4); heal; lose-health
      src/stateCheck.ts        deaths, Reborn, Death triggers, hero check loop (§4.5)
      src/layers.ts            stat and keyword layer computation (§10.4)
      src/events.ts            emit helpers
      src/triggers.ts          trigger registry, queue, ordering (§10.3)
      src/traps.ts             trap matching and immediate resolution
      src/prompts.ts           PendingChoice open/answer/resume (§10.6)
      src/modifiers.ts         player modifiers, delayed effects, expiry
      src/effects/             one file per primitive (section 3, M3-T1)
      src/subsystems/          fuse.ts, rotation.ts, scorer.ts, aiPolicy.ts, heroPower.ts,
                               comboIndex.ts, callToChaos.ts, lethal.ts
      src/viewFor.ts           filtered per-player view (§10.8)
      src/replay.ts            fold(seed, log) -> state; state hash
      test/                    unit + property tests
    cards/
      catalog.json             100 cards + 9 tokens (schema in M4-T1)
      src/index.ts             registry: defId -> {def, base, radiant}
      src/scripts/NNN-slug.ts  one file per card, NNN = zero-padded index, tokens as NNN-1-slug.ts
      test/NNN-slug.test.ts    one test file per card
      test/catalog.test.ts     shape test (M4-T1 acceptance)
    validator/
      src/index.ts             loadout rules L1–L6 (§9.4), used by web and server
  apps/
    web/                       React client
      src/game/Board.tsx Hand.tsx Zone.tsx Hero.tsx Backrow.tsx Prompt.tsx Log.tsx
      src/game/animations.ts   eventType -> animation table (section 5)
      src/game/hotseat.ts      local loop: reduce in-browser, seat switching, seeded
      src/game/net.ts          WebSocket client, reconnect, view refresh
      src/deckbuilder/         loadout editor using packages/validator
      src/routes/dev/hotseat   /dev/hotseat?seed=&a=&b= for tests
    server/
      src/api/                 codes, collection, loadouts, queue (stateless functions)
      src/match/actor.ts       one actor per match: state, WS, clock alarm, action log
      src/match/protocol.ts    WS messages: hello, view, action, ack, error, prompt, clock
      src/db/migrations/       profiles, invite_codes, code_attempts, cards, collection,
                               collection_grants, loadouts, loadout_decks, loadout_deck_cards,
                               tickets, matches, match_actions, results
  e2e/
    cypress.config.ts
    cypress/e2e/*.cy.ts        section 6.4
    fixtures/decks/*.json      scenario decks
    support/                   commands: seedGame, playCard, attack, answerPrompt, endTurn
```

## 2. Constants (`packages/engine/src/config.ts`)

Every number below is a named export. Nothing in the engine hard-codes them.

| Constant | Value | Spec |
| --- | --- | --- |
| `DECK_SIZE` | 20 | §2.6 |
| `MAX_COPIES` | 1 | §2.6, §9.4 |
| `MAX_MANA` | 4 | §2.3 |
| `HERO_HEALTH` | 30 | §2 |
| `TURN_CAP_PLAYER_TURNS` | 30 | §2.5, R2 (decide) |
| `HAND_CAP` | 10 | §2.4, R4 (decide) |
| `OPENING_DRAW` | `[3, 4]` (index = seat, Nth seat = N+2) | §2.1 |
| `UNIT_ZONES` / `BACKROW_ZONES` | 5 / 5 | §3 |
| `LANE_RESTRICTED_ATTACKS` | false | R5 (decide) |
| `CRY_ON_PLAY_ONLY` | true | R1 (decide) |
| `ROTATION_RING` | "two-rings" | R14 (decide) |
| `GENN_GREED_EXILES` | "odd" | R26 (decide) |
| `FIENDER_STATS_MODE` | "printed-plus-sum" | R39 (decide) |
| `FATIGUE_DAMAGE(n)` | n | R3 |
| `DRAW_OFFERS_PER_TURN` | 1 | §2.5, R36 |
| `DRAW_OFFER_BLOCK_TURNS` | 3 | §2.5, R36 |
| `CALL_TO_CHAOS_CHAIN_CAP` | 20 | R28 |
| `CAST_ON_DRAW_CHAIN_CAP` | 20 | R58 |
| `LIBRARY_CAP` | 60 | R80 |
| `ANTI_ONESHOT_CAP` | `{ base: 5, radiant: 3 }` | §8 #73 |
| `RANDOM_KEYWORD_POOL` | Taunt, Armor 1, Rush, Charge, First Strike, Poisonous, Lifesteal, Reborn, Divine Shield, Trample, Cleave | R21 |
| `FIB` | `[0,1,1,2,3,5,8,13,21,34,55,89]`, index clamps at 11 | R25 |
| `FUSE_COST_CAP` | 4 | §6.3 |
| `MULLIGAN_ORDER` | "draw-then-shuffle" | R9 |
| `AI_END_TURN_PROBABILITY` | 0.1 | §10.7 |

Server constants (`apps/server/src/config.ts`, added in M7) carry R79's values: `TURN_CLOCK_SECONDS` 75, `PROMPT_CLOCK_SECONDS` 30, `DISCONNECT_GRACE_SECONDS` 60, `MATCH_CEILING_MINUTES` 60, `ROOM_CODE_LENGTH` 6, `ELO_K` 32, `ELO_START` 1000.

## 3. Milestones

### M1 — Engine core (`packages/engine`)

**M1-T1 State and types.** Files: `shared/src/*`, `engine/src/state.ts`.
Implement `GameState`, `PlayerState`, `CardInstance`, `PendingChoice`, `DelayedEffect`, `PlayerModifier` exactly as §10.1. `createGame({ seed, decks: [defId[], defId[]] })` returns a state in phase `setup`.
Acceptance:
- `state.ts` type-checks against `shared/src/catalog-types.ts`; no `any`.
- `createGame` with two 20-card decks yields 2 players, 30 health each, empty zones, `turn = 0`, `pending = null`.
- `createGame` rejects a deck that is not exactly `DECK_SIZE`, contains duplicates, or contains a Token-tagged def (throws with a message naming the rule).

**M1-T2 RNG.** Files: `engine/src/rng.ts`.
Seeded PRNG (mulberry32 is fine) whose cursor is stored in `state.rngCursor`. Helpers: `next()`, `int(n)`, `pick(list)`, `shuffle(list)`, `coin()`, `chance(p)`, `lucky(x, roll, better)`.
Acceptance:
- Same seed and cursor produce the same sequence across two processes (test serializes cursor and resumes).
- `lucky(1, roll, better)` calls `roll` exactly 2 times and returns the better result; `lucky(0, …)` calls once.
- ESLint fails the build on `Math.random`, `Date.now`, `new Date()` anywhere under `packages/engine` or `packages/cards` (test: a fixture file with `Math.random()` fails lint).

**M1-T3 Reducer skeleton.** Files: `engine/src/reduce.ts`, `shared/src/actions.ts`.
`reduce(state, action, rng)` returns `{ state, events, error? }`. Action union per §10.2 with `playerId` and `nonce`. `legalActions(state, playerId)` enumerates every action that would not error, including every legal `answer` to an open prompt. Nonce dedupe: a repeated nonce returns the previous result without re-applying.
Acceptance:
- An action from the non-active player (other than `answer` to their own prompt, `concede`, `answerDraw`) returns `error` and an unchanged state (deep-equal).
- An action other than `answer`, `mulligan`, `concede`, `timeout`, `disconnectExpired` or `ceilingReached` while `state.pending` is non-null errors.
- Every action in `legalActions` succeeds; property test over 200 random states.
- Replaying the same nonce twice yields identical state and no duplicate events.

**M1-T4 Zones.** Files: `engine/src/zones.ts`.
Move primitives between hand/library/graveyard/exile/field; unit zones as `(Pile | null)[5]` with top-first piles; backrow `(CardInstance | null)[5]`; locks; `adjacent(side, row, index)`; `ringNeighbor(zoneRef, direction, perspective)` for the two rings of §3.1, whose order is read from the rotating player's seat (R14); `firstFreeZone(side, row)`; "fill your board" helper; tokens vanish on leaving the field (§3.2).
Acceptance:
- Adjacency: lane 1 has one neighbour (2), lane 3 has two (2, 4), never across sides.
- Ring: from your lane 5 rotating right lands on the opponent's lane 5; from the opponent's lane 1 rotating right lands on your lane 1; backrow ring is independent.
- Summon into a full row returns "no zone" and leaves state unchanged; summon into a Locked zone by index fails; lock persists after the occupant leaves.
- A Rush Token bounced or exiled is not in any hand, library, graveyard or exile afterwards; a spell token that resolves is in the graveyard.
- Stack: pushing onto an occupied zone makes the pushed card top; only the top card appears in `activeUnits(side)`; popping the top resumes the card beneath with its stored damage.

**M1-T5 Setup and mulligan.** Files: `engine/src/setup.ts`.
Shuffle both libraries with the match rng; opening draws from `OPENING_DRAW`; Quickdraw cards replace a draw (§6.2); mulligan prompt per player; returned cards redraw first, then shuffle back (R9); start-of-game hooks (Heroic Power).
Acceptance:
- P1 hand = 3, P2 hand = 4 after setup; libraries 17 and 16.
- A deck with two Quickdraw cards puts both in the opening hand and draws one fewer random card... (exactly `OPENING_DRAW[seat] − quickdrawCount` random draws, minimum 0).
- Mulligan returning 2 cards: the 2 replacements are not the returned cards (property test over 100 seeds).
- Heroic Power's power is chosen during setup, deterministically from the seed, including a copy the mulligan returned to the library (R43).

**M1-T6 Turn loop and mana.** Files: `engine/src/turn.ts`, `engine/src/mana.ts`, `engine/src/modifiers.ts`.
Phases per §2.2 and R62. Start-of-turn: refresh mana (`min(turnsStarted, MAX_MANA) + permMod + nextTurnMod`, floor 0), delayed effects due, start-of-turn triggers, then draw. End-of-turn: end-of-turn triggers (Combo-Index and "add back to hand" spells included), the Bread and Butter / Intern Stimmy trap window, delayed effects due, cleanup expiring "this turn" modifiers, turn-cap check. Cost calculation per R65: `effectiveCost(instance, player)` starts from `costOverride` or the printed cost, adds instance `costMod`, then player discounts (next-spell, this-turn), then Curvature, floors at 0; X-cost cards cost exactly X. X and embiggen selection are part of the `play` action and stored on the instance.
Acceptance:
- Turn 1 P1: 1 mana; turn 4: 4; turn 10: 4. Mana Well turn 4: 5 available.
- `nextTurnMod = −1` (Hinder) on a turn-2 player yields 1 mana, and 0 mana never goes negative.
- A "this turn" discount is gone after `endTurn`; Twinspell's pending Echo is not (R30).
- Start-of-turn triggers fire before the draw (test: Gravedigger adds a card, then the draw happens; hand order proves it).
- `play` with `x` greater than current mana errors; `x = 0` is legal.

**M1-T7 Draw.** Files: `engine/src/draw.ts`.
`draw(player, n)`: from top; cast-on-draw resolves immediately and draws again; empty library → fatigue damage `FATIGUE_DAMAGE(fatigueCount)` unless an Infinite Reserves hook supplies a Rush Token card; hand at `HAND_CAP` burns the card to the graveyard (spell tokens too; unit tokens vanish).
Acceptance:
- Drawing Hinder casts it, applies the opponent modifier, and the hand gains the next card instead.
- Three consecutive empty draws deal 1, 2, 3 damage.
- Eleventh card is in the graveyard, not the hand; `drawn` counter still increments.
- CN-Virus drawn: 1 damage via the pipeline, 2 copies shuffled, next card drawn; a library of only viruses with hero Armor 2 stops after `CAST_ON_DRAW_CHAIN_CAP` casts and the next virus sits in hand uncast (R58).
- A cast-on-draw card drawn into a full hand is still cast (R58).
- Shuffling a copy into a 60-card library creates nothing (R80).

**M1-T8 Game end.** Files: `engine/src/turn.ts`, `engine/src/reduce.ts`.
Hero ≤ 0 at a state check → loss; both → draw; concede; draw offer/answer with `DRAW_OFFER_BLOCK_TURNS`; turn cap after the 30th player-turn ends → draw; a turn whose only legal actions are ending it, conceding and offering a draw auto-ends (R82, emitted as `turnAutoEnded`).
Acceptance:
- R59 simultaneous lethal: one effect (fixture script) that deals the enemy hero lethal damage and then fatigue-draws its own player to 0 yields `winner: "draw"`; the same two hits as two separate actions end the game at the first one.
- After the 30th `endTurn`, `result.reason = "turn-cap"`; the 29th does not end the game.
- A declined offer blocks the offering player for 3 of their turns; the opponent may still offer.
- R82: a player whose only legal actions are ending the turn, conceding and offering a draw gets `turnAutoEnded` after their draw.

**M1 gate.** `engine/test/hotseat.smoke.test.ts` plays a full game between two vanilla-stat decks (script-less defs) using random `legalActions` until `result` is set, for 100 seeds, never throwing and always ending by hero death or the cap. `engine/test/replay.test.ts` folds each of those logs and gets an identical state hash.

### M2 — Combat (`packages/engine`)

**M2-T1 Positions and exertion.** Files: `engine/src/combat.ts`.
Units enter in ATK; `switchPosition` costs the unit's exertion; Deft Duelist flag allows one attack plus one switch; Spikey Pillow flag blocks DEF; spells that switch positions (5pek Controller) spend no exertion (R20).
Acceptance: a unit that switched cannot attack that turn; a unit that attacked cannot switch; both resets at the controller's next turn; Deft Duelist does both; 5pek-switched units keep their exertion.

**M2-T2 Attack validation.** Files: `engine/src/combat.ts`.
Steps 1–3 of §4.2: attacker eligible (exertion, ATK position, not sick unless Rush/Charge, attack > 0, no "can't attack"), target legal (enemy unit or hero; Rush cannot pick hero on summon turn; `LANE_RESTRICTED_ATTACKS` false), Taunt filter (printed, granted, DEF-position).
Acceptance: each rejection reason has a test; a DEF-position enemy forces targeting even with no printed Taunt; Big D-fender (0 attack) can never be an attacker.

**M2-T3 Damage pipeline.** Files: `engine/src/damage.ts`.
`dealDamage({ source, target, amount, flags: { ignoreArmor, combat } })` implementing the 10 steps of §4.4 in order; `loseHealth` bypasses it (R18); `heal` per §6.3 (units capped at max, heroes uncapped, "heal to full", "heal up to N").
Acceptance (one test per step, in order):
1. Divine Shield negates a 10 hit fully and is gone; a second hit lands; a 0-attack unit's strike-back leaves the shield (R63).
2. Armor 7 turns 7 into 0; DEF adds 1; Big D-fender adds 2 more; True Strike ignores all of it.
3. Anti-oneshot caps 12 to 5 on the hero only.
4. Indestructible takes 0 and stays.
5. `damage` event carries the amount actually dealt.
6. Fed Fauci gains exactly one Plague Token per instance, none on an instance Armor reduced to 0, which also emits no `damage` event (R63).
7. Poisonous destroys on 1 dealt, not on 0, and never affects a hero (R63).
8. Lifesteal heals the source's controller by dealt amount (post-armor); a unit with Trample and Lifesteal heals the total damage once (R63).
9. Trample sends only the excess over the target's health to its controller's hero as its own instance, from non-combat damage too (R63).
10. Cleave hits both neighbours for the attacker's attack, not across sides, even when Divine Shield stopped the hit on the defender (R63).

**M2-T4 Combat resolution.** Files: `engine/src/combat.ts`.
First Strike step, simultaneous step, hero targets, forced attacks (`forceAttack(attacker, target)` skipping validation and exertion; each is its own combat with a state check, and the sequence stops when the target is gone, R53).
Acceptance: First Strike attacker survives a defender it kills; two First Strikers hit each other; defender in DEF strikes back at full attack; hero never strikes back; Moths pulls a summoning-sick enemy into an attack without spending its exertion.

**M2-T5 State check.** Files: `engine/src/stateCheck.ts`.
Loop of §4.5, run after each action, whole effect, cast-on-draw cast and combat, never between the hits of one effect (R59): collect (health ≤ 0 or destroyed, tokens vanish, Reborn units reserve their zone (R64), a marked Indestructible unit switches to ATK and loses Taunt this turn instead, an Indestructible unit at max health ≤ 0 is collected (R69)), hero check, Death triggers in R68 order, Reborn to the reserved zone at 1 health without Reborn, repeat until stable.
Acceptance: Big Felinor's Cry kills six units in one check and fires six Death triggers in the specified order; a Jlockeed Shredder trigger kills two units with Death triggers and both fire only after every hit has landed (R59); radiant Right-house defender yields two base Right-house defenders over two deaths while Reborn returns to its reserved zone (R8, R64); Reborn into a zone that was Locked meanwhile fails silently (R47); an Indestructible unit "destroyed" by Hit Job is in ATK with no Taunt until end of turn.

**M2 gate.** `engine/test/combat.property.test.ts`: 1,000 random combats between random keyword combinations never produce negative health, never leave a unit at health ≤ 0 on the field unless it is Indestructible with max health above 0 (R69), and never emit a `damage` event on an Indestructible target.

### M3 — Effects, triggers, prompts, layers, view (`packages/engine`)

**M3-T1 Effects library.** Files: `engine/src/effects/<name>.ts`, grouped by family — one file may own several related §6.3 verbs (`move.ts` holds exile, bounce, discard and counter; `destroy.ts` holds the destruction verbs) so that verbs sharing a rule share one implementation. What must hold is the barrel, not the filenames: every state-changing §6.3 row is an exported factory named in `effects/index.ts`, which uses explicit named exports and no `export *`, so a missing verb fails typecheck rather than at runtime, and every module has its own test file or a named owner in `effects-core.test.ts`'s map. Embiggen, Choose one and Cost are play-time choices and a calculation, living in `prompts.ts` and `mana.ts`, plus stat/keyword helpers:
`summon`, `play` (internal), `destroy`, `sacrifice`, `exile`, `bounce`, `discard`, `counter`, `steal`, `transform`, `vanilla`, `heal`, `damage`, `loseHealth`, `draw`, `addToHand`, `shuffleInto`, `recruit`, `discover`, `tribute`, `fuse` (delegates to subsystem), `lock`, `plague`, `gainMana`, `nextTurnMana`, `setRadiant`, `buff`, `grantKeyword`, `setCostMod`, `setCostOverride`, `fillBoard`, `switchPosition`, `swap`, `cast`, `replace`, `rotate` (delegates to the subsystem) (§6.3).
Each effect is a pure function `(state, rng, args) → { state, events }` and is the only place its zone move or counter change happens.
Acceptance: every effect has its own test file; `grep -r "state.players\[" packages/cards` returns nothing (scripts never touch state); `steal` places into the same lane if free else first free and leaves excess (R15); `summon` with no zone takes the leftmost free zone and skips zones reserved for Reborn (R64); `cast` counts as a play with cost paid 0 (R70); `fuse` follows R77; leaving the field resets an instance per R78 while `costMod`, `costOverride` and `radiant` persist; `bounce` returns to the owner's hand and drops buffs (§6.3); `transform` and `vanilla` are refused on Immutable (R23); `recruit` scans top-down and keeps library order.

**M3-T2 Events and triggers.** Files: `engine/src/events.ts`, `engine/src/triggers.ts`, `engine/src/traps.ts`.
Event union per §10.3. Trigger registry keyed by hook (`cry`, `death`, `startOfTurn`, `endOfTurn`, `onEvent(predicate)`, `handTrigger`, `startOfGame`, `onPlayHook`) and by zone. Resolution loop per the §10.3 diagram: apply → emit → traps fire immediately → queue other triggers in R68 order (delayed effects at their R62 point, in creation order; active player, then opponent; unit lanes 1–5, backrow 1–5, hand, then graveyard) → state check → repeat.
Acceptance: two end-of-turn triggers on the same side resolve in lane order (R68); a trap fires before a queued trigger, except in the end-of-turn trap window, which comes after end-of-turn triggers (R62); the state check never runs between two hits of one effect (R59); a trap that opens a prompt for its owner during the opponent's turn pauses the opponent's action until answered; `CRY_ON_PLAY_ONLY` makes `summon` never fire `cry` (R1) while `play` does; Cast on draw, Echo and Call to Chaos casts do fire it.

**M3-T3 Prompts.** Files: `engine/src/prompts.ts`.
`PendingChoice` per §10.6 with kinds `discover | target | mode | mulligan | hand | zone | tribute | direction | x | embiggen`. `resume` is a serializable continuation (script id + step + captured data), never a closure. Chained prompts supported (Private Tutor's three steps, Craft a Card's two Discovers).
Acceptance: a state with an open prompt survives `JSON.parse(JSON.stringify(state))` and answering still works; the opponent's `viewFor` shows `pendingFor: playerId` and no options; an `answer` with an option not in `options` errors; `legalActions` lists every option.

**M3-T4 Layers.** Files: `engine/src/layers.ts`.
`unitView(state, instance)` computes attack, maxHealth, health, keywords, armor per §10.4; recomputed on read, never cached in state.
Acceptance: Suppressive Aura −2/−2 on a 2-health unit makes health 0 and the next state check kills it; removing the aura restores a surviving unit's max health; Jlockeed's Weapons grants Rush to a unit summoned after it; Vanilla strips printed keywords but not `grantedKeywords`; Felinor Fiender = printed + sum of Felinors including dormant stacked ones (R39, R13); Spikey Pillow floors attack at 0.

**M3-T5 Modifiers and delayed effects.** Files: `engine/src/modifiers.ts`.
Player-scoped modifiers with expiry (`thisTurn`, `nextTurnOf(player)`, `untilUsed`), delayed effects keyed to a turn boundary (Kpop Fanatic, Recycling Initiative, /fullsend exile), resolved at their R62 point in creation order. Efficiency Dividend's mana is a `mana.nextTurnMod`, not a delayed effect.
Acceptance: Lunar Eclipse's discount applies to the next spell only and expires at cleanup; Professor Curvature's discount applies only on the next turn to cards whose current cost is 4 (R48); Kpop Fanatic's steal fires at the next start of turn after the unit has died (§8 #50).

**M3-T6 viewFor.** Files: `engine/src/viewFor.ts`.
Per §10.8: own hand in full; opponent hand as a count; both libraries as counts; face-down traps as `{ faceDown: true }` for the opponent; Field Spells public; graveyards and exile in full; the viewer's own prompt options only; last N events.
Acceptance: `JSON.stringify(viewFor(state, P1))` contains no `defId` from P2's hand, no P2 library entries, and no P2 face-down trap `defId`; a trap stolen by P1 becomes visible to P1 and hidden from P2 (R33).

**M3-T7 Subsystems.** Files: `engine/src/subsystems/*.ts`.
- `fuse.ts`: per R77, fuse the base forms and the radiant forms separately (sum stats, union keywords and tags, concatenate scripts so both Cry/Death lists run), cost `min(sum, FUSE_COST_CAP)`, new `defId` in `state.transientDefs`; the result keeps the target's instance and state while the other ingredients cease to exist with no Death trigger (R77); a fused trap keeps every trigger condition.
- `rotation.ts`: rotate both rings one step in a direction; control changes on crossing; Locked destination bounces (R14); radiant Silly Silas bounce-with-cost-0 variant.
- `scorer.ts`: Zephyrs scorer per §10.7; deterministic ranking of all non-token Core defs for a state; weights in one exported object.
- `aiPolicy.ts`: uniform choice from `legalActions`, `endTurn` when it is the only option or with `AI_END_TURN_PROBABILITY`; prompts answered uniformly; used by My Pawn and "Targets chosen randomly".
- `heroPower.ts`: the 7 powers with X, once-per-turn flag, `activatePower` action, radiant variants.
- `comboIndex.ts`: grade counter, threshold check, E→S cascade, S terminal (R27).
- `callToChaos.ts`: the 10 effects, recursion counter with `CALL_TO_CHAOS_CHAIN_CAP` (R28), radiant "two effects, one guaranteed recursion".
- `lethal.ts`: projected damage of a declared attack after armor and cap versus hero health (R44).
Acceptance: each subsystem has a test file with at least one case per bullet in its spec row; `scorer.rank(state)` returns a total order that is stable across runs; `aiPolicy` given a seed produces the same action sequence.

**M3 gate.** R62's end-of-turn half (end-of-turn triggers, then the trap window, then delayed effects, then cleanup) has a named test now that traps and delayed effects exist; all effects and subsystems tested; `engine/test/rulings.test.ts` exists with one `it("R<n> …")` per §11 row (R1–R168) (rows that only concern cards may delegate to the card test and reference it by name in a comment).

### M4 — Catalog and card scripts (`packages/cards`)

**M4-T1 Catalog data.** Files: `cards/catalog.json`, `cards/test/catalog.test.ts`, `shared/src/catalog-types.ts`.
Schema per card:
```json
{
  "id": "core-043", "index": "43", "name": "Big Felinor", "set": "Core",
  "type": "Unit", "tags": ["Felinor"], "rarity": "Rare", "token": false,
  "cost": 3,                       // number | "X" | { "base": 2, "embiggen": 4 }
  "base":    { "attack": 3, "health": 10, "keywords": [], "text": "…" },
  "radiant": { "attack": 6, "health": 20, "keywords": [], "text": "…" }
}
```
Tokens use `index` `"51.1"`, `"65.1"`, `"90.1"`, `"93.1"`, `"95.1"`, `"T-rush"`, `"T-sheep"`, `"T-felinor"`, `"T-bread"` and `"token": true`. `rarity` is the value in SPEC §8 (assigned by complexity), not the source list's grouping (§8, rarity paragraph). Apply every row of §5.3.
Acceptance (`catalog.test.ts`):
- Exactly 100 entries with `token: false` and 9 with `token: true`; indices 1–100 each present once.
- For every entry, `cost`, `type`, `tags`, `rarity`, `base.attack/health`, `radiant.attack/health` equal the values in SPEC §8 (encode §8 as a fixture table in the test; the test is the diff).
- Rarity counts: 35 Common, 37 Rare, 16 Epic, 7 Legendary, 5 Mythic.
- Every `tags` value is one of Human, Felinor, KY, CN, Fruit, "Call to Chaos", Quickdraw, Token.
- Cards with no radiant text in §8 (#38, #80, #93.1, #95.1, #96 and the shared tokens) have `radiant` equal to `base`.

**M4-T2 Script contract and registry.** Files: `cards/src/index.ts`, `cards/src/scripts/NNN-slug.ts`.
Each script file exports `{ def: CardDef, base: Script, radiant: Script }` with `Script = { cost?, cry?, death?, startOfGame?, resume?, delayed?, setStat?, startOfTurn?, endOfTurn?, aura?, triggers?, activate?, onPlayHook?, handTriggers?, staticFlags?, targets?, modes? }` (§10.9). `targets` and `modes` declare the prompts the play action needs so the client and `legalActions` can build them without running the script. Hooks return `Effect[]`. `catalog.query({ type, cost, costRange, tags, notTags, rarity, set, excludeIndex })` lives here and is the only random-pool source (§5.1).
Acceptance: a registry test asserts every catalog id has a script and every script has a catalog entry; `catalog.query` never returns a token unless `tags` includes `Token`, and never the `excludeIndex`; the KY pool is exactly #31, #51, #82; the trap pool is exactly #18, #41, #60, #71, #85, #96; the Legendary pool for Transmogulate is exactly #52, #85, #87, #92, #93, #95 (the §8 Legendary set minus #83, R35).

**M4-T3 Test template.** Files: `cards/test/_harness.ts`, `cards/test/NNN-slug.test.ts`.
`_harness.ts` gives `scenario({ seed, p1: { hand, field, library, health, mana }, p2: {…} })` builders that place real instances, `playFrom(hand)`, `attack`, `answer`, `endTurn`, `view` and assertion helpers (`expectInZone`, `expectStats`, `expectEvents`). Every card test file covers, for base and radiant separately, each behaviour named in its §8 row plus the "must-pass" cases in the table below.
Acceptance: `pnpm test --filter cards` runs 109 test files; a script that lists catalog ids without a test file (`cards/scripts/missing-tests.ts`) prints nothing.

**M4-T4 Implement cards in waves.** Wave 1 first (keywords and single primitives), then Wave 2 (stored state, prompts, delayed and cross-turn effects, traps), then Wave 3 (subsystems). Within a wave, go in index order. A wave is done when every card in it passes its tests and the fuzz gate (M4 gate) still passes with those cards added to the fuzz deck pool.

| # | Card | Wave | Must-pass cases (base; radiant) |
| --- | --- | --- | --- |
| 1 | Big D-fender | 1 | DEF ally takes 3 less (1 position + 2 aura), ATK ally unaffected; it never attacks; radiant +4 |
| 2 | Bigot | 1 | Destroys chosen enemy non-Human, Human not targetable, no target → enters anyway; radiant clears every enemy non-Human, Humans survive |
| 3 | Right-house defender | 2 | Shield eats first hit; dies → returns at 1 without Reborn; radiant Death summons a base Right-house defender on both deaths while Reborn keeps its zone (R8, R64) |
| 4 | Gary the Gambler | 2 | Fixed seed → fixed stats; heads+tails = 5 (radiant 7 at +2 each); Lucky has no effect (R32) |
| 5 | Stockpile | 1 | Draw 2, heal 2 (hero may exceed 30); hand cap burns; radiant 5/5 |
| 6 | Mana Well | 1 | Turn-4 player has 5 mana; leaves → back to 4; radiant 6 |
| 7 | Jewelosco Scarab | 1 | Discover offers 3 distinct 2-cost non-token cards, never #7; radiant 3-cost pick costs 2 |
| 8 | Mr. Vanilla | 1 | Sheepish fires and does nothing; Fuse-onto refused; Vanilla copy by Postdoc still allowed (copy is stats only) |
| 9 | Moths to the Flame | 2 | Each enemy unit attacks it in lane order at controller's start of turn, no exertion spent, sick units included, each attack is its own combat, stops when Moths dies (R53); radiant Armor 1 reduces each hit (R53) |
| 10 | Rapid Replenish | 1 | 2 prior plays → no draw; 3 → draw 3; radiant 6; counts as played either way |
| 11 | Tempo Timmy | 1 | Attacks a unit on summon turn, not the hero; kills a 3-health unit unharmed; radiant may hit the hero |
| 12 | Duplicating Felinors | 2 | Copy lands in the leftmost free zone (R64), its Cry does not fire, buffs copied, damage not (R57); board full → no copy |
| 13 | Jlockeed Shredder-10 | 1 | Controller's end of turn: 2 to every enemy unit and hero as separate instances; units it kills die after all hits land (R59); not on the opponent's end; radiant 5 (R51) |
| 14 | Jlockeed's Weapons | 1 | Allies +4 attack, Rush, First Strike while present; later summons get it; gone when destroyed; radiant +10 |
| 15 | Me and Mr Token | 1 | 1 Rush Token; radiant 3; fewer when the board is nearly full |
| 16 | Hit Job | 1 | Target destroyed; Indestructible survives; radiant also kills same-side neighbours, never across |
| 17 | Flood | 1 | Bounces both sides, tokens vanish, hand cap burns; radiant three modes each tested plus draw 1 |
| 18 | Bread and Butter | 2 | Fires in the trap window at either player's end with unspent mana (R62), token to trap controller (R52), X = unspent, 0 → nothing, stays; radiant 3X |
| 19 | Midrange Menace | 1 | Taunt enforced; heals to full at own end of turn; radiant Immutable refuses Sheepish |
| 20 | Pointmaster | 1 | First Strike; radiant Divine Shield |
| 21 | Hinder | 2 | Auto-casts on draw and draws again; opponent's next refresh −1 floored at 0; counts as played (R40, R70); radiant −2 |
| 22 | Carnivorous Cube | 2 | The Tribute choice travels in the play action (R81) and excludes itself, chosen permanent sacrificed and remembered; Death → 2 copies (radiant fills board), backrow permanents copy to backrow, copies keep `statsOverride` (R41); nothing eaten → Death does nothing (R41) |
| 23 | Reoccurring Dream | 2 | Seeded 30% roll on a non-Radiant hand card (R60); returns to hand at end of turn; hand full → burned; radiant two rolls at 40% keeping a success |
| 24 | Efficiency Dividend | 2 | X chosen with the play, bounded by mana (R81); three modes; next-turn mana +floor(X/2); returns to hand; radiant uses X+1 |
| 25 | 4-mana 7/7 | 1 | Armor 7 zeroes a 7 hit; radiant Indestructible: no damage, sacrifice and exile still remove it |
| 26 | Glowy Jelly Bean | 1 | Chosen hand card gets radiant flag, picked as part of the play rather than a prompt (R81); radiant chooses 2, or the one card available |
| 27 | Blood Ridden Glowy Jelly Bean | 2 | Cast on draw; a random non-Radiant hand card becomes Radiant (R60); 5 health lost ignoring Going Long (R18); radiant 2 cards |
| 28 | Knockoff Temu Glowy Jelly Bean | 1 | 2 different non-Radiant cards across library+hand+field (R60); a field unit swaps base stats in place keeping damage (R22); radiant 5 |
| 29 | GIGA Glowy Jelly Bean | 1 | Uncastable at 4 mana, castable at 6 after gains; whole hand radiant; radiant also permanents |
| 30 | Archivist | 2 | Mode chosen with the play (R81); highest/lowest by current cost, ties nearest top, X counts 0 (R24); radiant draws both |
| 31 | KY's Math Equation | 2 | Cost 1 → 1 damage, returns at cost 2 → 2, cost 3 → 3, cost 4 → 5; clamps at 89 (R25); player discounts don't change the damage (R67); radiant Fib(cost+2) |
| 32 | Prem Panther | 2 | Rush; draw 2 on a combat kill, none when it dies without killing; radiant Cleave kills draw per kill (R42) |
| 33 | Unstable Clone Machine | 2 | After each play, library +3 fresh copies with the radiant flag preserved; token spells copied (R34); nothing is added to a 60-card library (R80); radiant one radiant copy |
| 34 | Collateral Damage | 1 | Exiles an Indestructible permanent and a random opponent library card; radiant same-row neighbours too |
| 35 | Lunar Eclipse | 2 | 3 damage; next spell this turn −1; a unit play does not consume it; expires at cleanup; radiant 6 / −2 |
| 36 | Magic Jammed | 2 | Destroy backrow and lock zone, locked zone rejects play; radiant steals into same-lane zone else first free, original zone locked, trap identity visible to thief (R33) |
| 37 | Gravedigger | 1 | Random GY card to hand at start of turn before the draw; empty GY nothing; radiant Discover at −1 |
| 38 | Quickstriker | 2 | First play deals 0, second 1, third 2 to the enemy hero; nothing when not on the field; no radiant change |
| 39 | Recycling Initiative | 2 | Exiled on play; end of turn adds copies of every other card played this turn, including later ones (R71); radiant copies cost 1 less |
| 40 | Echoes of the Forgotten | 1 | Start of turn: damage = exile count, then bottom card exiled; empty library → no exile, no fatigue; radiant +3 |
| 41 | Sheepish | 2 | Opponent's unit becomes a Sheep before its Cry (R17); trap consumed; Immutable target → consumed with no effect; radiant adds 0-cost Lava Golem |
| 42 | Eugenics | 1 | 8 random exiled (all if fewer); 30% per remaining card; radiant two rolls at 40% |
| 43 | Big Felinor | 1 | Non-Felinors on both sides destroyed, Felinors and itself survive; radiant enemy side only |
| 44 | True Strike | 1 | 4 damage through Armor 7; Divine Shield still blocks; exiled; radiant 9 |
| 45 | Deft Duelist | 2 | Charge; attack then switch and switch then attack in one turn (R49); radiant Armor 1 |
| 46 | Suppressive Aura | 2 | Embiggen price chosen with the play (R81); −2/−2 to all, 2-health units die, restored on leaving; radiant enemy only −4/−4, paid 4 → −10/−10, which kills an enemy The Rock despite Indestructible (R69) |
| 47 | Fig of Life | 1 | Heals a unit up to max or the hero without cap (R19); radiant 50 |
| 48 | 5pek Controller | 1 | Every unit switches, exertion untouched (R20), Spikey Pillow stays ATK; radiant enemy-only mode |
| 49 | Snom Bunny Mind Control | 1 | Steal placement per R15; radiant sets the flag on the stolen card |
| 50 | Kpop Fanatic | 2 | Steal fires at your next start of turn even if it died (R76); fizzles if the target left; radiant Divine Shield |
| 51 | KY's Private Tutor | 2 | Only types and brackets with a match offered; 3 random matches revealed; no match → Notebook; Field Trap counts as Trap; radiant runs twice |
| 51.1 | KY's Empty Notebook | 1 | Draw 1; radiant 2; absent from every random pool |
| 52 | Silly Silas | 3 | Rotate both rings either direction, control changes on crossing, damage travels, Silas moves too; Locked destination bounces; radiant bounces crossing cards to their owner's hand at cost 0 (R14) |
| 53 | Reno | 1 | 12 → 30; 35 stays 35; radiant 60 |
| 54 | Straaza | 1 | 2 random units of cost 3 or 4, no tokens, not #54, cost override 1; radiant 0 |
| 55 | Lava Golem | 2 | Tribute 3 counts enemy units and Sheep as 2, enemies sacrificed; Taunt and Armor 3; radiant Indestructible; Sheepish's free copy still needs tributes |
| 56 | Jilliax | 1 | All four keywords; radiant Charge and Indestructible |
| 57 | Conjure KY | 1 | Pool exactly #31, #51, #82 with repeats allowed; radiant 2 base + 2 radiant |
| 58 | Rush Token Farm | 1 | Token each start of turn; radiant +3/+3 aura only on Rush Tokens |
| 59 | Unbiased Immigration | 2 | Random non-token card each start of turn; paid 4 → cost 0; radiant gives a radiant card |
| 60 | Bear Honeypot | 2 | Fires after the opponent's ≤1-cost play resolves (R17, R56); a unit is attacked by each token in order until dead, one combat each (R53); radiant any card and fills the board |
| 61 | Prejudiced Postdoc | 2 | Vanilla copy of a Human keeps the target's form and buffs, no keywords or text, no damage; auras apply afresh; an Immutable target is legal (R23, R57); radiant any unit |
| 62 | Friend of Felinors | 1 | Fills empty zones only; radiant then +2/+2 to every unit you control including the new tokens |
| 63 | Plastic Surgery | 1 | +3/+3 and one pool keyword the unit lacks (R21); radiant +6/+6 and two distinct keywords |
| 64 | Gifted Program | 2 | First ≤1-cost card each turn is radiant before it resolves (its Cry uses radiant text); second is not; radiant threshold 2 (R56) |
| 65 | Masochism Mask | 2 | In opening hand (Quickdraw); start-of-turn mode prompt; "lose 3" ignores armor; radiant two picks including "nothing" |
| 65.1 | Spikey Pillow | 2 | Cannot switch to DEF; your units −2 attack floored at 0; radiant excludes other Pillows |
| 66 | The Rock | 2 | Play refused without a tribute; Indestructible; radiant Immutable |
| 67 | Zoomerbin Oomen | 2 | Random trap face-down and unpaid into own lane's backrow; occupied or Locked → nothing (R47); pool = six traps |
| 68 | Twisted Sorcerer | 1 | 4 damage, 8 when hero < 10 at resolution; radiant 6 / 12 |
| 69 | Call to Arms | 1 | Three top-down recruits of cost ≤1, library order otherwise kept, stops when the board fills; radiant ≤2 |
| 70 | Spiteful Stab | 1 | 2 + floor(missing/5) + exile count; radiant 4 + floor(missing/3) + exile |
| 71 | Intern Stimmy | 2 | Trap window at the end of any turn with library > opponent's → recruit ≤1 (R62); fires again next qualifying turn; radiant ≤2 |
| 72 | Reminisce | 1 | Discover from the GY including spell tokens (R50); chosen card −1 (radiant 0); exiled; empty GY → nothing |
| 73 | Anti-oneshot Armor | 2 | A 12 hit becomes 5 (radiant 3), per instance, hero only; Cry draws 1 |
| 74 | Adaptive UI | 1 | X=2: 2 damage, heal 2, draw 2, a 2/2 Rush Token; radiant 4 / 6 / 4 / 6-6; X=0 nothing but counts as played |
| 75 | Infinite Reserves | 2 | Empty-library draw yields a Rush Token card and no fatigue damage; radiant Cry draws 3 |
| 76 | Field of Dreams | 2 | Hand of N → N Reminisce, old cards in GY (R31); exiled; radiant gives radiant Reminisce |
| 77 | Professor Curvature | 2 | Next turn only: current-cost-4 cards −1 (radiant −2); not this turn; expires (R48) |
| 78 | /fullsend | 2 | +4 mana; −1 cost this turn; each play draws 1; hand exiled at end of turn; radiant −2 |
| 79 | Twinspell | 2 | Next spell echoes once (radiant twice); consumed to GY on use (R30); survives cleanup |
| 80 | Zao Gao | 2 | Discard prompt for 2 or fewer; two Rush Tokens each with two distinct pool keywords |
| 81 | Radiant Saintess | 2 | Cry makes every unit you control radiant including itself (R22); Death does it again; radiant Reborn body fires Death on its second death |
| 82 | KY's Trial | 2 | Three distinct numbers 1–100 never 82 or a token index (R54); chosen card is radiant; radiant costs 0 |
| 83 | Transmogulate | 3 | Zone counts preserved; board cards replaced by same-type Legendaries in place; pool is exactly #52, #85, #87, #92, #93, #95, and a Field Trap becomes Unlicensed Experimentation (R35); radiant gives radiant cards |
| 84 | Going Long | 2 | In opening hand; embiggen 2 → Armor 2, 4 → Armor 5 on the hero; radiant 4 / 10 |
| 85 | Unlicensed Experimentation | 3 | Fires after the Cry of a permanent the opponent played (R17); tokens, Recruit and copies don't set it off (R61); fuses onto a random same-type permanent per R77: stats summed, keywords unioned, cost capped at 4, the target instance kept with its damage and position; opponent's card gone with no Death trigger; Immutable permanents are never chosen and with no legal target the trap is consumed for nothing (R61); radiant fuses onto all |
| 86 | "Miss" Mrow | 2 | Cannot attack; Death steals enemy units in lane order, each placed per R15, excess stay; radiant may attack |
| 87 | Pocket Chaos | 3 | Health swap, lane-preserving board swap including face-down traps with locks staying put, library swap that transfers ownership of the swapped cards (R73); opponent gains a Pocket Chaos; exiled; radiant may skip the gift |
| 88 | Twisting Nether | 1 | Every permanent on both rows destroyed, Indestructibles survive; radiant enemy-only mode |
| 89 | Corpse Eater | 2 | In hand it gains the dying unit's current attack and max health from either side, tokens excluded (R11); stats per R38; stops once on the field; radiant double |
| 90 | CN-Viral Injection | 1 | Virus shuffled into the opponent's library at a random position; radiant virus is radiant |
| 90.1 | CN-Virus | 2 | On draw: 1 damage through the pipeline (Going Long reduces it), 2 copies shuffled, draw again; a chain stops at 20 casts (R58); radiant 3 copies |
| 91 | Fed Fauci | 2 | One Plague Token per damage instance; +1 mana per token at start of turn (radiant +2); counters reset on leaving |
| 92 | Felinor Fiender | 3 | Plays onto an occupied zone; card beneath is dormant; stats = printed + all your Felinors including dormant ones (R13, R39); radiant Charge |
| 93 | Combo-Index | 3 | Grade 1 needs 1 play, grade 2 needs 2; cascade E→new grade in order; E adds a copy (R27); S terminal (R27); radiant adds Combo-Fodder each start of turn |
| 93.1 | Combo-Fodder | 1 | 2 damage with Lifesteal; no radiant change |
| 94 | Genn's Greed | 2 | Draws every 2-cost card; odd current-cost cards exiled from library, hand and GY, X-cost exempt (R26, R66); +2 mana (radiant +6) |
| 95 | Call to Chaos (Core Edition) | 3 | Each of the 10 effects has a test; recursion stops at 20 (R28); radiant rolls the recursion plus one of the other 9 effects (R28) |
| 95.1 | Chaos Golem | 1 | 10/10 with all four keywords |
| 96 | My Pawn | 3 | Lethal detection accounts for armor and the cap (R44); attack cancelled; AI finishes the turn deterministically from the seed; opponent's actions rejected until end of turn |
| 97 | Zephyrs | 3 | Scorer deterministic; a lethal-enabling card ranks first when lethal exists; Discover offers the top 3 (R29); exiled; radiant picks are radiant |
| 98 | Heroic Power | 3 | In opening hand; power chosen at start of game from the seed; playing costs the power's X and activates once; a copy created mid-game, mulliganed back into the library, or bounced to hand still has a power (R43); once per turn afterwards; Indestructible; each radiant power variant |
| 99 | Craft a Card | 3 | Two Discovers, fused def in `transientDefs` with both forms fused, no on-field target and the ingredients' shared type (R77), cost 0 in hand, making it Radiant later switches to the fused radiant form; radiant three |
| 100 | Ceaseless Void | 2 | Cost = 100 − (drawn + played + destroyed + exiled by both players), floor 0 (R55); Cry exiles every other permanent; radiant Charge |
| T | Rush, Sheep, Felinor, Bread Tokens | 1 | Vanish on leaving the field; Sheep counts 2 toward Tribute; Bread is X/X with no text; none in random pools |

**M4 gate.** `cards/test/fuzz.test.ts`: 1,000 games per wave (seeds 1–1000) with decks drawn randomly from all implemented cards, played by `aiPolicy`, never throw, always terminate (hero death or cap), and replay to the same hash. Any card that appears in a failing seed is listed in the failure message. A fuzz game is bounded at `TURN_CAP_PLAYER_TURNS` × `AI_PLAYOUT_STEP_CAP` actions. The bound is a failure condition, not a pass condition: a game that reaches it is reported as non-terminating rather than left to hang CI, and a policy that returns no action while the game is live is reported as a stall, since R82 should have ended the turn.

### M5 — Hotseat client and animations (`apps/web`)

**M5-T1 Board rendering.** Files: `web/src/game/Board.tsx`, `Zone.tsx`, `Hand.tsx`, `Hero.tsx`, `Backrow.tsx`, `Log.tsx`.
Render `PlayerView` only. Five lanes as columns, each column showing the opponent's backrow, opponent's unit, your unit, your backrow (top to bottom). Cards show cost, name, attack/health (current over max), position (DEF rotated 90°), keywords as icons, radiant glow, plague and grade counters, face-down backs for opponent traps and for cards under a Stack. Every interactive element carries a `data-testid`: `zone-<side>-<row>-<lane>`, `card-<instanceId>`, `hero-<side>`, `hand-card-<instanceId>`, `end-turn`, `offer-draw`, `power`.
Acceptance: a snapshot test renders a fixture `PlayerView` with 10 units, 10 backrow cards and a stacked pile without layout overflow at 1280×720 and 390×844; the opponent's hand renders `count` cards backs and no names.

**M5-T2 Actions and prompts.** Files: `web/src/game/Prompt.tsx`, `web/src/game/actions.ts`.
Clicking a hand card highlights legal zones (from `legalActions`); clicking a unit highlights legal targets; attack by drag or click-click; switch via a button on the card; X, embiggen, zone and tribute choices built inline into the `play` action (R81); every `PendingChoice.kind` has a modal or inline picker (`discover` shows the 3 options as cards; `mode` as buttons; `direction` as two arrows, both built into the play action per R81; `tribute` as multi-select on the board; `mulligan` as toggles). The client never computes legality itself; it asks `legalActions` and greys out the rest.
Acceptance: a component test for each prompt kind submits the right `answer` action; an illegal click produces no action; the opponent's seat shows "waiting for choice" and no options.

**M5-T3 Hotseat loop.** Files: `web/src/game/hotseat.ts`, `web/src/routes/dev/hotseat.tsx`.
Runs `reduce` in the browser with a seed and two deck lists from the URL (`/dev/hotseat?seed=42&a=<deckId>&b=<deckId>`); a seat switch button hands the device over and re-renders `viewFor` for the other player; prompts for the non-active player switch seats automatically; exposes `window.__jackioh = { state, dispatch, seed }` when `import.meta.env.MODE !== "production"` for Cypress.
Acceptance: a Cypress smoke (`e2e/01`) plays to completion; the same seed and actions reproduce the same final state hash in the browser and in vitest.

**M5-T4 Animations.** Files: `web/src/game/animations.ts`.
A table `eventType → { animation, durationMs, testid }` with exactly one row per event type in SPEC §10.3. Animations are CSS/Framer transitions triggered by the event stream; the state view updates after the animation for that event completes; a `data-animating="<eventType>"` attribute is set on the affected element for the duration so tests can await it. `prefers-reduced-motion` collapses every duration to 0.

| Event | Animation | Duration | Acceptance |
| --- | --- | --- | --- |
| `cardPlayed` | Card lifts from hand and lands in zone (unit) or flashes centre then to GY (spell) | 400 ms | element gains `data-animating` then appears in the target zone |
| `cardResolved` | Brief settle flash on the resolved card, or on its graveyard pile when it has already left | 150 ms | element gains `data-animating="cardResolved"`; fires once per play, after the Cry and any Echo repeats (§10.5 step 7, R17) |
| `summoned` | Card scales in at zone | 250 ms | same; a permanent played from hand emits `cardPlayed` then `summoned` for the same card, and the client plays the pair as one motion |
| `attackDeclared` | Attacker lunges toward target and back | 350 ms | attacker translates ≥ 20 px toward target |
| `damage` | Red number pops on target, target shakes; hero portrait shakes | 300 ms | `.damage-pop` text equals amount |
| `healed` | Green number pops | 300 ms | `.heal-pop` text equals amount |
| `destroyed` | Card dissolves, then slides to GY count | 350 ms | GY counter increments after animation |
| `exiled` | Card fades to black and shrinks | 350 ms | exile counter increments |
| `bounced` | Card flies to owner's hand | 350 ms | hand count increments |
| `drawn` | Card slides from library to hand (own) or back to hand count (opponent) | 250 ms | hand length or count increments |
| `radiantSet` | Gold glow pulse, stats swap | 400 ms | card has class `radiant` afterwards |
| `positionSwitched` | Rotate 90° / back | 250 ms | transform contains rotate(90deg) for DEF |
| `controlChanged` | Card slides across the centre line to the new zone | 450 ms | card testid now under the other side's zone |
| `trapFired` | Backrow card flips face-up, holds, then dissolves (or stays for Field Trap) | 700 ms | trap name visible during hold |
| `promptOpened` | Modal fades in | 150 ms | modal has `data-prompt-kind` |
| `manaChanged` | Crystals fill/empty | 150 ms | crystal count equals mana |
| `turnStarted` | Banner "Your turn" / "Opponent's turn" | 600 ms | banner text |
| `divineShieldLost` | Shield shatter | 250 ms | shield icon removed |
| `fused` | Two cards merge into one | 500 ms | one card remains with summed stats |
| `rotated` | All cards slide one lane | 500 ms | every card's zone testid changed by one step |
| `gameOver` | Result overlay | — | overlay text Win / Loss / Draw |
| `healthLost` | Purple number pops on the hero, no shake | 300 ms | `.loss-pop` text equals amount |
| `enteredGraveyard` | GY pile pulses | 150 ms | GY counter equals graveyard length |
| `burned` | Card flips face-up above the hand and burns away | 400 ms | card name visible during the burn, then GY counter increments |
| `discarded` | Card drops from hand to GY | 300 ms | hand length decrements |
| `addedToHand` | Card appears at the hand edge (own) or the hand count bumps (opponent) | 250 ms | hand length or count increments |
| `shuffledIn` | Card flies into the library, library pulses | 300 ms | library count increments |
| `buffed` | Stat numbers flash and tick to their new values | 250 ms | shown stats equal the view |
| `keywordGranted` | Keyword icon pops in | 200 ms | icon present |
| `counterChanged` | Counter badge ticks | 200 ms | badge text equals the counter |
| `transformed` | Card spins and shows its new face | 400 ms | card name equals the new definition |
| `swapped` | Swapped health, boards or library counts cross the centre line together | 500 ms | the swapped values are exchanged |
| `locked` | Chain icon closes over the zone | 250 ms | zone has `data-locked="true"` |
| `attackCancelled` | Attacker snaps back with a "Cancelled" tag | 350 ms | attacker back in its zone, tag visible |
| `turnEnded` | End-turn button greys out | 150 ms | `end-turn` disabled |
| `turnAutoEnded` | Banner "No moves left — turn ended" | 600 ms | banner text |
| `promptAnswered` | Modal fades out | 150 ms | no element with `data-prompt-kind` |
| `drawOffered` | Offer toast on the opponent's seat | 150 ms | toast visible to the opponent's seat only |
| `drawAnswered` | Toast resolves to Accepted or Declined | 300 ms | toast text |
| `costChanged` | Cost gem flashes and ticks to the new value | 200 ms | cost gem text equals the view's cost |
| `modifierChanged` | Player modifier badge appears or fades by the hero | 200 ms | badge list equals the view's modifiers |

Acceptance: `animations.test.ts` asserts every `GameEvent["type"]` has a row (fail on a missing one); with `prefers-reduced-motion` every duration is 0 and a full game's event queue drains synchronously.

**M5 gate.** `e2e/01` and `e2e/02` pass against the hotseat route.

### M6 — Server, accounts, collection, loadouts, match actor (`apps/server`, `packages/validator`)

**M6-T1 Auth and invite gate.** Files: `server/src/api/auth.ts`, `codes.ts`, migrations for `profiles`, `invite_codes`, `code_attempts`.
Managed auth provider for email/password; `profiles.status ∈ pending | active | banned`; redemption transaction per §9.4 (verified email required, per-account 5/h, per-IP 20/h, identical error and timing for missing/expired/exhausted, global circuit breaker); 16-char codes from a 32-symbol alphabet without 0/O/1/I/l, stored hashed.
Acceptance: integration tests for each rejection step; timing test shows the three failure responses within 5 ms of each other over 50 samples; a pending account cannot call collection, loadout or queue endpoints (403).

**M6-T2 Collection ledger.** Files: `server/src/api/collection.ts`, migrations `cards`, `collection`, `collection_grants`.
Every mutation writes `collection` and `collection_grants` in one transaction; no client-writable path; catalog version checked on every loadout save and queue request; launch mode grants every card to every active profile.
Acceptance: a direct insert attempt through the public API is impossible (no endpoint); a grant with `reason` writes both tables or neither (fault-injection test); a stale `catalogVersion` gets "update required".

**M6-T3 Loadout validator.** Files: `validator/src/index.ts`, `server/src/api/loadouts.ts`, migrations `loadouts`, `loadout_decks`, `loadout_deck_cards` with the unique index on `(profile_id, card_id)`.
Rules L1–L6 (§9.4) with `DECK_SIZE = 20`, `MAX_COPIES = 1`, no Token-tagged cards, every card in the catalog and not banned; one module imported by both `apps/web` and `apps/server`; `saveLoadout(profileId, catalogVersion, decks[3])` all-or-nothing.
Acceptance: unit test per rule with the specific error message; the unique index rejects a duplicate across decks even when the application check is bypassed (raw SQL test); `apps/web` and `apps/server` both import from `@jackioh/validator` (grep test).

**M6-T4 Match actor.** Files: `server/src/match/actor.ts`, `protocol.ts`, migrations `matches`, `match_actions`, `results`.
One actor per match holding `GameState` in memory, one WebSocket per player, `reduce` on every action, `viewFor` pushed to each player after every change, nonce dedupe, append-only `match_actions` log (seed + ordered actions), crash recovery by folding the log, room-code challenge (`createRoom` → 6-char code → `joinRoom`).
Acceptance: two WebSocket clients complete a scripted game; killing the actor mid-game and reconnecting yields the same `viewFor` for both players; an action with a reused nonce returns the original ack; the opponent's socket never receives the other hand's `defId`s (protocol-level test).

**M6 gate.** `e2e/06` (room-code match) passes with the second player driven by a Node WebSocket client via `cy.task`.

### M7 — Clock, disconnects, results, matchmaking

**M7-T1 Turn clock and grace.** Files: `server/src/match/actor.ts` (alarm), `web/src/game/Clock.tsx`.
Per-turn timer stored on the match and shown to both; expiry → server `timeout` action (auto-answer the open prompts of the player whose clock expired via `aiPolicy`, and end the turn only when that is the active player; a prompt held by the non-active player runs its own `PROMPT_CLOCK_SECONDS` and pauses the turn clock, R79); disconnect grace stored on the match; grace expiry → `disconnectExpired` action → concede; hard wall-clock ceiling with a reaper that resolves stuck matches and clears both players' in-match flags.
Acceptance: fake-timer test drives a timeout; a trap prompt held by the non-active player pauses the turn clock and its own expiry answers only that prompt (R79); a disconnected player who returns inside grace resumes with the same view; past grace they have lost and both can queue again.

**M7-T2 Results and rating.** Files: `server/src/api/results.ts`.
Every terminal reason (hero death, draw accepted, turn cap, concede, disconnect, match ceiling; R79) reaches the engine as its own action (`concede`, `disconnectExpired`, `ceilingReached`) and writes one `results` row and clears in-match state; Elo rating update (K = 32, start 1000; R79).
Acceptance: one integration test per reason.

**M7-T3 Matchmaking.** Files: `server/src/api/queue.ts`, migration `tickets`.
`enqueue` per §9.5 with frozen decks in the ticket, opportunistic pairing on enqueue plus a sweeper, widening ±50 every 10 s from ±100 (uncapped after 60 s), atomic claim of both tickets, queue population endpoint.
Acceptance: two concurrent matchers cannot pair the same ticket twice (race test); editing a loadout after enqueue does not change the match's decks.

### M8 — End-to-end (`e2e/`)

Cypress runs against `apps/web` in `E2E=1` mode (hotseat route and a test server with fixture accounts). No fixed `cy.wait(ms)`; waits are on `data-animating` clearing or on testids. Every spec sets a seed. Scenario decks live in `e2e/fixtures/decks/` and are named for the spec that uses them.

| Spec | Scenario | Key assertions |
| --- | --- | --- |
| `01-hotseat-full-game.cy.ts` | Seeded game to completion via the UI with two aggro decks | result overlay appears; final state hash equals the vitest replay of the recorded actions |
| `02-prompts.cy.ts` | One deck containing Jewelosco Scarab, Hit Job, Flood (radiant), Archivist, Glowy Jelly Bean, Zoomerbin Oomen, Lava Golem, Silly Silas, Efficiency Dividend, Suppressive Aura | each choice picker (`discover, target, mode, hand, zone, tribute, direction, x, embiggen, mulligan`) is rendered once and answered, whether it builds the `play` action or answers a `PendingChoice` (R81) |
| `03-trap-opponent-turn.cy.ts` | P2 has Sheepish set; P1 plays a unit | trap flips during P1's turn; the unit is a Sheep; P1 can continue |
| `04-combat.cy.ts` | Taunt, DEF position, First Strike, Divine Shield on board | illegal target not highlighted; DEF card rotated; damage pops match pipeline numbers |
| `05-reconnect.cy.ts` | Networked game, reload mid-prompt | same view and same open prompt after reload; clock kept running |
| `06-room-code.cy.ts` | Create room, second player joins via `cy.task("wsPlayer")` | both see the board; actions round-trip; game ends and both are queue-eligible |
| `07-my-pawn-ai.cy.ts` | P2 has My Pawn; P1 declares lethal | attack cancelled; P1's controls disabled; AI actions animate; turn ends |
| `08-turn-cap-draw.cy.ts` | Two do-nothing decks, seed with no lethal | after the 30th player-turn the overlay says Draw |
| `09-deckbuilder.cy.ts` | Loadout editor | each of L1–L6 shows its message; a card dragged into a second deck is refused; save succeeds when legal |
| `10-invite-gate.cy.ts` | Pending account | code screen shown; bad code error identical for three failure kinds; good code activates |
| `11-radiant.cy.ts` | Glowy Jelly Bean on a hand card, Knockoff Temu on a field unit | glow animation; stats swap on the field card keeping damage |
| `12-rotation-and-swaps.cy.ts` | Silly Silas, Pocket Chaos board swap | every card testid moves one lane; board swap flips sides |

**M8 gate.** All twelve specs green in CI on Chrome and Electron.

### M9 — Deck library and constructor (`apps/server`, `apps/web`, `packages/validator`)

SPEC §11 R171 and R172. A Hearthstone-style collection manager: an account keeps up to `MAX_LIBRARY_DECKS` named decks beside its §9.4 loadout, builds them by drag and drop, imports them into loadout slots and plays them directly.

**M9-T1 Library store and API.** Files: `validator/src/index.ts` (`validateDeck`, `DeckRules`), migration `0006_decks.sql`, `server/src/api/decks.ts`, `server/src/api/queue.ts`, `server/src/match/rooms.ts`, `server/src/db/store.ts`.
`GET/POST /api/decks`, `PUT/DELETE /api/decks/:id`, all `active`; a save checks the catalog version, trims and bounds the name (`DECK_NAME_MAX_LENGTH`) and runs `validateDeck` with `allowIncomplete`; the queue and both room endpoints take `{ deckId }` as an alternative to `{ deckIndex }` and freeze the deck (R172).
Acceptance: the validator's single-deck check never reports L1 or L4 and accepts a short deck only when asked (`it("R171 …")`); each route has a test for its refusals (pending 403, another profile's id 404, the cap 409, a stale version 409, an illegal deck 422 with the validator's messages); the cap holds under concurrent creates in both stores (`test/db/contract.ts`); `decks` has RLS, a client reads only its own rows and cannot write any (`test:sql`); a `deckId` match freezes the library deck, refuses an incomplete or foreign one and needs no loadout, and editing the deck after enqueue does not change the match (`it("R172 …")` in the queue and room tests).

**M9-T2 Constructor.** Files: `web/src/game/library/*` (`Library.tsx`, `CardFace.tsx`, `CardInspector.tsx`, `library.ts`, `library.css`, `testids.ts`).
Left: pages of full-size cards, as many rows and columns as fit (about 5×3 at 1440×900, 6×2–3 at 1920×1080), turned by arrows at the sides and by ←/→. Right: the deck list, or while editing the decklist as cost-and-name bars sorted by cost. Drag a card onto the decklist or right-click it to add; drag a bar onto the pages or right-click it to remove. Hovering or focusing a bar shows the full card beside the list. Clicking a card opens a full-screen inspector that tilts and rotates the card in 3D (base face in front, Radiant face on the back). `deckSize` and `maxCopies` are props defaulting to `DECK_SIZE` and `MAX_COPIES`, passed through to the validator as `DeckRules`.
Acceptance: component tests for paging (arrows disable at the ends, the page clamps after a resize), both add paths and both remove paths, the size cap, the hover preview, the inspector opening, rotating on drag and closing on Esc, and every validator sentence rendered verbatim.

**M9-T3 Wiring.** Files: `web/src/routes/library.tsx`, `web/src/main.tsx`, `web/src/game/deckbuilder/Deckbuilder.tsx`, `web/src/routes/decks.tsx`, `web/src/routes/play.tsx`.
`/library` behind the §9.4 gate; the loadout editor's "Import from library" copies a library deck into a slot (R171); `/play` picks a complete library deck or a loadout deck.
Acceptance: route tests for each; `e2e/13-deck-library.cy.ts` builds a deck across two pages with right-clicks, saves it, reloads, checks the hover preview and the inspector, imports it into a loadout slot and creates a room with its `deckId`.

**M9 gate.** `e2e/13-deck-library.cy.ts` green, and `05`, `06`, `09` and `10` still green.

## 4. Test strategy summary

- Unit: every engine module, every effect, every subsystem, every card (base and radiant), every validator rule, every server endpoint.
- Property: random combats (M2), random legal-action games per wave (M4), random loadouts against the validator.
- Determinism: every recorded game in CI is replayed by `replay.fold(seed, log)` and hashed; any mismatch fails the run.
- Rulings: `rulings.test.ts` has one named test per §11 row; the review greps for `R<n>` coverage.
- Catalog: `catalog.test.ts` diffs `catalog.json` against a fixture transcribed from SPEC §8.
- Coverage floor: 90% lines in `packages/engine` and `packages/cards`; 100% of card script files have a test file.
- E2E: the twelve specs above, run headless in CI, plus a nightly run of `01` over 20 seeds.

## 5. Definition of done

- `pnpm lint && pnpm typecheck && pnpm test && pnpm test:e2e` all green in CI.
- `catalog.test.ts` passes: 100 cards, 9 tokens, rarity counts 35/37/16/7/5.
- `missing-tests.ts` prints nothing.
- `rulings.test.ts` covers every SPEC §11 row, R1–R168 (script `rulings-coverage.ts` lists any missing id).
- Fuzz gate: `pnpm fuzz` runs 1,000 seeds with the full card pool and prints its own counts (seeds, throws, non-terminations, replay mismatches, endings). `pnpm test` sweeps the same file at a reduced seed count as a smoke wave; the card pool is never reduced, and any exclusion must be a named entry in `POOL_EXCLUSIONS` with a reason, printed on every run so a narrowing cannot be hidden.
- `animations.test.ts` passes: every event type animated, reduced-motion path drains synchronously.
- A networked room-code game between two browsers completes and records a result.
- SPEC.md has a §11 row for every ruling the code makes; no ruling exists only in code comments.
