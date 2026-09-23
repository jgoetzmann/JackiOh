// Setup and the mulligan when a cast asks (SPEC §2.1, §2.4, §9.3, §10.1, §10.6, R9, R70, R81, R158,
// R224). Found by the polish-4 edge-case hunt, round 7 (docs/polish/4-edge-cases.md, lenses L7,
// "legality-agreement" and "engine invariants"); every case here failed before its fix.
//
//  - R224: a cast-on-draw card drawn by the opening draw or by R9's replacement draws is cast, and a
//    cast can ask its caster something. Setup used to open the next mulligan over that question,
//    which replaced it and left the cast half-played in its caster's resolving zone for good.
//  - §10.6: the mulligan's `promptAnswered` named the word "mulligan" rather than the prompt.
//
// No Core cast-on-draw card asks anything, so the asking card is a fixture (a transient def and a
// registered script, the way paused-sequences.test.ts builds its asking cards).

import { describe, expect, it } from "vitest";
import type { Action, ActionInput, CardDef, CardType } from "@jackioh/shared";
import {
  DECK_SIZE,
  beginGame,
  createGame,
  newInstance,
  query,
  reduce,
  registerScripts,
  registeredScripts,
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
