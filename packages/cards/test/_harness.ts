// The card test harness (BUILD M4-T3). Every card test file imports `scenario` from here and
// nothing else from the engine: importing this module registers the real 110-card catalog and every
// registered script (`registerAll()`), so a card test never wires the engine up by hand.
//
// A scenario is built out of the engine's OWN functions — `createGame`, `newInstance`,
// `placeOnField`, `moveToZone`, `createInHand`, `refreshMana`, `stateCheck` — never out of a
// hand-written state literal, so a state built here always has every field the engine adds later.
//
// ---------------------------------------------------------------------------------------------
// DEFAULTS  (pass `seed`, `turn`, `active` to change them)
// ---------------------------------------------------------------------------------------------
//   seed    "jackioh-harness"
//   active  "p1"
//   turn    9  — a mid-game board: the active side has started ceil(9/2) = 5 turns and the other
//               floor(9/2) = 4, so both sides sit at MAX_MANA (4/4) with no asymmetry to reason
//               about. Turn counts player-turns (§2.5): turn 1 is p1's first, 2 is p2's first.
//               `turnsStarted` always follows `active`/`turn` by that rule, NOT by the parity of
//               `turn`, so `{ active: "p2", turn: 9 }` gives p2 five started turns and p1 four.
//   mana    each side's `mana.max` is whatever `refreshMana` computes from `turnsStarted`, and
//           `mana.current` equals it. `SideSetup.mana` sets `current` only — §2.3 lets current
//           exceed max, so the harness never raises max.
//   health  HERO_HEALTH (30); armor 0.
//
// The scenario starts in `phase: "main"` with the mulligan, `beginGame` and the opening `startTurn`
// all skipped: setup draws nothing and fires no trigger. Units placed by `field` are NOT summoning
// sick (`summonedTurn` is left unset) and have both exertions unspent.
//
// ---------------------------------------------------------------------------------------------
// SIDE SETUP  (what `p1`/`p2` accept)
// ---------------------------------------------------------------------------------------------
//   hand, library, graveyard, exile   readonly (string | { def?, defId?, radiant?, costMod?,
//                                                          costOverride? })[]
//   field, backrow                    readonly (string | { def?, defId?, radiant?, row?, lane?,
//                                                          stack?, position?, damage?, counters?,
//                                                          faceUp?, statsOverride?, costMod?,
//                                                          costOverride? })[]
//   health, mana, armor               number
// `def` and `defId` are aliases: exactly one is required, and both with different values throws
// naming both. A bare string is `{ def: <string> }`. `radiant: true` sets the instance's Radiant
// flag in whatever zone the entry names, a library or a hand included (#21, #23 need a Radiant
// card sitting on top of a library). `statsOverride` is §10.4 layer 1 / R41's X/X token.
// `counters` seeds §10.1's instance counters — #91's `plague`, #93's `grade`. `costMod` and
// `costOverride` seed §2.3's cost layers, which R78 keeps in every zone, so a ruling about the cost
// at resolution rather than the printed cost (R65, R66) can be set up in a hand or a library.
// `faceUp` is written exactly as given, so `faceUp: false` reads back `false` rather than
// `undefined` (R33: a Trap is face-down until it fires). Every array is `readonly`, so a fixture
// written `as const` is assignable as it stands.
//
// `stack: true` (unit zones only) builds a §3.2 Stack pile: the entry buries the card already in
// its lane instead of taking a lane of its own, so the `lane` may be repeated, and with no `lane`
// it lands on the entry before it. Later entries go on top, the way a play would put them, so the
// pile reads top-first and the list reads bottom-first:
//   field: ["core-043", { def: "core-092", stack: true }]
// is a Felinor Fiender on top of a Big Felinor in lane 1, the Big Felinor dormant (R13).
//
// `field` and `backrow` describe ONE board and take the same entries: an entry's row comes from
// its def's type — a Unit to the unit zones, a Field Spell / Trap / Field Trap to the backrow —
// and `row: "units" | "backrow"` overrides that, so `field: [{ defId: MANA_WELL, row: "backrow" }]`
// and `backrow: [{ defId: MANA_WELL }]` are the same setup — and a card filed under the wrong list
// is routed by its type rather than refused. Only an explicit `row` that contradicts the type is an
// error, and a Spell is refused in either list: §3.2 never puts one on the field.
// Lanes are handed out per row over the whole board, `field` entries
// first: an entry naming a `lane` keeps it, and the rest take the leftmost zone still free, in
// list order. Instances are created in list order either way, so the ids follow the literal.
//
// ---------------------------------------------------------------------------------------------
// STRING REFERENCES  (`play("43")`, `attack("Big Felinor", "hero")`, `expectInZone("c7", "gone")`)
// ---------------------------------------------------------------------------------------------
// A `string` is resolved in this order, first match wins:
//   1. an instance id that exists right now (`"c7"`);
//   2. a catalog id (`"core-043"`);
//   3. a SPEC §5 index (`"43"`, `"51.1"`, `"T-rush"`);
//   4. a card name, exact (`"Big Felinor"`), then case-insensitive.
// Steps 2-4 give a defId, and the instance is then the first one found scanning
//   the ACTIVE player first, then the opponent, and within a side:
//   hand → unit zones (lane 1..5, top of a Stack pile before the cards dormant under it) →
//   backrow (lane 1..5) → graveyard → exile → library → resolving.
// A method that needs the card somewhere particular narrows the search to that place first:
// `play` looks in hands only, `attack`/`switchPosition` on the field only. Nothing matching throws
// an Error naming the string and listing what was there instead. Holding several copies of one def?
// Use the `CardInstance` the setup or `s.card(...)` handed back; the string form is first-match.
//
// ---------------------------------------------------------------------------------------------
// INSTANCES ARE SNAPSHOTS
// ---------------------------------------------------------------------------------------------
// `reduce` clones the state, so a `CardInstance` you captured before a step is a stale object after
// it. Every harness method re-resolves a `CardInstance` argument by its `id` against the live
// state, so passing a stale instance is fine — but never read `.damage`/`.buffs` off one you are
// holding; read it back with `s.card(inst)`, `s.unit(p, lane)` or `s.expectStats(inst, …)`.
//
// ---------------------------------------------------------------------------------------------
// startTurn() vs endTurn()  — the two easiest things to get wrong
// ---------------------------------------------------------------------------------------------
// `startTurn()` runs the engine's `startTurn(sink, state.active)` for the player who is active NOW.
//   It does not pass the turn: `state.turn` and that player's `turnsStarted` go up by one, mana
//   refreshes, delayed and start-of-turn effects fire, exertion resets, the player draws one card,
//   and the phase lands back in `main`. This is what an "at the start of your turn" card test wants.
// `endTurn()` is the `endTurn` ACTION: end-of-turn triggers and delayed effects fire, the turn log
//   closes, "this turn" modifiers expire — and then `turn.ts` starts the OPPONENT's turn (their
//   draw, their triggers). So one `endTurn()` hands the turn over; two come back around to your own
//   next turn. It is not `startTurn()` twice: the opponent really takes a turn in between.
//   WARNING (engine `reduce`, §2.5): after any action, a turn with nothing meaningful left on it
//   auto-ends by itself and emits `turnAutoEnded`. A side with an empty hand and no unit that could
//   switch position has nothing meaningful, so `endTurn()` can cascade several turns forward. Give
//   each side a card in hand or a unit on the board when a test crosses a turn boundary.
//
// ---------------------------------------------------------------------------------------------
// ZONES, EVENTS, ASSERTIONS
// ---------------------------------------------------------------------------------------------
// `expectInZone(card, "field")` means a unit zone or the backrow, a card dormant under a Stack pile
//   included. `"gone"` means in no pile at all: SPEC §3.2 / R11's unit token that ceased to exist
//   (`moveToZone` returns "vanished" and leaves it nowhere). To assert `"gone"` pass the
//   `CardInstance` or its instance id — a def reference has nothing left to find.
// `expectStats` reads the engine's `unitView` (`layers.ts`), so every §10.4 layer is already in the
//   number: never `def.base`, never raw `buffs`. `stats(card)` returns that whole `UnitView`
//   (attack, maxHealth, health, keywords, armor, position) for a test that needs to read a keyword
//   or an Armor total — a `CardInstance` has none of those, they are computed on every read.
// `events` is the cumulative log of every event produced since setup finished, oldest first; the
//   events of the setup itself (including a death from a unit placed at lethal damage) are not in
//   it. `lastEvents` is just the most recent step. `expectEvents(...)` searches `events` for those
//   types as a SUBSEQUENCE: in that relative order, not necessarily adjacent.
// Every refusal — an illegal play, an illegal attack, an answer that matches no option — throws an
//   Error carrying the engine's own message, which is the mechanism the M4-T4 table's "Play refused
//   without a tribute" / "locked zone rejects play" / "Uncastable at 4 mana" rows use:
//   `expect(() => s.play(x)).toThrow(/tribute/)`.
//
// ---------------------------------------------------------------------------------------------
// THREE ACTIONS `reduce` HAS NOT WIRED YET
// ---------------------------------------------------------------------------------------------
// `packages/engine/src/reduce.ts` still answers three action types with a placeholder string,
// although the modules behind all three are written. For those EXACT messages — and for no other
// refusal — the harness calls the engine function `reduce` will call, so a card test can be written
// against the documented API today and needs no change when the wiring lands:
//   attack         "combat arrives with M2"    → `declareAttack(sink, attacker, target)` (combat.ts)
//   answer         "prompts arrive with M3"    → `answerPrompt(sink, {…})`               (prompts.ts)
//   activate       "hero powers arrive with M3"→ `subsystems.activatePower(sink, player, {…})`
// These are the engine's own complete implementations — validation, payment, damage pipeline and
// state check included — not a harness re-implementation of any rule, and each fallback stops
// being reachable the moment its `reduce` case returns something else. A genuine rules refusal is
// never swallowed: it is not one of the three strings, so it throws untouched.
// `view()` calls `viewFor(state, playerId)` (§10.8) directly and needs no fallback.

