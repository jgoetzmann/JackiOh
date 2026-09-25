# `@jackioh/cards` — the card layer

110 card definitions (100 cards + 10 tokens), one script file and one test file per card, and the
catalog query every random pool in the game goes through.

`SPEC.md` is the only source of rules and card text. `BUILD.md` M4-T1…M4-T4 is the work order, and
its must-pass table is the per-card acceptance list. This file is the contract *between* the card
files: what a card file looks like, what the harness gives a test, and what order the waves go in.
When this README and SPEC.md disagree, SPEC.md wins and this file is the bug.

```
packages/cards
├── catalog.json                 card data, proved against SPEC §8 by test/catalog.test.ts (M4-T1)
├── src
│   ├── catalog-data.ts          the ONE reader of catalog.json: CATALOG, cardDef(id)
│   ├── query.ts                 SPEC §5.1's catalog.query — the only random-pool source
│   ├── index.ts                 CARDS, registerAll() — the registry (M4-T2)
│   └── scripts
│       ├── _generated.ts        GENERATED list of the script files present — never edit by hand
│       └── NNN-slug.ts          one card, one file: { def, base, radiant }
├── scripts                      tooling (node + fs live here, never in src/)
│   ├── naming.ts                the id <-> filename convention both scripts share
│   ├── gen-registry.ts          rewrites src/scripts/_generated.ts from the directory
│   ├── missing-tests.ts         prints catalog ids with no test file (M4-T3 acceptance)
│   └── validate-catalog.ts      catalog data checks (M4-T1)
└── test
    ├── _harness.ts              scenario() — the only way a card test builds a game (M4-T3)
    ├── globalSetup.ts           regenerates the script barrel before every test run
    ├── catalog.test.ts          SPEC §8 as a fixture table (M4-T1)
    ├── query.test.ts            the §5.1 pools (M4-T2)
    ├── registry.test.ts         every catalog id has a script, every script a catalog entry (M4-T2)
    └── NNN-slug.test.ts         one card, one test file
```

## 1. The card-file contract

**One card, one file, one test file.** (CLAUDE.md rule 6.) The file name is the SPEC §5 index,
three digits, plus a slug:

| card | script | test |
| --- | --- | --- |
| #1 Big D-fender (`core-001`) | `src/scripts/001-big-d-fender.ts` | `test/001-big-d-fender.test.ts` |
| #43 Big Felinor (`core-043`) | `src/scripts/043-big-felinor.ts` | `test/043-big-felinor.test.ts` |
| #51.1 KY's Empty Notebook (`core-051-1`) | `src/scripts/051-1-kys-empty-notebook.ts` | `test/051-1-kys-empty-notebook.test.ts` |
| Rush Token (`core-t-rush`) | `src/scripts/t-rush.ts` | `test/t-rush.test.ts` |

`scripts/missing-tests.ts` is the authority on the pairing: for every catalog id whose test file it
cannot find it prints the id, the card name and the exact path it expected, and it prints nothing
when all 110 are covered. Run it to learn what to call your files:

```
pnpm --filter @jackioh/cards run missing-tests | grep core-043
core-043  Big Felinor  ->  test/043-big-felinor.test.ts
```

**The exports.** Exactly three, per SPEC §10.9:

```ts
// src/scripts/043-big-felinor.ts
// #43 Big Felinor (SPEC §8.2). Destroys every non-Felinor on both sides; radiant: enemy side only.
import { destroy, targetsInScope } from "@jackioh/engine/effects";
import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-043");

export const base: Script = {
  cry: (ctx) => [/* Effect[] */],
};

export const radiant: Script = {
  cry: (ctx) => [/* Effect[] */],
};
```

- **`def` always comes from `cardDef("core-NNN")`.** Never retype stats, cost, tags or rarity in a
  script file: `catalog.json` is the data and `test/catalog.test.ts` is what proves it against
  SPEC §8. A hand-written `def` is a second source of truth and will be rejected in review.
