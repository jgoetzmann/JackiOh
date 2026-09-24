// Swap (SPEC §6.3's Swap row, R73; BUILD M3-T1): #87 Pocket Chaos's three swaps — hero health,
// the board lane by lane, and the libraries — with R12's ownership rule and its one exception,
// R33's face-down trap and §3.2's Stack pile. The fixture Trap this file needs is registered here,
// so no shared fixture has to grow for it (BUILD §0).

import type { CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { swap, swapBoard, swapHealth, swapLibrary } from "../src/effects/swap";
import { makeContext, type HookOptions } from "../src/resolve";
import type { Effect } from "../src/script";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { viewFor } from "../src/viewFor";
import { cardAt, moveToZone, pileAt, placeOnField, lockZone } from "../src/zones";
import { spellDef } from "./fixtures/catalog";
import { plain, stacker } from "./fixtures/combat";
import { eventsOfType, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

/** A face-down Trap for R33; #87's board swap moves the backrow too. */
const trap: CardDef = spellDef(720, { id: "sw-trap", index: "720", name: "Swap Trap (fixture)", type: "Trap" });

/** The shared fixture unit token (R11). */
const TOKEN_ID = "fx-token-rush";

function game(seed = "swap-test"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [trap.id]: trap });
  state.turn = 3;
  state.active = "p1";
  return state;
}