import { expect } from "vitest";
import type { ActionInput, GameEvent, PlayerId, PlayerView, Row, Selection, ZoneChoice } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import {
  BACKROW_ZONES,
  DECK_SIZE,
  UNIT_ZONES,
  cardAt,
  createGame,
  createInHand,
  createRng,
  declareAttack,
  defOf,
  findInstance,
  moveToZone,
  newInstance,
  placeOnField,
  query,
  reduce,
  refreshMana,
  registeredCatalog,
  removeFromAnyZone,
  showToOwner,
  startTurn as engineStartTurn,
  stateCheck,
  subsystems,
  unitView,
  viewFor,
  answerPrompt,
  type AttackTarget,
  type CardInstance,
  type EngineSink,
  type GameState,
  type PendingChoice,
  type UnitView,
} from "@jackioh/engine";
import { registerAll } from "../src/index";

// The §10.4 layer view (engine `layers.ts`), re-exported so a card test can type a local.
export type { UnitView };

// Every card test file gets the real catalog and every registered script just by importing this.
registerAll();

export const DEFAULT_SEED = "jackioh-harness";
/** A mid-game board: both sides at MAX_MANA. See the file header. */
export const DEFAULT_TURN = 9;

/**
 * `reduce`'s three not-yet-wired action cases. The engine modules behind them are all written, so
 * for these EXACT messages — and no other — the harness calls the engine function `reduce` will
 * call. Each fallback vanishes by itself the moment its `reduce` case is wired; see the header.
 */
