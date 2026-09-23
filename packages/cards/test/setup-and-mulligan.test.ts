// Setup and the mulligan when a cast asks (SPEC §2.1, §2.4, §9.3, §10.1, §10.6, R9, R70, R81, R158,
// R224). Found by the polish-4 edge-case hunt, round 7 (docs/polish/4-edge-cases.md, lenses L7,
// "legality-agreement" and "engine invariants"); every case here failed before its fix.
//
//  - R224: a cast-on-draw card drawn by the opening draw or by R9's replacement draws is cast, and a
//    cast can ask its caster something. Setup used to open the next mulligan over that question,
//    which replaced it and left the cast half-played in its caster's resolving zone for good.
//  - §10.6: the mulligan's `promptAnswered` named the word "mulligan" rather than the prompt.
//  - Round 8 (lens L10). R225: a Quickdraw card is the last of the opening draws it replaces,
//    reported and counted as a draw, so #100's price, the deal's events and the counts while setup
//    waits (R224) do not tell the other seat whether the opening hand holds one.
//
// No Core cast-on-draw card asks anything, so the asking card is a fixture (a transient def and a
// registered script, the way paused-sequences.test.ts builds its asking cards).

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, ActionInput, CardDef, CardType, PlayerId, PlayerView } from "@jackioh/shared";
import {
  DECK_SIZE,
  beginGame,
  createGame,
  newInstance,
  query,
  reduce,
  registerScripts,
  registeredScripts,
  viewFor,
  type GameState,
  type Script,
} from "@jackioh/engine";
import { chooseMode, damage } from "@jackioh/engine/effects";
import { CATALOG } from "../src/index";
// Importing the harness registers the real catalog and every card script (`registerAll()`); these
// cases build their games through `createGame`, since a `scenario()` starts past the mulligan.
import "./_harness";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function fixtureDef(id: string, type: CardType): CardDef {
  const face = type === "Unit" ? { attack: 2, health: 2, keywords: [], text: id } : { keywords: [], text: id };
  return {
    id,
    index: id,
    name: id,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
  };
}

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(state: GameState, id: string, type: CardType, script: Script): void {
  state.transientDefs[id] = fixtureDef(id, type);
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

/** Two legal decks straight from the catalog: the first 40 non-token cards in id order. */
function catalogDecks(): [string[], string[]] {
  const pool = Object.entries(CATALOG)
    .filter(([, def]) => def.token !== true && !def.tags.includes("Token"))
    .map(([id]) => id)
    .sort();
  return [pool.slice(0, DECK_SIZE), pool.slice(DECK_SIZE, DECK_SIZE * 2)];
}

let nonce = 0;
function act(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `setup-mulligan-${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

const P1_DECK = Array.from({ length: 20 }, (_, at) => `core-${String(at + 1).padStart(3, "0")}`);
const P2_DECK = Array.from({ length: 20 }, (_, at) => `core-${String(at + 30).padStart(3, "0")}`);

describe("R224: setup waits for a cast's question", () => {
  it("R224 the question a cast-on-draw replacement asks p1 is not overwritten by p2's mulligan prompt (§10.1, R9, R158)", () => {
    let state = beginGame(createGame({ seed: "edge-r7-l7-mulligan", decks: [P1_DECK, P2_DECK] })).state;
    expect(state.pending?.kind).toBe("mulligan");
    expect(state.pending?.playerId).toBe("p1");

    // A cast-on-draw Spell whose cast asks its caster something, on top of p1's library.
    fixture(state, "edge-r7-l7-cod-asks", "Spell", {
      staticFlags: { castOnDraw: true },
      cry: () => [chooseMode({ options: ["ok"], step: "ok", prompt: "the cast's question" })],
      resume: { ok: () => [] },
    });
    const cod = newInstance(state, "edge-r7-l7-cod-asks", "p1", { z: "library", player: "p1" });
    state.players.p1.library.unshift(cod);

    // p1 returns one card: R9 draws the replacement first, and it is the cast-on-draw card (§2.4).
    const hand = state.players.p1.hand.map((card) => card.id);
    const returned = must(hand[0], "a card to return");
    const result = act(state, { type: "mulligan", keep: hand.slice(1), playerId: "p1" });
    state = result.state;
    // The replacement was cast, and its cast asked p1 (§2.4, R70, R81).
    expect(result.events.some((event) => event.type === "promptOpened" && event.kind === "mode")).toBe(true);

    // §9.3, §10.1: one prompt at a time, and the cast's question is state until p1 answers it. p2's
    // mulligan waits behind it; it must not replace it, and the returned card waits to go back.
    const pending = must(state.pending, "an open prompt");
    expect(pending.playerId, `open prompt: ${pending.kind} "${pending.prompt}"`).toBe("p1");
    expect(pending.kind).toBe("mode");
    expect(state.players.p1.library.some((card) => card.id === returned)).toBe(false);

    // The answer finishes the cast and the rest of p1's mulligan (R122): the returned card is
    // shuffled back, and then p2's mulligan opens.
    state = act(state, { type: "answer", choiceId: pending.id, selection: [{ pick: "mode", option: "ok" }], playerId: "p1" }).state;
    expect(state.players.p1.library.some((card) => card.id === returned)).toBe(true);
    expect(state.pending?.kind).toBe("mulligan");
    expect(state.pending?.playerId).toBe("p2");
    expect(state.mulliganed).toEqual(["p1"]);
  });

  it("R224 a cast-on-draw card's question from the opening draw is not written over by the mulligan (§2.1, §2.4, R158, R70)", () => {
    const deck = query({})
      .map((def) => def.id)
      .slice(0, 20);
    const game = createGame({ seed: "edge-r7-setup", decks: [deck, deck] });
    // A cast-on-draw Spell that declares a target, so its cast asks its caster for it (R70, R81).
    const id = "edge-r7-asking-cod";
    fixture(game, id, "Spell", {
      staticFlags: { castOnDraw: true },
      targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["hero"] } }],
      cry: () => [damage({ to: { of: "chosen" }, amount: 1 })],
    });
    game.players.p1.library = game.players.p1.library.map(() =>
      newInstance(game, id, "p1", { z: "library", player: "p1" }),
    );

    const started = beginGame(game);
    const cast = started.events.find((event) => event.type === "promptOpened" && event.kind === "target");
    expect(cast, "p1's opening draw casts the card, which asks for its target").toBeDefined();

    // R158: a draw a prompt interrupts stops there and owes the rest, and §2.1's mulligan follows
    // the opening draw. A second prompt never overwrites an unanswered one (R156), so the cast's
    // question stays open until it is answered, and the cast is not left half-played.
    const answered = started.events.some(
      (event) => event.type === "promptAnswered" && cast !== undefined && event.choiceId === (cast as { choiceId: string }).choiceId,
    );
    const stillOpen = cast !== undefined && started.state.pending?.id === (cast as { choiceId: string }).choiceId;
    expect(answered || stillOpen, `the cast's question was replaced by a ${started.state.pending?.kind ?? "no"} prompt`).toBe(true);

    // Every card in p1's library is one of these, so the draw chain goes on casting (R58) and each
    // cast asks in turn. Answering each finishes that cast and goes on with the opening deal, and the
    // first mulligan opens only once nothing is asking — with no cast left half-played.
    let state = started.state;
    for (let guard = 0; guard < 40 && state.pending?.kind === "target"; guard += 1) {
      const open = must(state.pending, "a cast's question");
      state = act(state, { type: "answer", choiceId: open.id, selection: [{ pick: "hero", player: "p2" }], playerId: "p1" }).state;
    }
    expect(state.pending?.kind).toBe("mulligan");
    expect(state.pending?.playerId).toBe("p1");
    expect(state.players.p1.resolving).toEqual([]);
    expect(state.players.p2.hand).toHaveLength(4);
  });

  it("R224 the mulligan's promptAnswered names the prompt that promptOpened named (§10.3, §10.6)", () => {
    const begun = beginGame(createGame({ seed: "r7-mulligan-ids", decks: catalogDecks() }));
    const opened = begun.events.find((event) => event.type === "promptOpened");
    const openedId = opened?.type === "promptOpened" ? opened.choiceId : null;
    expect(openedId).not.toBeNull();
    expect(begun.state.pending?.id).toBe(openedId);

    const answered = reduce(begun.state, { type: "mulligan", keep: [], playerId: "p1", nonce: "m1" } as Action);
    expect(answered.error).toBeUndefined();
    const closed = answered.events.find((event) => event.type === "promptAnswered");
    // Every other prompt's answer names its PendingChoice id (`prompts.ts`); the mulligan's named
    // the word "mulligan", which no prompt ever had.
    expect(closed?.type === "promptAnswered" ? closed.choiceId : null).toBe(openedId);
  });
});

