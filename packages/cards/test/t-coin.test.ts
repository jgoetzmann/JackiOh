// T-coin The Coin (SPEC §7, §2.1, §2.3; R244, R245). BUILD M4-T4's row: "0-cost Spell token dealt to
// the seat going second after the mulligan; gain 1 mana this turn (radiant 2), may exceed the cap;
// never in a deck or a random pool".
//
// Two halves, one file, because both are about this card: what the card does once played (R245,
// through `scenario()` like every card test), and who is dealt it and when (R244). The second half
// is §2.1's setup, which a `scenario()` skips, so it builds real games with `createGame` and
// `beginGame` over the real catalog, the way setup-and-mulligan.test.ts does.

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, GameEvent, PlayerId } from "@jackioh/shared";
import {
  AI_DIFFICULTY,
  COIN_DEF_ID,
  HAND_CAP,
  OPENING_DRAW,
  beginGame,
  createGame,
  createRng,
  dealCoins,
  fold,
  hashState,
  legalActions,
  moveToZone,
  query,
  reduce,
  viewFor,
  type EngineSink,
  type GameState,
  type Handicap,
} from "@jackioh/engine";
import { CATALOG } from "../src/index";
import { base, def, radiant } from "../src/scripts/t-coin";
import { scenario } from "./_harness";

const SEED = "t-coin";

/** `core-NNN` for NNN in [from, from + count): a run of deckable cards. */
function run(from: number, count: number): string[] {
  return Array.from({ length: count }, (_, at) => `core-${String(from + at).padStart(3, "0")}`);
}

/**
 * Two legal 20-card decks with no cast-on-draw card (#21, #27, #90.1) and no Quickdraw card (#65,
 * #84, #98), so the opening hands are exactly §2.1's table and nothing asks during setup (R224).
 */
const DECK_A = run(1, 20);
const DECK_B = run(41, 20);
/** 30 cards for a Hard seat (R184), from the same card-free-of-casts stretch. */
const DECK_HARD = run(31, 30);

type Game = { state: GameState; log: Action[]; events: GameEvent[] };

/** Every seat keeps its whole opening hand, then the game is at p1's turn 1 (§2.1 step 5). */
function throughMulligans(decks: [string[], string[]], handicaps?: Partial<Record<PlayerId, Handicap>>): Game {
  const created = createGame({ seed: SEED, decks, ...(handicaps === undefined ? {} : { handicaps }) });
  let state = beginGame(created).state;
  const log: Action[] = [];
  const events: GameEvent[] = [];
  for (const player of ["p1", "p2"] as const) {
    const pending = state.pending;
    expect(pending?.kind, `${player}'s mulligan is open`).toBe("mulligan");
    expect(pending?.playerId).toBe(player);
    const action: Action = {
      type: "mulligan",
      playerId: player,
      keep: state.players[player].hand.map((card) => card.id),
      nonce: `m-${player}`,
    };
    const result = reduce(state, action);
    expect(result.error).toBeUndefined();
    state = result.state;
    log.push(action);
    events.push(...result.events);
  }
  return { state, log, events };
}

function coinsIn(cards: readonly { defId: string }[]): number {
  return cards.filter((card) => card.defId === COIN_DEF_ID).length;
}

