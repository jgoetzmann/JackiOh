// R153: a card registers only the triggers its zone allows (SPEC §10.3's registry, §6.2's
// start-of-turn and end-of-turn hooks, §3.2 and R13 on a Stack, R68 on the graveyard return).
//
// The registry is keyed by hook AND by zone, and the zone half is what this file pins:
//
//   * on the field or in the backrow a card answers its `triggers` plus its `startOfTurn`,
//     `endOfTurn`, `aura`, `setStat` and `onPlayHook` hooks;
//   * in a hand it answers only `handTriggers` (#89 Corpse Eater) — no hook at all;
//   * in a graveyard only the end-of-turn return of a spell that flagged itself when it was played
//     (#23 Reoccurring Dream, #24 Efficiency Dividend, #31 KY's Math Equation, R68);
//   * in a library, in exile, in the resolving zone or dormant under a Stack, nothing (R13).
//
// `triggers.triggerHoldersWithHook` read the hook off the script and ignored the zone, so a card in
// a HAND or a GRAVEYARD answered every hook it carried. Neither half raised an error; both produced
// a different game, which is why every test below asserts the board and not the registry alone:
//
//   * #58 Rush Token Farm in a hand summoned a Rush Token at the start of every turn, moving a unit
//     into a lane from a card that was never on the board;
//   * #64 Gifted Program in a hand made a 1-cost play Radiant, and a radiant #8 Mr. Vanilla is a
//     7/7 rather than a 3/3 — a combat spec's arithmetic, silently rewritten.
//
// Each test has a second half on purpose: the same card on the field or in the backrow must fire.
// Without it every assertion here would pass just as well on a card that never fires at all.
//
// Every fixture is its own: defs are prefixed `tz-` and indexed above 2500, so they cannot collide
// with another test file's catalog (BUILD §0).

