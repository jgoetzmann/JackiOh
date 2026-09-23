// R171 over random boards (SPEC §4.1, §11; docs/polish/4-edge-cases.md "fast-check properties").
//
// Each case builds a random board — per side and per lane, optionally one keyword body in either
// position, entered this turn, last turn or never marked, with any exertion, and optionally a Stack
// card on top of it — then applies one to three random control changes for either player: a steal
// of one of the actor's enemy top units, Steal all, the board swap, or a rotation in either
// direction on either face. The actor may be the inactive player, which is the opponent's-turn case.
//
// Four properties, each read from outside the code under test:
//   P1 bookkeeping: a card that got a `controlChanged` and is still on the field took this turn and
//      a fresh exertion; every other card on the field kept exactly what it started with; a card's
//      controller only changes with a `controlChanged`; nobody's owner changes.
//   P2 the §6.1 oracle: a unit that crossed, or started the turn freshly entered, is sick, so with
//      neither Rush nor Charge it has no target and without Charge it cannot aim at the hero; one
//      that crossed with Charge and nothing else stopping it has a target (the fresh exertion).
//   P3 `legalActions` offers exactly the attacks `reduce` accepts.
//   P4 R53: a forced attack by a unit that crossed still happens and spends nothing.
//
// Every run is reproducible from PROPERTY_SEED (CLAUDE.md rules 4 and 9 in spirit).

import type { Action, ActionInput, GameEvent, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, hasKeyword, opponentOf } from "@jackioh/shared";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { attackTargets, forceAttack, isActiveOnField, type AttackTarget } from "../src/combat";
import { UNIT_ZONES } from "../src/config";
import { rotate } from "../src/effects/rotate";
import { steal, stealAll } from "../src/effects/steal";
import { swapBoard } from "../src/effects/swap";
import { unitView } from "../src/layers";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { activeUnitsOf, placeOnField } from "../src/zones";
import { charger, deftDuelist, pacifist, plain, rusher, stacker, taunter, zeroAttack } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

/** The one seed every property runs from, so a failure reproduces exactly. */
const PROPERTY_SEED = 20260922;
/** P1, P2 and P4 build a board and apply a few effects: cheap. */
const BOOKKEEPING_RUNS = 300;
const ORACLE_RUNS = 300;
const FORCED_RUNS = 150;
/** P3 calls `reduce` for every attacker and target, and each call clones the state. */
const AGREEMENT_RUNS = 60;

/** The keyword bodies of `fixtures/combat` a unit zone is filled from. */
const BODIES = [plain, rusher, charger, deftDuelist, taunter, pacifist, zeroAttack] as const;

const FRESH = { attacked: false, switched: false };

type Entry = "now" | "last" | "unset";
type Exertion = { attacked: boolean; switched: boolean };
type Marks = { entry: Entry; exertion: Exertion };
type UnitSpec = Marks & { body: number; position: "ATK" | "DEF"; top: Marks | null };
type Board = Record<PlayerId, (UnitSpec | null)[]>;
type Verb =
  | { kind: "steal"; actor: PlayerId; pick: number }
  | { kind: "stealAll"; actor: PlayerId }
  | { kind: "swapBoard"; actor: PlayerId }
  | { kind: "rotate"; actor: PlayerId; direction: "left" | "right"; radiant: boolean };

const entryArb = fc.constantFrom<Entry>("now", "last", "unset");
const exertionArb = fc.record({ attacked: fc.boolean(), switched: fc.boolean() });
const marksArb = fc.record({ entry: entryArb, exertion: exertionArb });
const unitArb: fc.Arbitrary<UnitSpec> = fc.record({
  body: fc.nat({ max: BODIES.length - 1 }),
  position: fc.constantFrom<"ATK" | "DEF">("ATK", "DEF"),
  entry: entryArb,
  exertion: exertionArb,
  top: fc.option(marksArb, { nil: null }),
});
const sideArb = fc.array(fc.option(unitArb, { nil: null }), { minLength: UNIT_ZONES, maxLength: UNIT_ZONES });
const boardArb: fc.Arbitrary<Board> = fc.record({ p1: sideArb, p2: sideArb });
const actorArb = fc.constantFrom<PlayerId>("p1", "p2");
const verbArb: fc.Arbitrary<Verb> = fc.oneof(
  fc.record({ kind: fc.constant("steal" as const), actor: actorArb, pick: fc.nat({ max: UNIT_ZONES - 1 }) }),
  fc.record({ kind: fc.constant("stealAll" as const), actor: actorArb }),
  fc.record({ kind: fc.constant("swapBoard" as const), actor: actorArb }),
  fc.record({
    kind: fc.constant("rotate" as const),
    actor: actorArb,
    direction: fc.constantFrom<"left" | "right">("left", "right"),
    radiant: fc.boolean(),
  }),
);
const verbsArb = fc.array(verbArb, { minLength: 1, maxLength: 3 });