const PLACEHOLDERS = {
  attack: "combat arrives with M2",
  power: "hero powers arrive with M3",
  prompt: "prompts arrive with M3",
} as const;

// ---------------------------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------------------------

export type CardRef = string | CardInstance;

/**
 * Every setup entry names its card with `def` OR `defId` — the two are aliases, exactly one is
 * required, and giving both with different values throws. A bare string is the same as `{ def }`.
 */
export type DefRef = { def?: string; defId?: string };

/**
 * R78: "`costMod`, `costOverride` and `radiant` persist in every zone", so a setup may seed the two
 * cost layers wherever the card sits — which is what a ruling about the cost *at resolution* rather
 * than the printed cost (R65, R66) needs in order to be testable at all.
 */
export type CostSetup = {
  /** R65: added to the printed cost, in every zone (§2.3's cost layers). */
  costMod?: number;
  /** R65: the cost this card has instead of its printed one, modifiers still applying over it. */
  costOverride?: number;
};

export type PileSetup = string | (DefRef & CostSetup & { radiant?: boolean });

/**
 * One card on the field. `field` and `backrow` take the same shape: the row comes from the def's
 * type (Units to the unit zones, Field Spells and Traps to the backrow) unless `row` names it.
 */
export type FieldEntry = DefRef &
  CostSetup & {
    radiant?: boolean;
    /** Overrides the row the def's type implies. */
    row?: Row;
    /** 1-based lane; omitted takes the leftmost zone still free in that row. */
    lane?: number;
    /**
     * §3.2 Stack: this entry buries the card already in its lane instead of taking a lane of its
     * own, so the lane may be repeated. Later entries go on top, as a play would put them: the pile
     * reads top-first, which is the reverse of the list. Unit zones only, and the buried card must
     * come earlier in the list (or be pinned there with the same `lane`).
     */
    stack?: boolean;
    position?: "ATK" | "DEF";
    damage?: number;
    /** §10.1 counters: #91's plague and #93's grade. */
    counters?: { plague?: number; grade?: number };
    /** A backrow card whose identity is public (§10.8, R33); `false` is written as `false`. */
    faceUp?: boolean;
    /** §10.4 layer 1 / R41: a token summoned X/X. */
    statsOverride?: { attack: number; health: number };
  };

export type FieldSetup = string | FieldEntry;
export type BackrowSetup = string | FieldEntry;

/** Every array is `readonly`, so a fixture declared `as const` is assignable as it stands. */
export type SideSetup = {
  hand?: readonly PileSetup[];
  field?: readonly FieldSetup[];
  backrow?: readonly BackrowSetup[];
  library?: readonly PileSetup[];
  graveyard?: readonly PileSetup[];
  exile?: readonly PileSetup[];
  health?: number;
  mana?: number;
  armor?: number;
};

export type PlayOptions = {
  /** 1-based lane; the row comes from the def's type. Omitted means R64's leftmost free zone. */
  zone?: number;
  x?: number;
  embiggen?: boolean;
  targets?: readonly Selection[];
  modes?: readonly string[];
  /** Units sacrificed for a Tribute cost; each entry is any card reference on the field. */
  tributes?: readonly string[];
};

export type ActivateOptions = { targets?: readonly Selection[] };

export type ScenarioOptions = {
  seed?: string;
  p1?: SideSetup;
  p2?: SideSetup;
  turn?: number;
  active?: PlayerId;
};

export type ZoneName = "hand" | "library" | "graveyard" | "exile" | "field" | "gone";
export type PileName = "hand" | "library" | "graveyard" | "exile";

export type Scenario = {
  /** The live state; it follows every step (`reduce` returns a new object, this getter tracks it). */
  readonly state: GameState;
  /** Every event since setup finished, oldest first. */
  readonly events: GameEvent[];
  /** The events of the most recent step only. */
  readonly lastEvents: GameEvent[];

  play(card: CardRef, opts?: PlayOptions): Scenario;
  attack(attacker: CardRef, target: CardRef | "hero"): Scenario;
  answer(selection: readonly Selection[] | string | readonly string[]): Scenario;
  endTurn(): Scenario;
  startTurn(): Scenario;
  switchPosition(card: CardRef): Scenario;
  activate(card: CardRef, opts?: ActivateOptions): Scenario;

  view(player?: PlayerId): PlayerView;
  unit(player: PlayerId, lane: number): CardInstance | null;
  backrow(player: PlayerId, lane: number): CardInstance | null;
  hand(player?: PlayerId): CardInstance[];
  pile(player: PlayerId, zone: PileName): CardInstance[];
  card(ref: CardRef): CardInstance;
  /** §10.4's computed view: attack, maxHealth, health, keywords, armor, position. */
  stats(card: CardRef): UnitView;

  expectInZone(card: CardRef, zone: ZoneName): Scenario;
  expectStats(card: CardRef, stats: { attack?: number; health?: number; maxHealth?: number }): Scenario;
  expectEvents(...types: GameEvent["type"][]): Scenario;
  expectHealth(player: PlayerId, health: number): Scenario;
  expectMana(player: PlayerId, current: number): Scenario;
};

// ---------------------------------------------------------------------------------------------
// Card references
// ---------------------------------------------------------------------------------------------

type Where = "any" | "hand" | "field";
type Located = ZoneName | "resolving";

const INSTANCE_ID = /^c\d+$/;

function describeInstance(state: GameState, card: CardInstance): string {
  const name = registeredCatalog()[card.defId]?.name ?? state.transientDefs[card.defId]?.name ?? "?";
  return `${card.id} ${card.defId} "${name}"${card.radiant ? " (radiant)" : ""}`;
}

/** Every def the engine can see: the registered catalog plus this state's transient defs (Fuse). */
function visibleDefs(state: GameState): { id: string; index: string; name: string }[] {
  return [...Object.values(registeredCatalog()), ...Object.values(state.transientDefs)];
}