- **The catalog entry is the printed card.** `radiant.text` is the Radiant face written out in full
  (SPEC §8's cell read by its Conventions, R277), never shorthand, because the client prints it
  whole and marks what differs from `base.text`; every Radiant face meets R275's standard
  (`test/radiant-standard.test.ts`, `docs/radiant-audit.md`); and `refs` lists every card or token
  the entry's texts name, by id (R279) — `test/references.test.ts` proves it against the texts both
  ways, so a text that names a card must list it.
- **`base` and `radiant` are both required**, even when they are the same object — a card whose
  Radiant face differs only in what the engine reads off the catalog or its config (its stats and
  keywords, or #38's Combo multiple, `QUICKSTRIKER_COMBO_MULTIPLE`) runs the same script on both
  faces, so write `export const radiant = base;` and say so in a comment.
- The `Script` shape is `{ cost?, cry?, death?, startOfGame?, resume?, delayed?, setStat?,
  startOfTurn?, endOfTurn?, aura?, triggers?, activate?, onPlayHook?, handTriggers?, staticFlags?,
  targets?, modes?, conditionMet?, preview? }` (`packages/engine/src/script.ts`, SPEC §10.9). `resume` is the named
  continuation a prompt answer re-enters (R113), `delayed` the hook a scheduled effect lands on
  (R126), and `setStat` layer 2's stat hook (R116) — 13 card files already export one of them. A spell's script hangs off `cry`: that is the
  on-resolve hook for a Spell as well as the Cry of a permanent.
- `conditionMet` is R195's yellow glow: a pure read of `{ state, self, controller, radiant, zone,
  yourTurn }` that returns whether the card's printed condition holds now (`zone: "hand"` as if
  played now, `"field"` as the card in play reads it), built on the same local predicate the card's
  own resolution uses so the two cannot disagree; it never writes, never draws from `rng` and never
  reads `state.active` (use `yourTurn`).
- `preview` is R280's number a formula comes to now: a pure read of the same context (the card's
  own controller, its running face, the zone, `yourTurn`) that returns `{ label, value }[]`. Each
  `label` is an exact substring of the running face's catalog text — the formula as printed,
  `"Fib(cost+1)"` — because the client prints `{value}` right after its first occurrence; each
  `value` is what the formula comes to if the card resolved now, computed by the same local function
  the card's own hook deals or gains with. `viewFor` shows it wherever the viewer may read the card,
  the other seat's public cards included, so a hook reads only public facts and the card's own face
  and counters — a hero's health, a pile's size, the plays this turn, the active player's mana —
  never a library's contents or order or a hand's cards, and never `state.active`. An empty list is
  no preview. The Core cards with one are #18, #31, #38, #40, #70 and #91; a fixed number already on
  the face (#92's stats, #100's cost, #89's hand stats) and an X chosen at play (#24, #74) have none.

**Purity (CLAUDE.md rules 4 and 5).** A hook is `(ctx: EffectContext) => Effect[]`. It reads
`ctx` and returns effects; it never assigns to `ctx.state`, never calls an engine mutator, never
calls `Math.random` or `Date`, and never awaits. Every effect comes from
`@jackioh/engine/effects` — that barrel is the entire vocabulary a card file has
(`packages/engine/src/effects/index.ts` lists all of it and says which SPEC §6.3 verb each name
implements). If the verb you need is not there, the effect is missing from the engine: report it,
do not reach into state.

**The read surface.** §10.9 lets a hook READ state to compute an effect's argument, and BUILD M3-T1
adds how: `grep -r "state.players[" packages/cards` must come back empty, so a card file names the
FACT it needs and never a field of `PlayerState` — otherwise the state model cannot change shape
without editing every card that reads it. Verbs come from `@jackioh/engine/effects`; facts come
from `@jackioh/engine`, except `instanceOf`, which the effects barrel exports because it resolves a
`TargetSpec` exactly as the verbs do. These are all of them:

| read | what it answers |
| --- | --- |
| `heroOf(state, player)` | `{ health, armor }`, copied (#68's threshold, #70's missing health) |
| `zoneCards(state, player, zone)` | one off-field pile as a `readonly` copy, `library[0]` first (#30, #51, #83) |
| `zoneCount(state, player, zone)` | how many cards are in it (#70's exile, #71's libraries, #76's hand) |
| `cardsPlayedThisTurn(state, player)` | §10.5 step 4's counter, already counting the card being played (#38) |
| `unspentManaOf(state, player)` | the mana a player holds now, which `turnEnded.unspentMana` is as the turn ends (#18's preview) |
| `playedIdsThisTurn(state, player)` | the instance ids played this turn, in order, copied (#39) |
| `playedEarlier(state, player, card)` | §6.2's Combo count: the plays before this card's play, at play time, so a card its own resolution casts is not one; for a card in hand, every play so far; for `null` (a `ctx.self` that has ceased to exist), every play but the latest (#10) |
| `wasPlayedThisTurn(state, player, card)` | the one-shot gate §5.1's "return to hand" spells need (#23, #24, #31) |
| `activeUnitsOf` / `dormantUnitsOf` / `cardAt` / `slotsOf` / `slotOf` | the field, by lane (§3.2, R13) |
| `faceOf` / `statsWithBuffs` / `unitView` | a unit through the §10.4 layers — never off the instance |
| `defOf` / `printedCost` / `effectiveCost` / `queryCost` | a definition and R65's two costs |
| `findInstance` | an instance id, wherever the card has since landed (R98) |
| `instanceOf(ctx, spec)` | the card a `TargetSpec` names on the stay the run aimed at — a chosen card on the stay its prompt or the play offered it on (R174) — or `null` for a hero, for nothing, or for a card buried under a Stack pile (§3.2, R13) (#22's meal) |
| `recalled(ctx, key)` | what the running card remembers under a key (`remember`'s write) — on a fused card, its own ingredient's (R102, #22) |

`zone` is `"hand" | "library" | "graveyard" | "exile"`; the field is not a pile, so read it by lane.
Every one of these but `findInstance` and `instanceOf` returns a number, a boolean or a fresh
`readonly` array, so a card cannot write the game through a value it read; those two hand back the
card itself, which a card file reads and never writes (CLAUDE.md rule 5). Board facts live in
`packages/engine/src/query.ts` (the read half of the surface, next to `src/effects/index.ts`, the
write half); if the fact you need is not there, it is missing from the engine — extend that module
and test it, do not reach into `state.players`.

Randomness goes through `ctx.rng` (seeded, cursor in state) and every pool through
`catalog.query` — see §3 below. A player choice is either a play-time choice you *declare*
(next paragraph) or a `PendingChoice` opened by a `choose*`/`discover*` effect; a card file never
asks a question inline.

**Play-time choices (R81).** Zone, X, embiggen, Tribute, and the targets and modes a card needs for
its own play travel in the `play` action, not in a prompt. Declare them so `legalActions` and the
client can build the pickers without running the script:

```ts
export const base: Script = {
  targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"], notTags: ["Human"] } }],
  cry: (ctx) => [destroy({ of: "chosen" })],   // ctx.targets[0] is the declared pick
};
```
`kind` is `"target" | "hand" | "zone" | "tribute"` for `targets` and `"mode" | "direction"` for
`modes`; a declared `hand` or `zone` pick arrives in `ctx.targets`, a `direction` in `ctx.modes`
(R81). Every choice made *during* resolution — Discover, a chained step, an Echo repeat, a trigger
— is a prompt instead, and prompts are state (SPEC §10.6).

**Instance memory.** Anything a card must remember lives on the instance (`ctx.self.memory`, via
the `remember`/`rememberRandom` effects) so Fuse, copies and replay stay trivial (SPEC §10.1).

## 2. Registering a card — there is nothing to wire

`src/index.ts` is a contract file shared by every card, the harness and the server. **Do not edit
it to add a card.** Drop your file in `src/scripts/` and the registry picks it up:
`src/scripts/_generated.ts` is regenerated from the directory by `scripts/gen-registry.ts`, and the
cards project runs that automatically before every test run (`test/globalSetup.ts`). To regenerate
by hand:

```
pnpm --filter @jackioh/cards run gen            # rewrite src/scripts/_generated.ts
pnpm --filter @jackioh/cards run missing-tests   # catalog ids with no test file (silent = done)
```

`tsc` does **not** regenerate the barrel — a missing import is not a type error — so if you
typecheck without running the tests, run `gen` first or your card is silently unregistered.

What the registry exports, for the server, the client and the tests:

| export | meaning |
| --- | --- |
| `CATALOG`, `CATALOG_IDS`, `CATALOG_VERSION` | all 110 defs from `catalog.json`, script or no script |
| `cardDef(id)`, `cardDefByIndex(index)` | one def, throwing rather than returning `undefined` |
| `CARDS` | `Record<catalogId, { def, base, radiant }>` — one entry per script file present |
| `registerAll()` | `registerCatalog(CATALOG, CATALOG_VERSION)` then `registerScripts(...)`; idempotent |
| `query`, `catalog` | SPEC §5.1's pool query, re-exported from `./query` |

A card with no script file yet is still in `CATALOG` and still playable as data: the engine falls
back to `EMPTY_SCRIPT`. `test/registry.test.ts` is the M4-T2 gate that every catalog id has a
script and every script a catalog entry; it flips to strict when M4-T4 lands the last file.

## 3. `catalog.query` — the only random pool (SPEC §5.1)

```ts
import { catalog } from "../query";        // or: import { query } from "../query";
catalog.query({ type, cost, costRange, tags, notTags, rarity, set, excludeIndex })
catalog.pool("57", { tags: ["KY"] })       // the same, with your own §5 index excluded
catalog.cost(def)                          // R65's out-of-play cost: X reads 0, embiggen reads base
catalog.trapTypes                          // ["Trap", "Field Trap"]
```

`src/query.ts` is a thin typed wrapper over the engine's one filter
(`packages/engine/src/catalog.ts`), so there is exactly one filter in the codebase. It also takes
`index`, `notIndex`, `defId` and `token` for a pool a card names card by card.

The pools the spec pins down, as the argument object to write:

| pool | write | result |
| --- | --- | --- |
| any random card | `catalog.query({})` | the 100 non-token cards |
| KY (#57 Conjure KY) | `catalog.pool("57", { tags: ["KY"] })` | #31, #51, #82 |
| a Trap (#67 Zoomerbin Oomen) | `catalog.query({ type: catalog.trapTypes, cost: 1 })` | #18, #41, #60, #71, #85, #96 |
| Transmogulate (#83, R35) | `catalog.pool("83", { rarity: "Legendary" })` | #52, #85, #87, #92, #93, #95 |
| Call to Chaos (#95) | `catalog.query({ tags: ["Call to Chaos"] })` — **no** `excludeIndex` | includes #95, the §5.1 exception |

**Footgun:** `type: "Trap"` matches the `type` field exactly and so drops the two Field Traps
(#18, #71). Everywhere SPEC says "Field Trap counts as Trap" — #51's type choice, #85's type match,
R35's same-type replacement — pass `catalog.trapTypes`.

Guarantees a card file may rely on, all proved in `test/query.test.ts`:

- **No tokens** unless the query asks for them (`tags: ["Token"]`, `rarity: "Token"`,
  `token: true`, or naming members through `index`/`defId`). #51.1 is "absent from every random
  pool" for exactly this reason.
- **Never the generating card**: pass `excludeIndex` with your own §5 index. A pool that can offer
  the card that made it is a bug (§5.1).
- **Costs read out of play (R65)**: an X-cost card queries as cost 0 and an embiggen card as its
  base price.
- **Deterministic order** (§5 index ascending, tokens last), so `ctx.rng.pick`/`shuffle` over the
  result replays identically (§9.3, R60). Never sort, filter or de-duplicate a pool yourself
  afterwards: that is how two card files end up disagreeing about what "a random unit" means.

`test/query.test.ts` names the four pools the spec pins down — the KY pool (#31/#51/#82), the trap
pool (#18/#41/#60/#71/#85/#96, Field Trap counting as Trap), the Transmogulate Legendary pool
(#52/#85/#87/#92/#93/#95, R35) and the cost brackets — with the exact argument object each one
needs. Copy from there rather than inventing a filter.

## 4. The test harness

Every card test builds its game with `scenario(...)` from `test/_harness.ts` and with nothing else:
it places real instances through the engine's own zone functions, so a test can never assert
against a state the engine could not have produced. Importing the harness also calls
`registerAll()`, so the real catalog and every registered script are live.

```ts
import { describe, it } from "vitest";
import { scenario } from "./_harness";

describe("#43 Big Felinor", () => {
  it("destroys every non-Felinor on both sides and spares Felinors", () => {
    scenario({ p1: { hand: ["core-043"], field: ["core-056"] }, p2: { field: ["core-012", "core-025"] } })
      .play("core-043")
      .expectInZone("core-056", "graveyard")
      .expectEvents("cardPlayed", "destroyed");
  });
});
```

### `scenario(opts)`

```ts
scenario({ seed?, p1?: SideSetup, p2?: SideSetup, turn?, active? })

type DefRef = { def?: string; defId?: string };      // aliases; exactly one, both-and-differing throws

type CostSetup = { costMod?: number; costOverride?: number };   // R78: they persist in every zone

type SideSetup = {
  hand?:      readonly (string | (DefRef & CostSetup & { radiant?: boolean }))[];
  field?:     readonly (string | (DefRef & CostSetup & { radiant?: boolean; position?: "ATK" | "DEF"; damage?: number; lane?: number; stack?: boolean; counters?: { plague?: number; grade?: number } }))[];
  backrow?:   readonly (string | (DefRef & CostSetup & { radiant?: boolean; faceUp?: boolean; lane?: number }))[];
  library?:   readonly (string | (DefRef & CostSetup & { radiant?: boolean }))[];
  graveyard?: readonly (string | (DefRef & CostSetup & { radiant?: boolean }))[];
  exile?:     readonly (string | (DefRef & CostSetup & { radiant?: boolean }))[];
  health?: number; mana?: number; armor?: number;
};
```

A bare string is the same as `{ def }`, every array is `readonly` so an `as const` fixture is
assignable as it stands, and any pile entry may be an object when it needs `radiant: true` — which
is how a test puts a Radiant card on top of a library (#21, #23).

- Lanes are **1-based**; a `lane` given places there, omitted fills left to right (R64).
- `stack: true` (unit zones only) builds a **§3.2 Stack pile**: that entry buries the card already
  in its lane instead of taking a lane of its own, so its `lane` may repeat one an earlier entry
  pinned and, with no `lane` of its own, it lands on the entry before it. Later entries go on top,
  the way a play would put them, so the pile reads top-first and the list reads bottom-first:
  `field: ["core-043", { def: "core-092", stack: true }]` is a Felinor Fiender on top of a dormant
  Big Felinor in lane 1 (R13). A repeated lane without the flag is still the "two cards were given
  lane N" error, and `stack: true` with nothing under it throws rather than quietly making no pile.
- `counters` seeds §10.1's instance counters (`plague` for #91, `grade` for #93), and `costMod` /
  `costOverride` seed §2.3's cost layers in any zone (R78), which is what a ruling read at
  resolution rather than off the printed cost (R65, R66) needs in order to be set up at all.
- `faceUp` is written exactly as given, so `faceUp: false` reads back `false` rather than
  `undefined` — a face-down Trap is a state a test asserts (R33).
- `library[0]` is the **top** of the library: the next card drawn.
- The game starts in the **main phase** of `active` (default `p1`) on `turn` (player-turns, 1-based:
  turn 1 is p1's first, turn 2 is p2's first). The default `turn` is **9** — a mid-game board where
  both sides sit at `MAX_MANA` 4/4 — and the default `seed` is `"jackioh-harness"`. `turnsStarted`
  is derived from `turn` and `active`, so the mana refresh is the real one; `mana` overrides current
  mana without raising max (SPEC §2.3 allows current above max). No mulligan runs, no start-of-turn
  triggers fire and nothing is drawn during setup; the engine's state check runs once at the end of
  it. Units placed by `field` are not summoning sick and have both exertions unspent.
- `reduce` clones the state, so a `CardInstance` captured before a step is a stale object after it.
  Passing a stale instance to a harness method is fine (it re-resolves by id), but read values back
  with `s.card(inst)` / `s.unit(p, lane)` rather than off the object you are holding.
- SPEC §2.5: a turn with nothing meaningful left auto-ends itself, so `endTurn()` can cascade
  several turns forward when both hands are empty. Give each side a card in hand or a unit that
  could switch position when a test crosses a turn boundary.
- A card reference (`string`) may be a catalog id (`"core-043"`), a §5 index (`"43"`, `"51.1"`,
  `"T-rush"`), a card name (`"Big Felinor"`) or an instance id (`"c7"`). With several copies of one
  def in play, hold the `CardInstance` (`s.unit(...)`, `s.hand()[0]`) instead of the string.

### Steps and assertions

| member | what it does |
| --- | --- |
| `play(card, { zone, x, embiggen, targets, modes, tributes })` | the `play` action; `zone` is a lane number. Throws with the engine's message when the play is illegal — that is how a test asserts a refusal: `expect(() => s.play(x)).toThrow(/tribute/)` |
| `attack(attacker, target \| "hero")` | the `attack` action |
| `answer(selection)` | answers the open prompt; a string is an option key (or label/instance id). Call it again for the next prompt in a chain (SPEC §10.6) |
| `endTurn()` | the `endTurn` action: end-of-turn triggers, the trap window, delayed effects, cleanup — and the opponent's turn then starts, so two `endTurn()` calls come back to your own next turn |
| `startTurn()` | runs the engine's start of turn for the player who is active now: turn counter, mana refresh, start-of-turn triggers, one draw, back to main |
| `state`, `events`, `lastEvents` | the live state, every event so far, and the last step's events |
| `view(player?)` | `viewFor` — what that player is allowed to see (§10.8) |
| `unit(player, lane)`, `backrow(player, lane)`, `hand(player?)`, `pile(player, zone)`, `card(ref)` | board and zone readers, returning live `CardInstance`s |
| `stats(card)` | the §10.4-computed `{ attack, maxHealth, health, keywords, armor, position }`. A `CardInstance` has none of those: `health`, `armor` and `keywords` are layers, so read them here (or through `expectStats`), never off the instance |
| `expectInZone(card, "hand" \| "library" \| "graveyard" \| "exile" \| "field" \| "gone")` | `"gone"` is R11's token that ceased to exist |
| `expectStats(card, { attack, health, maxHealth })` | computed through the §10.4 layers, never the printed def |
| `expectEvents(...types)` | those event types appear in that order in `events` (a subsequence) |
| `expectHealth(player, n)`, `expectMana(player, n)` | hero health and current mana |

Everything is chainable and every assertion failure names the card, what was expected and what was
found. The harness is seeded and pure: same seed plus same steps equals the same event log, which
is what makes the fuzz and replay gates meaningful.

## 5. What a card's test file must cover

For **base and radiant separately**: one case per behaviour named in the card's SPEC §8 row, plus
every must-pass case in the BUILD M4-T4 table row for that card. Name a test after the ruling it
pins down when there is one — `it("R64 the copy lands in the leftmost free zone", …)` — so a
ruling change has a failing test with its name on it (CLAUDE.md rule 3).

A card whose script declares `conditionMet` (R195's yellow glow) also proves both answers of its
hook against the branch its own resolution then takes (SPEC §10.9). Those proofs live together in
`test/condition-active.test.ts`, not in the card's own file, because they share one harness for
reading `conditionActive` off `s.view(...)`; the card's own test file names that file in its header.
The same file pins the set of cards that declare the hook to R195's list, so a card that adds one
fails `pnpm test` until its proof and the ruling's list are updated.

A card whose script declares `preview` (R280) proves, on both faces, that each value its view
carries is what its own resolution then deals or gains, that each label sits in its face's text,
and what the hook may read. Those proofs live together in `test/preview.test.ts`, which also pins
the set of cards that declare the hook to R280's six and fences every library and hand off from the
hooks; the card's own test file names that file in its header.

A card is done when its tests are green, `pnpm lint` and `pnpm typecheck` are clean, and the fuzz
gate still passes with the card in the pool.

## 6. Wave order (BUILD M4-T4)

Within a wave, go in index order. A wave is done when every card in it passes its tests and the
M4 fuzz gate still passes with those cards in the fuzz deck pool; do not start the next wave first.

**Wave 1 — keywords and single primitives (45):** #1, #2, #5, #6, #7, #8, #10, #11, #13, #14, #15,
#16, #17, #19, #20, #25, #26, #28, #29, #34, #37, #40, #42, #43, #44, #47, #48, #49, #51.1, #53,
#54, #56, #57, #58, #62, #63, #68, #69, #70, #72, #74, #88, #90, #93.1, #95.1 — plus the four
shared tokens (`t-rush`, `t-sheep`, `t-felinor`, `t-bread`) and The Coin (`t-coin`, which §2.1's
setup deals to the seat going second, R244), which have no §8 row of their own.

**Wave 2 — stored state, prompts, delayed and cross-turn effects, traps (49):** #3, #4, #9, #12,
#18, #21, #22, #23, #24, #27, #30, #31, #32, #33, #35, #36, #38, #39, #41, #45, #46, #50, #51, #55,
#59, #60, #61, #64, #65, #65.1, #66, #67, #71, #73, #75, #76, #77, #78, #79, #80, #81, #82, #84,
#86, #89, #90.1, #91, #94, #100.

**Wave 3 — subsystems (11):** #52 (rotation), #83 (Transmogulate), #85, #87 (Pocket Chaos), #92
(Felinor Fiender/Stack), #93 (Combo-Index), #95 (Call to Chaos), #96 (My Pawn/lethal), #97
(Zephyrs/scorer), #98 (Heroic Power), #99 (Craft a Card).

## 7. Commands

```
pnpm exec vitest run --project cards                 # every card test
pnpm exec vitest run --project cards 043              # one card
pnpm exec tsc -p packages/cards/tsconfig.json         # src + test + scripts
pnpm lint                                             # includes the Math.random / Date ban
pnpm --filter @jackioh/cards run gen                  # rebuild the script barrel
pnpm --filter @jackioh/cards run missing-tests        # M4-T3 gate: silence means covered
```