/** Apply one effect the way `resolve.ts` does, and hand back the events it emitted. */
function run(state: GameState, effect: Effect, options: HookOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const ctx = makeContext(sink, null, { controller: "p1", ...options });
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

/** A Stack card pushed onto an occupied unit zone (§3.2); the harness's `put` fills empty zones. */
function stackOnto(state: GameState, defId: string, player: PlayerId, lane: number): CardInstance {
  const card = newInstance(state, defId, player, { z: "hand", player });
  expect(placeOnField(state, card, slot(player, "units", lane), { stack: true })).toBe(true);
  return card;
}

/** Where a card sits now, as "p2 units 5", for readable assertions. */
function whereIs(state: GameState, card: CardInstance): string {
  const zone = findInstance(state, card.id)?.zone;
  if (zone === undefined) return "gone";
  if (zone.z !== "field") return zone.z;
  return `${zone.player} ${zone.row} ${zone.lane}`;
}

describe("swap (§6.3, R73, M3-T1)", () => {
  it("R73 swaps hero health and leaves each hero's armor where it was", () => {
    const state = game();
    state.players.p1.hero = { health: 12, armor: 3 };
    state.players.p2.hero = { health: 27, armor: 5 };

    const events = run(state, swapHealth());

    expect(state.players.p1.hero.health).toBe(27);
    expect(state.players.p2.hero.health).toBe(12);
    // R73: armor stays with its hero, so only the two numbers changed places.
    expect(state.players.p1.hero.armor).toBe(3);
    expect(state.players.p2.hero.armor).toBe(5);

    // A swap is not damage, not a heal and not "lose health" (R18): one event, and that is all.
    expect(events).toEqual([{ type: "swapped", what: "health" }]);
  });

  it("R73 swaps board contents lane by lane in both rows, with control moving and nothing left behind", () => {
    const state = game();
    const mine = put(state, plain.id, slot("p1", "units", 2));
    mine.damage = 1;
    mine.buffs = { attack: 3, health: 4 };
    mine.counters = { plague: 2 };
    mine.position = "DEF";
    mine.summonedTurn = state.turn - 1;
    mine.exertion = { attacked: true, switched: false };
    const myBack = put(state, trap.id, slot("p1", "backrow", 4));
    const theirs = put(state, plain.id, slot("p2", "units", 5));
    const theirBack = put(state, trap.id, slot("p2", "backrow", 1));

    const events = run(state, swapBoard());

    // Lane-preserving: every card is in the same row and lane on the other side (R73, §3.1).
    expect(whereIs(state, mine)).toBe("p2 units 2");
    expect(whereIs(state, myBack)).toBe("p2 backrow 4");
    expect(whereIs(state, theirs)).toBe("p1 units 5");
    expect(whereIs(state, theirBack)).toBe("p1 backrow 1");
    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(cardAt(state, slot("p2", "units", 5))).toBeNull();

    // Control changes, ownership does not (R12).
    expect([mine.controller, myBack.controller]).toEqual(["p2", "p2"]);
    expect([theirs.controller, theirBack.controller]).toEqual(["p1", "p1"]);
    expect([mine.owner, myBack.owner, theirs.owner, theirBack.owner]).toEqual(["p1", "p1", "p2", "p2"]);

    // Nothing left the field, so R78's reset never ran: damage, buffs, counters and position came along.
    expect(mine.damage).toBe(1);
    expect(mine.buffs).toEqual({ attack: 3, health: 4 });
    expect(mine.counters).toEqual({ plague: 2 });
    expect(mine.position).toBe("DEF");
    // R171: summoning sickness does not come along. Changing sides is an entry on this turn, with a
    // fresh exertion for the new controller.
    expect(mine.summonedTurn).toBe(3);
    expect(mine.exertion).toEqual({ attacked: false, switched: false });

    // §10.3: one `swapped`, then a `controlChanged` per card — no new event type is needed.
    expect(new Set(events.map((event) => event.type))).toEqual(new Set(["swapped", "controlChanged"]));
    expect(eventsOfType(events, "swapped")).toEqual([{ type: "swapped", what: "board" }]);
    expect(eventsOfType(events, "controlChanged")).toEqual([
      { type: "controlChanged", instanceId: mine.id, controller: "p2", row: "units", lane: 2 },
      { type: "controlChanged", instanceId: myBack.id, controller: "p2", row: "backrow", lane: 4 },
      { type: "controlChanged", instanceId: theirs.id, controller: "p1", row: "units", lane: 5 },
      { type: "controlChanged", instanceId: theirBack.id, controller: "p1", row: "backrow", lane: 1 },
    ]);
  });

  it("R12 a swapped card changes controller but never owner, so it still leaves to its owner's zones", () => {
    const state = game();
    const card = put(state, plain.id, slot("p1", "units", 1));

    run(state, swapBoard());
    expect(card.controller).toBe("p2");
    expect(card.owner).toBe("p1");

    // Off the field a card always belongs to its owner (R12, §3.2), and R78 hands control back.
    moveToZone(state, card, "graveyard");
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(state.players.p2.graveyard).toHaveLength(0);
    expect(card.controller).toBe("p1");
  });

  it("R73 swaps uneven boards, so an empty side simply receives the other side's cards", () => {
    const state = game();
    const units = [1, 3, 4].map((lane) => put(state, plain.id, slot("p1", "units", lane)));
    const back = put(state, trap.id, slot("p1", "backrow", 5));

    const events = run(state, swapBoard());

    expect(units.map((card) => whereIs(state, card))).toEqual(["p2 units 1", "p2 units 3", "p2 units 4"]);
    expect(whereIs(state, back)).toBe("p2 backrow 5");
    expect(state.players.p1.units.every((pile) => pile === null)).toBe(true);
    expect(state.players.p1.backrow.every((card) => card === null)).toBe(true);
    expect(units.every((card) => card.controller === "p2")).toBe(true);
    // Nothing came back the other way, and nothing was bounced or lost.
    expect(eventsOfType(events, "controlChanged")).toHaveLength(4);
    expect(eventsOfType(events, "bounced")).toEqual([]);
    expect(state.players.p1.hand).toHaveLength(0);
  });

  it("R73 leaves locks with their zones, so a lock never travels with the card that sat under it", () => {
    const state = game();
    const card = put(state, plain.id, slot("p1", "units", 1));
    // §3.2: the current occupant is unaffected by the lock and the lock persists after it leaves.
    lockZone(state, slot("p1", "units", 1));

    run(state, swapBoard());

    expect(whereIs(state, card)).toBe("p2 units 1");
    // The lock stayed on the zone it was set on; the card's new zone did not become Locked (R73).
    expect(state.players.p1.locks.units).toEqual([true, false, false, false, false]);
    expect(state.players.p2.locks.units).toEqual([false, false, false, false, false]);
    expect(state.players.p1.locks.backrow.every((locked) => locked === false)).toBe(true);
  });

  it("R88 a card whose destination is Locked bounces to its owner's hand, as R14 does for a rotation", () => {
    // R88: R73 does not say what happens to a card swapped into a Locked
    // zone; §3.2's "accepts no summons" plus R14's answer for the other whole-board move is the
    // reading implemented here.
    const state = game();
    const blocked = put(state, plain.id, slot("p1", "units", 3));
    blocked.damage = 2;
    blocked.buffs = { attack: 1, health: 1 };
    const other = put(state, plain.id, slot("p1", "units", 2));
    lockZone(state, slot("p2", "units", 3));

    const events = run(state, swapBoard());

    expect(whereIs(state, blocked)).toBe("hand");
    expect(state.players.p1.hand.map((c) => c.id)).toContain(blocked.id);
    expect(cardAt(state, slot("p2", "units", 3))).toBeNull();
    expect(eventsOfType(events, "bounced")).toEqual([
      { type: "bounced", instanceId: blocked.id, defId: plain.id, owner: "p1" },
    ]);
    // It left the field, so R78's reset ran on the way to the hand.
    expect(blocked.damage).toBe(0);
    expect(blocked.buffs).toEqual({ attack: 0, health: 0 });
    expect(blocked.controller).toBe("p1");
    // The rest of the board still swapped, and the bounced card changed no control.
    expect(whereIs(state, other)).toBe("p2 units 2");
    expect(eventsOfType(events, "controlChanged").map((event) => event.instanceId)).toEqual([other.id]);
  });

  it("R33 a swapped face-down trap stays face-down and is readable by its new controller only", () => {
    const state = game();
    const hidden = put(state, trap.id, slot("p1", "backrow", 2));
    expect(hidden.faceUp).toBeUndefined();
    // Before the swap only p1 may read it: p2 sees a face-down marker (§3, R33).
    expect(viewFor(state, "p1").you.backrow[1]).toMatchObject({ defId: trap.id, faceDown: false });
    expect(viewFor(state, "p2").opponent.backrow[1]).toEqual({ faceDown: true });

    const events = run(state, swapBoard());

    expect(whereIs(state, hidden)).toBe("p2 backrow 2");
    expect(hidden.controller).toBe("p2");
    expect(hidden.owner).toBe("p1");
    // The swap never flips the card: `controller` is what decides who may read it (R33).
    expect(hidden.faceUp).toBeUndefined();
    expect(viewFor(state, "p2").you.backrow[1]).toMatchObject({ defId: trap.id, faceDown: false });
    expect(viewFor(state, "p1").opponent.backrow[1]).toEqual({ faceDown: true });
    expect(JSON.stringify(viewFor(state, "p1"))).not.toContain(trap.id);
    expect(eventsOfType(events, "controlChanged")).toEqual([
      { type: "controlChanged", instanceId: hidden.id, controller: "p2", row: "backrow", lane: 2 },
    ]);
  });

  it("§3.2 a Stack pile swaps whole and keeps the same card on top", () => {
    const state = game();
    const under = put(state, plain.id, slot("p1", "units", 5));
    under.damage = 1;
    const top = stackOnto(state, stacker.id, "p1", 5);

    const events = run(state, swapBoard());

    expect(pileAt(state, slot("p1", "units", 5))).toBeNull();
    expect(pileAt(state, slot("p2", "units", 5))?.map((c) => c.id)).toEqual([top.id, under.id]);
    expect(cardAt(state, slot("p2", "units", 5))?.id).toBe(top.id);
    // The dormant card came along, kept its damage and changed control with the zone (§3.2, R73).
    expect(under.damage).toBe(1);
    expect(top.controller).toBe("p2");
    expect(under.controller).toBe("p2");
    expect(eventsOfType(events, "controlChanged").map((event) => event.instanceId)).toEqual([top.id, under.id]);
    // Nothing beneath the top resumed, so no Stack note is kept against it (R212, `withPile`).
    expect(state.fieldExits?.uncovered?.[top.id]).toBeUndefined();
  });

  it("R11 a unit token that cannot land ceases to exist instead of reaching a hand", () => {
    const state = game();
    const token = put(state, TOKEN_ID, slot("p1", "units", 4));
    lockZone(state, slot("p2", "units", 4));

    const events = run(state, swapBoard());

    expect(eventsOfType(events, "bounced").map((event) => event.instanceId)).toEqual([token.id]);
    expect(findInstance(state, token.id)).toBeUndefined();
    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p2.graveyard).toHaveLength(0);
  });

  it("R73 swaps libraries whole and R12's exception gives each swapped card its new holder as owner", () => {
    const state = game();
    const mine = setLibrary(state, "p1", [plain.id, stacker.id, plain.id]);
    const theirs = setLibrary(state, "p2", [trap.id, TOKEN_ID]);
    state.players.p1.fatigueCount = 2;
    state.players.p2.fatigueCount = 0;

    const events = run(state, swapLibrary());

    // The piles changed places whole and kept their order, so each top card is still the next draw.
    expect(state.players.p1.library.map((c) => c.id)).toEqual(theirs.map((c) => c.id));
    expect(state.players.p2.library.map((c) => c.id)).toEqual(mine.map((c) => c.id));

    // R12's one exception (R73): the owner becomes the player whose library now holds the card.
    expect(theirs.every((card) => card.owner === "p1" && card.controller === "p1")).toBe(true);
    expect(mine.every((card) => card.owner === "p2" && card.controller === "p2")).toBe(true);
    expect(theirs.map((card) => card.zone)).toEqual(theirs.map(() => ({ z: "library", player: "p1" })));
    expect(mine.map((card) => card.zone)).toEqual(mine.map(() => ({ z: "library", player: "p2" })));

    // R73: fatigue is the player's, not the library's, so the counters stay where they were.
    expect(state.players.p1.fatigueCount).toBe(2);
    expect(state.players.p2.fatigueCount).toBe(0);

    // R11 (decision): a unit-token card never left a library, so it is still there, now p1's.
    expect(findInstance(state, theirs[1]?.id ?? "")?.zone).toEqual({ z: "library", player: "p1" });

    expect(events).toEqual([{ type: "swapped", what: "library" }]);
  });

  it("§6.3 swap reads the Choose one answer and swaps nothing when the answer names none of the three", () => {
    const state = game();
    state.players.p1.hero.health = 10;
    state.players.p2.hero.health = 30;

    // R81: a play-time mode arrives in `ctx.modes` …
    expect(run(state, swap(), { modes: ["health"] })).toEqual([{ type: "swapped", what: "health" }]);
    expect(state.players.p1.hero.health).toBe(30);

    // … and an answered "Choose one" prompt arrives in `ctx.targets` as a mode selection (§10.6).
    const answered = run(state, swap(), { targets: [{ pick: "mode", option: "health" }] });
    expect(answered).toEqual([{ type: "swapped", what: "health" }]);
    expect(state.players.p1.hero.health).toBe(10);

    // No answer, or one naming something else, fizzles: nothing swaps and nothing is emitted.
    expect(run(state, swap())).toEqual([]);
    expect(run(state, swap(), { modes: ["mana"] })).toEqual([]);
    expect(run(state, swap({ what: "board" }))).toEqual([{ type: "swapped", what: "board" }]);
    expect(state.players.p1.hero.health).toBe(10);
  });
});
