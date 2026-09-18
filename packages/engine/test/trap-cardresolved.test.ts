// The second of R17's two trap moments: `cardResolved` (SPEC §10.3's event list, §10.5 step 7;
// R17, R61, R100, R119).
//
// R17 splits trap timing in two. Sheepish answers step 4's `summoned`/`cardPlayed` pair, before the
// Cry, and costs the card its Cry. Bear Honeypot, Unstable Clone Machine and Unlicensed
// Experimentation fire "after the card resolves", which is step 7's `cardResolved` — emitted once
// per play or cast, after the Cry and after step 6 has drained every Echo repeat, carrying
// `permanent: true` when the card is still in play (R61's "played permanents only").
//
// What this file pins about the trap side of that event:
//
//   * R17 — a trap whose trigger names `cardResolved` is offered it, and the trap resolves to
//     completion there, like any other immediate response (§10.3).
//   * R100 — `cardResolved` travels the immediate path and not the scheduled one: it is not a
//     `TRAP_WINDOW_EVENTS` member, so the end-of-turn window never delivers it and the two paths
//     stay disjoint.
//   * R119 — a trap is itself a card someone played, so it does not answer the arrival event that
//     names it: not `cardPlayed` or `summoned` at step 4, and not its own `cardResolved` at step 7.
//     It stays armed and face-down for the next play instead.
//
// The events here are built by hand rather than played out, because the step-7 emission is
// `playSteps.ts`'s and lands separately (`echo.landAfterResolution` is written and not yet called).
// That is the point of the seam: the trap side is complete against the declared event.
//
// Fixtures are this file's own: defs are prefixed `tr-` and indexed from 2300 (BUILD §0).

import type { CardDef, GameEvent } from "@jackioh/shared";
import { GAME_EVENT_TYPES } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { damage } from "../src/effects";
import { beginGame, reduce } from "../src/reduce";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import {
  TRAP_WINDOW_EVENTS,
  fireTrapsFor,
  isTrapWindowEvent,
  runTrapWindow,
  trapsWatching,
} from "../src/traps";
import { settle } from "../src/triggers";
import { cardAt } from "../src/zones";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 2300;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `tr-${name}`,
    index: String(nextIndex),
    name: `${name} (cardResolved)`,
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

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

/** #60's shape: a Trap that answers the moment a played card has resolved (R17). */
const afterTrap = def("after", "Trap");
/** #85's shape: the same moment, but only for a card still in play — R61's `permanent` flag. */
const permanentTrap = def("permanent", "Trap");
/** A Trap on step 4's pair, for the other half of R119's arrival window. */
const arrivalTrap = def("arrival", "Trap");
/** The played card the hand-built events name, so they are about something real. */
const body = def("body", "Unit", {
  base: { attack: 2, health: 3, keywords: [], text: "body" },
  radiant: { attack: 4, health: 6, keywords: [], text: "body" },
});

const DEFS = [afterTrap, permanentTrap, arrivalTrap, body];

const SCRIPTS: Record<string, CardScripts> = {
  [afterTrap.id]: both({
    triggers: [
      { id: "tr-after", on: ["cardResolved"], run: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] },
    ],
  }),
  [permanentTrap.id]: both({
    triggers: [
      {
        id: "tr-permanent",
        on: ["cardResolved"],
        // R61: "only for played permanents", which is exactly what the event's flag reports.
        when: (ctx) => ctx.event.type === "cardResolved" && ctx.event.permanent,
        run: () => [damage({ to: { of: "enemyHero" }, amount: 3 })],
      },
    ],
  }),
  [arrivalTrap.id]: both({
    triggers: [
      { id: "tr-arrival", on: ["cardPlayed"], run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] },
    ],
  }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  let ready = beginGame(state).state;
  let nonceAt = 0;
  for (const player of ["p1", "p2"] as const) {
    nonceAt += 1;
    const result = reduce(ready, {
      type: "mulligan",
      keep: ready.players[player].hand.map((card) => card.id),
      playerId: player,
      nonce: `tr-mull-${seed}-${nonceAt}`,
    });
    if (result.error !== undefined) throw new Error(result.error);
    ready = result.state;
  }
  return ready;
}

/** §10.5 step 7's event, as `echo.landAfterResolution` builds it. */
function resolved(instance: CardInstance, permanent: boolean): GameEvent {
  return {
    type: "cardResolved",
    player: instance.controller,
    instanceId: instance.id,
    defId: instance.defId,
    permanent,
  };
}

/** The traps here are p2's, so `enemyHero` is p1's: what a trap firing is read off. */
function enemyHealth(state: GameState): number {
  return state.players.p1.hero.health;
}

// ---------------------------------------------------------------------------