/**
 * Steps 2-4 of the header's resolution order: catalog id, then §5 index, then name (exact, then
 * case-insensitive). Returns every defId that matched at the first matching step.
 */
function defIdsFor(state: GameState, ref: string): string[] {
  const defs = visibleDefs(state);
  const steps: ((d: { id: string; index: string; name: string }) => boolean)[] = [
    (d) => d.id === ref,
    (d) => d.index === ref,
    (d) => d.name === ref,
    (d) => d.name.toLowerCase() === ref.toLowerCase(),
  ];
  for (const step of steps) {
    const hit = defs.filter(step).map((d) => d.id);
    if (hit.length > 0) return hit;
  }
  return [];
}

/** A side's instances in the header's documented scan order. */
function sideOrder(state: GameState, player: PlayerId, where: Where): CardInstance[] {
  const side = state.players[player];
  const units = side.units.flatMap((pile) => pile ?? []);
  const backrow = side.backrow.flatMap((card) => (card === null ? [] : [card]));
  if (where === "hand") return [...side.hand];
  if (where === "field") return [...units, ...backrow];
  return [
    ...side.hand,
    ...units,
    ...backrow,
    ...side.graveyard,
    ...side.exile,
    ...side.library,
    ...side.resolving,
  ];
}

function searchOrder(state: GameState, where: Where): CardInstance[] {
  const active = state.active;
  return [...sideOrder(state, active, where), ...sideOrder(state, opponentOf(active), where)];
}

function whereLabel(where: Where): string {
  if (where === "hand") return "a hand";
  if (where === "field") return "the field";
  return "any zone";
}

// ---------------------------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------------------------

/**
 * `createGame` validates decks (§2.6: DECK_SIZE cards, no duplicates, no tokens), so the filler
 * deck is the first DECK_SIZE non-token catalog ids in §5 index order, straight from `query({})`.
 * Both libraries are emptied again right afterwards and `nextId` is reset, so the ids a scenario
 * hands out start at `c1` and follow the setup's own order.
 */
function fillerDeck(): string[] {
  const ids = query({}).map((def) => def.id);
  if (ids.length < DECK_SIZE) {
    throw new Error(
      `the registered catalog holds only ${ids.length} non-token cards; ` +
        `createGame needs ${DECK_SIZE} for its filler deck (did registerAll() run?)`,
    );
  }
  return ids.slice(0, DECK_SIZE);
}

function setupDefId(state: GameState, ref: string, label: string): string {
  const ids = defIdsFor(state, ref);
  const first = ids[0];
  if (first === undefined) {
    throw new Error(
      `${label}: no catalog card matches "${ref}" — use a catalog id ("core-043"), ` +
        `a SPEC §5 index ("43", "T-rush") or a name ("Big Felinor")`,
    );
  }
  return first;
}

/**
 * The one place `def`/`defId`/a bare string become a single name. Exactly one of the two keys is
 * required; both with different values is a typo worth naming.
 */
function refOf(entry: string | DefRef, label: string): string {
  if (typeof entry === "string") return entry;
  const { def, defId } = entry;
  if (def !== undefined && defId !== undefined && def !== defId) {
    throw new Error(`${label}: \`def\` is "${def}" but \`defId\` is "${defId}"; they are aliases, so give one`);
  }
  const ref = def ?? defId;
  if (ref === undefined) {
    throw new Error(`${label}: no card named — an entry needs \`def\` or \`defId\` (or be a plain string)`);
  }
  return ref;
}

/** One resolved card to place, with its row decided and (later) its lane assigned. */
type Placement = FieldEntry & { defId: string; row: Row; label: string; lane?: number };

function rowSizeOf(row: Row): number {
  return row === "units" ? UNIT_ZONES : BACKROW_ZONES;
}

/**
 * §3.2: a Unit goes in the unit zones and a Field Spell, Trap or Field Trap in the backrow, so the
 * def's type picks the row and `row` on the entry overrides it. `field` and `backrow` therefore
 * accept the same entries: naming the list is a convenience, not a second rule.
 */
function normalizePlacement(state: GameState, entry: FieldSetup, fallback: Row, label: string): Placement {
  const fields: FieldEntry = typeof entry === "string" ? { def: entry } : entry;
  const defId = setupDefId(state, refOf(entry, label), label);
  const def = defOf(state, defId);
  const implied: Row = def.type === "Unit" ? "units" : "backrow";
  const row = fields.row ?? (def.type === "Spell" ? fallback : implied);

  if (def.type === "Spell") {
    throw new Error(`${label}: "${def.name}" is a Spell; a Spell is never on the field (§3.2)`);
  }
  if (row === "units" && def.type !== "Unit") {
    throw new Error(`${label}: "${def.name}" is a ${def.type}; the unit zones hold Units only`);
  }
  if (row === "backrow" && def.type === "Unit") {
    throw new Error(`${label}: "${def.name}" is a Unit; the backrow holds Field Spells and Traps`);
  }
  if (row === "backrow" && fields.stack === true) {
    throw new Error(`${label}: \`stack: true\` is a unit-zone pile (§3.2); the backrow holds one card per zone`);
  }

  return { ...fields, defId, row, label };
}

/**
 * §3.2 lane assignment for a setup row: entries that name a `lane` keep it, and the rest take the
 * leftmost lane still free, in list order. Instances are still created in list order, so the ids
 * follow the setup literal even when a later entry pinned an earlier lane.
 *
 * §3.2 Stack: an entry with `stack: true` does not take a lane of its own — it buries the card
 * already in one, so it may repeat a `lane` an earlier entry pinned, and with no `lane` of its own
 * it lands on the entry before it in the list.
 */