const HEROIC_POWER = "core-098";
const CRAFT = "core-099";
const VOID = "core-100";

function sameView(a: PlayerView, b: PlayerView): void {
  expect(b.events).toEqual(a.events);
  expect(b).toEqual(a);
}

// ---------------------------------------------------------------------------
// Quickdraw and the game's draw counter (#100 Ceaseless Void, R55)
// ---------------------------------------------------------------------------

const QD_P1_DECK = [
  "core-003", "core-004", "core-005", "core-007", "core-008", "core-010", "core-011", "core-015",
  "core-018", "core-023", "core-031", "core-035", "core-036", "core-039", "core-041", "core-044",
  "core-048", "core-050", "core-060", VOID,
];
/** p2's deck less one card: the twentieth is #98 Heroic Power (Quickdraw) or #99 Craft a Card. */
const QD_P2_SHARED = [
  "core-003", "core-004", "core-005", "core-007", "core-008", "core-011", "core-015", "core-023",
  "core-031", "core-035", "core-036", "core-044", "core-050", "core-062", "core-063", "core-081",
  "core-082", "core-086", "core-012",
];

function actAs(state: GameState, player: PlayerId, body: ActionBody): GameState {
  return act(state, { ...body, playerId: player } as ActionInput).state;
}

/** Both players keep their opening hands; p1's first turn has begun. */
function keepBoth(state: GameState): GameState {
  let next = actAs(state, "p1", { type: "mulligan", keep: state.players.p1.hand.map((card) => card.id) });
  next = actAs(next, "p2", { type: "mulligan", keep: next.players.p2.hand.map((card) => card.id) });
  return next;
}

