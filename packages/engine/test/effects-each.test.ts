// `forEachCard`: one effect for each card of a set a clause reads off the board (R113, R66).
//
// A list a prompt split is continued by building it again and skipping what already ran, which is
// exact only for a list whose shape does not hang on the board. A clause over a set it reads off the
// board is a part of the list instead: it reads its set once, as the list reaches it, and a pause
// inside it resumes over that same set (`EffectPart.memo`). #94 Genn's Greed's draw clause and #30
// radiant's two draws are written with it; their card tests cover the Core cases, and this file the
// verb on its own, with fixture cards.

import type { CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { chooseMode, drawFromLibrary, forEachCard } from "../src/effects";
import { answerPrompt, runHookResumable } from "../src/prompts";
import { zoneCards } from "../src/query";
import { lazyPart } from "../src/resolve";
import type { Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { newGame, setLibrary, sinkFor } from "./fixtures/harness";
import { plain } from "./fixtures/combat";

const drawer: CardDef = {
  id: "each-drawer",
  index: "each-drawer",
  name: "each drawer",
  set: "Core",
  type: "Spell",
  tags: [],
  rarity: "Common",
  token: false,
  cost: 1,
  base: { keywords: [], text: "draw every card in your library; ask after the first" },
  radiant: { keywords: [], text: "draw every card in your library; ask after the first" },
};

/**
 * "Draw every card in your library", the first draw followed by a question. The set is the library
 * as the clause begins; by the answer the first card has left it, so a list rebuilt from the board
 * would be one draw shorter and, resumed by index, would skip a card.
 */
function script(asksAfter: () => string | undefined): Script {
  return {
    cry: () => [
      forEachCard({
        cards: (ctx) => zoneCards(ctx.state, ctx.controller, "library"),
        each: (instanceId) =>
          lazyPart("each-draw", () => ({
            effects: [
              drawFromLibrary({ instanceId }),
              ...(instanceId === asksAfter() ? [chooseMode({ options: ["ok"], step: "ok", prompt: "a question" })] : []),
            ],
          })),
      }),
    ],
    resume: { ok: () => [] },
  };
}

function board(seed: string, asksAfter: () => string | undefined): { state: GameState; library: CardInstance[] } {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [drawer.id]: drawer });
  registerScripts({ ...registeredScripts(), [drawer.id]: { base: script(asksAfter), radiant: script(asksAfter) } });
  state.active = "p1";
  state.phase = "main";
  // A copy: the library array itself empties as the cards are drawn.
  const library = [...setLibrary(state, "p1", [plain.id, plain.id, plain.id])];
  state.players.p1.hand = [];
  return { state, library };
}

describe("forEachCard (R113, R66)", () => {
  it("R113 applies its effect to every card of the set, in the set's order", () => {
    const { state, library } = board("each-plain", () => undefined);
    const card = newInstance(state, drawer.id, "p1", { z: "resolving", player: "p1" });
    runHookResumable(sinkFor(state), card, "cry");

    expect(state.pending).toBeNull();
    expect(state.players.p1.hand.map((held) => held.id)).toEqual(library.map((held) => held.id));
    expect(state.players.p1.library).toEqual([]);
  });

  it("R113 resumes after a question over the set it began with, though the board it was read from has moved", () => {
    const asks: { after?: string } = {};
    const { state, library } = board("each-paused", () => asks.after);
    asks.after = library[0]?.id;
    const first = asks.after;
    const card = newInstance(state, drawer.id, "p1", { z: "resolving", player: "p1" });
    const sink = sinkFor(state);
    runHookResumable(sink, card, "cry");

    // The first card is drawn and the question is open; the other two wait in the library.
    const pending = state.pending;
    if (pending === null) throw new Error("expected the question");
    expect(state.players.p1.hand.map((held) => held.id)).toEqual([first]);

    // The continuation is data, so it survives the round trip a stored game makes (§9.3).
    const stored = JSON.parse(JSON.stringify(state)) as GameState;
    const answered = sinkFor(stored);
    expect(
      answerPrompt(answered, { playerId: "p1", choiceId: pending.id, selection: [{ pick: "mode", option: "ok" }] }),
    ).toBeNull();

    // Both cards still owed are drawn: the clause resumed over the three it read, not over the two
    // the library holds by the answer (which, resumed at the second place, would skip one).
    expect(stored.pending).toBeNull();
    expect(stored.players.p1.hand.map((held) => held.id)).toEqual(library.map((held) => held.id));
    expect(stored.players.p1.library).toEqual([]);
  });
});