function assignLanes(entries: readonly { lane?: number; stack?: boolean }[], size: number, label: string): number[] {
  const taken = new Set<number>();
  entries.forEach((entry, at) => {
    if (entry.lane === undefined) return;
    if (!Number.isInteger(entry.lane) || entry.lane < 1 || entry.lane > size) {
      throw new Error(`${label}: lane ${String(entry.lane)} is out of range; lanes are 1..${size}`);
    }
    if (taken.has(entry.lane) && entry.stack !== true) {
      throw new Error(
        `${label}: two cards were given lane ${entry.lane}` +
          ` — add \`stack: true\` to entry [${at}] for a §3.2 Stack pile`,
      );
    }
    taken.add(entry.lane);
  });

  const lanes: number[] = [];
  let next = 1;
  entries.forEach((entry, at) => {
    if (entry.stack === true) {
      const under = entry.lane ?? lanes[at - 1];
      if (under === undefined || !lanes.slice(0, at).includes(under)) {
        throw new Error(
          `${label}: entry [${at}] has \`stack: true\` but lane ${under ?? "?"} holds nothing yet` +
            ` — the card it buries goes EARLIER in the list, the pile reading top-first`,
        );
      }
      lanes.push(under);
      return;
    }
    if (entry.lane !== undefined) {
      lanes.push(entry.lane);
      return;
    }
    while (taken.has(next)) next += 1;
    if (next > size) throw new Error(`${label}: the row holds ${size} zones and the setup asks for more`);
    taken.add(next);
    lanes.push(next);
  });
  return lanes;
}

/** R78: `costMod` and `costOverride` persist in every zone, so every setup entry may seed them. */
function applyCostSetup(card: CardInstance, entry: string | (DefRef & CostSetup)): void {
  if (typeof entry === "string") return;
  if (entry.costMod !== undefined) card.costMod = entry.costMod;
  if (entry.costOverride !== undefined) card.costOverride = entry.costOverride;
}

/** Place one resolved entry, in the list order the ids follow. */
function placeOne(sink: EngineSink, player: PlayerId, entry: Placement): void {
  const state = sink.state;
  const { row, label, defId } = entry;
  const lane = entry.lane as number;
  const def = defOf(state, defId);

  const card = newInstance(state, defId, player, { z: "field", player, row, lane });
  if (entry.radiant === true) card.radiant = true;
  if (entry.statsOverride !== undefined) card.statsOverride = { ...entry.statsOverride };
  if (entry.counters !== undefined) card.counters = { ...entry.counters };
  applyCostSetup(card, entry);

  // §3.2 Stack: `stack: true` buries whatever is in the lane already — `placeOnField` puts the
  // arriving card on top, so the pile reads top-first and the list reads bottom-first.
  if (!placeOnField(state, card, { player, row, lane }, { stack: entry.stack === true })) {
    throw new Error(`${label}: ${player} ${row} lane ${lane} would not take "${def.name}"`);
  }

  if (row === "units") {
    card.position = entry.position ?? "ATK";
    if (entry.damage !== undefined) card.damage = entry.damage;
  }
  // R33: a Trap is face-down, so `faceUp: false` is a state a test asserts — write it as given
  // rather than leaving the flag unset, which would read `undefined`.
  if (row === "backrow" && entry.faceUp !== undefined) card.faceUp = entry.faceUp;
}

function placePile(
  sink: EngineSink,
  player: PlayerId,
  zone: PileName,
  refs: readonly PileSetup[],
  label: string,
): void {
  const state = sink.state;
  refs.forEach((entry, at) => {
    const at_ = `${label}[${at}]`;
    const defId = setupDefId(state, refOf(entry, at_), at_);
    const radiant = typeof entry === "string" ? false : entry.radiant === true;

    if (zone === "hand") {
      const card = createInHand(sink, player, defId);
      if (radiant) card.radiant = true;
      applyCostSetup(card, entry);
      return;
    }

    const card = newInstance(state, defId, player, { z: zone, player });
    if (radiant) card.radiant = true;
    applyCostSetup(card, entry);
    // `position: "bottom"` keeps list order, so `library[0]` is the next card drawn (draw.ts).
    const result = moveToZone(state, card, zone, { position: "bottom" });
    // R311: a scenario's library stands for its owner's deck, which they know.
    if (zone === "library" && result === "moved") showToOwner(card);
    if (result === "vanished") {
      throw new Error(
        `${at_}: "${defOf(state, defId).name}" is a unit token, and R11 makes one cease to ` +
          `exist on the way to a ${zone}; put it in a hand or a library instead`,
      );
    }
  });
}

function placeSide(sink: EngineSink, player: PlayerId, setup: SideSetup): void {
  placePile(sink, player, "hand", setup.hand ?? [], `${player}.hand`);

  // `field` and `backrow` are one board: each entry's row comes from its def's type (or its own
  // `row`), and lanes are then handed out per row over the whole board, `field` entries first.
  const placements: Placement[] = [
    ...(setup.field ?? []).map((entry, at) =>
      normalizePlacement(sink.state, entry, "units", `${player}.field[${at}]`),
    ),
    ...(setup.backrow ?? []).map((entry, at) =>
      normalizePlacement(sink.state, entry, "backrow", `${player}.backrow[${at}]`),
    ),
  ];
  for (const row of ["units", "backrow"] as const) {
    const inRow = placements.filter((entry) => entry.row === row);
    const lanes = assignLanes(inRow, rowSizeOf(row), `${player}.${row}`);
    inRow.forEach((entry, at) => {
      entry.lane = lanes[at];
    });
  }
  for (const entry of placements) placeOne(sink, player, entry);

  placePile(sink, player, "library", setup.library ?? [], `${player}.library`);
  placePile(sink, player, "graveyard", setup.graveyard ?? [], `${player}.graveyard`);
  placePile(sink, player, "exile", setup.exile ?? [], `${player}.exile`);
}

