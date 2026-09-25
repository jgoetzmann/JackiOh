// `viewFor(state, playerId)` — the one window a player has onto a match (SPEC §10.8, BUILD M3-T6).
//
// The centrepiece is the hidden-information proof: a board where p2 holds a full hand, a full
// library and face-down traps, serialized for p1, must name none of it. The forbidden list is
// derived from the state itself rather than written out here, so the proof cannot quietly stop
// proving anything when the fixtures change.
//
// The rest of §10.8 is the positive half — own hand in full, the opponent's as a count, both
// libraries as counts, Field Spells public, graveyards and exile in full, the viewer's own prompt
// options only, mana, health, armor, the clock and the last N events — plus R33's two halves: a
// face-down trap follows its *controller*, and a Field Trap that has fired is public to both.
//
// R97 is here too: the event stream is filtered like the zones it reports on — redacted to the
// `"hidden"` sentinel, never truncated, and judged by where a card sits *now*.
//
// The Trap, Field Trap and "secret" definitions this file needs live here rather than in a shared
// fixture, as effects-swap.test.ts does for its own Trap (BUILD §0, CLAUDE.md).

import type {
  CardDef,
  CardView,
  DistributiveOmit,
  GameEvent,
  PendingView,
  PlayerId,
  PlayerView,
} from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defOf, registerCatalog, registeredCatalog } from "../src/catalog";
import { HAND_CAP } from "../src/config";
import { steal } from "../src/effects";
import { openPrompt } from "../src/prompts";
import { makeContext, type HookOptions } from "../src/resolve";
import type { Effect } from "../src/script";
import {
  newInstance,
  type CardInstance,
  type GameState,
  type PlayerModifier,
  type PromptOption,
  type Resume,
} from "../src/state";
import { addModifier } from "../src/modifiers";
import { HIDDEN_ID, VIEW_EVENT_LIMIT, viewFor } from "../src/viewFor";
import { lockZone, placeOnField } from "../src/zones";
import { plain } from "./fixtures/combat";
import { inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let nextIndex = 1300;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `vf-${name}`,
    index: String(nextIndex),
    name,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function unit(name: string, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack: 2, health: 3, keywords: [], text: name },
    radiant: { attack: 4, health: 6, keywords: [], text: name },
    ...extra,
  });
}

/** Two-digit names, so no secret id is a prefix of another one. */
function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** §9.1's hidden zones, each with definitions of its own, so a leak names its own zone. */
const secretHandDefs = Array.from({ length: HAND_CAP }, (_, i) => unit(`secret-hand-${pad(i)}`));
const secretLibraryDefs = Array.from({ length: 12 }, (_, i) => def(`secret-library-${pad(i)}`, "Spell"));
/** A face-down Trap and a Field Trap: the two backrow types §10.8 calls "unknown". */
const secretTrap = def("secret-trap", "Trap");
const secretFieldTrap = def("secret-field-trap", "Field Trap");
/** The card under a Stack, whose identity R13 and §3.2 keep from both players. */
const secretBuried = unit("secret-buried", { base: { attack: 9, health: 9, keywords: [], text: "buried" } });
/** A Field Spell in the backrow, which §10.8 makes public. */
const publicField = def("public-field", "Field Spell");
/** A Stack unit, to bury the secret one under (§3.2). */
const stackTop = unit("stack-top", {
  base: { attack: 1, health: 1, keywords: [{ kind: "Stack" }], text: "stack" },
  radiant: { attack: 2, health: 2, keywords: [{ kind: "Stack" }], text: "stack" },
});

const DEFS: CardDef[] = [
  ...secretHandDefs,
  ...secretLibraryDefs,
  secretTrap,
  secretFieldTrap,
  secretBuried,
  publicField,
  stackTop,
];