describe("the cardResolved trap moment (§10.5 step 7, R17, R61, R100, R119)", () => {
  it("R17 offers a trap the cardResolved moment and resolves it there, on the immediate path", () => {
    const state = game("r17-card-resolved");
    const trap = put(state, afterTrap.id, slot("p2", "backrow", 1));
    const played = put(state, body.id, slot("p1", "units", 1));

    // The event type is declared, so nothing here is reaching ahead of the engine (§10.3's list).
    expect(GAME_EVENT_TYPES).toContain("cardResolved");
    // Matching needs no list of its own: a trigger that names the type is woken by it.
    expect(trapsWatching(state, resolved(played, true)).map((match) => match.trap.id)).toEqual([
      trap.id,
    ]);

    const before = enemyHealth(state);
    const sink = sinkFor(state);
    sink.events.push(resolved(played, true));
    settle(sink);

    // §10.3: the trap fired immediately, to completion, and was consumed (§5.1).
    expect(eventsOfType(sink.events, "trapFired").map((event) => event.instanceId)).toEqual([trap.id]);
    expect(enemyHealth(state)).toBe(before - 2);
    expect(cardAt(state, slot("p2", "backrow", 1))).toBeNull();
    expect(state.players.p2.graveyard.some((card) => card.id === trap.id)).toBe(true);
  });

  it("R61 reads the event's `permanent` flag, so a resolved Spell does not count as a played permanent", () => {
    const state = game("r61-permanent-flag");
    const trap = put(state, permanentTrap.id, slot("p2", "backrow", 1));
    const played = put(state, body.id, slot("p1", "units", 1));
    const before = enemyHealth(state);

    // A card that has left play by now reports `permanent: false`: the trap declines and stays
    // armed, which is R99's "a condition that must leave the trap armed belongs in `when`".
    const spent = sinkFor(state);
    expect(fireTrapsFor(spent, resolved(played, false)).fired).toEqual([]);
    expect(enemyHealth(state)).toBe(before);
    expect(cardAt(state, slot("p2", "backrow", 1))?.id).toBe(trap.id);
    expect(cardAt(state, slot("p2", "backrow", 1))?.faceUp).not.toBe(true);

    // Still in play, so the trap fires.
    const kept = sinkFor(state);
    expect(fireTrapsFor(kept, resolved(played, true)).fired).toEqual([trap.id]);
    expect(enemyHealth(state)).toBe(before - 3);
  });

  it("R100 keeps cardResolved on the immediate path: the end-of-turn window never delivers it", () => {
    const state = game("r100-card-resolved-immediate");
    put(state, afterTrap.id, slot("p2", "backrow", 1));
    const played = put(state, body.id, slot("p1", "units", 1));
    const event = resolved(played, true);

    // The two paths are disjoint, and only the window's events are withheld from the immediate one.
    expect(TRAP_WINDOW_EVENTS).not.toContain("cardResolved");
    expect(isTrapWindowEvent(event)).toBe(false);

    // The window's own event still fires nothing here: this trap does not watch a turn end.
    const window = sinkFor(state);
    const turnEnded: GameEvent = { type: "turnEnded", player: "p1", turn: state.turn, unspentMana: 0 };
    expect(runTrapWindow(window, turnEnded).fired).toEqual([]);
    expect(window.state.work).toEqual([]);

    // And the immediate check delivers `cardResolved`, which is the only path that does.
    const immediate = sinkFor(state);
    expect(fireTrapsFor(immediate, event).fired).toHaveLength(1);
  });

  it("R119 does not offer a trap the arrival of the play that put it there, at step 4 or step 7", () => {
    const state = game("r119-own-arrival");
    const after = put(state, afterTrap.id, slot("p2", "backrow", 1));
    const arrival = put(state, arrivalTrap.id, slot("p2", "backrow", 2));
    const before = enemyHealth(state);

    // Step 7, the subtle case: a trap played this turn is on the field when its own `cardResolved`
    // is dispatched, so only R119 keeps it from answering its own arrival.
    const own = sinkFor(state);
    expect(trapsWatching(state, resolved(after, true))).toEqual([]);
    expect(fireTrapsFor(own, resolved(after, true)).fired).toEqual([]);

    // Step 4's half of the same rule: a trap does not answer the `cardPlayed` that named it.
    const play: GameEvent = {
      type: "cardPlayed",
      player: "p2",
      instanceId: arrival.id,
      defId: arrival.defId,
      costPaid: 0,
    };
    expect(trapsWatching(state, play)).toEqual([]);
    expect(fireTrapsFor(sinkFor(state), play).fired).toEqual([]);

    // Nothing fired, nothing was spent, and both traps are still armed and face-down.
    expect(enemyHealth(state)).toBe(before);
    expect(cardAt(state, slot("p2", "backrow", 1))?.id).toBe(after.id);
    expect(cardAt(state, slot("p2", "backrow", 2))?.id).toBe(arrival.id);
    expect(cardAt(state, slot("p2", "backrow", 2))?.faceUp).not.toBe(true);

    // The very next play is answered: R119 excludes this play, not the trap (§8 #33's wording).
    const played = put(state, body.id, slot("p1", "units", 1));
    const next = sinkFor(state);
    expect(fireTrapsFor(next, resolved(played, true)).fired).toEqual([after.id]);
    expect(enemyHealth(state)).toBe(before - 2);
  });
});