describe("T-coin The Coin — card data (§7)", () => {
  it("R245 prints a 0-cost Token Spell whose faces gain 1 and 2 mana", () => {
    expect(def.id).toBe(COIN_DEF_ID);
    expect(def.index).toBe("T-coin");
    expect(def.name).toBe("The Coin");
    expect(def.type).toBe("Spell");
    expect(def.cost).toBe(0);
    expect(def.token).toBe(true);
    expect(def.tags).toEqual(["Token"]);
    expect(def.rarity).toBe("Token");
    expect(def.base.text).toBe("Gain 1 mana this turn");
    expect(def.radiant.text).toBe("Gain 2 mana this turn");
    expect(base).not.toBe(radiant);
  });

  it("R245 is never in a deck: createGame refuses one that holds it (§2.6, §9.4 L3)", () => {
    const deck = [...run(1, 19), COIN_DEF_ID];
    expect(() => createGame({ seed: SEED, decks: [deck, DECK_B] })).toThrow(/Token card/);
  });

  it("R245 is never in a random pool: only a query that names the token pool reaches it (§5.1)", () => {
    expect(query({}).map((card) => card.id)).not.toContain(COIN_DEF_ID);
    expect(query({ type: "Spell", cost: 0 }).map((card) => card.id)).not.toContain(COIN_DEF_ID);
    expect(query({ tags: ["Token"] }).map((card) => card.id)).toContain(COIN_DEF_ID);
    expect(query({ index: "T-coin" }).map((card) => card.id)).toEqual([COIN_DEF_ID]);
  });
});

describe("T-coin The Coin — base: gain 1 mana this turn", () => {
  it("R245 gains 1 temporary mana, above the cap, and max mana does not move (§2.3)", () => {
    const s = scenario({ seed: SEED, p1: { hand: ["core-t-coin", "core-010"] } });
    expect(s.state.players.p1.mana).toMatchObject({ current: 4, max: 4 });

    s.play("core-t-coin");

    s.expectMana("p1", 5);
    expect(s.state.players.p1.mana.max).toBe(4);
    s.expectEvents("cardPlayed", "manaChanged");
  });

  it("R245 the mana lasts this turn only: the next refresh sets current back to max (§2.3)", () => {
    const s = scenario({ seed: SEED, p1: { hand: ["core-t-coin", "core-010"] } });
    s.play("core-t-coin").expectMana("p1", 5);

    s.startTurn();

    s.expectMana("p1", 4);
  });

  it("R245 on the second seat's first turn it pays for a 2-cost card that 1 mana cannot", () => {
    // p2's first turn is turn 2: one started turn, so 1 mana (§2.3).
    const s = scenario({ seed: SEED, active: "p2", turn: 2, p2: { hand: ["core-t-coin", "core-020"] } });
    const pointmaster = s.card("core-020");
    const playable = (): string[] =>
      legalActions(s.state, "p2").flatMap((action) => (action.type === "play" ? [action.instanceId] : []));
    expect(s.state.players.p2.mana.current).toBe(1);
    expect(playable()).not.toContain(pointmaster.id);

    s.play("core-t-coin");
    expect(playable()).toContain(pointmaster.id);
    s.play(pointmaster);

    s.expectInZone(pointmaster, "field").expectMana("p2", 0);
  });

  it("R245 is a play, and a spell token goes to the graveyard when it resolves (R11, R70)", () => {
    const s = scenario({ seed: SEED, p1: { hand: ["core-t-coin", "core-010"] } });
    const played = s.state.counters.played;

    s.play("core-t-coin");

    s.expectInZone("core-t-coin", "graveyard");
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    expect(s.state.counters.played).toBe(played + 1);
  });

  it("R245 #64 Gifted Program makes it Radiant as it is played, so it gains 2 (R213)", () => {
    const s = scenario({ seed: SEED, p1: { hand: ["core-t-coin", "core-010"], backrow: ["core-064"] } });

    s.play("core-t-coin");

    s.expectMana("p1", 6);
    expect(s.card("core-t-coin").radiant).toBe(true);
  });
});

describe("T-coin The Coin — radiant: gain 2 mana this turn", () => {
  it("R245 a Radiant Coin gains 2 (§8 Conventions: only the number changes)", () => {
    const s = scenario({ seed: SEED, p1: { hand: [{ def: "core-t-coin", radiant: true }, "core-010"] } });

    s.play("core-t-coin");

    s.expectMana("p1", 6);
    expect(s.state.players.p1.mana.max).toBe(4);
    s.expectInZone("core-t-coin", "graveyard");
  });

  it("R245 a Radiant Coin's mana is temporary too", () => {
    const s = scenario({ seed: SEED, p1: { hand: [{ def: "core-t-coin", radiant: true }, "core-010"] } });
    s.play("core-t-coin").expectMana("p1", 6);

    s.startTurn();

    s.expectMana("p1", 4);
  });
});