/** p1's main phase on turn 3, with this file's definitions registered alongside the fixtures. */
function game(seed = "view-test"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

/** Apply one effect the way `resolve.ts` does (effects-swap.test.ts's helper). */
function run(state: GameState, effect: Effect, options: HookOptions = {}): void {
  const sink = sinkFor(state);
  effect.apply(makeContext(sink, null, { controller: "p1", ...options }));
  state.rngCursor = sink.rng.cursor;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${index}`);
  return value;
}

/** §10.8: the viewer's own hand is the full list, never a count. */
function ownHand(view: PlayerView): CardView[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand must travel in full (§10.8)");
  return hand;
}

/** The options of a prompt that belongs to this viewer (§10.6). */
function ownOptions(view: PlayerView): Extract<PendingView, { forYou: true }> {
  const pending = must(view.pending, "an open prompt in the view");
  if (!pending.forYou) throw new Error("that prompt belongs to the other player");
  return pending;
}

/** A card in a pile off the field, put there directly: `graveyard` and `exile` are public (§10.8). */
function putInPile(state: GameState, defId: string, player: PlayerId, pile: "graveyard" | "exile"): CardInstance {
  const card = newInstance(state, defId, player, { z: pile, player });
  state.players[player][pile].push(card);
  return card;
}

/** A continuation nothing services: this file is about the view, not about answering (§10.6). */
const inertResume: Resume = { defId: "", hook: "resume", step: "none", radiant: false, data: {} };

function modeOption(option: string): PromptOption {
  return { key: `mode:${option}`, label: option, selection: { pick: "mode", option } };
}

// ---------------------------------------------------------------------------

describe("viewFor (§10.8, M3-T6)", () => {
  it("§10.8 names nothing in the opponent's hand, library or face-down backrow, derived from the state", () => {
    const state = game("hidden-information");

    // p2 fills all three zones §9.1 hides: a full hand, a library and two face-down backrow cards.
    const theirHand = secretHandDefs.map((d) => at(inHand(state, d.id, "p2"), 0));
    const theirLibrary = setLibrary(
      state,
      "p2",
      secretLibraryDefs.map((d) => d.id),
    );
    const theirTraps = [
      put(state, secretTrap.id, slot("p2", "backrow", 1)),
      put(state, secretFieldTrap.id, slot("p2", "backrow", 2)),
    ];
    expect(theirHand).toHaveLength(HAND_CAP);

    // Public things on the same board, so the proof is not vacuous: an empty view hides everything.
    const myHand = inHand(state, plain.id, "p1", 3);
    const theirUnit = put(state, plain.id, slot("p2", "units", 1));
    const theirField = put(state, publicField.id, slot("p2", "backrow", 3));

    // §10.3's event stream is filtered like the zones it reports on: a `drawn` naming a card that is
    // now in p2's hand may not carry its identity to p1 either (§9.1, §10.8's "last N events").
    const drawn = at(theirHand, 0);
    state.applied = [
      {
        nonce: "hidden-1",
        events: [{ type: "drawn", player: "p2", instanceId: drawn.id, defId: drawn.defId }],
      },
    ];

    // The forbidden list comes out of the state, never out of a literal in this file.
    const forbidden = new Set<string>();
    for (const card of [...state.players.p2.hand, ...state.players.p2.library]) {
      forbidden.add(card.id);
      forbidden.add(card.defId);
    }
    for (const card of state.players.p2.backrow) {
      if (card === null) continue;
      const type = defOf(state, card.defId).type;
      if (card.faceUp === true || (type !== "Trap" && type !== "Field Trap")) continue;
      forbidden.add(card.id);
      forbidden.add(card.defId);
    }
    // Every hidden card contributed both of its ids, so the list cannot have gone quietly empty.
    expect(forbidden.size).toBe(2 * (theirHand.length + theirLibrary.length + theirTraps.length));

    const view = viewFor(state, "p1");
    const serialized = JSON.stringify(view);
    for (const id of forbidden) expect(serialized).not.toContain(`"${id}"`);

    // The positive half of §10.8, on the same board.
    expect(ownHand(view).map((card) => card.instanceId)).toEqual(myHand.map((card) => card.id));
    expect(view.opponent.hand).toEqual({ count: HAND_CAP });
    expect(view.you.libraryCount).toBe(state.players.p1.library.length);
    expect(view.opponent.libraryCount).toBe(theirLibrary.length);
    // Units are public on both sides; the two traps are markers and the Field Spell is not.
    expect(view.opponent.units[0]).toMatchObject({ defId: theirUnit.defId, attack: 3, health: 3, buried: 0 });
    expect(view.opponent.backrow[0]).toEqual({ faceDown: true });
    expect(view.opponent.backrow[1]).toEqual({ faceDown: true });
    expect(view.opponent.backrow[2]).toMatchObject({
      faceDown: false,
      defId: publicField.id,
      instanceId: theirField.id,
      type: "Field Spell",
    });
    // The redacted event kept its cue and its place, so the animation still runs (§10.10).
    expect(view.events).toHaveLength(1);
    expect(at(view.events, 0).type).toBe("drawn");

    // p2's own view is the mirror: p2 reads p2's hand, and p1's hand is the count there.
    const theirView = viewFor(state, "p2");
    expect(ownHand(theirView).map((card) => card.defId)).toEqual(theirHand.map((card) => card.defId));
    expect(theirView.opponent.hand).toEqual({ count: myHand.length });
    expect(theirView.you.backrow[0]).toMatchObject({ faceDown: false, defId: secretTrap.id });
  });

  it("§10.8 the viewer's own hand travels in full and in order, and the opponent's as a count", () => {
    const state = game("hands");
    const mine = inHand(state, plain.id, "p1", 2);
    at(mine, 1).radiant = true;
    const theirs = inHand(state, secretTrap.id, "p2", 4);

    const view = viewFor(state, "p1");
    expect(ownHand(view)).toMatchObject([
      { instanceId: at(mine, 0).id, defId: plain.id, radiant: false, cost: 1 },
      { instanceId: at(mine, 1).id, defId: plain.id, radiant: true, cost: 1 },
    ]);
    expect(ownHand(view)).toHaveLength(mine.length);
    // A count and nothing else: no array, no ids, no defs (§10.8).
    expect(view.opponent.hand).toEqual({ count: theirs.length });
    expect(Object.keys(view.opponent.hand)).toEqual(["count"]);
  });

  it("§9.1 sends both libraries as a count, and no library card's instance reaches either player's view", () => {
    const state = game("libraries");
    const theirLibrary = setLibrary(
      state,
      "p2",
      secretLibraryDefs.map((d) => d.id),
    );
    const myLibrary = state.players.p1.library;
    expect(myLibrary.length).toBeGreaterThan(0);

    const mine = JSON.stringify(viewFor(state, "p1"));
    const theirs = JSON.stringify(viewFor(state, "p2"));

    expect(viewFor(state, "p1").you.libraryCount).toBe(myLibrary.length);
    expect(viewFor(state, "p1").opponent.libraryCount).toBe(theirLibrary.length);
    // Library order is hidden from *both* players, the owner included: no instance id ships. The
    // owner's own library also travels as a list without order (R310, ownLibrary.test.ts), and the
    // opponent's contents never do.
    for (const card of myLibrary) {
      expect(mine).not.toContain(`"${card.id}"`);
      expect(theirs).not.toContain(`"${card.id}"`);
    }
    for (const card of theirLibrary) {
      expect(mine).not.toContain(`"${card.id}"`);
      expect(mine).not.toContain(`"${card.defId}"`);
      expect(theirs).not.toContain(`"${card.id}"`);
    }
  });

  it("§10.8 sends both graveyards and both exile piles in full", () => {
    const state = game("graveyards");
    const myGrave = putInPile(state, at(secretLibraryDefs, 0).id, "p1", "graveyard");
    const myExile = putInPile(state, at(secretLibraryDefs, 1).id, "p1", "exile");
    const theirGrave = putInPile(state, at(secretLibraryDefs, 2).id, "p2", "graveyard");
    const theirExile = putInPile(state, at(secretLibraryDefs, 3).id, "p2", "exile");

    for (const viewer of ["p1", "p2"] as const) {
      const view = viewFor(state, viewer);
      const own = viewer === "p1" ? view.you : view.opponent;
      const other = viewer === "p1" ? view.opponent : view.you;
      expect(own.graveyard).toMatchObject([
        { instanceId: myGrave.id, defId: myGrave.defId, radiant: false, cost: 1 },
      ]);
      expect(own.exile).toMatchObject([
        { instanceId: myExile.id, defId: myExile.defId, radiant: false, cost: 1 },
      ]);
      // The opponent's piles too: nothing about a graveyard or an exile pile is hidden.
      expect(other.graveyard.map((card) => card.defId)).toEqual([theirGrave.defId]);
      expect(other.exile.map((card) => card.defId)).toEqual([theirExile.defId]);
    }
  });

  it("§10.8 makes a backrow Field Spell public and a backrow Trap unknown to the opponent", () => {
    const state = game("backrow-types");
    const field = put(state, publicField.id, slot("p2", "backrow", 1));
    const trap = put(state, secretTrap.id, slot("p2", "backrow", 2));
    const fieldTrap = put(state, secretFieldTrap.id, slot("p2", "backrow", 3));
    trap.counters.grade = 2;

    const mine = viewFor(state, "p1");
    expect(mine.opponent.backrow[0]).toMatchObject({
      faceDown: false,
      instanceId: field.id,
      defId: publicField.id,
      type: "Field Spell",
    });
    // Both trap types are "unknown", and the marker carries no identity at all: §10.8 grants the
    // non-controller that the zone is occupied and nothing more.
    expect(mine.opponent.backrow[1]).toEqual({ faceDown: true });
    expect(mine.opponent.backrow[2]).toEqual({ faceDown: true });
    for (const marker of [mine.opponent.backrow[1], mine.opponent.backrow[2]]) {
      for (const field of ["instanceId", "defId", "cost", "type", "counters", "radiant"]) {
        expect(Object.keys(marker ?? {})).not.toContain(field);
      }
    }
    expect(mine.opponent.backrow[3]).toBeNull();

    // Their controller reads both, with the grade counter a Combo-Index trap carries (§10.1).
    const theirs = viewFor(state, "p2");
    expect(theirs.you.backrow[1]).toMatchObject({
      faceDown: false,
      instanceId: trap.id,
      defId: secretTrap.id,
      type: "Trap",
      counters: { grade: 2 },
    });
    expect(theirs.you.backrow[2]).toMatchObject({
      faceDown: false,
      instanceId: fieldTrap.id,
      defId: secretFieldTrap.id,
      type: "Field Trap",
    });
  });

  it("R33 a stolen trap becomes visible to its thief and hidden from its owner, though ownership is unchanged", () => {
    const state = game("r33-steal");
    const hidden = put(state, secretTrap.id, slot("p2", "backrow", 1));

    // Before the steal: p2 controls it and reads it; p1 sees a marker and the id never travels.
    expect(viewFor(state, "p2").you.backrow[0]).toMatchObject({ faceDown: false, defId: secretTrap.id });
    expect(viewFor(state, "p1").opponent.backrow[0]).toEqual({ faceDown: true });
    expect(JSON.stringify(viewFor(state, "p1"))).not.toContain(`"${secretTrap.id}"`);

    run(state, steal({ instanceId: hidden.id }), { controller: "p1" });

    // R33's point: control moved, ownership did not, and the view follows control.
    expect(hidden.controller).toBe("p1");
    expect(hidden.owner).toBe("p2");
    expect(hidden.faceUp).toBeUndefined();
    expect(viewFor(state, "p1").you.backrow[0]).toMatchObject({
      faceDown: false,
      instanceId: hidden.id,
      defId: secretTrap.id,
    });
    expect(viewFor(state, "p2").opponent.backrow[0]).toEqual({ faceDown: true });
    // The previous controller stops seeing it entirely, even though it still owns the card.
    expect(JSON.stringify(viewFor(state, "p2"))).not.toContain(`"${secretTrap.id}"`);
    expect(JSON.stringify(viewFor(state, "p2"))).not.toContain(`"${hidden.id}"`);
  });

  it("R33 a Field Trap that has fired is face-up to both players", () => {
    const state = game("r33-fired");
    const fired = put(state, secretFieldTrap.id, slot("p2", "backrow", 2));
    expect(viewFor(state, "p1").opponent.backrow[1]).toEqual({ faceDown: true });

    // §10.1 reserves `faceUp` for exactly this ("a Field Trap that has fired, R33"); `traps.ts`
    // sets it when the trap fires, and R33's half that lives here is what the view does with it.
    fired.faceUp = true;

    expect(viewFor(state, "p1").opponent.backrow[1]).toMatchObject({
      faceDown: false,
      instanceId: fired.id,
      defId: secretFieldTrap.id,
      type: "Field Trap",
    });
    expect(viewFor(state, "p2").you.backrow[1]).toMatchObject({ faceDown: false, defId: secretFieldTrap.id });
  });

  it("§10.8 sends a prompt's options to its own player only, the revealed library card included", () => {
    const state = game("prompt-options");
    // §10.8: "a card revealed out of a library is revealed only as an option of the prompt that
    // reveals it: the chooser sees it in full, the opponent sees only that a prompt is open."
    const revealed = at(state.players.p1.library, 0);
    const rest = state.players.p1.library.slice(1);
    const pending = must(
      openPrompt(sinkFor(state), {
        player: "p1",
        kind: "discover",
        prompt: "Put a card from your library into your hand",
        options: [
          { key: `instance:${revealed.id}`, label: "a card", selection: { pick: "instance", instanceId: revealed.id } },
        ],
        min: 1,
        max: 1,
        resume: inertResume,
      }),
      "the discover prompt",
    );

    const mine = viewFor(state, "p1");
    const ownPending = ownOptions(mine);
    expect(ownPending.choiceId).toBe(pending.id);
    expect(ownPending.kind).toBe("discover");
    expect(ownPending.min).toBe(1);
    expect(ownPending.max).toBe(1);
    expect(ownPending.prompt).toBe("Put a card from your library into your hand");
    expect(ownPending.options).toEqual([
      { key: `instance:${revealed.id}`, label: "a card", instanceId: revealed.id, defId: revealed.defId },
    ]);
    // The rest of the library stays hidden from the chooser too.
    for (const card of rest) expect(JSON.stringify(mine)).not.toContain(`"${card.id}"`);

    // The opponent learns that a prompt is open and whose, and nothing else (§10.6, R81).
    const theirs = viewFor(state, "p2");
    expect(theirs.pending).toEqual({ forYou: false, pendingFor: "p1" });
    const serialized = JSON.stringify(theirs);
    expect(serialized).not.toContain(`"${revealed.id}"`);
    expect(serialized).not.toContain("a card");
    expect(serialized).not.toContain("Put a card from your library into your hand");
  });

  it("§3.2 a Stack pile shows its top card and a count, never a buried card's identity (R13)", () => {
    const state = game("stack");
    const buried = put(state, secretBuried.id, slot("p2", "units", 1));
    const top = newInstance(state, stackTop.id, "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, top, slot("p2", "units", 1), { stack: true })).toBe(true);

    for (const viewer of ["p1", "p2"] as const) {
      const view = viewFor(state, viewer);
      const side = viewer === "p2" ? view.you : view.opponent;
      expect(side.units[0]).toMatchObject({ instanceId: top.id, defId: stackTop.id, buried: 1, attack: 1 });
      // The buried card is not on the field (R13), so neither player is told what it is.
      const serialized = JSON.stringify(view);
      expect(serialized).not.toContain(`"${buried.id}"`);
      expect(serialized).not.toContain(`"${secretBuried.id}"`);
    }
  });

  it("§10.8 carries mana, health, armor, locks, the phase, the result and the server's clock (R79)", () => {
    const state = game("scalars");
    state.players.p1.hero = { health: 12, armor: 3 };
    state.players.p1.mana = { current: 2, max: 4, nextTurnMod: -1, permMod: 1 };
    state.players.p2.hero = { health: 21, armor: 0 };
    state.players.p2.fatigueCount = 2;
    lockZone(state, slot("p2", "backrow", 4));

    const view = viewFor(state, "p1");
    expect(view.viewer).toBe("p1");
    expect(view.turn).toBe(3);
    expect(view.active).toBe("p1");
    expect(view.phase).toBe("main");
    expect(view.you.hero).toMatchObject({ health: 12, armor: 3 });
    expect(view.opponent.hero).toMatchObject({ health: 21, armor: 0 });
    // Mana is the pair a player spends from; the two modifiers behind it are bookkeeping (§2.3).
    expect(view.you.mana).toEqual({ current: 2, max: 4 });
    expect(view.opponent.fatigueCount).toBe(2);
    expect(view.opponent.locks.backrow[3]).toBe(true);
    expect(view.opponent.locks.backrow[0]).toBe(false);
    expect(view.result).toBeNull();

    // R79: the engine holds no clock, so the caller passes the one the server is running.
    expect(viewFor(state, "p1", 75_000).clockMs).toBe(75_000);
    expect(viewFor(state, "p1").clockMs).toBeNull();

    state.result = { winner: "p1", reason: "hero-death" };
    expect(viewFor(state, "p1").result).toEqual({ winner: "p1", reason: "hero-death" });
  });

  it("§10.8 carries the last N events for animation, oldest first", () => {
    const state = game("events");
    const total = VIEW_EVENT_LIMIT + 5;
    state.applied = Array.from({ length: total }, (_, i) => ({
      nonce: `n${i}`,
      events: [{ type: "manaChanged", player: "p1", current: i, max: 4 } satisfies GameEvent],
    }));

    const events = viewFor(state, "p1").events;
    expect(events).toHaveLength(VIEW_EVENT_LIMIT);
    const current = events.map((event) => (event.type === "manaChanged" ? event.current : -1));
    // The tail of the stream, in the order it happened.
    expect(current).toEqual(Array.from({ length: VIEW_EVENT_LIMIT }, (_, i) => total - VIEW_EVENT_LIMIT + i));

    // A shorter history travels whole, and an empty one is an empty list rather than a missing field.
    state.applied = [{ nonce: "one", events: [{ type: "turnStarted", player: "p2", turn: 4 }] }];
    expect(viewFor(state, "p1").events).toEqual([{ type: "turnStarted", player: "p2", turn: 4 }]);
    state.applied = [];
    expect(viewFor(state, "p1").events).toEqual([]);
  });

  it("R168 §10.8's N is a floor: one action's own event burst is never truncated", () => {
    const state = game("burst");

    // §10.8's window is the client's only animation channel (BUILD M5-T4), so an action longer
    // than `VIEW_EVENT_LIMIT` must not lose its front. #96 My Pawn's cancel plus the §10.7 AI turn
    // it hands over is 38 events in one `reduce`, and `attackDeclared` / `trapFired` /
    // `attackCancelled` — the three the cancel is made of — are the first three of them.
    const head: GameEvent[] = [
      { type: "attackDeclared", attackerId: "atk", targetId: "hero-p2", forced: false },
      { type: "attackCancelled", attackerId: "atk", targetId: "hero-p2", byInstanceId: "trap" },
    ];
    const tail: GameEvent[] = Array.from({ length: VIEW_EVENT_LIMIT + 4 }, (_, i) => ({
      type: "manaChanged",
      player: "p1",
      current: i,
      max: 4,
    }));
    state.applied = [{ nonce: "burst", events: [...head, ...tail] }];

    const events = viewFor(state, "p1").events;
    expect(events).toHaveLength(head.length + tail.length);
    expect(events.map((event) => event.type)).toContain("attackDeclared");
    expect(events.map((event) => event.type)).toContain("attackCancelled");

    // An older action is still trimmed away: the floor widens the window for the NEWEST action
    // only, so the history before it does not grow without bound (§9.3's `NONCE_HISTORY`).
    state.applied = [
      { nonce: "old", events: [{ type: "turnStarted", player: "p2", turn: 1 }] },
      { nonce: "burst", events: [...head, ...tail] },
    ];
    const withHistory = viewFor(state, "p1").events;
    expect(withHistory).toHaveLength(head.length + tail.length);
    expect(withHistory.map((event) => event.type)).not.toContain("turnStarted");
  });

  it("R97 redacts an event that names a card the viewer may not read, rather than dropping it", () => {
    const state = game("r97-redaction");
    // §11 names the sentinel, so the string itself is part of the ruling.
    expect(HIDDEN_ID).toBe("hidden");

    const theirs = at(inHand(state, plain.id, "p2"), 0);
    const mine = at(inHand(state, plain.id, "p1"), 0);
    state.applied = [
      {
        nonce: "r97",
        events: [
          { type: "drawn", player: "p2", instanceId: theirs.id, defId: theirs.defId },
          { type: "drawn", player: "p1", instanceId: mine.id, defId: mine.defId },
        ],
      },
    ];

    const drawnFor = (viewer: PlayerId, player: PlayerId): Extract<GameEvent, { type: "drawn" }> => {
      const events = viewFor(state, viewer).events;
      // Redacted, not truncated: both draws are still in the stream for both viewers.
      expect(events).toHaveLength(2);
      const found = events.find((event) => event.type === "drawn" && event.player === player);
      if (found === undefined || found.type !== "drawn") throw new Error(`no ${player} draw in ${viewer}'s view`);
      return found;
    };

    // While the card sits in p2's hand, p1 gets the cue and neither id.
    expect(drawnFor("p1", "p2")).toEqual({
      type: "drawn",
      player: "p2",
      instanceId: HIDDEN_ID,
      defId: HIDDEN_ID,
    });
    // p1's own draw is never redacted, so the rule is not "redact everything".
    expect(drawnFor("p1", "p1")).toEqual({
      type: "drawn",
      player: "p1",
      instanceId: mine.id,
      defId: mine.defId,
    });
    // And the owner reads their own draw, as the hand rule says.
    expect(drawnFor("p2", "p2")).toMatchObject({ instanceId: theirs.id, defId: theirs.defId });

    // R97's history rule: readability is judged by where the card sits *now*. p2 plays it, and the
    // same stored `drawn` event reads openly for p1 — same event, different answer.
    state.players.p2.hand = state.players.p2.hand.filter((card) => card.id !== theirs.id);
    expect(placeOnField(state, theirs, slot("p2", "units", 1))).toBe(true);
    expect(drawnFor("p1", "p2")).toEqual({
      type: "drawn",
      player: "p2",
      instanceId: theirs.id,
      defId: theirs.defId,
    });

    // The other direction: a unit bounced into the enemy hand stops reading the moment it lands.
    state.players.p2.units[0] = null;
    theirs.zone = { z: "hand", player: "p2" };
    state.players.p2.hand.push(theirs);
    state.applied = [
      {
        nonce: "r97-bounce",
        events: [{ type: "bounced", instanceId: theirs.id, defId: theirs.defId, owner: "p2" }],
      },
    ];
    expect(at(viewFor(state, "p1").events, 0)).toEqual({
      type: "bounced",
      instanceId: HIDDEN_ID,
      defId: HIDDEN_ID,
      owner: "p2",
    });
    expect(at(viewFor(state, "p2").events, 0)).toMatchObject({ instanceId: theirs.id });
  });

  it("R97 never reads a card in a library, and blanks a shuffled-in card's slot for both players", () => {
    const state = game("r97-library");
    const inLibrary = at(state.players.p1.library, 3);
    state.applied = [
      {
        nonce: "r97-shuffle",
        events: [
          { type: "shuffledIn", player: "p1", instanceId: inLibrary.id, defId: inLibrary.defId, position: 3 },
        ],
      },
    ];

    // An event never reads a card in a library, its owner included (§9.1): the owner's list (R310)
    // names what is left without saying which instance is which.
    for (const viewer of ["p1", "p2"] as const) {
      const event = at(viewFor(state, viewer).events, 0);
      expect(event.type).toBe("shuffledIn");
      if (event.type !== "shuffledIn") continue;
      expect(event.instanceId).toBe(HIDDEN_ID);
      expect(event.defId).toBe(HIDDEN_ID);
      // §9.1 hides library order without qualifying by player, so the slot is blanked for both.
      expect(event.position).not.toBe(3);
    }
    const asOwner = at(viewFor(state, "p1").events, 0);
    const asOpponent = at(viewFor(state, "p2").events, 0);
    expect(asOwner).toEqual(asOpponent);
  });

  it("§10.6 tells each player only that a prompt is open when it is not theirs", () => {
    const state = game("pending-for");
    openPrompt(sinkFor(state), {
      player: "p2",
      kind: "mode",
      prompt: "Choose one",
      options: [modeOption("burn"), modeOption("freeze")],
      resume: inertResume,
    });

    expect(viewFor(state, "p1").pending).toEqual({ forYou: false, pendingFor: "p2" });
    expect(ownOptions(viewFor(state, "p2")).options.map((option) => option.key)).toEqual([
      "mode:burn",
      "mode:freeze",
    ]);
    const serialized = JSON.stringify(viewFor(state, "p1"));
    expect(serialized).not.toContain("burn");
    expect(serialized).not.toContain("freeze");
  });
});

