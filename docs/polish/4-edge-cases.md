# Polish task 4: edge cases (summoning sickness and control changes)

Design notes for `polish/4-edge-cases`, written 2026-09-22 against `main` at `d04474a`. The brief is
[`reference.md`](reference.md), section 4. SPEC.md is still the rules. This file adds one ruling
(R171) and one clarification (R172), and fixes how R171 is proved and hunted.

The task owns `packages/engine/src/combat.ts` and the control-change paths in `effects/steal.ts`,
`effects/swap.ts` and `subsystems/rotation.ts`. Its SPEC surface is §4.1 and the §11 rows R171–R179.
The hunt's fixes reached well past that: every edit to a file or SPEC section another task owns is
listed, with its reason, under "Merge notes" at the end, and "Hunt status" says where the hunt
stopped.

---

## Goal

Hearthstone's rule is that a minion which changes control is exhausted. In JackiOh, a unit that
changes sides mid-game has to be summoning sick in the same way. Today it isn't:

- `combat.isSick` (`packages/engine/src/combat.ts:73-75`) is `unit.summonedTurn === state.turn`.
- None of the three paths that change control on the field write `summonedTurn` or `exertion`.

So a stolen, swapped or crossing unit keeps the `summonedTurn` it had on the other side, and it can
attack at once.

This was measured, not guessed. A throwaway probe replayed the fuzz games with an event-stream oracle
(the I1 below). On today's engine, legalActions offered **246 sick attacks across fuzz seeds 1–300**.
One example: seed 5, turn 25. Fed Fauci `c58`, owned by p2 and controlled by p1 since that turn, still
had `summonedTurn` 24, and legalActions offered it an attack on the hero. With the one-helper fix
below, the same oracle found **0 violations in seeds 1–1000**.

The task delivers three things:

1. **R171.** A change of control is an entry, applied on every control-change path, with §4.1 text,
   a §11 row and tests. R172 states how a stolen unit dies, which the brief asked to check and SPEC
   never says.
2. **Regression nets.**
   - Fuzz invariants in every random game (I1–I4).
   - fast-check properties over random boards and random control-change sequences (P1–P4).
3. **A hunt.** Loop-until-dry adversarial finders, one per lens (see "Hunt lenses"). Every confirmed
   finding becomes a failing `scenario()` test, then a fix, then a §11 row (R173–R179) if a ruling
   was needed.

---

## Inventory

Every code path where a card changes controller, lane or zone, or re-enters the field, as of
`d04474a`. The "sT" and "exertion" columns say whether the path updates `summonedTurn` and
`exertion`. "(bug)" marks a path that R171 fixes.

### A. Control changes on the field (the R171 paths)

| # | Path | Where | What moves | sT | exertion |
|---|---|---|---|---|---|
| A1 | Steal, one card | `effects/steal.ts:49-75` `takeControl` (remove :57, `placeOnField` :58, which sets `controller` at `zones.ts:139`; `controlChanged` :67-73), called by `steal` :78-87 | the top card of a unit zone, or a backrow card, to the thief's side, placed per R15 | not updated (bug) | not updated: keeps the old side's (bug) |
| A2 | #36 radiant Magic Jammed | `cards/src/scripts/036-magic-jammed.ts` → `steal({ of: "chosen" })` after `lock` | a backrow card (either side) | via A1 | via A1 |
| A3 | #49 Snom Bunny Mind Control | `049-snom-bunny-mind-control.ts` → `steal`, then radiant `setRadiant` | an enemy permanent, either row | via A1 | via A1 |
| A4 | #50 Kpop Fanatic's delayed steal | `050-kpop-fanatic.ts:72` `stealStep` → `steal({ instanceId })`, run by `turn.ts:164` `runDelayed`. This runs after `state.turn += 1` (:143), `resetExertion` (:91-95, called :151) and `turnStarted` (:153) | the chosen enemy permanent, at the start of the Fanatic controller's next turn | via A1. It is the new turn, so the unit attacks at once today: the headline bug | via A1 |
| A5 | Steal all, #86 "Miss" Mrow's Death | `steal.ts:94-105` `stealAll` → `takeControl` per enemy unit in lane order, from `086-miss-mrow.ts:43`. The Death hook runs with `ctx.controller` = the snapshot's controller (`stateCheck.ts` Death firing, R78/R89), on whichever turn Mrow dies | every enemy top unit that finds a free zone | via A1 | via A1 |
| A6 | Board swap, #87 Pocket Chaos | `effects/swap.ts:141-184` `swapBoardNow`: read all zones, remove all (:160-162), `placeContents` (:84-95, :170), `controlChanged` per card (:174-182). The header (:9-16) wrongly says "summoning sickness … come along" | every card in both rows on both sides, **dormant Stack cards included**, to the mirror zone | not updated (bug) | not updated (bug) |
| A7 | Rotation across the centre line, #52 Silly Silas base | `subsystems/rotation.ts:128-190` `rotateRings` (crossing detected :172-186) via `effects/rotate.ts:34-52`. The header (:7-13) wrongly says sickness travels | cards whose ring step crosses sides (your lane 5 ↔ their lane 5, your lane 1 ↔ their lane 1), whole Stack piles | not updated (bug) | not updated (bug) |

### B. Moves that are not control changes