describe("R225: a Quickdraw card is counted as the draw it replaces", () => {
  /** "r8-l10-void-3" puts #100 in p1's opening hand. */
  function voidGame(p2Twentieth: string): GameState {
    const decks: [string[], string[]] = [[...QD_P1_DECK], [...QD_P2_SHARED, p2Twentieth]];
    return keepBoth(beginGame(createGame({ seed: "r8-l10-void-3", decks })).state);
  }

  it("R225 p1's Ceaseless Void does not price in whether p2's opening hand holds a Quickdraw card (§2.1, §9.1, R55)", () => {
    const withPower = voidGame(HEROIC_POWER);
    const without = voidGame(CRAFT);

    // Same public course: p1's turn 1 has begun, p2 holds 4 cards, and p1 holds its Void.
    for (const state of [withPower, without]) {
      expect(state.turn).toBe(1);
      expect(state.active).toBe("p1");
      expect(viewFor(state, "p1").opponent.hand).toEqual({ count: 4 });
      const hand = viewFor(state, "p1").you.hand;
      expect(Array.isArray(hand) && hand.some((card) => card.defId === VOID)).toBe(true);
    }
    // The Heroic Power started in p2's hand "instead of a draw" (§6.2 Quickdraw).
    expect(withPower.players.p2.hand.some((card) => card.defId === HEROIC_POWER)).toBe(true);

    // §2.1: p2's opening hand is 4 cards either way, and whether one of them is a Quickdraw card is
    // p2's hand (§9.1). The Void's cost counts draws (R55), and a Quickdraw card is no draw, so the
    // cost p1 reads off its own hand tells p1 how many Quickdraw cards p2 started with.
    sameView(viewFor(withPower, "p1"), viewFor(without, "p1"));
  });
});

// ---------------------------------------------------------------------------
// Quickdraw and setup resumed after a cast's question (R224)
// ---------------------------------------------------------------------------

const ASKING = "r8-l10-cod-asks";

function asking(state: GameState): void {
  state.transientDefs[ASKING] = fixtureDef(ASKING, "Spell");
  const script: Script = {
    staticFlags: { castOnDraw: true },
    cry: () => [chooseMode({ options: ["ok"], step: "ok", prompt: "the cast's question" })],
    resume: { ok: () => [] },
  };
  registerScripts({ ...registeredScripts(), [ASKING]: { base: script, radiant: script } });
}