import type { Action, ActionInput, CardDef, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { summon } from "../src/effects";
import { beginGame, reduce } from "../src/reduce";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { triggerHoldersWithHook } from "../src/triggers";
import { activeUnitsOf, placeOnField } from "../src/zones";
import { inHand, newGame, put, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 2500;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `tz-${name}`,
    index: String(nextIndex),
    name: `${name} (trigger zones)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function unit(name: string, attack = 2, health = 4): CardDef {
  return def(name, "Unit", {
    base: { attack, health, keywords: [], text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords: [], text: name },
  });
}

/** The note sink: a script-less Field Spell parked in p1's backrow lane 5. */
const logCard = def("log", "Field Spell");
/** #58 Rush Token Farm's shape: a Field Spell that summons a token at every start of turn. */
const farm = def("farm", "Field Spell");
/** #64 Gifted Program's shape: a Field Spell with a pre-resolution hook on every play. */
const gifter = def("gifter", "Field Spell");
/** #23/#24/#31's shape: a Spell that comes back from the graveyard at the end of the turn. */
const wanderer = def("wanderer", "Spell");
/** #13 Jlockeed Shredder-10's shape: a UNIT with an end-of-turn hook, which the graveyard denies. */
const shredder = unit("shredder");
/** A unit with a start-of-turn hook, to be buried under a Stack (§3.2, R13). */
const sleeper = unit("sleeper");

const DEFS = [logCard, farm, gifter, wanderer, shredder, sleeper];

/** The fixture catalog's Rush token, the thing #58's shape puts on the board. */
const TOKEN_ID = "fx-token-rush";
/** A plain 1-cost vanilla unit from the fixture catalog: the card the `onPlayHook` test plays. */
const BAIT_ID = "fx-1";

// ---------------------------------------------------------------------------
// The note log: what fired, in the order it fired.
// ---------------------------------------------------------------------------

const NOTE_LANE = 5;

function logOf(state: GameState): CardInstance | null {
  const card = state.players.p1.backrow[NOTE_LANE - 1] ?? null;
  return card !== null && card.defId === logCard.id ? card : null;
}

function note(name: string): Effect {
  return {
    kind: "tz:note",
    apply(ctx): void {
      const log = logOf(ctx.state);
      if (log === null) return;
      const steps = Array.isArray(log.memory.steps) ? (log.memory.steps as string[]) : [];
      log.memory.steps = [...steps, name];
    },
  };
}

function notes(state: GameState): string[] {
  const log = logOf(state);
  return Array.isArray(log?.memory.steps) ? (log.memory.steps as string[]) : [];
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [farm.id]: both({ startOfTurn: () => [note("farm:start"), summon({ defId: TOKEN_ID })] }),
  [gifter.id]: both({ onPlayHook: () => [note("gifter:onPlay")] }),
  // Both hooks, so the graveyard's "end-of-turn return and nothing else" is a real restriction and
  // not just the only hook the card happens to carry.
  [wanderer.id]: both({
    startOfTurn: () => [note("wanderer:start")],
    endOfTurn: () => [note("wanderer:end")],
  }),
  [shredder.id]: both({ endOfTurn: () => [note("shredder:end")] }),
  [sleeper.id]: both({ startOfTurn: (ctx) => [note(`sleeper:${ctx.self?.id ?? "none"}`)] }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

let nonce = 0;

function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `tz${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in p1's main phase, with the note log parked in p1's backrow lane 5. */
function playing(seed: string): GameState {
  let state = beginGame(game(seed)).state;
  state = act(state, {
    type: "mulligan",
    keep: state.players.p1.hand.map((card) => card.id),
    playerId: "p1",
  });
  state = act(state, {
    type: "mulligan",
    keep: state.players.p2.hand.map((card) => card.id),
    playerId: "p2",
  });
  put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
  return state;
}

/** Round the table once, so p1's turn starts and p1's `startOfTurn` hooks are offered (§6.2). */
function roundToP1Start(state: GameState): GameState {
  return act(act(state, { type: "endTurn", playerId: "p1" }), { type: "endTurn", playerId: "p2" });
}

/** A card put straight into a graveyard, the way a mill or a discard leaves one there. */
function bury(state: GameState, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(state, defId, player, { z: "graveyard", player });
  state.players[player].graveyard.push(card);
  return card;
}

/** A Stack card pushed onto an occupied unit zone (§3.2); the harness's `put` fills empty ones. */
function stackOnto(state: GameState, defId: string, player: PlayerId, lane: number): CardInstance {
  const card = newInstance(state, defId, player, { z: "hand", player });
  expect(placeOnField(state, card, slot(player, "units", lane), { stack: true })).toBe(true);
  return card;
}

function tokensOf(state: GameState, player: PlayerId): number {
  return activeUnitsOf(state, player).filter((card) => card.defId === TOKEN_ID).length;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

// ---------------------------------------------------------------------------

describe("R153 a card registers only the triggers its zone allows (§10.3, §6.2, R13, R68)", () => {
  it("R153 a start-of-turn hook in a HAND does nothing, and the same card in the backrow fires", () => {
    // The hand half: #58's shape sits in p1's hand over a whole turn cycle and never acts.
    const held = playing("tz-start-hand");
    const card = only(inHand(held, farm.id, "p1"));
    expect(triggerHoldersWithHook(held, "startOfTurn", "p1")).toEqual([]);

    const afterHand = roundToP1Start(held);
    expect(notes(afterHand)).toEqual([]);
    // The observable damage the bug did: a unit in a lane, from a card that was never on the board.
    expect(tokensOf(afterHand, "p1")).toBe(0);
    expect(afterHand.players.p1.hand.some((inHandNow) => inHandNow.id === card.id)).toBe(true);

    // The backrow half, which is what stops the assertions above passing on a card that never
    // fires: the same fixture, the same turn cycle, on the board.
    const placed = playing("tz-start-field");
    put(placed, farm.id, slot("p1", "backrow", 1));
    expect(triggerHoldersWithHook(placed, "startOfTurn", "p1").map((h) => h.card.defId)).toEqual([
      farm.id,
    ]);

    const afterField = roundToP1Start(placed);
    expect(notes(afterField)).toEqual(["farm:start"]);
    expect(tokensOf(afterField, "p1")).toBe(1);
  });

  it("R153 an on-play hook in a HAND does not see the play, and the same card in the backrow does", () => {
    // #64's shape: the hook runs at §10.5 step 3, before the played card resolves.
    const held = playing("tz-onplay-hand");
    inHand(held, gifter.id, "p1");
    expect(triggerHoldersWithHook(held, "onPlayHook")).toEqual([]);

    const bait = only(inHand(held, BAIT_ID, "p1"));
    const afterHand = act(held, {
      type: "play",
      instanceId: bait.id,
      zone: { row: "units", lane: 2 },
      playerId: "p1",
    });
    expect(notes(afterHand)).toEqual([]);

    const placed = playing("tz-onplay-field");
    put(placed, gifter.id, slot("p1", "backrow", 1));
    expect(triggerHoldersWithHook(placed, "onPlayHook").map((h) => h.card.defId)).toEqual([
      gifter.id,
    ]);

    const other = only(inHand(placed, BAIT_ID, "p1"));
    const afterField = act(placed, {
      type: "play",
      instanceId: other.id,
      zone: { row: "units", lane: 2 },
      playerId: "p1",
    });
    expect(notes(afterField)).toEqual(["gifter:onPlay"]);
  });

  it("R153, R68 a GRAVEYARD spell flagged when it was played still answers its end-of-turn return", () => {
    const state = playing("tz-gy-flagged");
    const spell = bury(state, wanderer.id, "p1");
    // §5.1: "Spells with 'End of turn: add this back to your hand' are flagged
    // `returnToHandAtEndOfTurn` when they are played". This is that flag, and nothing else.
    spell.returnToHandAtEndOfTurn = true;
    expect(triggerHoldersWithHook(state, "endOfTurn", "p1").map((h) => h.card.id)).toEqual([
      spell.id,
    ]);

    const ended = act(state, { type: "endTurn", playerId: "p1" });
    expect(notes(ended)).toEqual(["wanderer:end"]);
  });

  it("R153 the graveyard answers the end-of-turn return ONLY, not a start-of-turn hook on the same spell", () => {
    const state = playing("tz-gy-start");
    const spell = bury(state, wanderer.id, "p1");
    spell.returnToHandAtEndOfTurn = true;
    // The same instance that answers `endOfTurn` above answers no `startOfTurn` at all.
    expect(triggerHoldersWithHook(state, "startOfTurn", "p1")).toEqual([]);

    const afterStart = roundToP1Start(state);
    expect(notes(afterStart).filter((step) => step === "wanderer:start")).toEqual([]);
  });

  it("R155 the flag, not the turn log, is what lets a graveyard spell answer its return", () => {
    // This test used to assert the turn log, because nothing set `returnToHandAtEndOfTurn` and the
    // registry took the log as a stand-in. R155 gives §10.5 step 7 the setter, so the flag is now
    // the gate and the log is no longer consulted — which is strictly more correct, since the log
    // cannot tell a spell that asked to return from a card that merely happened to be played.
    const played = playing("tz-gy-log");
    const spell = bury(played, wanderer.id, "p1");
    spell.returnToHandAtEndOfTurn = true;

    expect(notes(act(played, { type: "endTurn", playerId: "p1" }))).toEqual(["wanderer:end"]);

    // Being in this turn's play log is NOT enough on its own any more: that is the R155 change,
    // and asserting it here is what stops the flag check silently reverting to the old behaviour.
    const logged = playing("tz-gy-logonly");
    const viaLog = bury(logged, wanderer.id, "p1");
    logged.players.p1.turnLog.playedIds = [...logged.players.p1.turnLog.playedIds, viaLog.id];
    expect(triggerHoldersWithHook(logged, "endOfTurn", "p1")).toEqual([]);
    expect(notes(act(logged, { type: "endTurn", playerId: "p1" }))).toEqual([]);

    // Unflagged and unplayed: a copy that was milled or discarded, or one left from an earlier
    // turn, stays in the graveyard and answers nothing.
    const stale = playing("tz-gy-stale");
    bury(stale, wanderer.id, "p1");
    expect(triggerHoldersWithHook(stale, "endOfTurn", "p1")).toEqual([]);
    expect(notes(act(stale, { type: "endTurn", playerId: "p1" }))).toEqual([]);
  });

  it("R153 a UNIT that died on the turn it was played does not fire its end-of-turn hook from the graveyard", () => {
    // #13 Jlockeed Shredder-10's shape. It is in the graveyard and in this turn's play log, so the
    // log alone would let it shred from there; the §5.1 return belongs to spells.
    const dead = playing("tz-gy-unit");
    const corpse = bury(dead, shredder.id, "p1");
    dead.players.p1.turnLog.playedIds = [...dead.players.p1.turnLog.playedIds, corpse.id];
    expect(triggerHoldersWithHook(dead, "endOfTurn", "p1")).toEqual([]);
    expect(notes(act(dead, { type: "endTurn", playerId: "p1" }))).toEqual([]);

    // On the field the same unit fires, so the assertion above is about the zone and not the card.
    const alive = playing("tz-field-unit");
    put(alive, shredder.id, slot("p1", "units", 1));
    expect(notes(act(alive, { type: "endTurn", playerId: "p1" }))).toEqual(["shredder:end"]);
  });

  it("R153, R13 a card dormant under a Stack answers nothing, while the top of the pile fires", () => {
    const state = playing("tz-stack");
    const dormant = put(state, sleeper.id, slot("p1", "units", 1));
    const top = stackOnto(state, sleeper.id, "p1", 1);
    expect(state.players.p1.units[0]?.map((card) => card.id)).toEqual([top.id, dormant.id]);

    // §3.2: cards under a Stack are not on the field, so only the top of the pile is a holder.
    expect(triggerHoldersWithHook(state, "startOfTurn", "p1").map((h) => h.card.id)).toEqual([
      top.id,
    ]);

    const started = roundToP1Start(state);
    expect(notes(started)).toEqual([`sleeper:${top.id}`]);
  });
});