| # | Path | Where | sT / exertion | Verdict |
|---|---|---|---|---|
| B1 | Rotation along one side | `rotation.ts:172-177` (controller unchanged → `return`) | kept | Correct: a lane change on your own side is not an entry (R171) |
| B2 | Radiant #52: a card that would cross to the opponent is bounced at cost 0 instead | `rotation.ts:155-161` → `bounceHome` :98-116 → `draw.addToHand` | reset by R78 (leaves the field) | Correct for the bounced card. As written at `d04474a` it also bounced the opponent's cards crossing the other way; round 2 amended R14 so those still cross, change control and are marked by R171 like any crossing card |
| B3 | Rotation or board swap into a Locked or reserved zone | `rotation.ts:163-170`, `swap.ts:165-168` → `bounceHome` (`swap.ts:102-119`) | reset by R78 | Correct (R14, R88) |
| B4 | Steal that does nothing: already yours (R76), no free zone (R15), off the field | `steal.ts:51-55` | untouched | Correct, and must stay untouched |
| B5 | Library swap (#87) | `swap.ts:191-222` `claimLibrary` | off the field; owner and controller follow the pile | N/A |
| B6 | Leaving the field: destroy, bounce, exile, sacrifice | `zones.ts:240-284` `moveToZone` → `resetInstance` :203-224 (exertion :210, controller back to owner :211, `summonedTurn` deleted :213); `move.ts:31` exile, `:49` bounce; `stateCheck.ts:395` | reset | Correct (R78) |

### C. Entries and re-entries (already set `summonedTurn`)

| # | Path | Where | sT | exertion |
|---|---|---|---|---|
| C1 | Play from hand (Stack onto a pile included) | `playSteps.ts:362-363` | set | fresh: a hand card was reset by R78 or is new |
| C2 | Cast: cast on draw, Echo, Call to Chaos casting | `resolve.ts:174-196` `placeCast` (:189-190), `summoned` from :198 | set | fresh |
| C3 | Summon, Recruit, summonRandom, fillBoard, tokens (Call to Chaos, Heroic Power, Bread and Butter, Bear Honeypot) | `effects/summon.ts:90-108` `summonOnto` (:93), `summonExisting` :129-145, `summonFresh` :111-126 | set | fresh |
| C4 | Copies (#12, #61) | `summon.ts:210-251` `cloneOf` / `summonCopy` | set | fresh (new instance) |
| C5 | Reborn | `stateCheck.ts:229-259` `rebornStep`. It returns to the reserved zone (`reserveZone` :381 in `collect` :370-398), and `placeOnField` (:238) sets `controller` to **that zone's side** | set (:244, R83) | fresh (R78 reset on the way out) |
| C6 | Transform on the field (#41, #83) | `effects/transform.ts:58-84` `replaceOnField`: a new instance, `summonedTurn` = this turn (:71) | set | fresh (new instance) |
| C7 | Fuse onto a target on the field (#85) | `subsystems/fuse.ts:312-330` `keepInstance`: R77 keeps the instance's zone, exertion and `summonedTurn` | kept | kept. Correct: no entry |
| C8 | A dormant Stack card resuming when the top leaves | `zones.ts:146-167` `removeFromField` | kept | kept. Open question Q1 |

### D. Readers of sickness and exertion

- **Attack legality.** `combat.ts`:
  - `hasExertion` :63-67
  - `isSick` :73-75
  - `whyCannotDeclare` :127-144
  - `whyCannotAttack` :156-191, where Rush can't hit the hero at :178-182
  - `attackTargets` :202-209

  `legalActions` enumerates attacks with `attackTargets` (`reduce.ts:309-310`), so the legal list and
  the refusals come from one function.
- **Forced attacks.** `forceAttack` / `forceAttacksOn` (`combat.ts:538-566`) read neither, by design
  (R53).
- **The view.** `viewFor.ts:155-160` `canAct` ("either exertion unspent", only for the active
  controller).
- **The AI.** `subsystems/scorer.ts` and `lethal.ts` go through `canAttack`, so they follow the fix
  for free.
- **Exertion reset.** `turn.ts:91-95` `resetExertion` resets exertion at the controller's own turn
  start, dormant pile cards included.

### E. What a quick patch of R171 breaks

Measured by applying the fix below in this worktree and then reverting it:

- **Engine: one failure.** `test/effects-steal.test.ts:62` asserts that a stolen unit keeps
  `exertion.attacked`. All other engine tests pass (1105 of 1108; the 2 expected-fail stay expected).
- **Pass by coincidence.** `test/rotation.test.ts:183/194` and `test/effects-swap.test.ts:82/107` set
  `summonedTurn = state.turn` before the move and assert it afterwards. They still pass, but they no
  longer prove what their comments claim.
- **Cards: all 112 files green**, including `hotseat-replay.test.ts` with its literal hash, plus a
  200-seed fuzz wave.
- **No import cycle.** `steal.ts`, `swap.ts` and `rotation.ts` importing from `../combat`, as
  `effects/position.ts` already does, causes none.
- **No re-recording.** The recorded hotseat game
  (`packages/cards/test/fixtures/01-hotseat-full-game.json`) plays none of #36, #49, #50, #52, #86 or
  #87, so it stays legal and its hash is unchanged. Re-recording it the way `cd780db` did is **not**
  needed.

---

## Ruling

### §4.1: the text to add

The "Summoning sickness" bullet today:

> - Summoning sickness: a unit cannot attack the turn it entered the field. Rush lifts this for unit
>   targets only; Charge lifts it for units and the hero. A sick unit may still switch to Defense. A
>   unit that enters the field again, a Reborn body included, entered it on that turn like any other
>   (R83).

After the change. The first four sentences are unchanged; two are appended:

> - Summoning sickness: a unit cannot attack the turn it entered the field. Rush lifts this for unit
>   targets only; Charge lifts it for units and the hero. A sick unit may still switch to Defense. A
>   unit that enters the field again, a Reborn body included, entered it on that turn like any other
>   (R83). A unit whose controller changes (stolen, swapped with the board, or rotated across the
>   centre line) has entered its new controller's side on that turn: it is summoning sick in exactly
>   the same way, and its exertion is fresh for its new controller. A unit that only moves between
>   lanes on its own side has not entered anything (R171).

No other SPEC section changes. §6.3's Steal, Swap and Rotate rows, R14 and R73 stay as written: none
of them claims sickness travels, and R171 names every verb.

### §11: R171, inserted after R170 in numeric position

```
| R171 | A change of control is an entry | A card whose controller changes on the field has entered its new controller's side on that turn, which is Hearthstone's rule for a minion that changes control. It takes that turn as its `summonedTurn`, so it is summoning sick exactly as a unit summoned that turn is (§4.1, R83): with neither Rush nor Charge it cannot attack that turn, Rush lets it attack units and Charge units or the hero, whether the keyword is printed, granted, or comes from an aura on its new side. Its exertion is reset for its new controller, so it may switch position that turn, and a Rush or Charge unit may attack even if it had already acted for the player it left. Every path applies it: Steal (#36 radiant, #49, #50's delayed steal, #86's Death), the board swap (#87) and a rotation across the centre line (#52). It applies to every card that changes sides, a card dormant under a Stack and a backrow card included, and to every change, so a unit handed back the same turn to the player who held it when the turn began is sick again, and a Charge unit that already attacked may attack once more. A card that moves between lanes on its own side (a rotation that does not cross) keeps both. A change on the opponent's turn leaves the unit free to attack on its new controller's next turn, as R83 says of a Reborn body. Forced attacks still ignore sickness and spend nothing (R53) | #36 radiant, #49, #50, #52, #86, #87 |
```

### §11: R172, inserted after R171

The brief says "check a stolen Reborn unit". The engine already does the Hearthstone thing, but SPEC
never says what that is. `stateCheck.ts` runs Death with the snapshot's `controller` and returns a
Reborn body to its reserved zone, which is on the side it died on. R12 only says where the body goes
(its owner's graveyard). R172 writes the rest down, and the slice pins it with tests. No engine
change.

```
| R172 | A stolen unit dies as its controller's | A unit that dies under a player who does not own it dies as that player's: its Death hook runs with that player as "you" (R78's last-known state, R89), and a Reborn body returns to the zone it reserved on that player's side (R64), under that player's control and still owned by its owner, as the re-entry R83 describes, so it is summoning sick for the rest of that turn. Between the two it passes through its owner's graveyard (R12). Hearthstone resolves a Deathrattle and a Reborn for the minion's controller in the same way | #3, #81, #86, any granted Reborn (R21) |
```

### Rulings index (`packages/engine/test/rulings.test.ts`)

Insert these after the R170 `it`, beside the other card-proof constants:

```ts
/** R171's and R172's card-side proofs: the six control-change cards and the stolen Reborn bodies. */
const CARDS_CONTROL_CHANGE_TEST = "../../cards/test/control-change.test.ts";

  // Proved by control-change.test.ts's "R171 …" tests (every verb, Rush and Charge, the fresh
  // exertion, same-side moves, Stack piles, the round trip, the opponent's turn),
  // control-change.property.test.ts (fast-check), and the cards package's control-change.test.ts
  // with #36 radiant, #49, #50, #52, #86 and #87.
  it("R171 makes a change of control an entry: summoning sick, with a fresh exertion", () => {
    provenIn(171, "control-change.test.ts", "control-change.property.test.ts", CARDS_CONTROL_CHANGE_TEST);
  });

  // Proved by control-change.test.ts "R172 …" (a fixture Reborn unit) and the cards package's
  // control-change.test.ts with #81 Radiant Saintess and radiant #3 Right-house defender.
  it("R172 has a stolen unit die as its controller's: Death for that player, Reborn on that side", () => {
    provenIn(172, "control-change.test.ts", CARDS_CONTROL_CHANGE_TEST);
  });
```

`provenIn` matches a sibling engine file only on titles that **lead** with the row (`^R171`), so every
proving `it` in the two engine files starts `"R171 …"` or `"R172 …"`. Leave the file's header ("R1 to
R170") and the `describe` title ("R1–R167") alone. All seven tasks insert at this spot, and the
integration branch rewords them once.

### Rows the hunt may need (R173–R179)

These are not added by the slice. The hunt's single fixer assigns R173 upward in the order findings
are confirmed, and only when SPEC really is silent. Until a row exists, a test must never cite its
number: `pnpm rulings:coverage` fails on an `R<n>` that §11 lacks, comments included. Known questions,
with the recommended answer:

- **Q1, Stack resume (lens L4).** When the top of a pile leaves, the dormant card that resumes has
  not entered anything. It keeps its own `summonedTurn` and exertion, unless R171 marked it because
  the whole pile changed sides that turn. This is what the code does today (`zones.ts:146-167`).
- **Q2, Heroic Power across a change of control (lens L1).** R43's `memory.usedTurn` is per
  instance, so a power already used this turn stays used whoever controls it. R171's exertion reset is
  about units attacking and switching, not activated abilities.
- **Q3, an attack whose attacker or target changes side inside §4.2 step 4's window (lens L7).**
  `resolveDeclaredAttack` (`combat.ts:428-443`) does not re-validate. No Core trap changes control in
  that window (My Pawn cancels first, R44), so this is only a finding if a hunter builds a reachable
  case.

---

## Invariants

### Fuzz invariants (`packages/cards/test/_invariants.ts`, wired into `fuzz.test.ts`)

The monitor keeps a **shadow** built only from the event stream, never from `summonedTurn`, so it is
an oracle and not the fix restated:

- `turn`: starts at `beginGame`'s `state.turn` and is updated on every `turnStarted`.
- `entered: Map<instanceId, turn>` and `stint: Map<instanceId, number>`. An **entry event** sets
  `entered` to the current shadow turn and increments `stint`. The entry events are:
  - `cardPlayed`
  - `summoned`
  - `controlChanged`
  - `transformed`, keyed on its `newInstanceId` when that differs from `instanceId`

  `fused` keeps its target's entry (R77). Same-side moves and Stack resumes emit nothing and change
  nothing.
- `lastAttack: Map<instanceId, "turn/stint">`: set by every `attackDeclared` with `forced: false`.
  That includes the attacks My Pawn's AI playout makes inside one reduction (R168: its events are in
  the action's list).

The checks. The first three run before each action, on the state the action is chosen in. I2 and I4
run on each action's `result.events` and `result.state`. Every message leads with its id, names the
instance, def and turn, and cites the SPEC reference, so `signatureOf` groups it.

- **I1: no sick attack is ever offered** (§4.1, §6.1, R83, R171). In the main phase, with no prompt
  open, for every active unit U of the acting player with `entered(U) === state.turn`, read the
  keywords from `unitView(state, U)`:
  - `attackTargets(state, U)` must be empty unless U has Rush or Charge.
  - It must hold no hero target unless U has Charge.

  If the chosen action is an `attack`, check it the same way. Enumerate with `attackTargets` and not
  `legalActions`: it is the source `legalActions` uses (`reduce.ts:309-310`) and costs far less.
- **I2: one declared attack per stint per turn.** A second `attackDeclared` (not forced) whose key
  `"turn/stint"` equals `lastAttack` is a violation. A unit that re-entered (a new stint) may attack
  again within its keywords, as R83 and R171 allow. Forced attacks are excluded (R53).
- **I3: every card on the field arrived by an event.** Every card in either row on either side, a
  dormant pile card included, has an `entered` entry. A card with none means a path put it on the
  field without an event, which breaks §10.3's "every visible state change emits an event".
- **I4: the bookkeeping matches the shadow** (white-box R171). After each action, for every card on
  the field in either row:
  - (a) `summonedTurn === entered(id)`.
  - (b) If `exertion.attacked` is true, then `lastAttack(id)` holds the current stint. An exertion
    left spent across an entry, which is the second half of the bug, trips (b).

- **I5: nothing happens after the game is over** (§2.5, R216), added in round 4. `gameOver` is the
  last event of the action that emits it. Round 4's engine-invariants lens found the rest of an
  effect list, and a trap's consumption, resolving after the check that ended the game.

The fuzz gets one new failure stage, `"invariant"`: `FailureStage` gains the member, the summary line
gains `N invariant violation(s)`, and the first violation of a seed throws
`FuzzFailure("invariant", message, at)`. The monitor is exported for the hunters to reuse:

```ts
export type InvariantMonitor = {
  /** I1 and I3 on the state the next action is chosen in. [] when clean. */
  before(state: GameState, player: PlayerId, action: ActionBody): string[];
  /** Feeds one action's events into the shadow, then I2, I4 and I5 against the resulting state. */
  after(events: readonly GameEvent[], state: GameState): string[];
};
export function createInvariantMonitor(start: GameState): InvariantMonitor;
```

The probe that validated this design ran I1–I3 (I3 on the acting player's active units only). On today's engine it found
246 I1 violations in seeds 1–300, and none of any kind in seeds 1–1000 with the fix. I4 was not
probed. If it fires, first look for a missing entry event. If the engine turns out to be right and
the monitor wrong, fix the monitor and say why in its header.

**Budget.** `pnpm fuzz` must stay within 25% of its time without the monitor (about 100 s for 1000
seeds on an idle machine). Measure it once, alone.

### fast-check properties (`packages/engine/test/control-change.property.test.ts`)

`fast-check` 4.10.1 is already a root devDependency (`node_modules/fast-check`), so there is **no new
dependency** and no lockfile change: `import fc from "fast-check"`. Every `fc.assert` passes
`{ seed: PROPERTY_SEED, numRuns: … }` from named constants in the file, so a failure reproduces
exactly (CLAUDE.md rules 4 and 9 in spirit).

- **Base state.** Use `beginGame` plus both mulligans (the `playing()` pattern in
  `rulings-b.test.ts:401`), which leaves turn 1, p1 active, phase `main`, no prompt. Empty both
  boards, then place the generated one with `fixtures/harness.put`. Build Stack piles with
  `placeOnField(…, { stack: true })`.
- **Arbitrary board.** Per side and per lane, optionally one unit:
  - body from `fixtures/combat`: `plain`, `rusher`, `charger`, `deftDuelist`, `taunter`, `pacifist`,
    `zeroAttack`
  - position `ATK` or `DEF`
  - `summonedTurn` of "this turn", "last turn" or unset
  - any of the four exertion combinations
  - optionally a `stacker` on top, making the unit dormant
- **Arbitrary verbs.** A sequence of one to three, each applied with `makeContext(sinkFor(state),
  null, { controller })` and `effect.apply(ctx)`, the way `effects-steal.test.ts` does. The actor is
  either player, which covers the opponent's-turn case:
  - `steal({ instanceId })` of one of the actor's enemy top units
  - `stealAll()`
  - `swapBoard()`
  - `rotate({ direction, radiant })`

Properties, all titled `"R171 …"`:

- **P1, bookkeeping.**
  - Every card that got at least one `controlChanged` in the sequence has `summonedTurn === T` and
    exertion `{ attacked: false, switched: false }`.
  - Every other card still on the field keeps the `summonedTurn` and exertion it started with. That
    includes cards a rotation moved along their own side and radiant rotations.
  - No card's `owner` changes.
- **P2, the §6.1 oracle.** For every active unit of the active player, let
  `sick = crossed || startedWithSummonedTurn === T`. Then:
  - `sick` with neither Rush nor Charge ⇒ `attackTargets` is empty.
  - `sick` without Charge ⇒ no hero target.
  - `crossed` with Charge, in Attack Position, attack above 0 and no "Can't attack" ⇒ `attackTargets`
    is non-empty. This proves the fresh exertion from outside the code.
- **P3, legalActions and reduce agree.** For every active unit of the active player and every
  candidate target (each enemy top unit, and the enemy hero): `legalActions(state, active)` contains
  `attack(U, t)` exactly when `reduce(state, { type: "attack", … })` returns no error. Fewer runs
  here, because each call clones.
- **P4, R53 holds.** For every crossed unit U and any enemy target, `forceAttack` resolves:
  `attackDeclared` with `forced: true` is emitted, and U's exertion is unchanged.

Keep the whole file under 10 s.

---

## Slices

One slice. The slice's own files are disjoint from every other polish task's by the ownership table
in `reference.md`, and the shared files it edits (`SPEC.md` §4.1 and §11, `rulings.test.ts`,
`fuzz.test.ts`) are edited additively. The hunt that followed it was not confined to them: its fixes
edited files tasks 3 and 7 own, and SPEC and BUILD outside §4.1 and §11. "Merge notes" lists each.

### Slice `r171`

**Files**

| File | Change |
|---|---|
| `packages/engine/src/combat.ts` | new `enterNewSide`; `isSick`'s comment cites R171 |
| `packages/engine/src/effects/steal.ts` | call it in `takeControl`; header comment |
| `packages/engine/src/effects/swap.ts` | call it in `swapBoardNow`; header comment :9-16 |
| `packages/engine/src/subsystems/rotation.ts` | call it for crossing cards; header :7-13; `RotationResult.crossed` doc |
| `packages/cards/src/scripts/052-silly-silas.ts` | comment only: lines 30-31 claim exertion and `summonedTurn` travel |
| `SPEC.md` | §4.1 text, R171, R172 |
| `packages/engine/test/rulings.test.ts` | index rows R171, R172 |
| `packages/engine/test/effects-steal.test.ts` | line 62 expectation, now R171 |
| `packages/engine/test/effects-swap.test.ts` | stop claiming sickness travels (:75 title, :82, :107) |
| `packages/engine/test/rotation.test.ts` | the same (:175 test, :183, :194) |
| `packages/engine/test/control-change.test.ts` | **new** |
| `packages/engine/test/control-change.property.test.ts` | **new** |
| `packages/cards/test/control-change.test.ts` | **new**, through `scenario()` |
| `packages/cards/test/_invariants.ts` | **new**, the monitor |
| `packages/cards/test/fuzz.test.ts` | wire the monitor in; new stage `"invariant"` |

**The fix, exactly.** In `combat.ts`, directly after `isSick`:

```ts
/**
 * R171: a card whose controller changes has entered its new controller's side on this turn — §4.1's
 * "entered the field" for `isSick`, and a fresh exertion for its new controller. Every path that
 * changes control on the field calls this at the moment it emits `controlChanged`, for every card
 * that changes sides (a card dormant under a Stack and a backrow card included), and for nothing
 * else: a card moving along its own side has not entered anything.
 */
export function enterNewSide(state: GameState, card: CardInstance): void {
  card.summonedTurn = state.turn;
  card.exertion = { attacked: false, switched: false };
}
```

Call it once per card, immediately before that card's `controlChanged` push:

- `steal.ts` `takeControl`, after the successful `placeOnField` (after :63).
- `swap.ts` `swapBoardNow`, inside `for (const card of entry.cards)` (:174). Cards that bounced
  (:165-168) never reach it.
- `rotation.ts` `rotateRings`, after `if (card.controller === before[at]) return;` (:177).

Import it as `import { enterNewSide } from "../combat";`.

It deliberately does **not** go in `zones.placeOnField`. That function also places brand-new
instances (play, cast, summon, transform, Reborn) and can't tell a card that was already on another
side. One call beside the one event every control change emits keeps "`controlChanged` ⇔ entered"
true, easy to grep, and checkable by I4.

**Don't** (the slice's rules; the hunt's fixes later went past the second and third bullets, as
"Merge notes" records)

- Add a `CardInstance` field or a `GameEvent` type.
- Touch `placeOnField`, `summon.ts`, `playSteps.ts`, `resolve.ts`, `stateCheck.ts`, `transform.ts`,
  `turn.ts` or `state.ts`.
- Refactor the C-paths.
- Cite R173 or above.
- Re-record the hotseat fixture (§E: not needed).

**Behaviours** (the builder writes each as a test titled with its row)

1. R171 steal (#49): a unit stolen on its thief's turn with neither Rush nor Charge cannot attack that
   turn ("that unit is summoning sick"), and legalActions offers no attack for it. It attacks normally
   on the thief's next turn.
2. R171 Rush: a stolen Rush unit (#56 base) may attack an enemy unit that turn but not the hero
   ("Rush cannot hit the hero on its summon turn").
3. R171 Charge and fresh exertion: a stolen Charge unit (#45) that attacked for its owner the turn
   before may attack the hero on the turn it is stolen.
4. R171 switch: a stolen unit that switched position for its owner may switch again on the turn it
   is stolen, and legalActions offers the switch.
5. R171 Kpop (#50): the delayed steal at the start of the Fanatic controller's next turn leaves the
   stolen unit sick for that whole turn. It attacks on that player's following turn.
6. R171 Mrow (#86): if Mrow dies on its controller's own turn, every stolen unit is sick that turn. If
   it dies on the opponent's turn, the stolen units are free to attack on the thief's next turn.
7. R171 board swap (#87): every card that changes sides takes the current turn as `summonedTurn` and
   fresh exertion, dormant Stack cards and backrow cards included. Units the caster receives are sick
   that turn. Units the opponent receives attack freely on the opponent's next turn.
8. R171 rotation (#52): a card crossing the centre line takes the current turn and fresh exertion. A
   card moving along its own side keeps both: a ready unit can still attack, and an exerted one still
   cannot. Radiant #52 bounces the cards that would cross to the opponent, and the opponent's cards
   crossing onto its side still cross and are marked (R14 as amended in round 2).
9. R171 keywords from the new side: a stolen unit gets Rush or Charge from its new side at once.
   - Rush from the thief's #14 Jlockeed's Weapons lets it attack units only.
   - #49 radiant, by making a stolen #56 Radiant (Charge), lets it attack the hero.
10. R171 round trip: a ready unit that crosses away and back in the same turn (two #52 plays, right
    then left) is sick again. A Charge unit that had attacked and made the round trip may attack once
    more, which is the Hearthstone consequence R171 states.
11. R171 no-ops: a steal that does nothing (the thief already controls the card, R76; no free zone,
    R15) changes neither `summonedTurn` nor exertion.
12. R171 opponent's turn: a unit that changes controller during its new controller's opponent's turn
    is ready on its new controller's next turn. Engine fixture: a steal by the inactive player, then
    `endTurn`.
13. R53 unchanged: a unit that changed sides this turn is still made to attack by a forced attack,
    and spends no exertion.
14. R172 Reborn: a stolen Reborn unit that dies on the thief's side passes through its owner's
    graveyard and returns in the zone it reserved, controlled by the thief, owned by its owner, and
    summoning sick that turn. Proved with an engine fixture and with #81.
15. R172 Death: a stolen unit's Death runs for the thief. #81 radiates the thief's other units, and
    radiant #3 (the face with the Death) summons its base copy on the thief's side.
16. SPEC: §4.1 gains the R171 sentences, §11 gains R171 and R172 in numeric position, and
    `rulings.test.ts` indexes both with `provenIn`.
17. Stale claims fixed: every comment and existing test that said summoning sickness travels with a
    stolen, swapped or rotated card now states R171.
18. fast-check: properties P1–P4 hold at a fixed seed.
19. Fuzz: invariants I1–I4 hold on every `pnpm fuzz` seed, and a violation fails the gate as stage
    `"invariant"`, naming the seed's decks.
20. The hotseat replay is unchanged: `hotseat-replay.test.ts` passes with its committed
    `EXPECTED_HASH`, and the fixture is not re-recorded.

**Where each behaviour is proved**

- `packages/engine/test/control-change.test.ts`, engine fixtures only (the engine never depends on
  `packages/cards`): behaviours 7, 8, 10, 11, 12, 13 and 14 at the verb level, plus the backrow-card
  and Stack-pile halves of 7.
- `packages/cards/test/control-change.test.ts`, real cards through `scenario()`: behaviours 1–10, 14
  and 15.
- `control-change.property.test.ts`: behaviour 18.
- `fuzz.test.ts` and `_invariants.ts`: behaviour 19.

**Commands.** Targeted while working:

```
pnpm vitest run --project engine packages/engine/test/control-change.test.ts packages/engine/test/control-change.property.test.ts packages/engine/test/effects-steal.test.ts packages/engine/test/effects-swap.test.ts packages/engine/test/rotation.test.ts packages/engine/test/rulings.test.ts
pnpm vitest run packages/cards/test/control-change.test.ts packages/cards/test/hotseat-replay.test.ts
JACKIOH_FUZZ_SEEDS=100 pnpm fuzz
pnpm rulings:coverage && pnpm lint && pnpm typecheck
```

Then once, alone, the full `pnpm fuzz`, and time it (see the budget above).

**Done when** every command above is green, the full fuzz passes 1000/1000 within the budget, and
`pnpm test` is green.

---

## Testers

None. The one slice writes its own tests, because every behaviour above needs the SPEC row to exist
before a test can cite it. After the slice lands, the hunt below plays the independent adversarial
role.

---

## Hunt lenses

The method comes from the brief:

- The loop runs until a full round is dry.
- One finder per lens, each reading the code and SPEC through that lens alone.
- A finder never edits `src/`. It writes candidate failing tests in its own new file:
  - `packages/cards/test/hunt-<lens>.test.ts` through `scenario()`, or
  - `packages/engine/test/hunt-<lens>.test.ts` with fixtures.
- Titles are `it("HUNT L<n>: …")` until a row exists.
- A verifier reruns each candidate alone and confirms it against SPEC. One fixer then fixes the
  engine, renames the test after its row, and writes the §11 row (R173 upward) only when SPEC is
  silent.
- After each round, the fuzz invariants I1–I4 and P1–P4 must still hold.
- A lens is dry when a round produces no confirmed finding.

**L1, control change.** Every verb × every moment:

- Verbs: #36r, #49, #50, #52, #86, #87.
- Moments: the active player's main phase, the opponent's turn, the start of a turn (after the
  exertion reset), the end-of-turn trap window, inside a Death, inside a trap.
- Permanents that carry rules across: auras (#1 Big D-fender, #46 Suppressive Aura, #65.1 Spikey
  Pillow, #14 Jlockeed's Weapons), #98 Heroic Power's once per turn (Q2), Field Traps that summon for
  "the trap's controller" (#18), #93 Combo-Index reading its controller's `turnLog`, #92's
  "your Felinors".
- Kpop's target having moved, gone or come back (R76).

Start in `effects/steal.ts`, `effects/swap.ts`, `subsystems/rotation.ts`, `layers.ts`, `traps.ts`,
`subsystems/heroPower.ts` and `subsystems/comboIndex.ts`.

**L2, re-entry and zone moves.**

- Bounce and replay in one turn.
- Reborn (R83, R172).
- Transform's readiness: today a transform is always sick (`transform.ts:71`), while Hearthstone's
  Evolve keeps readiness. See Out of scope.
- Fuse keeping readiness (R77).
- Copies, Recruit, casts, Call to Chaos summons.
- A stolen unit token vanishing (R11).
- A stolen card returning to its owner's hand with `costMod` and `costOverride` kept (R78).

Start in `zones.ts`, `stateCheck.ts`, `effects/summon.ts`, `effects/move.ts`, `effects/transform.ts`,
`subsystems/fuse.ts`, `resolve.ts` and `playSteps.ts`.

**L3, keywords granted or removed.**

- Rush or Charge from an aura on the new side (#14).
- Random keywords (#63 Plastic Surgery, #80 Zao Gao).
- A radiant flip adding Charge: #49 radiant, #28, #29, and radiant faces #11r, #45, #56r, #92r,
  #100r.
- Vanilla removing Charge (#61's copies).
- "Can't attack" (#86 base) and 0 attack (R7).
- R46's Taunt suppression on a stolen Indestructible.
- A keyword gained or lost *between* a declaration and its combat.

**L4, Stack piles and dormancy.** #92 Felinor Fiender:

- Only the top of a pile can be stolen (R13).
- A whole pile swapped or rotated: dormant cards cross and R171 marks them.
- The top leaving on the same turn (Q1).
- A dormant card's exertion.
- Fiender's count of "your Felinors" after a control change (the one dormant exception).

**L5, forced attacks.** R53 and R121 with #9 Moths to the Flame and #60 Bear Honeypot:

- Sick or stolen forced attackers.
- Stolen targets.
- A target changing sides mid-run (the run stops when the target leaves the field; a target that
  stays on the field but becomes friendly is a candidate).
- No exertion spent, no trap window opened, and I2 excluding forced attacks.

**L6, rotation and swap.**

- Rings with locks and reserved zones (R14, R88).
- Piles crossing.
- Face-down traps crossing (R33).
- Silas rotating himself.
- The radiant bounce at cost 0 (`costOverride` kept, R78).
- Uneven boards.
- Both cast by #95 Call to Chaos or repeated by #79 Twinspell's Echo.

**L7, prompts mid-sequence.**

- Control changes inside effect lists that pause (Discover, target, mode), resumed after a
  `JSON.parse(JSON.stringify(state))` round trip.
- R113's order: a steal parked on `state.work` resolves with the right `state.turn`.
- Kpop's delayed steal behind another delayed effect's prompt.
- Q3, the §4.2 step-4 window.

**L8, turn boundaries and delayed effects.**

- Start of turn: `turn += 1`, then exertion reset, then `turnStarted`, then delayed effects (Kpop),
  then triggers (Moths), then the draw.
- End of turn: end-of-turn triggers, then the trap window (#18, #71), then delayed effects (#39,
  #78).
- R82's auto-end, now that a stolen unit can always switch.
- The turn cap.

**L9, `legalActions` and `reduce` disagreeing.**

- `attack`, `switchPosition`, `activatePower` on a stolen #98, and plays into zones a steal emptied
  or #36 locked.
- Prompt answers after a control change.
- P3 is the pattern to copy.

**L10, `viewFor` leaks.**

- `controlChanged` and `swapped` of face-down traps, redacted per R33 and R168.
- A stolen trap readable by its new controller only, and no longer by the previous one.
- `canAct` for stolen units.
- The library swap (R73): no library order becomes visible.
- The opponent's hand counts after a bounce to the owner.

### Round 1: what the hunt found

The ten finders' candidate tests were verified against SPEC, fixed at the root, and moved into
topic files under `packages/cards/test/` (the per-lens scratch files are gone). Rows R173 to R179
were needed; every other finding was already a rule SPEC states.

| Topic file | Findings | Rule |
|---|---|---|
| `forced-attacks.test.ts` | A forced run kept attacking a target that had changed sides (#86 stealing #9 mid-run; radiant #60's tokens against a #52 that crossed first), and kept attacking a Reborn body | R173, R174 |
| `re-entry.test.ts` | #50's delayed steal took a target that was dormant, or had been bounced and replayed or reborn; auras reached dormant cards; a unit token with Reborn vanished; a Reborn unit on top of a pile could not come back; copies dropped a Bread Token's Armor X; radiant #52 left "costing 0" on a burned card (and `addToHand`'s cost riders did the same) | R174, R175, R13, R57, R4 |
| `control-change-carry.test.ts` | A stolen #79 left its grant with the player it left; a turn hook queued for one controller fired for the thief | §8 conventions, R30, §6.2 |
| `vanilla-and-positions.test.ts` | A Vanilla copy kept its static flags, triggers, turn hooks and Death (`scripts.scriptOf` now returns no script for a Vanilla instance); R46 reported a switch that did not happen | R115, R91 |
| `combat-windows.test.ts` | `killerId` credited an earlier non-lethal hit; My Pawn's projection ignored First Strike and Cleave; My Pawn could fire again inside its own AI turn; the AI kept playing after its turn; the AI turn's events were dispatched twice | R42, R176, §5.1, R152, §10.3 |
| `echo-and-exile.test.ts` | No state check between an Echo's resolutions; a self-exiling Spell never took Twinspell's grant or its repeats | §4.5, R178 |
| `fuse-registry.test.ts` | Fused scripts of two matches in one process collided on `t-<n>` | R179 |
| `turn-clock-and-legality.test.ts` | `timeout` acted for the wrong player and stopped after one prompt; a declined draw offer could still be accepted; `activatePower` accepted unreachable ping targets and a forged Discover answer; Heroic Power offered and recorded a chosen X; "this turn" read the opponent's last turn | R79, R36, R103, R43, §6.2 |
| `hidden-information.test.ts` | Prompt options named face-down traps; `transformed` named cards replaced in hidden zones; `costChanged` gave away hidden costs and library order | R177 |

One finding is kept as an expected failure rather than fixed: `legalActions` names a face-down trap
by its instance id, which a player who saw that id while the card was public can read. Ids are the
action protocol's only handle for a face-down target, so closing it is a protocol change (a
per-viewer alias, or a fresh id on entering a hidden zone), not an edge-case fix.

The recorded hotseat game's hash moved once, deliberately: the other player's turn log is emptied at
each turn start (§6.2's "this turn"), and that log is in the hashed state. The log itself replays
unchanged.

### Round 2: what the hunt found

The second round's candidates were verified the same way and moved into topic files; the per-lens
scratch files are gone. Task 4's own range (R171–R179) was used up in round 1, so the rows this
round needed come from the overflow range (`reference.md`: R209 and up, renumbered at integration if
another task took the same numbers).

| Topic file | Findings | Rule |
|---|---|---|
| `lasting-effects.test.ts` | Twinspell's rider outlived the Twinspell (bounced by radiant #52, destroyed by #36) and a bounced-and-replayed Twinspell stacked two; a Twinspell radiant #49 stole and made Radiant still granted +1 | R209 (new) |
| `deaths-and-reborn.test.ts` | §4.5's collection read each dying unit after the ones before it had moved, so an aura or a layer-2 Felinor was missing from its `destroyed` event; the killer was read at death, so an aura's death credited an earlier non-lethal hit; a trigger or turn hook queued for a unit's old stay (#91's Plague Token, #37's hook) acted on its Reborn body; a delayed steal dropped by an earlier one still ran | R89, R42, R174 (amended) |
| `plays-and-casts.test.ts` | A cast skipped §10.5 steps 3 and 5's granted parts (#64, #38, #78) and owed its Echo tail past the draw that cast it, with no state check between cast-on-draw casts; #33 copied before the card resolved and lost the radiant flag of a card #41 replaced; an X-cost Spell kept its X in hand; a sacrificed Reborn unit never came back; a Tribute's Death could fill the zone the play named, leaving the played card in no zone | R70, R59, R17, R57, R65, R210 (new) |
| `my-pawn.test.ts` | A second My Pawn fired on the attack the first had cancelled, and on the player's next turn; My Pawn's consumption pulled it back out of exile, and left it in the backrow through the next turn's start | §4.2, §6.3, R152 |
| `play-choices.test.ts` | A Heroic Power summoned onto the field never rolled; a crafted card's Cry handed every ingredient the whole choice list; #24's damage and heal modes could name no target; `legalActions` did not offer the concede `reduce` accepts while a prompt is open | R151, R102, R90, R211 (new) |
| `control-change.test.ts` | Radiant #52 bounced the opponent's cards crossing onto its side as well as its own; #85 could pick the played #52 that crossed onto its side as its own Fuse target | R14 (amended), R61 |
| `hidden-information.test.ts` | `destroyed.killerId` named a killer back in its owner's hand; a card #83 replaced in a hidden zone read openly in its earlier events | R177 (amended) |

Three engine changes carry most of this:

- **A cast is §10.5's pipeline.** `resolve.castCard` enters `playSteps`' driver at step 3 through a
  registered driver (the same inversion as `registerWorkHandler`), so a cast gets Gifted Program's
  hook, the granted Combo parts, its Echo repeats and its landing exactly as a play does, and owes
  its remainder only at a real pause (R117). The one difference is that it settles nothing itself:
  §2.4's chain runs the state check after each cast-on-draw cast. #38 Quickstriker is now a static
  flag §10.5 step 5 reads off the field, since a trigger on `cardPlayed` read the count whenever the
  event happened to be dispatched.
- **A stay on the field owns what it queued.** Leaving the field drops the card's queued triggers
  and hooks along with its delayed watchers (`zones.moveToZone`), and the state check ends the
  player modifiers a permanent installed once it has gone (R209).
- **The killer is credited at the hit.** `damage.creditKiller` names the source only of the hit that
  takes a unit from above 0 health to 0 or less (or a Poisonous hit), and the state check forgets a
  credit on a unit standing again.

`cardResolved` gained an optional `radiant` (the face that resolved), which `viewFor` hides with the
card; `TargetDecl` gained `forModes`; `StaticFlags` gained `echoGrant` and `quickstriker`. No event
type was added. The `StaticFlags` fields are an additive edit to `script.ts`, which task 7 owns.

Outside §4.1 and §11, SPEC changed in one sentence: §10.7 used to say that with a prompt open
`legalActions` offers only the prompt's answers. R211 adds concede to that list, so §10.7 now says
the policy's set (`legalActions` minus R84's skipped actions) is what holds only the answers.

The recorded hotseat game's hash moved again, and only because `lastDamagedBy` now names a lethal
hit rather than the last one: folding the committed log before and after differs in that field on
three instances and nowhere else, so the log itself is unchanged.

### Round 3: what the hunt found

The third round's candidates were verified the same way and moved into topic files; the per-lens
scratch files are gone. The rows come from the overflow range again (R212–R214), and four of task
4's own rows were amended rather than joined by new ones.

| Topic file | Findings | Rule |
|---|---|---|
| `trigger-stays.test.ts` | A Reborn body answered the events of the stay that died: #91's Plague Token for the lethal hit (in a combat, a forced run and between Echo resolutions) and #32's draw for a kill; a #89 drawn by an Echo repeat fed on a death from before it reached the hand; #32 drew for the player #86's Death stole it for | R212 (new) |
| `after-resolution.test.ts` | An Echo repeat skipped §10.5 step 5's granted Combo parts (#38, #78); no state check ran between a card's last resolution and step 7, so #60 and #85 met a board still holding what the Cry killed; a later trap answering the same play fused a card out of a graveyard, or attacked a Reborn body | §10.5, §4.5, R174 (amended) |
| `stacks-and-reborn.test.ts` | §4.5's check collected cards dormant under a Stack, killing what a positive aura had kept alive and returning a buried Reborn card on top of the pile; a Bread Token's Reborn body came back 0/0 and died again | R13, R175 (amended) |
| `hand-returns.test.ts` | #31's +1 and #37r's 1 less stayed on a card a full hand burned; a Spell's end-of-turn return flag survived it leaving the graveyard | R4, R155 (amended) |
| `resolving-face.test.ts` | #64's "first cheap card" was a flag on the card, so a stolen one blocked its thief and a bounced one fired twice; a play's choices were read against the face in hand after step 3 had made it Radiant (#87, #48, a crafted card) | R213, R214 (new) |
| `tributes.test.ts` | A Tribute's Deaths resolved in the order the play listed them; a target the play's own Tribute sacrificed still took the damage, in its graveyard | R68, R174 |
| `hidden-information.test.ts` | A hidden hand card's buff gave its face away; a card replaced where the opponent could not read it read openly once its replacement went public; an Immutable library card escaped #83, so the count told the opponent it was there; a hand card's queued trigger shifted the next modifier's id | R177 (amended), R35 |

One finding was rejected: that an action ending with a prompt open must run the hero check, so a
player at 0 after radiant #65 Masochism Mask's first pick loses before the second is asked. §4.5 and
R59 run the check after a whole triggered script, and the Mask's two picks are one; R156 says what a
check does when it begins while a prompt is open, and does not begin one at every pause.
Hearthstone, likewise, resolves a Discover inside a Battlecry before its death phase. The test was
deleted.

The engine changes that carry most of this:

- **An event meets the board as it stood.** `triggers.dispatchEvent` reads the events still owed
  behind the one it dispatches (`stays.ts`): a card that has moved zones since does not answer, and a
  card whose controller has changed since answers for the one it had. The queued entry keeps that
  controller.
- **Step 6 ends in the check.** An Echo repeat runs `RESOLVE_PARTS` whole, and step 6 runs §4.5's
  check after the last resolution, before step 7's `cardResolved`. `traps.ts` re-reads
  `cardResolved.permanent` for each trap of a dispatch, and #60 honours it.
- **Gifted Program is the engine's.** #64 is a `giftedProgram` static flag; step 3 reads it against
  the turn log's new `costsPaid`, and step 1 and `legalActions` read the choices of the face step 5
  will resolve (`playChoices.resolvingFace`).
- **Smaller ones.** The check collects only the top of each pile; a Reborn body keeps its X/X;
  `setCostMod`/`setCostOverride` take `inHandOnly`; leaving the graveyard clears the return flag; a
  Tribute is sacrificed together (`stateCheck.sacrificeTogether`); damage never lands off the field;
  an off-field Replace ignores Immutable; `transformed` records `hiddenFrom`.

`transformed` gained an optional `hiddenFrom`, which `viewFor` reads and never forwards; `TurnLog`
gained an optional `costsPaid`; `StaticFlags` gained `giftedProgram`. No event type was added.

Outside §11, SPEC changed in one cell: §8 #64's Engine cell said "per-turn flag", which R213
replaces, so it now says the first cheap card is counted over the player's plays that turn.

The recorded hotseat game's hash moved a third time, for bookkeeping only: the turn log now records
what each play paid, and a hand card's queued trigger no longer takes a number from `nextSeq`.
Folding the committed log before and after differs in p1's `costsPaid` and in `nextSeq` and the two
frontier ids it numbers, and nowhere else.

### Round 4: what the hunt found

Round 4 ran past the three-round cap, with two new lenses beside L1, L2, L3, L7, L8 and L10: "card
by card" (the Epic, Legendary and Mythic cards and every radiant face that changes behaviour, each
driven into an interaction its own test file does not cover) and "engine invariants" (seeded random
games checked after every action against properties that must hold in every reachable state). Its
29 failing tests were 28 findings, all confirmed against SPEC and none rejected, and they are in
topic files now; the scratch files are gone. Two rows were needed, R215 and R216, and four rows
were amended: R77, R174, R177 and R209.

| Topic file | Findings | Rule |
|---|---|---|
| `hand-returns.test.ts` | A #89 that fed in hand, was discarded and came back by #72 kept its buffs; #99's crafted card a full hand burned kept its cost 0 | R215 (new) |
| `forced-attacks.test.ts` | A forced attacker that died mid-run and came back through Reborn still attacked in that run | R174 (amended) |
| `after-resolution.test.ts` | A unit played at 0 or less health (#2 under #46) died in step 4's check and lost its Cry | §4.5, R118 |
| `re-entry.test.ts` | A Fuse onto a token summoned X/X kept the token's `statsOverride` and `armorOverride`, so a 3/3 Bread Token fused with a 7/7 was a 3/3 and the 7/7's Armor 7 read as the token's X; a Transform refused a card in a Locked zone (#98 that #36 could not destroy) | R77 (amended), R175, R35, §3.2 |
| `fused-hooks.test.ts` | A fused Cry resumed after a pause by rebuilding every ingredient's list and skipping by index, which dropped the next ingredient's effects once #22's half had shrunk; a fused Cry split the play's choices against the board at step 5; an answer parked a pause's tail at the cursor the last action left | R113, R122, R90, R102 |
| `costs-and-mana.test.ts` | Two live #77 discounts read each other's result; #69's Recruit filter and #51's brackets read the printed cost, not the library card's R65 cost; the refresh wrote #24's and #21's one-shot rider into max mana | R65, R24, R66, §2.3 |
| `pools-and-randomness.test.ts` | #95's "add 3 random cards" could add #95; a crafted card with #54's text could add #54; #23, #83, #67 and #95's Unit summons drew randomness with nothing to do; the #97 scorer called a Charge unit lethal behind an enemy Taunt or with no zone to enter | §5.1, R129, §10.7 |
| `lasting-effects.test.ts` | #79's grant came from a Cry, so a Twinspell summoned by #22's Death, or fused by #85 onto the other player's Field Spell, granted nothing | R209 (amended), R169 |
| `hidden-information.test.ts` | Make Radiant on a hidden card that was already Radiant (#26, #29, #95, #64's step 3 on a face-down trap) emitted no cue, so the other seat could count the Radiant ones | R177 (amended), R97 |
| `game-over.test.ts` | The rest of #5's effect list resolved after the cast its draw made ended the game; #96 was consumed after the AI turn it handed over ended the game | R216 (new) |
| `turn-clock-and-legality.test.ts` | A target prompt keyed its options by card name, so two #12 Felinors shared one key and one could not be picked | §10.6, §10.8 |
| `030-archivist.test.ts` | #30 added a fresh copy of the library card instead of drawing it, the `it.fails` its own file pinned | §6.3 Draw, R24 |

The engine changes that carry most of this:

- **A composed list resumes part by part.** A fused hook tags each effect with its ingredient
  (`Effect.segment`), a pause records the parts' lengths (`PausedStep.segments`), and
  `work.resumeIndex` continues the part the pause stood in and every part after it, however the
  board has since reshaped the others. A fused Cry reads the slices §10.5 step 1 checked, which the
  pipeline carries in its `data` (`playChoices.DECLARATION_SLICES_KEY`). `prompts.answerPrompt` and
  `playSteps.answerPlayPrompt` reset the work cursor as they take the paused step up again.
- **A lasting effect is the permanent's.** `modifiers.installLastingModifiers` gives every
  permanent with `staticFlags.echoGrant` its rider on the side it stands on, in the state check and
  before a Spell takes the grant; #79 lost its Cry.
- **Step 4's loop holds the check** (`triggers.settle`'s `holdCheck`) until something in it has
  resolved: a trap, owed work or a queued trigger.
- **The game ends at the check that ends it.** `resolve.applyEffects`, `prompts.applyResumable` and
  `traps.fireTrap` stop once `state.result` is set.
- **Smaller ones.** `zones.moveToZone` resets a hand or library card reaching a graveyard or exile;
  `zones.replaceInZone` lets a Transform take a card's place without a summon; `mana.refreshMana`
  moves current mana only, and `effectiveCost` tests every Curvature against one number;
  `summonRandom` checks for a zone before it draws; pool queries add the running card's index to the
  exclusions (`catalog.excludingIndex`) instead of replacing them; Make Radiant and #64 always cue a
  hidden card; target prompt keys are built from the selection.

No event type was added. `Effect` gained an optional `segment`, and `PausedStep` an optional
`segments`, both additive. SPEC changed only in §11: R215 and R216 are new, and R77, R174, R177 and
R209 gained a sentence each (see "Merge notes").

---

## Out of scope

- **Transform readiness.** A transformed unit is always sick today (`transform.ts:71`). Hearthstone's
  Evolve keeps the original's readiness. It only matters for #83 Transmogulate on your own board, it
  errs on the side the user complained about (units attacking too early), and changing it is a
  balance call. It stays as it is unless the user asks.
- **UI.** No "sleeping" indicator. The client already follows `legalActions` (rule 7), and task 7
  owns the highlights. The only client edits are two lines the hunt's findings forced: the log's
  wording for a redacted buff (R177) and the highlight guard R211 changed (see "Merge notes").
- **Events and fields.** No new `GameEvent` type and no `CardInstance` field.
- **The C-paths.** Refactoring the entry paths to call `enterNewSide` is out: they are correct, and
  touching them widens the merge surface.
- **Rewording headers.** The §11 intro paragraph, and `rulings.test.ts`'s "R1 to R170" header and
  "R1–R167" `describe` title, are left for the integration branch.
- **BUILD.md.** Its M4 gate text is unchanged and the invariants are additive. One BUILD row did
  change: round 2 rewrote M4-T4's #52 row to match amended R14 (see "Merge notes").
- **E2E.** No spec changes. The recorded hotseat game is unaffected (§E).

---

## Risks

1. **Merge surface.** All seven tasks insert SPEC §11 rows and `rulings.test.ts` index rows at the
   same spot, right after R170, which will conflict textually. Task 4 merges first (merge order
   4 → 3 → …), so the others rebase onto R171/R172. `fuzz.test.ts` may also be touched by task 3
   (AI fuzz), so keep the edit to an import, one `createInvariantMonitor` call, two check calls and
   the new stage.
2. **Tests pinned to the old behaviour.** `effects-steal.test.ts:62` fails after the fix, and
   `effects-swap.test.ts:107` and `rotation.test.ts:194` pass only by coincidence. Rewrite all three
   to assert R171 rather than delete the lines, and keep each title leading with R15, R73 or R14 so
   the index still finds them.
3. **The Charge double-dip looks like a bug.** R171 lets a Charge unit that attacked, crossed away
   and came back in one turn attack again, and a reviewer may flag that. It is deliberate Hearthstone
   semantics, stated in the row and pinned by behaviour 10.
4. **R82 auto-end shifts.** A stolen unit now always has a fresh switch, so fewer turns auto-end and
   random games play differently. Nothing depends on that: fuzz hashes are computed live, and the
   only committed hash (the hotseat replay) plays no control-change card.
5. **Fuzz time.** The monitor runs at every step. The probe, which did a full `legalActions` scan
   every step, took 98 s for 1000 seeds under load. With `attackTargets` it should be cheaper.
   Measure once, alone, and if it goes over +25%, check only the chosen action for I1.
6. **I4 is unproven.** The probe did not run I4. If it fires, the finding is either a path without
   an entry event (a real §10.3 gap: fix the engine) or a monitor bug (fix the monitor and say so).
   Never loosen it to pass.
7. **`rulings:coverage` ordering.** A code comment that cites R171 or R172 before the SPEC rows exist
   fails the check. Add the rows first.
8. **Task 3's AI.** The AI decides through `legalActions`, `reduce` and `canAttack`, so it inherits
   R171 with no change. A search heuristic that assumed stolen units attack at once would only get
   weaker, not illegal. R211 also reaches it through `legalActions`: concede is now listed while a
   prompt is open, for both seats, so a search that answers prompts from `legalActions` must drop
   concede there, as the random policy's `AI_SKIPPED_ACTIONS` does.
9. **E2E.** Specs 02 and 12 play #52 and #87 but never attack with a moved unit. Rerun them with 01
   on Chrome after the fix: web port 5174, `pnpm build:e2e`, then
   `pnpm --dir apps/web exec vite preview --port 5174 --strictPort`, then
   `E2E_BASE_URL=http://localhost:5174 pnpm --dir e2e exec cypress run --browser chrome --spec …`.
   Kill the preview server afterwards.

---

## Hunt status

The brief asks for loop-until-dry finders. The hunt ran three rounds, was stopped by the schedule,
and was then continued for a fourth round past that cap. It is **still not dry**. Round 4 confirmed
28 findings from 29 failing tests and needed two new rows (R215, R216) and four amended ones. The
number of tests each round added fell for the first time (53, 44, 43, then 29), but the number of
confirmed findings did not (about twenty in round 3, twenty-eight in round 4), and the two new lenses
("card by card" and "engine invariants") found twelve of them between them. More edge cases very
likely remain, most likely where round 4 was still finding them: re-entry and zone moves (L2, six),
fused cards and prompts mid-sequence (L7 and the fused half of L2, six), the rarer cards' own text
(nine), and costs read outside play (three). The PR should say so in those words rather than call
the hunt complete.

The brief's headline is the one part with evidence of being dry. After the R171 slice, no round
found a unit that could attack while sick. The findings that touch a change of control are about
what else travels with the card: a Twinspell's grant, a queued trigger or turn hook, a forced run's
target, and radiant #52's bounce. The fuzz invariants that check sickness directly (I1 to I4) hold on
every `pnpm fuzz` seed (1 to 1000), as does round 4's I5, and I1 to I4 held on seeds 1001 to 2000,
run once for this note after round 3 (1000 passed, 0 invariant violations).

---

## Merge notes

Merge order puts task 4 first, so the other tasks rebase onto everything below. Each edit here is
outside what `reference.md` gives task 4. Each one is the smallest change that fixed a confirmed
finding, and a test named after its rule proves it.

### Task 3: `turn.ts`, `draw.ts`, `config.ts`, `state.ts`, `subsystems/fuse.ts`

| File | Edit | Why |
|---|---|---|
| `turn.ts` `runDelayed` | One guard: an entry runs only while `state.delayed` still holds it | R174: an earlier entry's resolution can drop a later one. The state check after #50's first steal can kill a second steal's target |
| `turn.ts` `startTurn` | The other player's `turnLog` is emptied too, keeping its `unspentAtEnd` | §6.2's "this turn": a card the other player casts during this turn (a cast on draw, R40, R70) counts from zero (#38) |
| `turn.ts` `cleanup` | One call to `traps.endHandedOverTurn` when the turn was handed to the AI. The function lives in `traps.ts` | R152, §3.2: My Pawn's effect ends at that cleanup, so the trap reaches the graveyard before the next turn starts (#37 looks for it there) |
| `turn.ts` | `hasStandingDrawOffer`, and `answerDraw` deletes `offeredTurn` | R36: a declined offer could still be accepted. `legalActions` and `reduce` now ask the same function |
| `draw.ts` | `continueChain`: the state check between cast-on-draw casts, in `completeDraw` and in the owed-chain handler | §4.5, R59: a hero a cast brought to 0 ends the game before the draw repeats, and a unit it killed has died before the next cast. Task 3's extra draws call `draw(sink, player, N)`, which runs every draw's chain through this, so R183's separate chains get the check with no further change |
| `config.ts` | `TIMEOUT_ANSWER_CAP`, placed with the §2.5 constants rather than at the end of the file, where task 3 appends its table | R79 and CLAUDE.md rule 9: the most prompts one `timeout` answers |
| `state.ts` | `TurnLog.costsPaid` (R213), `DelayedEffect.watch` (R174), and the doc of `lastDamagedBy` (R42) | Bookkeeping the fixes read. No handicap field is touched |
| `subsystems/fuse.ts` | R179: a fused def's id is `t-<n>:<a>+<b>`, and a fused Cry resolves each ingredient with its own slice of the play's choices (R102, R90). Round 4: the slices are the ones §10.5 step 1 checked (`storedDeclarationSlices`); every combined hook tags its effects with their ingredient (`inPart`, `Effect.segment`); an ingredient's face is read with its `statsOverride`/`armorOverride` (`wornFace`) and the kept instance drops them; a crafted card takes its cost 0 only if it reaches the hand | The first is the same bug task 3 fixed with `syncFusedScripts`: two matches in one process shared `t-1`'s scripts. Round 4: R113, R90, R77 (amended), R215 |
| `mana.ts` (round 4) | `maxManaFor` leaves out `nextTurnMod`, which `refreshMana` adds to current mana only (floored at 0); `effectiveCost` tests every Curvature against the cost the flat discounts leave | §2.3: max mana is min(turns, 4) plus persistent modifiers, and #24's next-turn mana is temporary mana. R65, R48: two Curvatures do not read each other's result |

`git merge-tree` against `polish/3-ai`, after this fix stage, reports textual conflicts in:

- the `turn.ts` import block. Keep both lines: task 3's multi-line `./state` import, and this
  branch's `import { endHandedOverTurn, runTrapWindow } from "./traps";`.
- `subsystems/fuse.ts`, in two places: the `../script` type import (keep `CardScripts`, `Effect`,
  `Hook` and `Script`, and this branch's `../playChoices` import), and `buildDef`'s head (keep task
  3's `FusedDef` return type and this branch's `nextTransientId(state, defs)`).
- `SPEC.md` and `rulings.test.ts`, where every task inserts after R170.

`config.ts` no longer conflicts, and `draw.ts` and `mana.ts` are untouched by task 3. `mana.ts` was
back to `main` after round 3 (`choosesX` moved to `playChoices.ts`, which calls it); round 4 edits
it again, in `maxManaFor`, `refreshMana` and `effectiveCost`'s Curvature loop, none of which task 3
changes. Task 3's AI reads max mana nowhere it plans with, so the refresh change reaches it only
through `mana.current`, which is unchanged.

`fuse.ts` needs a decision as well as a textual merge. Both fixes can stay, since task 3's
`fusedFrom` rebuilds a registry from the state alone and content-addressed ids do not. But two
things need changing:

- Task 3's `transientOrder` reads n after the last `-`. In `t-1:core-011+core-020` that gives 20,
  so it must read the n of `t-<n>`, before the colon.
- Task 3's `packages/engine/test/fuse-registry.test.ts` expects the bare `t-1`. It must use R179's
  id.

R211 changes what `legalActions` returns while a prompt is open. The seat without the prompt now
gets `[concede]` where it used to get `[]`, and the prompt holder gets its answers followed by
concede. Task 3's AI already drops concede through `AI_SKIPPED_ACTIONS`
(`packages/ai/src/candidates.ts`), so its prompt answers do not change. Any new consumer of
`legalActions` should drop it the same way. Two places in `packages/ai` take
`legalActions(state, promptHolder)[0]` (`simulate.ts`, `reply.ts`). That is still the prompt's first
answer, because concede comes last, but a prompt with no answers now yields concede where it used to
yield nothing. `aiToAct` does not read `legalActions`, so the extra concede never makes the AI think
it owes an action.

`observe.unansweredDrawOffer` in `packages/ai` re-derives R36's standing offer from `offeredTurn`
and `blockedUntil`. It agrees with this branch's `turn.hasStandingDrawOffer`, which `legalActions`
and `reduce` both ask, because `answerDraw` now deletes `offeredTurn`. Calling the engine's function
would keep the two from drifting apart.

### Task 7: `script.ts`, the card scripts, the client

- `script.ts`: `StaticFlags` gained `echoGrant` (R209, #79), `quickstriker` (#38) and
  `giftedProgram` (#64, R213). The change is additive, and task 7's `ConditionContext` and
  `conditionMet` merge cleanly beside it.
- #38 Quickstriker and #64 Gifted Program were rewritten, from a trigger and an `onPlayHook`, into
  those static flags. The engine resolves them now: `playSteps.quickstrikerCombo` at §10.5 step 5,
  and `playSteps.giftedProgramStep`, through `playChoices.giftedMakesRadiant`, at step 3. Both cards
  are conditional in §8, so their `conditionMet` has nothing in the card file to read. It should
  call the engine's helpers, both exported from `@jackioh/engine`:
  - #38's Combo X is above 0 when `cardsPlayedThisTurn(state, controller) > 0`.
  - `giftedMakesRadiant(state, controller, cost)` says whether a play paying `cost` now would be
    made Radiant. It is not yet in the cards README's table of read helpers, so the change that
    first reads it from a card file adds it there.
- `script.ts`, round 4: `Effect` gained an optional `segment` (the ingredient an effect of a fused
  hook came from, R113). Additive, and no card file sets it.
- The hunt also edited these card scripts: #22, #24, #31, #33, #37, #50, #52, #60, #72, #79 and
  #85, and in round 4 #21 (a comment), #23, #30, #51 and #83, and #79 again (its Cry is gone: the
  grant is the engine's, from `staticFlags.echoGrant`). None is one of task 7's `conditionMet`
  cards (#10, #53, #68, #71, #93).
- Round 4 changed two things the client sees. A target prompt's option keys are now built from the
  selection (`instance:<id>`, `hero:<player>`) instead of the card's name, so the client must go on
  treating a key as opaque. And `radiantSet` now also goes out for a hidden card that was already
  Radiant (R177), so the glow can play on a card whose face did not change.
- `apps/web/src/game/actions.ts` `highlightFor`: the guard that drops an in-flight selection now
  fires when nothing but concede is legal, because R211 lists concede while the other seat holds a
  prompt, and it keeps concede lit. The hunk sits above task 7's `glow` edits.
- `apps/web/src/game/Log.tsx`: two `describe` cases for R177's redactions, a hidden cost change
  and a hidden buff. They are apart from task 7's scroll edits.
- The branch leaves one seam open. R171 makes a stolen, swapped or rotated unit sick, but `UnitView`
  carries only `canAct`, so the client cannot draw Hearthstone's sleep marker. Task 7's green glow
  already leaves `switchPosition` unlit, so a sick unit does not glow. A `sick` flag on `UnitView`
  (owned by task 7) would let it draw the marker.

### SPEC and BUILD outside §4.1 and the new §11 rows

| Where | Change | When |
|---|---|---|
| §8 #64 Engine cell | "per-turn flag" becomes a count of the player's plays that turn (R213) | Round 3 |
| §10.1 `PlayerState` | The `mods` comment drops the Gifted flag, and `turnLog` gains `costsPaid` | Fix stage |
| §10.5 step 3 | Gifted Program is a static flag read against `costsPaid`, and `onPlayHook` runs after it | Fix stage |
| §10.7 AI policy | The policy's set, not `legalActions`, holds only a prompt's answers (R211) | Round 2 |
| R14 (decide) | Radiant #52 bounces only the cards leaving its controller's side, and the opponent's crossing cards still cross. This changes behaviour. The source's "cards you would lose" (`JackiOh_Core_Cards.md`) backs it | Round 2 |
| R102 | The fused id is followed by the ingredients' ids (R179) | Round 1 |
| R119 | #38 is a static flag excluded by id, not a trigger. #64 never meets its own arrival | Fix stage |
| R153 | No Core card has an `onPlayHook`. #64 is read off the field | Fix stage |
| R155 | The return flag clears when the card leaves the graveyard (#72, #76) | Round 3 |
| R174, R175, R177 | Task 4's own rows, amended. R177 now also records the known limit below | Rounds 2 and 3, fix stage |
| BUILD M4-T4, #52 row | Radiant bounces only the cards that would cross to the opponent (R14) | Round 2 |
| R77 | A token's `statsOverride` and `armorOverride` are its printed face, so a Fuse sums them and they leave the kept instance; it used to say `statsOverride` stayed unchanged | Round 4 |
| R174, R177, R209 | Task 4's own rows, amended again: a forced attacker back through Reborn is passed over; Make Radiant always cues a hidden card; a Twinspell has its grant however it came to stand on the field | Round 4 |

Rows R209 to R216 come from the overflow range, because R171 to R179 filled up in round 1 (R215 and
R216 in round 4). The integration branch renumbers any collision.

`packages/shared` gained no event type. `cardResolved` gained an optional `radiant`, `transformed`
an optional `hiddenFrom`, and `TargetDecl` an optional `forModes`.

---

## Known limits

- **A face-down card's id in `legalActions`** (R177's last sentences). The action protocol names a
  face-down card by its instance id, and a card keeps its id across zones. So a player who saw the
  id while the card was public can recognise the trap, for example one returned from a graveyard to
  hand and set again. An `it.fails` in `turn-clock-and-legality.test.ts` pins it, so the change that
  closes it has to flip that test. Closing it needs a per-viewer alias, or a fresh id whenever a card
  enters a hidden zone. Either is a change to the action protocol the server, the client and the e2e
  specs share. The gap predates this branch. The PR should open a tracked issue for it.
- **The hunt is not dry** (see "Hunt status").
- **No sleep marker** for a sick unit (see the seam under task 7).
- **Transform readiness** (see "Out of scope").