// ---------------------------------------------------------------------------
// Building and running a case.
// ---------------------------------------------------------------------------

let nonce = 0;

function act(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `ccp${nonce}` } as Action);
}

/** Past both mulligans, in p1's main phase of turn 1, with an empty board (rulings-b's `playing`). */
function playing(): GameState {
  let state = beginGame(newGame("control-change-property")).state;
  for (const player of PLAYER_IDS) {
    const result = act(state, { type: "mulligan", keep: state.players[player].hand.map((c) => c.id), playerId: player });
    if (result.error !== undefined) throw new Error(result.error);
    state = result.state;
  }
  return state;
}

const BASE = playing();

function clone(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

function mark(card: CardInstance, marks: Marks, turn: number): void {
  if (marks.entry === "now") card.summonedTurn = turn;
  else if (marks.entry === "last") card.summonedTurn = turn - 1;
  else delete card.summonedTurn;
  card.exertion = { ...marks.exertion };
}

/** Every card on the field, dormant pile cards and backrow cards included. */
function fieldCards(state: GameState): CardInstance[] {
  return PLAYER_IDS.flatMap((player) => {
    const side = state.players[player];
    return [...side.units.flatMap((pile) => pile ?? []), ...side.backrow.flatMap((card) => (card === null ? [] : [card]))];
  });
}

type Snapshot = { summonedTurn: number | undefined; exertion: Exertion; controller: PlayerId; owner: PlayerId };

function build(board: Board): { state: GameState; start: Map<string, Snapshot> } {
  const state = clone(BASE);
  const turn = state.turn;
  for (const player of PLAYER_IDS) {
    board[player].forEach((spec, index) => {
      if (spec === null) return;
      const ref = slot(player, "units", index + 1);
      const body = put(state, (BODIES[spec.body] ?? plain).id, ref);
      body.position = spec.position;
      mark(body, spec, turn);
      if (spec.top === null) return;
      const top = newInstance(state, stacker.id, player, { z: "hand", player });
      if (!placeOnField(state, top, ref, { stack: true })) throw new Error("could not stack");
      mark(top, spec.top, turn);
    });
  }
  const start = new Map<string, Snapshot>(
    fieldCards(state).map((card) => [
      card.id,
      { summonedTurn: card.summonedTurn, exertion: { ...card.exertion }, controller: card.controller, owner: card.owner },
    ]),
  );
  return { state, start };
}

function effectOf(state: GameState, verb: Verb): Effect | null {
  switch (verb.kind) {
    case "steal": {
      const enemies = activeUnitsOf(state, opponentOf(verb.actor));
      const target = enemies[verb.pick % Math.max(1, enemies.length)];
      return target === undefined ? null : steal({ instanceId: target.id });
    }
    case "stealAll":
      return stealAll();
    case "swapBoard":
      return swapBoard();
    case "rotate":
      return rotate({ direction: verb.direction, radiant: verb.radiant });
  }
}

/** Apply the verbs in order, each for its actor, and return every event with the crossed ids. */
function apply(state: GameState, verbs: readonly Verb[]): { events: GameEvent[]; crossed: Set<string> } {
  const events: GameEvent[] = [];
  for (const verb of verbs) {
    const effect = effectOf(state, verb);
    if (effect === null) continue;
    const sink = sinkFor(state, events);
    effect.apply(makeContext(sink, null, { controller: verb.actor }));
    state.rngCursor = sink.rng.cursor;
  }
  return { events, crossed: new Set(eventsOfType(events, "controlChanged").map((event) => event.instanceId)) };
}

type Case = { board: Board; verbs: Verb[] };
const caseArb: fc.Arbitrary<Case> = fc.record({ board: boardArb, verbs: verbsArb });

function run({ board, verbs }: Case): { state: GameState; start: Map<string, Snapshot>; crossed: Set<string> } {
  const { state, start } = build(board);
  const { crossed } = apply(state, verbs);
  return { state, start, crossed };
}

// ---------------------------------------------------------------------------
// The properties.
// ---------------------------------------------------------------------------

describe("R171 over random boards and random control changes (fast-check)", () => {
  it("R171 P1: only a card that changed sides takes this turn and a fresh exertion, and no owner changes", () => {
    fc.assert(
      fc.property(caseArb, (sample) => {
        const { state, start, crossed } = run(sample);
        const turn = state.turn;
        for (const card of fieldCards(state)) {
          const before = start.get(card.id);
          if (before === undefined) throw new Error(`${card.id} appeared on the field`);
          expect(card.controller, `${card.id} controller vs its zone`).toBe(card.zone.player);
          if (card.controller !== before.controller) expect(crossed.has(card.id), `${card.id} changed side silently`).toBe(true);
          if (crossed.has(card.id)) {
            expect(card.summonedTurn, `${card.id} crossed`).toBe(turn);
            expect(card.exertion, `${card.id} crossed`).toEqual(FRESH);
          } else {
            expect(card.summonedTurn, `${card.id} stayed`).toBe(before.summonedTurn);
            expect(card.exertion, `${card.id} stayed`).toEqual(before.exertion);
          }
        }
        for (const [id, before] of start) {
          expect(findInstance(state, id)?.owner, `${id} owner`).toBe(before.owner);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: BOOKKEEPING_RUNS },
    );
  });

  it("R171 P2: a unit that crossed is sick like one summoned this turn, and a Charge unit that crossed can attack", () => {
    fc.assert(
      fc.property(caseArb, (sample) => {
        const { state, start, crossed } = run(sample);
        const turn = state.turn;
        for (const unit of activeUnitsOf(state, state.active)) {
          const view = unitView(state, unit);
          const rush = hasKeyword(view.keywords, "Rush");
          const charge = hasKeyword(view.keywords, "Charge");
          const moved = crossed.has(unit.id);
          const sick = moved || start.get(unit.id)?.summonedTurn === turn;
          const targets = attackTargets(state, unit);
          const who = `${unit.id} (${unit.defId})`;
          if (sick && !rush && !charge) expect(targets, `${who} is sick`).toEqual([]);
          if (sick && !charge) expect(targets.some((t) => t.kind === "hero"), `${who} aims at the hero`).toBe(false);
          if (moved && charge && view.position === "ATK" && view.attack > 0 && !hasKeyword(view.keywords, "Can't attack")) {
            expect(targets.length, `${who} crossed with Charge`).toBeGreaterThan(0);
          }
        }
      }),
      { seed: PROPERTY_SEED, numRuns: ORACLE_RUNS },
    );
  });

  it("R171 P3: legalActions offers an attack exactly when reduce accepts it", () => {
    fc.assert(
      fc.property(caseArb, (sample) => {
        const { state } = run(sample);
        const player = state.active;
        const enemy = opponentOf(player);
        const offered = new Set(
          legalActions(state, player).flatMap((action) =>
            action.type === "attack" ? [`${action.attackerId}>${action.targetId}`] : [],
          ),
        );
        const targetIds = [...activeUnitsOf(state, enemy).map((card) => card.id), `hero-${enemy}`];
        for (const attacker of activeUnitsOf(state, player)) {
          for (const targetId of targetIds) {
            const result = act(state, { type: "attack", playerId: player, attackerId: attacker.id, targetId });
            expect(result.error === undefined, `${attacker.id} (${attacker.defId}) → ${targetId}: ${result.error ?? "accepted"}`).toBe(
              offered.has(`${attacker.id}>${targetId}`),
            );
          }
        }
      }),
      { seed: PROPERTY_SEED, numRuns: AGREEMENT_RUNS },
    );
  });

  it("R171 P4: a unit that crossed is still made to attack by a forced attack, which spends nothing (R53)", () => {
    fc.assert(
      fc.property(caseArb, (sample) => {
        const { state, crossed } = run(sample);
        for (const id of crossed) {
          const probe = clone(state);
          const attacker = findInstance(probe, id);
          if (attacker === undefined || !isActiveOnField(probe, attacker) || attacker.zone.z !== "field") continue;
          if (attacker.zone.row !== "units") continue;
          const enemy = opponentOf(attacker.controller);
          const first = activeUnitsOf(probe, enemy)[0];
          const target: AttackTarget = first === undefined ? { kind: "hero", player: enemy } : { kind: "unit", instance: first };
          const before = { ...attacker.exertion };

          const sink = sinkFor(probe);
          forceAttack(sink, attacker, target);

          expect(
            eventsOfType(sink.events, "attackDeclared").filter((event) => event.attackerId === id && event.forced),
            `${id} forced`,
          ).toHaveLength(1);
          expect(findInstance(probe, id)?.exertion, `${id} spent nothing`).toEqual(before);
        }
      }),
      { seed: PROPERTY_SEED, numRuns: FORCED_RUNS },
    );
  });
});