function buildState(opts: ScenarioOptions): GameState {
  const seed = opts.seed ?? DEFAULT_SEED;
  const deck = fillerDeck();
  const state = createGame({ seed, decks: [deck, deck] });

  // The filler libraries exist only to satisfy §2.6's deck validation.
  for (const player of PLAYER_IDS) {
    for (const card of [...state.players[player].library]) removeFromAnyZone(state, card);
  }
  state.nextId = 1;

  const active = opts.active ?? "p1";
  const turn = opts.turn ?? DEFAULT_TURN;
  if (!Number.isInteger(turn) || turn < 0) throw new Error(`scenario: turn must be a non-negative integer, got ${turn}`);
  state.active = active;
  state.turn = turn;
  state.phase = "main";
  state.players[active].turnsStarted = Math.max(0, Math.ceil(turn / 2));
  state.players[opponentOf(active)].turnsStarted = Math.max(0, Math.floor(turn / 2));

  const sink: EngineSink = { state, events: [], rng: createRng(state.seed, state.rngCursor) };

  // p1 then p2, and within a side hand → field → backrow → library → graveyard → exile, so the
  // instance ids a scenario hands out are a function of the setup literal alone.
  for (const player of PLAYER_IDS) placeSide(sink, player, (player === "p1" ? opts.p1 : opts.p2) ?? {});

  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    const setup = (player === "p1" ? opts.p1 : opts.p2) ?? {};
    refreshMana(side);
    if (setup.mana !== undefined) side.mana.current = setup.mana;
    if (setup.health !== undefined) side.hero.health = setup.health;
    if (setup.armor !== undefined) side.hero.armor = setup.armor;
  }

  // §4.5: settle the board once, so a unit placed at lethal damage dies like it would in play.
  stateCheck(sink);
  state.rngCursor = sink.rng.cursor;
  return state;
}

// ---------------------------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------------------------

class Harness implements Scenario {
  private current: GameState;
  private log: GameEvent[] = [];
  private last: GameEvent[] = [];
  private step = 0;

  constructor(opts: ScenarioOptions) {
    this.current = buildState(opts);
  }

  get state(): GameState {
    return this.current;
  }

  get events(): GameEvent[] {
    return this.log;
  }

  get lastEvents(): GameEvent[] {
    return this.last;
  }

  // --- refs -----------------------------------------------------------------------------------

  private resolve(ref: CardRef, where: Where, what: string): CardInstance {
    const state = this.current;

    if (typeof ref !== "string") {
      const live = findInstance(state, ref.id);
      if (live === undefined) {
        throw new Error(`${what}: ${ref.id} (${ref.defId}) is in no zone any more`);
      }
      const pool = searchOrder(state, where);
      if (!pool.some((card) => card.id === live.id)) {
        throw new Error(
          `${what}: ${describeInstance(state, live)} is not in ${whereLabel(where)} — it is in ${this.locate(live.id)}`,
        );
      }
      return live;
    }

    const pool = searchOrder(state, where);
    if (INSTANCE_ID.test(ref)) {
      const byId = pool.find((card) => card.id === ref);
      if (byId !== undefined) return byId;
    }

    const defIds = defIdsFor(state, ref);
    const byDef = pool.find((card) => defIds.includes(card.defId));
    if (byDef !== undefined) return byDef;

    const listing = pool.map((card) => describeInstance(state, card)).join(", ") || "nothing";
    const known = defIds.length > 0 ? ` (that names ${defIds.join(", ")}, of which no copy is there)` : "";
    throw new Error(`${what}: nothing matching "${ref}" is in ${whereLabel(where)}${known}; found ${listing}`);
  }

  private locate(id: string): Located {
    for (const player of PLAYER_IDS) {
      const side = this.current.players[player];
      if (side.hand.some((card) => card.id === id)) return "hand";
      if (side.library.some((card) => card.id === id)) return "library";
      if (side.graveyard.some((card) => card.id === id)) return "graveyard";
      if (side.exile.some((card) => card.id === id)) return "exile";
      if (side.resolving.some((card) => card.id === id)) return "resolving";
      if (side.units.some((pile) => (pile ?? []).some((card) => card.id === id))) return "field";
      if (side.backrow.some((card) => card?.id === id)) return "field";
    }
    return "gone";
  }

  /** An instance id for a reference, even when the instance has ceased to exist (R11). */
  private refId(ref: CardRef, zone: ZoneName): string {
    if (typeof ref !== "string") return ref.id;
    try {
      return this.resolve(ref, "any", "expectInZone").id;
    } catch (error) {
      if (INSTANCE_ID.test(ref)) return ref;
      const hint =
        zone === "gone"
          ? ' — to assert "gone" pass the CardInstance you were handed, or its instance id ("c7")'
          : "";
      throw new Error(`${(error as Error).message}${hint}`, { cause: error });
    }
  }

  card(ref: CardRef): CardInstance {
    return this.resolve(ref, "any", "card");
  }

  stats(ref: CardRef): UnitView {
    return unitView(this.current, this.resolve(ref, "any", "stats"));
  }

  // --- engine plumbing ------------------------------------------------------------------------

  /**
   * An action through `reduce`, with no rng argument so it derives one from (seed, cursor) itself.
   * Every action gets its own deterministic nonce, or `reduce`'s dedupe would replay the last
   * result instead of applying this one.
   */
  private tryAction(body: ActionInput): string | null {
    this.step += 1;
    const result = reduce(this.current, { ...body, nonce: `h${this.step}` });
    if (result.error !== undefined) return result.error;
    this.current = result.state;
    this.last = result.events;
    this.log.push(...result.events);
    return null;
  }

  private action(body: ActionInput, what: string): void {
    const error = this.tryAction(body);
    if (error !== null) throw new Error(`${error} — ${what}`);
  }