/* ----------------------------------------------------------------------------------------- *
 * R169: the player modifiers (§10.1 `mods`) in the view
 * ----------------------------------------------------------------------------------------- */

describe("viewFor player modifiers (R169, §10.1, §10.3 modifierChanged)", () => {
  /** Installs a modifier the way a card script does, so the id is the engine's own. */
  function install(state: GameState, player: PlayerId, mod: DistributiveOmit<PlayerModifier, "id">): PlayerModifier {
    return addModifier(sinkFor(state), player, mod);
  }

  it("R169 carries both seats' modifiers as { id, label }, in order, and nothing else", () => {
    const state = game("modifiers-both-seats");
    // #77 Professor Curvature, live: its discount is the controller's next turn (R48).
    const curvature = install(state, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: 1 },
    });
    // #78 /fullsend's two turn-scoped riders, in the order the Cry installs them.
    const discount = install(state, "p1", {
      kind: "costDiscount",
      amount: 1,
      expiry: { until: "thisTurn", turn: state.turn },
    });
    const combo = install(state, "p1", {
      kind: "comboDraw",
      amount: 1,
      expiry: { until: "thisTurn", turn: state.turn },
    });
    // #79 Twinspell on the other seat.
    const echo = install(state, "p2", { kind: "echoNextSpell", amount: 1, expiry: { until: "used" } });

    const view = viewFor(state, "p1");

    expect(view.you.modifiers.map((modifier) => modifier.id)).toEqual([curvature.id, discount.id, combo.id]);
    expect(view.you.modifiers).toEqual([
      { id: curvature.id, label: "Cost-4 cards cost 1 less" },
      { id: discount.id, label: "Your cards cost 1 less" },
      { id: combo.id, label: 'Your cards gain "Combo: draw 1"' },
    ]);
    // §10.8 gives a seat no privacy over its own badges, and `modifierChanged` is already public
    // in both directions, so the opponent's list travels too.
    expect(view.opponent.modifiers).toEqual([{ id: echo.id, label: "Next Spell gains Echo +1" }]);

    // The mirror view agrees: each seat sees the same two lists, swapped.
    const theirs = viewFor(state, "p2");
    expect(theirs.you.modifiers).toEqual(view.opponent.modifiers);
    expect(theirs.opponent.modifiers).toEqual(view.you.modifiers);

    // `{ id, label }` and no more: no kind, no amount, no expiry, no source.
    for (const modifier of [...view.you.modifiers, ...view.opponent.modifiers]) {
      expect(Object.keys(modifier).sort()).toEqual(["id", "label"]);
    }
  });

  it("R169 a board with no modifiers carries an empty list on both seats", () => {
    const view = viewFor(game("modifiers-empty"), "p1");
    expect(view.you.modifiers).toEqual([]);
    expect(view.opponent.modifiers).toEqual([]);
  });

  it("R169 + R48 say so on the badge while the modifier is installed but not yet live", () => {
    const state = game("modifiers-dormant");
    // The turn #77 was played: `mana.modifierIsLive` is false, so the discount does nothing yet.
    install(state, "p1", {
      kind: "costDiscount",
      amount: 2,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn },
    });

    // The radiant face of #77, so the number is 2.
    expect(at(viewFor(state, "p1").you.modifiers, 0).label).toBe("Cost-4 cards cost 2 less (next turn)");

    // p1's next turn: the discount bites, and the badge stops hedging.
    state.turn += 2;
    expect(at(viewFor(state, "p1").you.modifiers, 0).label).toBe("Cost-4 cards cost 2 less");
  });

  it("R169 labels every PlayerModifier kind from the modifier alone", () => {
    const state = game("modifiers-labels");
    install(state, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyType: "Spell",
      oncePerTurn: true,
      expiry: { until: "thisTurn", turn: state.turn },
    });
    install(state, "p1", { kind: "radiantFirstCheapCard", maxCost: 1, expiry: { until: "never" } });
    install(state, "p1", { kind: "quickstrikerDamage", expiry: { until: "never" } });

    expect(viewFor(state, "p1").you.modifiers.map((modifier) => modifier.label)).toEqual([
      // §8 #35 Lunar Eclipse: "the next Spell you play this turn costs 1 less".
      "Next Spell costs 1 less",
      // §8 #64 Gifted Program.
      "First card costing 1 or less becomes Radiant",
      // §8 #38 Quickstriker.
      'Your cards gain "Combo X: X damage to the enemy hero"',
    ]);
  });

  it("R169 a modifier's sourceId never travels, so a badge cannot name a face-down card (§9.1)", () => {
    const state = game("modifiers-source");
    // #79 Twinspell keeps the instance that installed the rider (R30). Point it at a card p1 may
    // not read at all — a face-down trap in p2's backrow — so a leak would be unmistakable.
    const trap = put(state, secretTrap.id, slot("p2", "backrow", 1));
    install(state, "p2", {
      kind: "echoNextSpell",
      amount: 2,
      sourceId: trap.id,
      expiry: { until: "used" },
    });

    const view = viewFor(state, "p1");
    expect(view.opponent.modifiers).toEqual([
      { id: at(state.players.p2.mods, 0).id, label: "Next Spell gains Echo +2" },
    ]);
    expect(JSON.stringify(view)).not.toContain(`"${trap.id}"`);
    expect(JSON.stringify(view)).not.toContain(trap.defId);
  });
});
