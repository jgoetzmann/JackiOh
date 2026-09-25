// SPEC §10.8, R310–R312: a player's own library as `viewFor` gives it to them — which cards are
// left, never in what order, and only what they were shown going in (`ownLibrary.ts`).
//
// The engine owns the rule, so these tests drive it with the fixture catalog and the effect verbs
// the real cards use; the cards that bring it about (#33, #42, #83, #87, #90) prove it again in
// packages/cards.

import type { Action, CardDef, GameEvent, LibraryView, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { DECK_SIZE } from "../src/config";
import { radiantChance, setRadiant, shuffleInto, swapLibrary, transform } from "../src/effects";
import { ownLibraryView } from "../src/ownLibrary";
import { beginGame, reduce } from "../src/reduce";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import { mulliganPromptFor } from "../src/setup";
import { cloneState, type CardInstance, type GameState } from "../src/state";
import { viewFor } from "../src/viewFor";
import { spellDef, unitDef, vanillaDeck } from "./fixtures/catalog";
import { newGame, setLibrary, sinkFor } from "./fixtures/harness";

/** Three cards that sort by cost, then name, then id, whatever order they lie in (R310). */
const cheap = unitDef(801, { id: "lib-cheap", name: "Zed the Cheap", cost: 0 });
const alpha = unitDef(802, { id: "lib-alpha", name: "Alpha", cost: 2 });
const beta = unitDef(803, { id: "lib-beta", name: "Beta", cost: 2 });
/** Same name and cost as `beta`: the id breaks the tie. */
const betaTwin = unitDef(804, { id: "lib-beta-2", name: "Beta", cost: 2 });
/** An X card sorts at 0 and an embiggen card at its base price (R65). */
const xSpell = spellDef(805, { id: "lib-x", name: "X Marks", cost: "X" });
const bigSpell = spellDef(806, { id: "lib-embiggen", name: "Embiggen", cost: { base: 3, embiggen: 5 } });
/** What the opponent's CN-Viral Injection names (#90): a card shuffled in by a play both saw. */
const virus = spellDef(807, { id: "lib-virus", name: "Virus (fixture)", cost: 1, token: true, tags: ["Token"] });
const legendary = unitDef(808, { id: "lib-legend", name: "Legend (fixture)", cost: 4, rarity: "Legendary" });

const DEFS: readonly CardDef[] = [cheap, alpha, beta, betaTwin, xSpell, bigSpell, virus, legendary];

function game(seed = "own-library"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

/** Apply one effect the way `resolve.ts` does, for `controller`, and hand back its events. */
function run(state: GameState, effect: Effect, controller: PlayerId = "p1"): GameEvent[] {
  const sink = sinkFor(state);
  const ctx = makeContext(sink, null, { controller });
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

function listOf(state: GameState, viewer: PlayerId): LibraryView {
  const library = viewFor(state, viewer).you.ownLibrary;
  if (library === undefined) throw new Error(`${viewer}'s view carries no library list`);
  return library;
}

function total(list: LibraryView): number {
  return list.cards.reduce((sum, entry) => sum + entry.count, 0) + list.unknown;
}

/** Every instance id in a library, which must never reach a view (§9.1, R97). */
function idsOf(cards: readonly CardInstance[]): string[] {
  return cards.map((card) => card.id);
}

describe("R310 the viewer's own library, without its order", () => {
  it("R310 lists the viewer's own library by definition, face and count, and leaves the opponent's a count", () => {
    const state = game();
    setLibrary(state, "p1", [beta.id, cheap.id, alpha.id, beta.id, xSpell.id, bigSpell.id, betaTwin.id]);
    const theirs = setLibrary(state, "p2", [legendary.id, alpha.id]);
    const view = viewFor(state, "p1");

    expect(view.you.ownLibrary).toEqual({
      cards: [
        // Printed cost first (R65: X is 0, embiggen its base price), then name, then id: the X
        // card costs 0 like "Zed the Cheap" and goes first by name.
        { defId: xSpell.id, radiant: false, count: 1 },
        { defId: cheap.id, radiant: false, count: 1 },
        { defId: alpha.id, radiant: false, count: 1 },
        { defId: beta.id, radiant: false, count: 2 },
        { defId: betaTwin.id, radiant: false, count: 1 },
        { defId: bigSpell.id, radiant: false, count: 1 },
      ],
      unknown: 0,
    });
    expect(total(listOf(state, "p1"))).toBe(view.you.libraryCount);

    // The opponent's library is a count and nothing else (§9.1, §10.8).
    expect(view.opponent.ownLibrary).toBeUndefined();
    expect(Object.keys(view.opponent)).not.toContain("ownLibrary");
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain(`"${legendary.id}"`);
    for (const id of idsOf(theirs)) expect(serialized).not.toContain(`"${id}"`);
  });

  it("R310 names no library card by instance, and gives two libraries of the same cards in different orders the same view", () => {
    const deck = [beta.id, cheap.id, alpha.id, beta.id, xSpell.id, bigSpell.id, betaTwin.id, alpha.id];
    const a = game("own-library-order");
    setLibrary(a, "p1", deck);
    // One card of each pair Radiant, so the face is part of the key and not only the id.
    const firstBeta = a.players.p1.library.find((card) => card.defId === beta.id);
    if (firstBeta === undefined) throw new Error("no beta");
    firstBeta.radiant = true;
    firstBeta.knownAs = { defId: beta.id, radiant: true };

    // The same cards, the same instances, in every other order the test tries.
    const orders: ((cards: CardInstance[]) => CardInstance[])[] = [
      (cards) => [...cards].reverse(),
      (cards) => [...cards.slice(3), ...cards.slice(0, 3)],
      (cards) => [...cards].sort((x, y) => (x.id < y.id ? 1 : -1)),
    ];
    for (const reorder of orders) {
      const b = cloneState(a);
      b.players.p1.library = reorder(b.players.p1.library);
      expect(idsOf(b.players.p1.library)).not.toEqual(idsOf(a.players.p1.library));
      for (const viewer of ["p1", "p2"] as const) {
        expect(viewFor(b, viewer)).toEqual(viewFor(a, viewer));
      }
    }

    const view = viewFor(a, "p1");
    expect(view.you.ownLibrary?.cards).toContainEqual({ defId: beta.id, radiant: false, count: 1 });
    expect(view.you.ownLibrary?.cards).toContainEqual({ defId: beta.id, radiant: true, count: 1 });
    // Base before Radiant within one definition.
    const betas = (view.you.ownLibrary?.cards ?? []).filter((entry) => entry.defId === beta.id);
    expect(betas.map((entry) => entry.radiant)).toEqual([false, true]);
    // No instance id of the viewer's own library reaches the viewer (§9.1): a list, not the pile.
    const serialized = JSON.stringify(view);
    for (const id of idsOf(a.players.p1.library)) expect(serialized).not.toContain(`"${id}"`);
    // An entry is three fields and no more: nothing a position, a live cost or a roll could ride on.
    for (const entry of view.you.ownLibrary?.cards ?? []) expect(Object.keys(entry).sort()).toEqual(["count", "defId", "radiant"]);
  });
});

describe("R311 what the owner was shown going in", () => {
  it("R311 knows the starting deck, and a mulligan's returns, through setup", () => {
    const decks: [string[], string[]] = [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 21)];
    let state = beginGame(newGame("own-library-setup", decks)).state;
    // Before either mulligan: the deck minus the opening hand, every card known.
    for (const viewer of ["p1", "p2"] as const) {
      const list = listOf(state, viewer);
      const hand = state.players[viewer].hand.map((card) => card.defId);
      const deck = viewer === "p1" ? decks[0] : decks[1];
      expect(list.unknown).toBe(0);
      expect(list.cards.map((entry) => entry.defId).sort()).toEqual(deck.filter((id) => !hand.includes(id)).sort());
    }

    // Both seats send their whole opening hand back: the returns are known too.
    for (const player of ["p1", "p2"] as const) {
      const prompt = mulliganPromptFor(state, player);
      expect(prompt).not.toBeNull();
      const result = reduce(state, { type: "mulligan", keep: [], playerId: player, nonce: `own-${player}` } as Action);
      expect(result.error).toBeUndefined();
      state = result.state;
    }
    for (const viewer of ["p1", "p2"] as const) {
      const list = listOf(state, viewer);
      expect(list.unknown).toBe(0);
      expect(total(list)).toBe(state.players[viewer].library.length);
      const inLibrary = state.players[viewer].library.map((card) => card.defId).sort();
      expect(list.cards.flatMap((entry) => Array<string>(entry.count).fill(entry.defId)).sort()).toEqual(inLibrary);
    }
  });

  it("R311 lists a card the opponent shuffled in by an open play, with the face it went in with", () => {
    const state = game("own-library-shuffle");
    setLibrary(state, "p1", [alpha.id, beta.id]);
    // p2 resolves #90's effect: a Radiant virus into p1's library (the Radiant face of the Injection).
    const events = run(state, shuffleInto({ defId: virus.id, count: 1, player: "enemy", radiant: true }), "p2");
    expect(events.map((event) => event.type)).toEqual(["shuffledIn"]);

    expect(listOf(state, "p1")).toEqual({
      cards: [
        { defId: virus.id, radiant: true, count: 1 },
        { defId: alpha.id, radiant: false, count: 1 },
        { defId: beta.id, radiant: false, count: 1 },
      ],
      unknown: 0,
    });
    // The shuffle's own event still names nothing, to either seat, and keeps the slot hidden (R97).
    for (const viewer of ["p1", "p2"] as const) {
      const shuffled = viewFor(state, viewer).events.filter((event) => event.type === "shuffledIn");
      expect(shuffled.every((event) => event.type === "shuffledIn" && event.defId === "hidden")).toBe(true);
    }
    // And p2, who played it, still reads p1's library as a count.
    expect(viewFor(state, "p2").opponent.ownLibrary).toBeUndefined();
  });

  it("R311 keeps the face a card went in with when it turns Radiant inside the library, where nobody sees it", () => {
    const state = game("own-library-radiant");
    const [first, second] = setLibrary(state, "p1", [alpha.id, beta.id]);
    if (first === undefined || second === undefined) throw new Error("library");
    const before = listOf(state, "p1");

    // #28's pick and #42's roll, as the verbs the cards use.
    run(state, setRadiant({ instanceId: first.id }));
    run(state, radiantChance({ zone: "library", chance: 1 }));
    expect(state.players.p1.library.every((card) => card.radiant)).toBe(true);

    // The list is what p1 was shown, so it has not moved.
    expect(listOf(state, "p1")).toEqual(before);
    expect(before.cards.every((entry) => !entry.radiant)).toBe(true);
  });
});

describe("R312 cards the owner was never shown", () => {
  it("R312 counts a swapped library as unknown to its new owner, on both sides", () => {
    const state = game("own-library-swap");
    setLibrary(state, "p1", [alpha.id, beta.id, cheap.id]);
    setLibrary(state, "p2", [legendary.id, virus.id]);
    run(state, swapLibrary(), "p1");

    expect(listOf(state, "p1")).toEqual({ cards: [], unknown: 2 });
    expect(listOf(state, "p2")).toEqual({ cards: [], unknown: 3 });
    // p1 learns nothing of what p2 held, and p2 nothing of p1's old library.
    const mine = JSON.stringify(viewFor(state, "p1"));
    expect(mine).not.toContain(`"${legendary.id}"`);
    expect(mine).not.toContain(`"${virus.id}"`);
    const theirs = JSON.stringify(viewFor(state, "p2"));
    for (const id of [alpha.id, beta.id, cheap.id]) expect(theirs).not.toContain(`"${id}"`);

    // A card that goes in openly afterwards is known again; the swapped ones stay unknown.
    run(state, shuffleInto({ defId: alpha.id, count: 1 }), "p1");
    expect(listOf(state, "p1")).toEqual({ cards: [{ defId: alpha.id, radiant: false, count: 1 }], unknown: 2 });
    // Swapped back, a library is not known again: what its first owner was shown went with it.
    run(state, swapLibrary(), "p1");
    expect(listOf(state, "p1")).toEqual({ cards: [], unknown: 3 });
  });

  it("R312 counts a card a Replace put in the library as unknown (#83)", () => {
    const state = game("own-library-replace");
    const [first] = setLibrary(state, "p1", [alpha.id, beta.id]);
    if (first === undefined) throw new Error("library");
    run(state, transform({ instanceId: first.id, defId: legendary.id, radiant: true }));

    expect(state.players.p1.library.map((card) => card.defId)).toContain(legendary.id);
    expect(listOf(state, "p1")).toEqual({ cards: [{ defId: beta.id, radiant: false, count: 1 }], unknown: 1 });
    expect(JSON.stringify(viewFor(state, "p1"))).not.toContain(`"${legendary.id}"`);
  });

  it("R312 treats a library card with no record as unknown, so a path that forgets to record shows a back", () => {
    const state = game("own-library-unrecorded");
    const cards = setLibrary(state, "p1", [alpha.id, beta.id]);
    for (const card of cards) delete card.knownAs;
    expect(ownLibraryView(state, "p1")).toEqual({ cards: [], unknown: 2 });
    expect(JSON.stringify(viewFor(state, "p1"))).not.toContain(`"${alpha.id}"`);
  });
});