describe("T-coin The Coin — R244: the seat going second is dealt it after the mulligan", () => {
  it("R244 p2 holds its opening hand plus The Coin as its last card at turn 1; p1 holds none", () => {
    const { state } = throughMulligans([DECK_A, DECK_B]);

    expect(state.turn).toBe(1);
    expect(state.active).toBe("p1");
    const p2 = state.players.p2.hand;
    expect(p2).toHaveLength((OPENING_DRAW[1] ?? 0) + 1);
    expect(p2[p2.length - 1]?.defId).toBe(COIN_DEF_ID);
    expect(coinsIn(p2)).toBe(1);
    // p1's opening hand and its turn-1 draw (R10), and no Coin.
    expect(state.players.p1.hand).toHaveLength((OPENING_DRAW[0] ?? 0) + 1);
    expect(coinsIn(state.players.p1.hand)).toBe(0);
  });

  it("R244 The Coin is not part of the mulligan: neither prompt offers it, and it arrives after both", () => {
    const created = createGame({ seed: SEED, decks: [DECK_A, DECK_B] });
    let state = beginGame(created).state;
    for (const player of ["p1", "p2"] as const) {
      const options = state.pending?.options ?? [];
      expect(options).toHaveLength(state.players[player].hand.length);
      expect(coinsIn(state.players.p2.hand), `no Coin while ${player}'s mulligan is open`).toBe(0);
      const result = reduce(state, {
        type: "mulligan",
        playerId: player,
        keep: [],
        nonce: `all-back-${player}`,
      });
      expect(result.error).toBeUndefined();
      state = result.state;
    }
    // Returning the whole hand shuffled four cards back and drew four; The Coin came after that.
    expect(coinsIn(state.players.p2.hand)).toBe(1);
    expect(coinsIn(state.players.p2.library)).toBe(0);
  });

  it("R244 it is an add to hand, not a draw: addedToHand alone, and #100's draw counter does not move (R55)", () => {
    const { state, events } = throughMulligans([DECK_A, DECK_B]);
    const coin = state.players.p2.hand.find((card) => card.defId === COIN_DEF_ID);
    expect(coin).toBeDefined();
    const named = events.filter((event) => "instanceId" in event && event.instanceId === coin?.id);
    expect(named.map((event) => event.type)).toEqual(["addedToHand"]);
    // Four opening draws for p2, three for p1, and p1's turn-1 draw: the Coin is not among them.
    expect(state.counters.drawn).toBe((OPENING_DRAW[0] ?? 0) + (OPENING_DRAW[1] ?? 0) + 1);
  });

  it("R244 p1 sees a fifth card in p2's hand and not which one it is (R97)", () => {
    const { state } = throughMulligans([DECK_A, DECK_B]);
    const mine = viewFor(state, "p2");
    const theirs = viewFor(state, "p1");
    expect(theirs.opponent.hand).toEqual({ count: (OPENING_DRAW[1] ?? 0) + 1 });
    expect(JSON.stringify(theirs)).not.toContain(COIN_DEF_ID);
    const dealt = theirs.events.filter((event) => event.type === "addedToHand" && event.player === "p2");
    expect(dealt.length).toBeGreaterThan(0);
    for (const event of dealt) expect(event.type === "addedToHand" && event.defId).toBe("hidden");
    // Its holder reads it like any card in its own hand.
    const hand = Array.isArray(mine.you.hand) ? mine.you.hand : [];
    expect(hand.map((card) => card.defId)).toContain(COIN_DEF_ID);
  });

  it("R244 a handicapped seat going second is dealt it too, after its extra opening card (R180, R182)", () => {
    const { state } = throughMulligans([DECK_A, DECK_HARD], { p2: AI_DIFFICULTY.hard });
    const hand = state.players.p2.hand;
    expect(hand).toHaveLength((OPENING_DRAW[1] ?? 0) + AI_DIFFICULTY.hard.extraOpeningCards + 1);
    expect(hand[hand.length - 1]?.defId).toBe(COIN_DEF_ID);
  });

  it("R244 a human seated second against a handicapped first seat gets it, and the first seat none", () => {
    const { state } = throughMulligans([DECK_HARD, DECK_B], { p1: AI_DIFFICULTY.hard });
    expect(coinsIn(state.players.p1.hand)).toBe(0);
    expect(coinsIn(state.players.p2.hand)).toBe(1);
  });

  it("R244 a full hand burns it into the graveyard, as any card added to one (§2.4, R4)", () => {
    // No Core opening hand reaches HAND_CAP, so the hand is filled by hand before the deal.
    const state = createGame({ seed: SEED, decks: [DECK_A, DECK_B] });
    const side = state.players.p2;
    for (const card of side.library.slice(0, HAND_CAP)) moveToZone(state, card, "hand");
    const sink: EngineSink = { state, events: [], rng: createRng(state.seed, state.rngCursor) };

    dealCoins(sink);

    expect(side.hand).toHaveLength(HAND_CAP);
    expect(coinsIn(side.hand)).toBe(0);
    expect(coinsIn(side.graveyard)).toBe(1);
    expect(sink.events.map((event) => event.type)).toEqual(["burned", "enteredGraveyard"]);
  });

  it("R244 the game still folds exactly from (seed, decks, handicaps, log), the Coin included (§9.3, R187)", () => {
    const decks: [string[], string[]] = [DECK_A, DECK_HARD];
    const handicaps = { p2: AI_DIFFICULTY.hard };
    const game = throughMulligans(decks, handicaps);
    let state = game.state;
    const log: Action[] = [...game.log];
    const step = (playerId: PlayerId, action: ActionBody): void => {
      const stamped: Action = { ...action, playerId, nonce: `s${String(log.length)}` };
      const result = reduce(state, stamped);
      expect(result.error).toBeUndefined();
      state = result.state;
      log.push(stamped);
    };
    // p1 ends turn 1; p2 plays The Coin on turn 2.
    step("p1", { type: "endTurn" });
    const coin = state.players.p2.hand.find((card) => card.defId === COIN_DEF_ID);
    expect(coin).toBeDefined();
    step("p2", { type: "play", instanceId: coin?.id ?? "", tributes: [], targets: [], modes: [] });
    // Hard's first turn refreshes to 2 (R181), and The Coin adds 1.
    expect(state.players.p2.mana.current).toBe(3);

    const replayed = fold({ seed: SEED, decks, handicaps, log });
    expect(replayed.errors).toEqual([]);
    expect(hashState(replayed.state)).toBe(hashState(state));
    expect(replayed.state.players.p2.mana.current).toBe(3);
    expect(coinsIn(replayed.state.players.p2.graveyard)).toBe(1);
  });

  it("R244 it moves nothing about the turn order or the cap: p1 takes turn 1, p2 turn 2 (§2.5, R2)", () => {
    const { state } = throughMulligans([DECK_A, DECK_B]);
    expect(state.turn).toBe(1);
    expect(state.active).toBe("p1");
    const next = reduce(state, { type: "endTurn", playerId: "p1", nonce: "e1" }).state;
    expect(next.turn).toBe(2);
    expect(next.active).toBe("p2");
    expect(next.players.p2.turnsStarted).toBe(1);
  });

  it("R244 the catalog the engine deals from holds it", () => {
    expect(CATALOG[COIN_DEF_ID]).toBeDefined();
  });
});