  /**
   * An action whose `reduce` case is still a placeholder: send it, and only for that exact message
   * run `engineCall`, which is the function `reduce` will call once it is wired. Any other refusal
   * throws untouched, so a real rules refusal is never swallowed.
   */
  private actionOrEngine(
    body: ActionInput,
    placeholder: string,
    what: string,
    engineCall: (sink: EngineSink) => string | null,
  ): void {
    const error = this.tryAction(body);
    if (error === null) return;
    if (error !== placeholder) throw new Error(`${error} — ${what}`);
    this.direct((sink) => {
      const refusal = engineCall(sink);
      if (refusal !== null) throw new Error(`${refusal} — ${what}`);
    });
  }

  /**
   * A direct engine call, threading the rng cursor the way `reduce` does. The state is mutated in
   * place (no clone), and nothing is merged into the log if `run` throws.
   */
  private direct(run: (sink: EngineSink) => void): void {
    const events: GameEvent[] = [];
    const sink: EngineSink = { state: this.current, events, rng: createRng(this.current.seed, this.current.rngCursor) };
    run(sink);
    this.current.rngCursor = sink.rng.cursor;
    this.last = events;
    this.log.push(...events);
  }

  // --- steps ----------------------------------------------------------------------------------

  play(card: CardRef, opts: PlayOptions = {}): Scenario {
    const inst = this.resolve(card, "hand", "play");
    const def = defOf(this.current, inst.defId);
    const what = `play ${describeInstance(this.current, inst)}`;

    let zone: ZoneChoice | undefined;
    if (opts.zone !== undefined) {
      if (def.type === "Spell") {
        throw new Error(`${what}: a Spell takes no zone, and zone ${opts.zone} was given`);
      }
      const row: Row = def.type === "Unit" ? "units" : "backrow";
      const size = row === "units" ? UNIT_ZONES : BACKROW_ZONES;
      if (!Number.isInteger(opts.zone) || opts.zone < 1 || opts.zone > size) {
        throw new Error(`${what}: zone ${opts.zone} is out of range; ${row} lanes are 1..${size}`);
      }
      zone = { row, lane: opts.zone };
    }

    const tributes = opts.tributes?.map((ref) => this.resolve(ref, "field", `${what} (tribute)`).id);

    this.action(
      {
        type: "play",
        playerId: inst.controller,
        instanceId: inst.id,
        ...(zone === undefined ? {} : { zone }),
        ...(opts.x === undefined ? {} : { x: opts.x }),
        ...(opts.embiggen === undefined ? {} : { embiggen: opts.embiggen }),
        ...(opts.targets === undefined ? {} : { targets: [...opts.targets] }),
        ...(opts.modes === undefined ? {} : { modes: [...opts.modes] }),
        ...(tributes === undefined ? {} : { tributes }),
      },
      what,
    );
    return this;
  }

  attack(attacker: CardRef, target: CardRef | "hero"): Scenario {
    const source = this.resolve(attacker, "field", "attack");
    const enemy = opponentOf(source.controller);
    const targetInstanceId = target === "hero" ? null : this.resolve(target, "field", "attack (target)").id;
    const targetId = targetInstanceId ?? `hero-${enemy}`;
    const what = `attack ${describeInstance(this.current, source)} → ${targetId}`;

    this.actionOrEngine(
      { type: "attack", playerId: source.controller, attackerId: source.id, targetId },
      PLACEHOLDERS.attack,
      what,
      (sink) => {
        const live = findInstance(sink.state, source.id);
        if (live === undefined) return "the attacker is gone";
        let aim: AttackTarget;
        if (targetInstanceId === null) {
          aim = { kind: "hero", player: opponentOf(live.controller) };
        } else {
          const defender = findInstance(sink.state, targetInstanceId);
          if (defender === undefined) return "the target is gone";
          aim = { kind: "unit", instance: defender };
        }
        return declareAttack(sink, live, aim).error ?? null;
      },
    );
    return this;
  }

  answer(selection: readonly Selection[] | string | readonly string[]): Scenario {
    const pending = this.current.pending;
    if (pending === null) {
      throw new Error(
        `answer(${JSON.stringify(selection)}): no prompt is open (phase ${this.current.phase}, ` +
          `turn ${this.current.turn}, active ${this.current.active})`,
      );
    }
    const picks = toSelections(this.current, selection, pending);
    const who = pending.playerId;
    const what = `answer ${pending.kind} prompt ${pending.id} with ${JSON.stringify(picks)}`;
    this.actionOrEngine(
      { type: "answer", playerId: who, choiceId: pending.id, selection: picks },
      PLACEHOLDERS.prompt,
      what,
      (sink) =>
        answerPrompt(sink, {
          playerId: who,
          choiceId: sink.state.pending?.id ?? pending.id,
          selection: picks,
        }),
    );
    return this;
  }

  endTurn(): Scenario {
    this.action({ type: "endTurn", playerId: this.current.active }, `endTurn for ${this.current.active}`);
    return this;
  }

  startTurn(): Scenario {
    this.direct((sink) => {
      engineStartTurn(sink, sink.state.active);
    });
    return this;
  }

  switchPosition(card: CardRef): Scenario {
    const unit = this.resolve(card, "field", "switchPosition");
    this.action(
      { type: "switchPosition", playerId: unit.controller, instanceId: unit.id },
      `switchPosition ${describeInstance(this.current, unit)}`,
    );
    return this;
  }

  activate(card: CardRef, opts: ActivateOptions = {}): Scenario {
    const source = this.resolve(card, "field", "activate");
    const who = source.controller;
    this.actionOrEngine(
      {
        type: "activatePower",
        playerId: who,
        instanceId: source.id,
        ...(opts.targets === undefined ? {} : { targets: [...opts.targets] }),
      },
      PLACEHOLDERS.power,
      `activate ${describeInstance(this.current, source)}`,
      (sink) =>
        subsystems.activatePower(sink, who, {
          instanceId: source.id,
          ...(opts.targets === undefined ? {} : { targets: opts.targets }),
        }),
    );
    return this;
  }