describe("R225, R224: a Quickdraw card is dealt as the last opening draw", () => {
  /**
   * p1's library holds one cast-on-draw card that asks (a fixture: no Core cast-on-draw card asks),
   * and with this seed p1's opening draw reaches it, so setup waits for p1's answer before it deals
   * to p2 (R224). The answer's action then carries p2's opening deal, which p1's view shows.
   */
  function pausedDeal(seed: string, p2Twentieth: string): GameState {
    const game = createGame({ seed, decks: [[...QD_P1_DECK], [...QD_P2_SHARED, p2Twentieth]] });
    asking(game);
    game.players.p1.library[0] = newInstance(game, ASKING, "p1", { z: "library", player: "p1" });
    return beginGame(game).state;
  }

  function firstPausingSeed(): string {
    for (let at = 0; at < 200; at += 1) {
      const seed = `r8-l10-deal-${at}`;
      const state = pausedDeal(seed, CRAFT);
      if (state.pending?.kind === "mode" && state.pending.playerId === "p1") return seed;
    }
    throw new Error("no seed deals the asking card to p1");
  }

  it("R225 the events of p2's opening deal do not tell p1 whether p2's hand holds a Quickdraw card (§2.1, §9.1, R97, R224)", () => {
    const seed = firstPausingSeed();
    const answered = (p2Twentieth: string): GameState => {
      const state = pausedDeal(seed, p2Twentieth);
      const pending = must(state.pending, "p1's cast question");
      expect(pending.kind).toBe("mode");
      return actAs(state, "p1", { type: "answer", choiceId: pending.id, selection: [{ pick: "mode", option: "ok" }] });
    };
    const withPower = answered(HEROIC_POWER);
    const without = answered(CRAFT);

    // Setup went on to the mulligans, and p2 holds its 4 opening cards in both games.
    for (const state of [withPower, without]) {
      expect(state.pending?.kind).toBe("mulligan");
      expect(viewFor(state, "p1").opponent.hand).toEqual({ count: 4 });
    }
    expect(withPower.players.p2.hand.some((card) => card.defId === HEROIC_POWER)).toBe(true);

    // The deal's events reach p1's view (R168), redacted (R97): a Quickdraw card's `addedToHand`
    // among p2's `drawn` events counts p2's Quickdraw cards, which are p2's hand (§9.1).
    const typesOf = (state: GameState): string[] =>
      viewFor(state, "p1").events.map((event) => `${event.type}${"player" in event ? `:${event.player}` : ""}`);
    expect(typesOf(without)).toEqual(typesOf(withPower));
    sameView(viewFor(withPower, "p1"), viewFor(without, "p1"));
  });

  /** p1's deck is 19 cards plus #98 Heroic Power (Quickdraw) or #99; the asking card is p1's. */
  function pausedOwnDeal(seed: string, p1Twentieth: string): GameState {
    const game = createGame({ seed, decks: [[...QD_P1_DECK.slice(0, 19), p1Twentieth], [...QD_P2_SHARED, CRAFT]] });
    asking(game);
    game.players.p1.library[0] = newInstance(game, ASKING, "p1", { z: "library", player: "p1" });
    return beginGame(game).state;
  }

  it("R225 p1's hand and library counts while setup waits do not tell p2 whether p1's opening hand holds a Quickdraw card (§2.1, §9.1, R224)", () => {
    // A seed whose shuffle puts the asking card on top of p1's library, so it is p1's first draw.
    let seed: string | undefined;
    for (let at = 0; at < 400 && seed === undefined; at += 1) {
      const candidate = `r8-l10-own-deal-${at}`;
      const state = pausedOwnDeal(candidate, CRAFT);
      if (state.pending?.kind === "mode" && state.players.p1.hand.length === 0) seed = candidate;
    }
    const found = must(seed, "a seed that draws the asking card first");
    const withPower = pausedOwnDeal(found, HEROIC_POWER);
    const without = pausedOwnDeal(found, CRAFT);

    // Both games wait on p1's cast question, the cast card in p1's resolving zone, p2 not yet dealt.
    for (const state of [withPower, without]) {
      expect(state.pending?.kind).toBe("mode");
      expect(state.pending?.playerId).toBe("p1");
      expect(state.players.p2.hand).toHaveLength(0);
    }
    // R225: the Heroic Power replaces the last of p1's opening draws, so it is still in the library
    // while the first draw's cast asks.
    expect(withPower.players.p1.hand).toEqual([]);
    expect(withPower.players.p1.library.some((card) => card.defId === HEROIC_POWER)).toBe(true);

    // p2 may count p1's hand and library (§10.8), but whether p1's deck holds a Quickdraw card is
    // p1's to keep (§9.1): the Heroic Power has already left the library for the hand, "instead of"
    // a draw that has not happened yet, so the counts say so.
    sameView(viewFor(withPower, "p2"), viewFor(without, "p2"));
  });
});