  // --- reads ----------------------------------------------------------------------------------

  view(player?: PlayerId): PlayerView {
    return viewFor(this.current, player ?? this.current.active);
  }

  unit(player: PlayerId, lane: number): CardInstance | null {
    this.checkLane("unit", "units", lane);
    return cardAt(this.current, { player, row: "units", lane });
  }

  backrow(player: PlayerId, lane: number): CardInstance | null {
    this.checkLane("backrow", "backrow", lane);
    return cardAt(this.current, { player, row: "backrow", lane });
  }

  hand(player?: PlayerId): CardInstance[] {
    return [...this.current.players[player ?? this.current.active].hand];
  }

  pile(player: PlayerId, zone: PileName): CardInstance[] {
    const side = this.current.players[player];
    if (zone === "hand") return [...side.hand];
    if (zone === "library") return [...side.library];
    if (zone === "graveyard") return [...side.graveyard];
    return [...side.exile];
  }

  private checkLane(what: string, row: Row, lane: number): void {
    const size = row === "units" ? UNIT_ZONES : BACKROW_ZONES;
    if (!Number.isInteger(lane) || lane < 1 || lane > size) {
      throw new Error(`${what}(): lane ${lane} is out of range; ${row} lanes are 1..${size}`);
    }
  }

  // --- assertions -----------------------------------------------------------------------------

  expectInZone(card: CardRef, zone: ZoneName): Scenario {
    const id = this.refId(card, zone);
    const actual = this.locate(id);
    const known = findInstance(this.current, id);
    const who = known === undefined ? id : describeInstance(this.current, known);
    expect(actual, `expectInZone: ${who} should be in ${zone} but is in ${actual}`).toBe(zone);
    return this;
  }

  expectStats(card: CardRef, stats: { attack?: number; health?: number; maxHealth?: number }): Scenario {
    const inst = this.resolve(card, "any", "expectStats");
    const view = unitView(this.current, inst);
    const who = describeInstance(this.current, inst);
    const seen = `attack ${view.attack}, health ${view.health}/${view.maxHealth}, damage ${inst.damage}, buffs +${inst.buffs.attack}/+${inst.buffs.health}`;
    for (const key of ["attack", "health", "maxHealth"] as const) {
      const want = stats[key];
      if (want === undefined) continue;
      expect(view[key], `expectStats: ${who} ${key} should be ${want} but is ${view[key]} — ${seen}`).toBe(want);
    }
    return this;
  }

  expectEvents(...types: GameEvent["type"][]): Scenario {
    let at = 0;
    const seen = this.log.map((event) => event.type);
    const missing: GameEvent["type"][] = [];
    for (const type of types) {
      const found = seen.indexOf(type, at);
      if (found < 0) {
        missing.push(type);
        break;
      }
      at = found + 1;
    }
    expect(
      missing,
      `expectEvents: ${types.join(" → ")} is not a subsequence of the log — the log holds ${seen.join(", ") || "nothing"}`,
    ).toEqual([]);
    return this;
  }

  expectHealth(player: PlayerId, health: number): Scenario {
    const actual = this.current.players[player].hero.health;
    expect(actual, `expectHealth: ${player}'s hero should be at ${health} but is at ${actual}`).toBe(health);
    return this;
  }

  expectMana(player: PlayerId, current: number): Scenario {
    const mana = this.current.players[player].mana;
    expect(
      mana.current,
      `expectMana: ${player} should have ${current} mana but has ${mana.current} of ${mana.max}`,
    ).toBe(current);
    return this;
  }
}

/**
 * §10.6: a prompt's answer is a `Selection[]`. A string (or `string[]`) is matched against
 * `state.pending.options` by `key`, then `label`, then a mode option, then the option's
 * `instanceId`, then that instance's `defId`, then the label case-insensitively, and finally by
 * resolving the string the way every other harness reference is resolved.
 */
function toSelections(
  state: GameState,
  selection: readonly Selection[] | string | readonly string[],
  pending: PendingChoice,
): Selection[] {
  if (typeof selection === "string") return [matchOption(state, selection, pending)];
  if (selection.length === 0) return [];
  const first = selection[0];
  if (typeof first === "string") {
    return (selection as readonly string[]).map((text) => matchOption(state, text, pending));
  }
  return [...(selection as readonly Selection[])];
}

function matchOption(state: GameState, text: string, pending: PendingChoice): Selection {
  const instanceIdOf = (pick: Selection): string | null => (pick.pick === "instance" ? pick.instanceId : null);
  const defIdOf = (pick: Selection): string | null => {
    const id = instanceIdOf(pick);
    return id === null ? null : findInstance(state, id)?.defId ?? null;
  };

  const tests: ((option: PendingChoice["options"][number]) => boolean)[] = [
    (o) => o.key === text,
    (o) => o.label === text,
    (o) => o.selection.pick === "mode" && o.selection.option === text,
    (o) => instanceIdOf(o.selection) === text,
    (o) => defIdOf(o.selection) === text,
    (o) => o.label.toLowerCase() === text.toLowerCase(),
    (o) => {
      const defIds = defIdsFor(state, text);
      const defId = defIdOf(o.selection);
      return defId !== null && defIds.includes(defId);
    },
  ];

  for (const test of tests) {
    const hit = pending.options.find(test);
    if (hit !== undefined) return hit.selection;
  }

  const listing = pending.options.map((o) => `${o.key} (${o.label})`).join(", ") || "nothing";
  throw new Error(
    `answer("${text}"): the ${pending.kind} prompt ${pending.id} has no such option. ` +
      `Keys and labels on offer: ${listing}. Pick ${pending.min}..${pending.max}.`,
  );
}

/** Build a scenario. See the file header for every default and every documented decision. */
export function scenario(opts: ScenarioOptions = {}): Scenario {
  return new Harness(opts);
}
