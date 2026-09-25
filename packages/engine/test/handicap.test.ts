// The per-seat handicap (SPEC §9.9; R180–R184, R290; docs/polish/3-ai.md B1–B8).
//
// Practice gives the AI seat more resources than a human: a bigger deck, extra mana crystals up to
// a higher cap, an extra opening card and, on Hard, a second draw each turn. The tutorial's
// opponent (AI_TUTORIAL, R290) gets fewer: a 12-card deck, 3 crystals at most and a hero that
// starts at 20. The human seat always plays with this spec's own numbers, and a game with no
// handicap must hash and replay exactly as it did before the field existed. Everything here is observed through `createGame`, `beginGame`,
// `reduce`, `fold` and the state they return; nothing reads how the rules are implemented.
//
// Fixtures: the engine's vanilla catalog (`fx-1`..`fx-40`, every one a 1-cost 2/2), the Hinder and
// Going Long fixtures from ./fixtures/scripts, and two cast-on-draw Spells of this file's own
// (prefixed `hc-`, indexed from 2800) for R183's draw chain.

import type { Action, ActionInput, CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import {
  AI_DIFFICULTY,
  AI_TUTORIAL,
  DECK_SIZE,
  DIFFICULTIES,
  DRAWS_PER_TURN,
  HAND_CAP,
  HERO_HEALTH,
  HUMAN_HANDICAP,
  LIBRARY_CAP,
  MAX_MANA,
  OPENING_DRAW,
  type Handicap,
} from "../src/config";
import { healHero, healHeroUpTo } from "../src/damage";
import { DRAW_COUNT_WORK, owedDrawCountOf } from "../src/draw";
import { maxManaFor, refreshMana } from "../src/mana";
import { openPrompt, resumeSelf } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import { fold, hashState } from "../src/replay";
import { createRng } from "../src/rng";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { openingHandSize } from "../src/setup";
import {
  createGame,
  handicapOf,
  newInstance,
  startingHeroHealth,
  validateDeck,
  validateHandicap,
  type CardInstance,
  type GameState,
} from "../src/state";
import { chooseAction } from "../src/subsystems/aiPolicy";
import { viewFor } from "../src/viewFor";
import { owedWork } from "../src/work";
import { tokenDef, vanillaCatalog, vanillaDeck } from "./fixtures/catalog";
import { eventsOfType, setupCatalog } from "./fixtures/harness";
import { goingLong, heroicPower, hinder } from "./fixtures/scripts";

type Handicaps = Partial<Record<PlayerId, Handicap>>;

// ---------------------------------------------------------------------------
// Fixtures: two cast-on-draw Spells for R183 (the shape draw-pause.test.ts uses).
// ---------------------------------------------------------------------------

function spell(id: string, index: string): CardDef {
  return {
    id,
    index,
    name: `${id} (handicap)`,
    set: "Core",
    type: "Spell",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: id },
    radiant: { keywords: [], text: id },
  };
}

/** §2.4 cast on draw, and its Cry asks its controller a one-option question (§10.6). */
const askOnDraw = spell("hc-ask-on-draw", "2801");
/** §2.4 cast on draw, asking nothing: the chain simply continues (R58). */
const quietOnDraw = spell("hc-quiet-on-draw", "2802");

function askController(): Effect {
  return {
    kind: "hc:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the cast-on-draw card asks its owner",
        options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
        resume: resumeSelf(ctx, "asked"),
      });
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [askOnDraw.id]: both({
    staticFlags: { castOnDraw: true },
    cry: () => [askController()],
    resume: { asked: () => [] },
  }),
  [quietOnDraw.id]: both({ staticFlags: { castOnDraw: true }, cry: () => [] }),
};

/** The engine's fixture catalog plus this file's two Spells. */
function registerAll(): void {
  setupCatalog();
  registerCatalog({ ...registeredCatalog(), [askOnDraw.id]: askOnDraw, [quietOnDraw.id]: quietOnDraw });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

function sizeFor(handicaps: Handicaps | undefined, player: PlayerId): number {
  return handicaps?.[player]?.deckSize ?? DECK_SIZE;
}

/** A legal deck pair for these handicaps: vanilla units, `fx-1` up, one per card id. */
function decksFor(handicaps?: Handicaps): [string[], string[]] {
  return [vanillaDeck(sizeFor(handicaps, "p1"), 1), vanillaDeck(sizeFor(handicaps, "p2"), 1)];
}

function game(seed: string, handicaps?: Handicaps, decks?: [string[], string[]]): GameState {
  registerAll();
  return createGame({
    seed,
    decks: decks ?? decksFor(handicaps),
    ...(handicaps === undefined ? {} : { handicaps }),
  });
}

let nonce = 0;

function step(state: GameState, body: ActionInput): { state: GameState; events: GameEvent[] } {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `hc${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(`${body.type} refused: ${result.error}`);
  return { state: result.state, events: result.events };
}

function act(state: GameState, body: ActionInput): GameState {
  return step(state, body).state;
}

/** Both mulligans kept whole: turn 1, p1's main phase. */
function started(seed: string, handicaps?: Handicaps, decks?: [string[], string[]]): GameState {
  let state = beginGame(game(seed, handicaps, decks)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

/** One endTurn, checked to have passed exactly one turn (no auto-ended cascade). */
function passTurn(state: GameState): { state: GameState; events: GameEvent[] } {
  const turn = state.turn;
  const next = step(state, { type: "endTurn", playerId: state.active });
  expect(next.state.turn, "endTurn passed exactly one turn").toBe(turn + 1);
  return next;
}

/** endTurn until `seat` is active having started `turns` turns. */
function advanceTo(state: GameState, seat: PlayerId, turns: number): GameState {
  let next = state;
  for (let guard = 0; guard < 60; guard += 1) {
    if (next.active === seat && next.players[seat].turnsStarted === turns) return next;
    next = passTurn(next).state;
  }
  throw new Error(`${seat} never reached turn ${turns}`);
}

/** Each seat's mana.max at the start of each of its turns, over `turns` player-turns. */
function maxesByTurn(seed: string, handicaps: Handicaps | undefined, turns: number): Record<PlayerId, number[]> {
  let state = started(seed, handicaps);
  const seen: Record<PlayerId, number[]> = { p1: [state.players.p1.mana.max], p2: [] };
  while (seen.p1.length + seen.p2.length < turns) {
    state = passTurn(state).state;
    seen[state.active].push(state.players[state.active].mana.max);
  }
  return seen;
}

function onTopOfLibrary(state: GameState, player: PlayerId, defIds: string[]): CardInstance[] {
  const cards = defIds.map((defId) => newInstance(state, defId, player, { z: "library", player }));
  state.players[player].library = [...cards, ...state.players[player].library];
  return cards;
}

function drawnBy(events: readonly GameEvent[], player: PlayerId): string[] {
  return eventsOfType(events, "drawn")
    .filter((event) => event.player === player)
    .map((event) => event.instanceId);
}

function roundTrip(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

/**
 * A full random-policy game (§10.7) under these handicaps, as fold must reproduce it. `observe`, when
 * given, sees the dealt state and every state after it.
 */
function playRandom(
  seed: string,
  handicaps: Handicaps,
  observe?: (state: GameState) => void,
): { state: GameState; log: Action[]; decks: [string[], string[]] } {
  const decks = decksFor(handicaps);
  let state = beginGame(game(seed, handicaps, decks)).state;
  observe?.(state);
  const policy = createRng(`handicap-policy-${seed}`);
  const log: Action[] = [];
  while (state.result === null) {
    if (log.length > 5000) throw new Error(`${seed} did not finish`);
    const player = state.pending?.playerId ?? state.active;
    const chosen = chooseAction(state, player, policy);
    if (chosen === null) throw new Error(`${seed}: no legal action for ${player}`);
    const action = { ...chosen, playerId: player, nonce: `hr${log.length}` } as Action;
    const result = reduce(state, action);
    if (result.error !== undefined) throw new Error(`${seed}: ${action.type} refused: ${result.error}`);
    log.push(action);
    state = result.state;
    observe?.(state);
  }
  return { state, log, decks };
}

// ---------------------------------------------------------------------------
// R180: the handicap table and what "no handicap" means.
// ---------------------------------------------------------------------------

describe("R180 handicaps: the table, the default and replay", () => {
  it("R180 B8: AI_DIFFICULTY is §9.9's table, Easy is HUMAN_HANDICAP and HUMAN_HANDICAP is this spec's numbers", () => {
    expect(HUMAN_HANDICAP).toEqual({
      deckSize: DECK_SIZE,
      manaBonus: 0,
      manaCap: MAX_MANA,
      extraOpeningCards: 0,
      extraDrawsPerTurn: 0,
    });
    expect(AI_DIFFICULTY.easy).toEqual(HUMAN_HANDICAP);
    expect(AI_DIFFICULTY.medium).toEqual({
      deckSize: 25,
      manaBonus: 1,
      manaCap: 5,
      extraOpeningCards: 1,
      extraDrawsPerTurn: 0,
    });
    expect(AI_DIFFICULTY.hard).toEqual({
      deckSize: 30,
      manaBonus: 1,
      manaCap: 7,
      extraOpeningCards: 1,
      extraDrawsPerTurn: 1,
    });
    expect([...DIFFICULTIES]).toEqual(["easy", "medium", "hard"]);
    expect(Object.keys(AI_DIFFICULTY).sort()).toEqual(["easy", "hard", "medium"]);
    expect(DRAWS_PER_TURN).toBe(1);
  });

  it("R180 B8: every tier's handicap is a valid one, and Easy's deck is the loadout's 20", () => {
    for (const difficulty of DIFFICULTIES) {
      expect(() => validateHandicap(AI_DIFFICULTY[difficulty], difficulty)).not.toThrow();
    }
    expect(() => validateHandicap(HUMAN_HANDICAP, "human")).not.toThrow();
    expect(AI_DIFFICULTY.easy.deckSize).toBe(DECK_SIZE);
  });

  it("R180 B1: no handicaps, HUMAN_HANDICAP or Easy store nothing and hash exactly like the plain game", () => {
    const decks = decksFor();
    const plain = game("r180-b1", undefined, decks);
    const variants: Handicaps[] = [
      {},
      { p1: HUMAN_HANDICAP },
      { p2: HUMAN_HANDICAP },
      { p1: AI_DIFFICULTY.easy, p2: AI_DIFFICULTY.easy },
      { p2: { ...HUMAN_HANDICAP } },
    ];
    for (const handicaps of variants) {
      const label = JSON.stringify(handicaps);
      const state = game("r180-b1", handicaps, decks);
      for (const player of PLAYER_IDS) {
        expect(Object.keys(state.players[player]), `${label}: ${player}`).not.toContain("handicap");
        expect(handicapOf(state.players[player]), `${label}: ${player}`).toEqual(HUMAN_HANDICAP);
      }
      expect(hashState(state), label).toBe(hashState(plain));
      expect(hashState(beginGame(state).state), label).toBe(hashState(beginGame(plain).state));
    }
  });

  it("R180 B1: a handicap that differs from HUMAN_HANDICAP in one field is stored, as a copy, on that seat only", () => {
    const bonus: Handicap = { ...HUMAN_HANDICAP, manaBonus: 1 };
    const decks = decksFor();
    const plain = game("r180-b1-stored", undefined, decks);
    const state = game("r180-b1-stored", { p2: bonus }, decks);

    expect(state.players.p2.handicap).toEqual(bonus);
    expect(state.players.p2.handicap).not.toBe(bonus);
    expect(Object.keys(state.players.p1)).not.toContain("handicap");
    expect(handicapOf(state.players.p2)).toEqual(bonus);
    expect(hashState(state)).not.toBe(hashState(plain));

    const hard = game("r180-b1-hard", { p1: AI_DIFFICULTY.hard });
    expect(handicapOf(hard.players.p1)).toEqual(AI_DIFFICULTY.hard);
    expect(handicapOf(hard.players.p2)).toEqual(HUMAN_HANDICAP);
  });

  it("R180 B1: with handicaps for both seats, only the one that differs from HUMAN_HANDICAP is stored", () => {
    const state = game("r180-b1-both", { p1: HUMAN_HANDICAP, p2: AI_DIFFICULTY.medium });
    expect(Object.keys(state.players.p1)).not.toContain("handicap");
    expect(state.players.p2.handicap).toEqual(AI_DIFFICULTY.medium);
  });

  it("R180 validateHandicap refuses a handicap with a missing field or a field of the wrong type", () => {
    const { manaCap: _manaCap, ...missing } = AI_DIFFICULTY.hard;
    expect(() => validateHandicap(missing as unknown as Handicap, "p2")).toThrow();
    expect(() => validateHandicap({ ...AI_DIFFICULTY.hard, manaBonus: "1" } as unknown as Handicap, "p2")).toThrow();
    expect(() => validateHandicap({ ...AI_DIFFICULTY.hard, deckSize: null } as unknown as Handicap, "p2")).toThrow();
  });

  it("R180 validateHandicap refuses a negative, fractional or non-finite field and a deck size outside 1..LIBRARY_CAP", () => {
    const bad: Handicap[] = [
      { ...HUMAN_HANDICAP, manaBonus: -1 },
      { ...HUMAN_HANDICAP, manaCap: 4.5 },
      { ...HUMAN_HANDICAP, extraOpeningCards: -2 },
      { ...HUMAN_HANDICAP, extraDrawsPerTurn: Number.NaN },
      { ...HUMAN_HANDICAP, manaBonus: Number.POSITIVE_INFINITY },
      { ...HUMAN_HANDICAP, deckSize: 0 },
      { ...HUMAN_HANDICAP, deckSize: LIBRARY_CAP + 1 },
      { ...HUMAN_HANDICAP, deckSize: 20.5 },
    ];
    for (const handicap of bad) {
      expect(() => validateHandicap(handicap, "p2"), JSON.stringify(handicap)).toThrow();
    }
    expect(() => validateHandicap({ ...HUMAN_HANDICAP, deckSize: 1 }, "p2")).not.toThrow();
    expect(() => validateHandicap({ ...HUMAN_HANDICAP, deckSize: LIBRARY_CAP }, "p2")).not.toThrow();
    expect(() => validateHandicap({ ...HUMAN_HANDICAP, manaCap: 0, manaBonus: 0 }, "p2")).not.toThrow();
  });

  it("R180 every field is checked: a negative or fractional value in any one field is refused", () => {
    const fields = ["deckSize", "manaBonus", "manaCap", "extraOpeningCards", "extraDrawsPerTurn"] as const;
    for (const field of fields) {
      for (const bad of [-1, 0.5]) {
        const handicap = { ...AI_DIFFICULTY.medium, [field]: bad } as Handicap;
        expect(() => validateHandicap(handicap, "p2"), `${field} = ${bad}`).toThrow();
      }
    }
  });

  it("R180 createGame refuses an invalid handicap before the game exists", () => {
    registerAll();
    const decks = decksFor();
    expect(() => createGame({ seed: "bad", decks, handicaps: { p2: { ...HUMAN_HANDICAP, manaBonus: -1 } } })).toThrow();
    expect(() => createGame({ seed: "bad", decks, handicaps: { p1: { ...HUMAN_HANDICAP, manaCap: 1.5 } } })).toThrow();
    expect(() =>
      createGame({ seed: "bad", decks, handicaps: { p2: { ...HUMAN_HANDICAP, deckSize: LIBRARY_CAP + 1 } } }),
    ).toThrow();
  });

  it("R180 B7: fold with the handicaps reproduces a handicapped random-policy game's hash", { timeout: 120_000 }, () => {
    const cases: [string, Handicaps][] = [
      ["r180-fold-medium", { p2: AI_DIFFICULTY.medium }],
      ["r180-fold-hard", { p2: AI_DIFFICULTY.hard }],
      ["r180-fold-hard-p1", { p1: AI_DIFFICULTY.hard }],
    ];
    for (const [seed, handicaps] of cases) {
      const live = playRandom(seed, handicaps);
      registerAll();
      const replayed = fold({ seed, decks: live.decks, log: live.log, handicaps });
      expect(replayed.errors, seed).toEqual([]);
      expect(hashState(replayed.state), seed).toBe(hashState(live.state));
      expect(replayed.state.result, seed).toEqual(live.state.result);
    }
  });

  it("R180 B7: the same fold without the handicaps throws on the 25- or 30-card deck", { timeout: 120_000 }, () => {
    const medium = playRandom("r180-fold-missing-medium", { p2: AI_DIFFICULTY.medium });
    registerAll();
    expect(() => fold({ seed: "r180-fold-missing-medium", decks: medium.decks, log: medium.log })).toThrow(
      /p2: deck must hold exactly 20/,
    );

    const hard = playRandom("r180-fold-missing-hard", { p1: AI_DIFFICULTY.hard });
    registerAll();
    expect(() => fold({ seed: "r180-fold-missing-hard", decks: hard.decks, log: hard.log })).toThrow(
      /p1: deck must hold exactly 20/,
    );
  });

  it("R180 B7: fold given HUMAN_HANDICAP explicitly replays an unhandicapped game exactly as fold without it", { timeout: 120_000 }, () => {
    const live = playRandom("r180-fold-human", {});
    registerAll();
    const bare = fold({ seed: "r180-fold-human", decks: live.decks, log: live.log });
    const explicit = fold({
      seed: "r180-fold-human",
      decks: live.decks,
      log: live.log,
      handicaps: { p1: HUMAN_HANDICAP, p2: AI_DIFFICULTY.easy },
    });
    expect(bare.errors).toEqual([]);
    expect(explicit.errors).toEqual([]);
    expect(hashState(explicit.state)).toBe(hashState(live.state));
    expect(hashState(bare.state)).toBe(hashState(live.state));
  });

  it("R180 B7: a fold given different handicaps does not reproduce the game", { timeout: 120_000 }, () => {
    const live = playRandom("r180-fold-wrong", { p2: AI_DIFFICULTY.hard });
    registerAll();
    const wrong = fold({
      seed: "r180-fold-wrong",
      decks: live.decks,
      log: live.log,
      handicaps: { p2: { ...AI_DIFFICULTY.hard, manaBonus: 0 } },
    });
    const same = wrong.errors.length === 0 && hashState(wrong.state) === hashState(live.state);
    expect(same).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// R181: max mana.
// ---------------------------------------------------------------------------

describe("R181 max mana under a handicap", () => {
  it("R181 B3: maxManaFor is min(turns started + manaBonus, manaCap) for every tier, and §2.3 for a human", () => {
    for (const difficulty of DIFFICULTIES) {
      const h = AI_DIFFICULTY[difficulty];
      const state = game(`r181-unit-${difficulty}`, { p2: h });
      for (let turns = 0; turns <= 10; turns += 1) {
        state.players.p2.turnsStarted = turns;
        state.players.p1.turnsStarted = turns;
        expect(maxManaFor(state.players.p2), `${difficulty} after ${turns} turns`).toBe(
          Math.min(turns + h.manaBonus, h.manaCap),
        );
        expect(maxManaFor(state.players.p1), `human after ${turns} turns`).toBe(Math.min(turns, MAX_MANA));
      }
    }
  });

  it("R181 B3: a persistent modifier applies after the cap, a next-turn one moves only that refresh, and both floor at 0", () => {
    const state = game("r181-mods", { p2: AI_DIFFICULTY.medium });
    const side = state.players.p2;
    const cap = AI_DIFFICULTY.medium.manaCap;

    // §2.3 as task 4 read it: the next-turn rider is spent on one refresh and never reaches max mana.
    side.turnsStarted = 9;
    side.mana.nextTurnMod = 2;
    expect(maxManaFor(side)).toBe(cap);
    refreshMana(side);
    expect(side.mana).toMatchObject({ max: cap, current: cap + 2, nextTurnMod: 0 });

    side.mana.nextTurnMod = -1;
    refreshMana(side);
    expect(side.mana).toMatchObject({ max: cap, current: cap - 1, nextTurnMod: 0 });

    side.mana.permMod = 1;
    expect(maxManaFor(side)).toBe(cap + 1);

    side.turnsStarted = 0;
    side.mana.permMod = -5;
    side.mana.nextTurnMod = -1;
    expect(maxManaFor(side)).toBe(0);
    refreshMana(side);
    expect(side.mana).toMatchObject({ max: 0, current: 0 });
  });

  it("R181 B3: a Medium seat refreshes to 2 on its first turn and to 5 from its fourth; the human is unchanged", () => {
    const seen = maxesByTurn("r181-medium", { p2: AI_DIFFICULTY.medium }, 12);
    expect(seen.p2).toEqual([2, 3, 4, 5, 5, 5]);
    expect(seen.p1).toEqual([1, 2, 3, 4, 4, 4]);
  });

  it("R181 B3: a Hard seat refreshes to 7 from its sixth turn; the human is unchanged", () => {
    const seen = maxesByTurn("r181-hard", { p2: AI_DIFFICULTY.hard }, 14);
    expect(seen.p2).toEqual([2, 3, 4, 5, 6, 7, 7]);
    expect(seen.p1).toEqual([1, 2, 3, 4, 4, 4, 4]);
  });

  it("R181 B3: a handicapped p1 gets its bonus from turn 1, and no handicap is §2.3's min(turns, 4)", () => {
    const medium = maxesByTurn("r181-medium-p1", { p1: AI_DIFFICULTY.medium }, 12);
    expect(medium.p1).toEqual([2, 3, 4, 5, 5, 5]);
    expect(medium.p2).toEqual([1, 2, 3, 4, 4, 4]);

    const plain = maxesByTurn("r181-plain", undefined, 12);
    expect(plain.p1).toEqual([1, 2, 3, 4, 4, 4]);
    expect(plain.p2).toEqual([1, 2, 3, 4, 4, 4]);
  });

  it("R181 B3: Hinder drawn by the human still costs a Medium seat one crystal on its next refresh", () => {
    let state = started("r181-hinder", { p2: AI_DIFFICULTY.medium });
    state = passTurn(state).state; // p2's first turn: 2
    expect(state.players.p2.mana.max).toBe(2);

    onTopOfLibrary(state, "p1", [hinder.id]);
    state = passTurn(state).state; // p1 draws Hinder, cast on draw
    state = passTurn(state).state; // p2's second turn: max min(2 + 1, 5), refreshed to one less
    expect(state.active).toBe("p2");
    expect(state.players.p2.mana).toMatchObject({ max: 3, current: 2 });

    state = advanceTo(state, "p2", 3);
    expect(state.players.p2.mana).toMatchObject({ max: 4, current: 4 });
  });

  it("R181 B3: Hinder at the cap takes the Medium seat below its cap, not back to it", () => {
    let state = advanceTo(started("r181-hinder-cap", { p2: AI_DIFFICULTY.medium }), "p2", 4);
    expect(state.players.p2.mana.max).toBe(5);

    onTopOfLibrary(state, "p1", [hinder.id]);
    state = advanceTo(state, "p2", 5);
    expect(state.players.p2.mana).toMatchObject({ max: 5, current: 4 });

    state = advanceTo(state, "p2", 6);
    expect(state.players.p2.mana).toMatchObject({ max: 5, current: 5 });
  });

  it("R181 B3: a next-turn gain lifts a capped Hard seat's refresh above its cap once, and a persistent one lifts its max every refresh", () => {
    let state = advanceTo(started("r181-gain", { p2: AI_DIFFICULTY.hard }), "p2", 6);
    expect(state.players.p2.mana).toMatchObject({ max: 7, current: 7 });

    state.players.p2.mana.nextTurnMod = 2;
    state = advanceTo(state, "p2", 7);
    expect(state.players.p2.mana).toMatchObject({ max: 7, current: 9 });

    state = advanceTo(state, "p2", 8);
    expect(state.players.p2.mana).toMatchObject({ max: 7, current: 7 });

    state.players.p2.mana.permMod = 1;
    state = advanceTo(state, "p2", 9);
    expect(state.players.p2.mana).toMatchObject({ max: 8, current: 8 });
    state = advanceTo(state, "p2", 10);
    expect(state.players.p2.mana).toMatchObject({ max: 8, current: 8 });
  });
});

// ---------------------------------------------------------------------------
// R182: the opening hand.
// ---------------------------------------------------------------------------

describe("R182 the opening hand under a handicap", () => {
  it("R182 B4: openingHandSize is §2.1's table entry plus extraOpeningCards", () => {
    for (const difficulty of DIFFICULTIES) {
      const extra = AI_DIFFICULTY[difficulty].extraOpeningCards;
      const asP2 = game(`r182-size-p2-${difficulty}`, { p2: AI_DIFFICULTY[difficulty] });
      expect(openingHandSize(asP2, "p1")).toBe(OPENING_DRAW[0]);
      expect(openingHandSize(asP2, "p2")).toBe((OPENING_DRAW[1] as number) + extra);

      const asP1 = game(`r182-size-p1-${difficulty}`, { p1: AI_DIFFICULTY[difficulty] });
      expect(openingHandSize(asP1, "p1")).toBe((OPENING_DRAW[0] as number) + extra);
      expect(openingHandSize(asP1, "p2")).toBe(OPENING_DRAW[1]);
    }
  });

  it("R182 B4: the mulligan offers 5 cards to a Medium or Hard p2 and 3 to the human p1", () => {
    for (const difficulty of ["medium", "hard"] as const) {
      const h = AI_DIFFICULTY[difficulty];
      let state = beginGame(game(`r182-p2-${difficulty}`, { p2: h })).state;

      expect(state.pending?.kind).toBe("mulligan");
      expect(state.pending?.playerId).toBe("p1");
      expect(state.pending?.options, difficulty).toHaveLength(OPENING_DRAW[0] as number);
      expect(state.players.p1.hand).toHaveLength(OPENING_DRAW[0] as number);

      state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
      expect(state.pending?.kind).toBe("mulligan");
      expect(state.pending?.playerId).toBe("p2");
      expect(state.pending?.options, difficulty).toHaveLength(5);
      expect(state.players.p2.hand).toHaveLength(5);
      expect(state.players.p2.library).toHaveLength(h.deckSize - 5);
    }
  });

  it("R182 B4: the mulligan offers 4 cards to a Medium or Hard p1 and 4 to the human p2", () => {
    for (const difficulty of ["medium", "hard"] as const) {
      const h = AI_DIFFICULTY[difficulty];
      let state = beginGame(game(`r182-p1-${difficulty}`, { p1: h })).state;

      expect(state.pending?.playerId).toBe("p1");
      expect(state.pending?.options, difficulty).toHaveLength(4);
      expect(state.players.p1.hand).toHaveLength(4);
      expect(state.players.p1.library).toHaveLength(h.deckSize - 4);

      state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
      expect(state.pending?.playerId).toBe("p2");
      expect(state.pending?.options, difficulty).toHaveLength(OPENING_DRAW[1] as number);
      expect(state.players.p2.hand).toHaveLength(OPENING_DRAW[1] as number);
    }
  });

  it("R182 B4: an Easy seat opens exactly as a human does", () => {
    let state = beginGame(game("r182-easy", { p1: AI_DIFFICULTY.easy, p2: AI_DIFFICULTY.easy })).state;
    expect(state.pending?.options).toHaveLength(OPENING_DRAW[0] as number);
    state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
    expect(state.pending?.options).toHaveLength(OPENING_DRAW[1] as number);
  });

  it("R182 B4: a Quickdraw card replaces one of the Medium seat's five opening draws", () => {
    const h = AI_DIFFICULTY.medium;
    const p2Deck = [goingLong.id, ...vanillaDeck(h.deckSize - 1, 1)];
    let state = beginGame(game("r182-quickdraw", { p2: h }, [vanillaDeck(DECK_SIZE, 1), p2Deck])).state;
    state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });

    const hand = state.players.p2.hand.map((c) => c.defId);
    expect(hand).toHaveLength(5);
    expect(hand).toContain(goingLong.id);
    expect(hand.filter((defId) => defId !== goingLong.id)).toHaveLength(4);
    expect(state.pending?.options).toHaveLength(5);
    expect(state.players.p2.library).toHaveLength(h.deckSize - 5);
  });

  it("R182 B4: two Quickdraw cards replace two of the Medium seat's five opening draws", () => {
    const h = AI_DIFFICULTY.medium;
    const p2Deck = [goingLong.id, heroicPower.id, ...vanillaDeck(h.deckSize - 2, 1)];
    let state = beginGame(game("r182-quickdraw-two", { p2: h }, [vanillaDeck(DECK_SIZE, 1), p2Deck])).state;
    state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });

    const hand = state.players.p2.hand.map((c) => c.defId);
    expect(hand).toHaveLength(5);
    expect(hand).toContain(goingLong.id);
    expect(hand).toContain(heroicPower.id);
    expect(state.players.p2.library).toHaveLength(h.deckSize - 5);
  });

  it("R182 B4: the Hard seat's mulligan returns and redraws its whole five-card hand per §2.1", () => {
    let state = beginGame(game("r182-mulligan", { p2: AI_DIFFICULTY.hard })).state;
    state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });

    const before = state.players.p2.hand.map((c) => c.id);
    expect(before).toHaveLength(5);
    const keep = [before[0] as string];
    const returned = before.slice(1);

    state = act(state, { type: "mulligan", keep, playerId: "p2" });
    const after = state.players.p2.hand.map((c) => c.id);
    // The turn has begun (p1's), so p2's hand is exactly its redrawn opening hand.
    expect(state.active).toBe("p1");
    expect(after).toHaveLength(5);
    expect(after).toContain(keep[0]);
    for (const id of returned) {
      expect(after).not.toContain(id);
      expect(state.players.p2.library.some((c) => c.id === id)).toBe(true);
    }
    expect(state.players.p2.library).toHaveLength(AI_DIFFICULTY.hard.deckSize - 5);
  });
});

// ---------------------------------------------------------------------------
// R183: extra draws per turn.
// ---------------------------------------------------------------------------

describe("R183 extra draws per turn", () => {
  it("R183 B5: a Hard seat's turn start makes two draws and its hand grows by 2; the human draws one", () => {
    let state = started("r183-two", { p2: AI_DIFFICULTY.hard });
    const handBefore = state.players.p2.hand.length;
    const libraryBefore = state.players.p2.library.length;

    const p2Turn = passTurn(state);
    state = p2Turn.state;
    expect(drawnBy(p2Turn.events, "p2")).toHaveLength(DRAWS_PER_TURN + 1);
    expect(state.players.p2.hand).toHaveLength(handBefore + 2);
    expect(state.players.p2.library).toHaveLength(libraryBefore - 2);

    const p1HandBefore = state.players.p1.hand.length;
    const p1Turn = passTurn(state);
    expect(drawnBy(p1Turn.events, "p1")).toHaveLength(DRAWS_PER_TURN);
    expect(p1Turn.state.players.p1.hand).toHaveLength(p1HandBefore + 1);
  });

  it("R183 B5: a Medium seat still draws one card a turn", () => {
    const state = started("r183-medium", { p2: AI_DIFFICULTY.medium });
    const handBefore = state.players.p2.hand.length;
    const p2Turn = passTurn(state);
    expect(drawnBy(p2Turn.events, "p2")).toHaveLength(1);
    expect(p2Turn.state.players.p2.hand).toHaveLength(handBefore + 1);
  });

  it("R183 B5: from an empty library the Hard seat's two draws are two fatigue steps, N then N + 1", () => {
    const state = started("r183-fatigue", { p2: AI_DIFFICULTY.hard });
    state.players.p2.library = [];
    state.players.p2.fatigueCount = 2;
    const handBefore = state.players.p2.hand.length;

    const p2Turn = passTurn(state);
    const hits = eventsOfType(p2Turn.events, "damage")
      .filter((event) => event.targetId === "hero-p2")
      .map((event) => event.amount);
    expect(hits).toEqual([3, 4]);
    expect(p2Turn.state.players.p2.fatigueCount).toBe(4);
    expect(p2Turn.state.players.p2.hero.health).toBe(HERO_HEALTH - 7);
    expect(drawnBy(p2Turn.events, "p2")).toEqual([]);
    expect(p2Turn.state.players.p2.hand).toHaveLength(handBefore);
  });

  it("R183 B5: a Medium seat with an empty library takes a single fatigue step", () => {
    const state = started("r183-medium-fatigue", { p2: AI_DIFFICULTY.medium });
    state.players.p2.library = [];
    const p2Turn = passTurn(state);
    const hits = eventsOfType(p2Turn.events, "damage")
      .filter((event) => event.targetId === "hero-p2")
      .map((event) => event.amount);
    expect(hits).toEqual([1]);
    expect(p2Turn.state.players.p2.fatigueCount).toBe(1);
    expect(p2Turn.state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
  });

  it("R183 B5: Easy seats draw exactly one card each turn, on both sides", () => {
    let state = started("r183-easy", { p1: AI_DIFFICULTY.easy, p2: AI_DIFFICULTY.easy });
    for (let turn = 0; turn < 4; turn += 1) {
      const next = passTurn(state);
      expect(drawnBy(next.events, next.state.active), `turn ${next.state.turn}`).toHaveLength(1);
      state = next.state;
    }
  });

  it("R183 B5: each of the Hard seat's draws makes its own hand-cap check", () => {
    const state = started("r183-hand-cap", { p2: AI_DIFFICULTY.hard });
    while (state.players.p2.hand.length < HAND_CAP - 1) {
      state.players.p2.hand.push(newInstance(state, "fx-40", "p2", { z: "hand", player: "p2" }));
    }

    const drawnBefore = state.counters.drawn;
    const p2Turn = passTurn(state);
    // Two draws were made (R55's counter), the first filled the hand and the second burned (R4).
    expect(p2Turn.state.counters.drawn - drawnBefore).toBe(2);
    expect(eventsOfType(p2Turn.events, "burned").filter((e) => e.owner === "p2")).toHaveLength(1);
    expect(p2Turn.state.players.p2.hand).toHaveLength(HAND_CAP);
  });

  it("R183 B6: a cast-on-draw card met by the first draw runs its chain before the second draw", () => {
    const state = started("r183-chain", { p2: AI_DIFFICULTY.hard });
    const [quiet, first, second] = onTopOfLibrary(state, "p2", [quietOnDraw.id, "fx-35", "fx-36"]);
    const handBefore = state.players.p2.hand.length;

    const p2Turn = passTurn(state);
    const order = p2Turn.events.flatMap((event, at) => {
      if (event.type === "drawn" && event.player === "p2") return [{ at, what: `drawn:${event.instanceId}` }];
      if (event.type === "cardPlayed" && event.instanceId === quiet?.id) return [{ at, what: "cast" }];
      return [];
    });
    expect(order.map((entry) => entry.what)).toEqual([
      `drawn:${quiet?.id}`,
      "cast",
      `drawn:${first?.id}`,
      `drawn:${second?.id}`,
    ]);
    const hand = p2Turn.state.players.p2.hand.map((c) => c.id);
    expect(hand).toContain(first?.id);
    expect(hand).toContain(second?.id);
    expect(hand).not.toContain(quiet?.id);
    expect(hand).toHaveLength(handBefore + 2);
    expect(p2Turn.state.phase).toBe("main");
    expect(p2Turn.state.work).toEqual([]);
  });

  it("R183 B6: a prompt opened by the first draw owes the second draw, and the answer makes it", () => {
    const state = started("r183-prompt", { p2: AI_DIFFICULTY.hard });
    const [ask, first, second] = onTopOfLibrary(state, "p2", [askOnDraw.id, "fx-35", "fx-36"]);
    const handBefore = state.players.p2.hand.map((c) => c.id);

    const paused = passTurn(state);
    // The first draw cast the asker and stopped: nothing further was drawn.
    expect(paused.state.pending?.playerId).toBe("p2");
    expect(drawnBy(paused.events, "p2")).toEqual([ask?.id]);
    expect(paused.state.players.p2.library.slice(0, 2).map((c) => c.id)).toEqual([first?.id, second?.id]);
    expect(paused.state.players.p2.hand.map((c) => c.id)).toEqual(handBefore);
    // R183 and R158: the second whole draw is owed on state.work, as plain data.
    const owed = owedWork(paused.state, DRAW_COUNT_WORK);
    expect(owed).toHaveLength(1);
    expect(owedDrawCountOf((owed[0] as (typeof owed)[number]).resume)).toEqual({ player: "p2", count: 1 });

    const pending = paused.state.pending;
    if (pending === null) throw new Error("expected the cast-on-draw prompt");
    const answered = step(roundTrip(paused.state), {
      type: "answer",
      choiceId: pending.id,
      selection: [{ pick: "none" }],
      playerId: "p2",
    });

    // The rest of the first draw's chain, then the second draw: both cards, once each.
    expect(drawnBy(answered.events, "p2")).toEqual([first?.id, second?.id]);
    const hand = answered.state.players.p2.hand.map((c) => c.id);
    expect(hand).toContain(first?.id);
    expect(hand).toContain(second?.id);
    expect(hand).toHaveLength(handBefore.length + 2);
    expect(answered.state.pending).toBeNull();
    expect(answered.state.phase).toBe("main");
    expect(answered.state.active).toBe("p2");
    expect(answered.state.work).toEqual([]);
  });

  it("R183 B6: the owed draw is made once: a repeated or second answer draws nothing more", () => {
    const state = started("r183-prompt-once", { p2: AI_DIFFICULTY.hard });
    onTopOfLibrary(state, "p2", [askOnDraw.id, "fx-35", "fx-36", "fx-37"]);
    const paused = passTurn(state).state;
    const pending = paused.pending;
    if (pending === null) throw new Error("expected the cast-on-draw prompt");

    const answer: Action = {
      type: "answer",
      choiceId: pending.id,
      selection: [{ pick: "none" }],
      playerId: "p2",
      nonce: "r183-once-answer",
    };
    const first = reduce(paused, answer);
    expect(first.error).toBeUndefined();
    const hand = first.state.players.p2.hand.map((c) => c.id);
    const library = first.state.players.p2.library.map((c) => c.id);

    // The same submission again (same nonce) is deduplicated: nothing changes.
    const repeated = reduce(first.state, answer);
    expect(repeated.error).toBeUndefined();
    expect(repeated.state.players.p2.hand.map((c) => c.id)).toEqual(hand);
    expect(repeated.state.players.p2.library.map((c) => c.id)).toEqual(library);

    // A fresh answer to the closed prompt is refused, and draws nothing.
    const second = reduce(first.state, { ...answer, nonce: "r183-once-again" });
    expect(second.error).toBeDefined();
    expect(second.state.players.p2.hand.map((c) => c.id)).toEqual(hand);
    expect(second.state.players.p2.library.map((c) => c.id)).toEqual(library);
  });
});

// ---------------------------------------------------------------------------
// R184: the deck size of a handicapped seat.
// ---------------------------------------------------------------------------

describe("R184 deck size for a handicapped seat", () => {
  it("R184 B2: a Hard p2 takes a 30-card distinct, token-free deck; a Medium p2 a 25-card one", () => {
    const hard = game("r184-hard", { p2: AI_DIFFICULTY.hard }, [vanillaDeck(DECK_SIZE, 1), vanillaDeck(30, 1)]);
    expect(hard.players.p2.library).toHaveLength(30);
    expect(hard.players.p1.library).toHaveLength(DECK_SIZE);

    const medium = game("r184-medium", { p2: AI_DIFFICULTY.medium }, [vanillaDeck(DECK_SIZE, 1), vanillaDeck(25, 1)]);
    expect(medium.players.p2.library).toHaveLength(25);
  });

  it("R184 B2: a Hard p2 with a 20-card deck is refused, naming the seat and its handicap", () => {
    registerAll();
    expect(() =>
      createGame({
        seed: "r184-short",
        decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 1)],
        handicaps: { p2: AI_DIFFICULTY.hard },
      }),
    ).toThrow(/p2: deck must hold exactly 30 cards \(its handicap, R184\)/);
  });

  it("R184 B2: one card short or over is refused for a Hard p2", () => {
    registerAll();
    for (const size of [29, 31]) {
      expect(
        () =>
          createGame({
            seed: `r184-${size}`,
            decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(size, 1)],
            handicaps: { p2: AI_DIFFICULTY.hard },
          }),
        `${size} cards`,
      ).toThrow(/p2: deck must hold exactly 30 cards/);
    }
  });

  it("R184 B2: a card missing from the catalog in the Hard deck is refused, naming the seat", () => {
    registerAll();
    const withGhost = [...vanillaDeck(29, 1), "fx-does-not-exist"];
    expect(() =>
      createGame({
        seed: "r184-ghost",
        decks: [vanillaDeck(DECK_SIZE, 1), withGhost],
        handicaps: { p2: AI_DIFFICULTY.hard },
      }),
    ).toThrow(/p2.*not in the catalog \(§9.4 L6\)/);
  });

  it("R184 B2: an Easy handicap keeps the 20-card rule, so a 25-card deck is refused with §2.6's message", () => {
    registerAll();
    expect(() =>
      createGame({
        seed: "r184-easy",
        decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(25, 1)],
        handicaps: { p2: AI_DIFFICULTY.easy },
      }),
    ).toThrow(/p2: deck must hold exactly 20 cards \(§2.6 L2\)/);
  });

  it("R184 B2: a Medium p1 takes 25 cards while the human p2 is still held to 20", () => {
    const state = game("r184-medium-p1", { p1: AI_DIFFICULTY.medium }, [vanillaDeck(25, 1), vanillaDeck(DECK_SIZE, 1)]);
    expect(state.players.p1.library).toHaveLength(25);
    expect(state.players.p2.library).toHaveLength(DECK_SIZE);

    registerAll();
    expect(() =>
      createGame({
        seed: "r184-medium-p1-bad",
        decks: [vanillaDeck(25, 1), vanillaDeck(25, 1)],
        handicaps: { p1: AI_DIFFICULTY.medium },
      }),
    ).toThrow(/p2: deck must hold exactly 20 cards \(§2.6 L2\)/);
  });

  it("R184 B2: a Medium p2 with a 30-card deck is refused", () => {
    registerAll();
    expect(() =>
      createGame({
        seed: "r184-long",
        decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(30, 1)],
        handicaps: { p2: AI_DIFFICULTY.medium },
      }),
    ).toThrow(/p2: deck must hold exactly 25 cards/);
  });

  it("R184 B2: the unhandicapped p1 is still held to 20, with §2.6's own message", () => {
    registerAll();
    expect(() =>
      createGame({
        seed: "r184-p1",
        decks: [vanillaDeck(30, 1), vanillaDeck(30, 1)],
        handicaps: { p2: AI_DIFFICULTY.hard },
      }),
    ).toThrow(/p1: deck must hold exactly 20 cards \(§2.6 L2\)/);
  });

  it("R184 B2: a duplicate id in the Hard deck is refused, naming the seat", () => {
    registerAll();
    const withDuplicate = [...vanillaDeck(29, 1), "fx-1"];
    expect(() =>
      createGame({
        seed: "r184-dup",
        decks: [vanillaDeck(DECK_SIZE, 1), withDuplicate],
        handicaps: { p2: AI_DIFFICULTY.hard },
      }),
    ).toThrow(/p2.*appears twice.*§2.6 L3/);
  });

  it("R184 B2: a Token card in the Hard deck is refused, naming the seat", () => {
    registerAll();
    const withToken = [...vanillaDeck(29, 1), tokenDef("rush").id];
    expect(() =>
      createGame({
        seed: "r184-token",
        decks: [vanillaDeck(DECK_SIZE, 1), withToken],
        handicaps: { p2: AI_DIFFICULTY.hard },
      }),
    ).toThrow(/p2.*is a Token card.*§2.6 L3/);
  });

  it("R184 B2: validateDeck holds any size exactly: one card for a size of 1, none refused", () => {
    const catalog = vanillaCatalog();
    expect(() => validateDeck(["fx-1"], catalog, "p2", 1)).not.toThrow();
    expect(() => validateDeck([], catalog, "p2", 1)).toThrow(/p2/);
    expect(() => validateDeck(["fx-1", "fx-2"], catalog, "p2", 1)).toThrow(/p2/);
  });

  it("R184 B2: validateDeck keeps §2.6's message byte-identical at DECK_SIZE and names R184 at any other size", () => {
    const catalog = vanillaCatalog();
    expect(() => validateDeck(vanillaDeck(DECK_SIZE, 1), catalog, "p1")).not.toThrow();
    expect(() => validateDeck(vanillaDeck(DECK_SIZE, 1), catalog, "p1", DECK_SIZE)).not.toThrow();
    expect(() => validateDeck(vanillaDeck(30, 1), catalog, "p2", 30)).not.toThrow();

    let viaValidate = "";
    try {
      validateDeck(vanillaDeck(19, 1), catalog, "p1");
    } catch (error) {
      viaValidate = (error as Error).message;
    }
    let viaCreate = "";
    try {
      createGame({ seed: "r184-msg", decks: [vanillaDeck(19, 1), vanillaDeck(DECK_SIZE, 21)], catalog });
    } catch (error) {
      viaCreate = (error as Error).message;
    }
    expect(viaValidate).toMatch(/exactly 20 cards \(§2.6 L2\)/);
    expect(viaValidate).not.toMatch(/R184/);
    expect(viaCreate).toBe(viaValidate);

    expect(() => validateDeck(vanillaDeck(25, 1), catalog, "p2", 30)).toThrow(
      /p2: deck must hold exactly 30 cards \(its handicap, R184\)/,
    );
    expect(() => validateDeck(vanillaDeck(30, 1), catalog, "p2")).toThrow(/exactly 20 cards \(§2.6 L2\)/);
  });
});

// ---------------------------------------------------------------------------
// R290: the tutorial's handicap, the one below Easy.
// ---------------------------------------------------------------------------

/** The five fields every handicap has; `heroHealth` (R290) is the optional sixth. */
const FIVE_FIELDS = ["deckSize", "manaBonus", "manaCap", "extraOpeningCards", "extraDrawsPerTurn"] as const;

/** The tutorial hero's starting health, read through the engine's own rule. */
const TUTORIAL_HEALTH = startingHeroHealth(AI_TUTORIAL);

/** AI_TUTORIAL without its heroHealth: what a fold that forgot the field would be given. */
function withoutHeroHealth(handicap: Handicap): Handicap {
  const { heroHealth: _heroHealth, ...rest } = handicap;
  return rest;
}

describe("R290 the tutorial handicap (AI_TUTORIAL)", () => {
  it("R290 AI_TUTORIAL is a 12-card deck, at most 3 mana, a 20-health hero and nothing extra, and a valid handicap", () => {
    expect(AI_TUTORIAL).toEqual({
      deckSize: 12,
      manaBonus: 0,
      manaCap: 3,
      extraOpeningCards: 0,
      extraDrawsPerTurn: 0,
      heroHealth: 20,
    });
    expect(TUTORIAL_HEALTH).toBe(20);
    expect(() => validateHandicap(AI_TUTORIAL, "p2")).not.toThrow();
    expect(() => validateHandicap(AI_TUTORIAL, "p1")).not.toThrow();
  });

  it("R290 AI_TUTORIAL is no practice tier: not in DIFFICULTIES, not a key of AI_DIFFICULTY, equal to none of them", () => {
    expect([...DIFFICULTIES]).toEqual(["easy", "medium", "hard"]);
    expect(Object.keys(AI_DIFFICULTY).sort()).toEqual(["easy", "hard", "medium"]);
    expect(Object.keys(AI_DIFFICULTY)).not.toContain("tutorial");
    expect(Object.values(AI_DIFFICULTY)).not.toContain(AI_TUTORIAL);
    for (const difficulty of DIFFICULTIES) {
      expect(AI_DIFFICULTY[difficulty], difficulty).not.toEqual(AI_TUTORIAL);
      // The three tiers never set the field, so they start at HERO_HEALTH (SPEC §9.9's table).
      expect(Object.keys(AI_DIFFICULTY[difficulty]), difficulty).not.toContain("heroHealth");
      expect(startingHeroHealth(AI_DIFFICULTY[difficulty]), difficulty).toBe(HERO_HEALTH);
    }
    expect(Object.keys(HUMAN_HANDICAP)).not.toContain("heroHealth");
    expect(startingHeroHealth(HUMAN_HANDICAP)).toBe(HERO_HEALTH);
    expect(startingHeroHealth(undefined)).toBe(HERO_HEALTH);
  });

  it("R290 AI_TUTORIAL is below a human's resources: every field at or under Easy's, and the three it changes strictly under", () => {
    expect(AI_TUTORIAL.deckSize).toBeLessThan(DECK_SIZE);
    expect(AI_TUTORIAL.manaCap).toBeLessThan(MAX_MANA);
    expect(TUTORIAL_HEALTH).toBeLessThan(HERO_HEALTH);
    expect(AI_TUTORIAL.manaBonus).toBe(0);
    expect(AI_TUTORIAL.extraOpeningCards).toBe(0);
    expect(AI_TUTORIAL.extraDrawsPerTurn).toBe(0);

    const changed: string[] = [];
    for (const field of FIVE_FIELDS) {
      expect(AI_TUTORIAL[field], field).toBeLessThanOrEqual(HUMAN_HANDICAP[field]);
      if (AI_TUTORIAL[field] !== HUMAN_HANDICAP[field]) changed.push(field);
    }
    expect(TUTORIAL_HEALTH).toBeLessThanOrEqual(startingHeroHealth(HUMAN_HANDICAP));
    if (TUTORIAL_HEALTH !== startingHeroHealth(HUMAN_HANDICAP)) changed.push("heroHealth");
    expect(changed).toEqual(["deckSize", "manaCap", "heroHealth"]);
    // Easy is a human's resources exactly (R180), so "below a human" is "below Easy".
    expect(AI_DIFFICULTY.easy).toEqual(HUMAN_HANDICAP);
  });

  it("R290 createGame: a tutorial p2 takes 12 cards and its hero starts at 20, stored as a copy; p1 keeps HERO_HEALTH", () => {
    const state = game("r290-create", { p2: AI_TUTORIAL });
    expect(state.players.p2.library).toHaveLength(AI_TUTORIAL.deckSize);
    expect(state.players.p1.library).toHaveLength(DECK_SIZE);
    expect(state.players.p2.hero).toEqual({ health: TUTORIAL_HEALTH, armor: 0 });
    expect(state.players.p1.hero).toEqual({ health: HERO_HEALTH, armor: 0 });

    expect(state.players.p2.handicap).toEqual(AI_TUTORIAL);
    expect(state.players.p2.handicap).not.toBe(AI_TUTORIAL);
    expect(Object.keys(state.players.p1)).not.toContain("handicap");
    expect(handicapOf(state.players.p2)).toEqual(AI_TUTORIAL);
    expect(handicapOf(state.players.p1)).toEqual(HUMAN_HANDICAP);
    // The stored copy survives the JSON round trip a paused or restarted match takes.
    expect(roundTrip(state).players.p2.handicap).toEqual(AI_TUTORIAL);
    expect(hashState(roundTrip(state))).toBe(hashState(state));

    // The setup and the mulligans do not reset it, and both seats' views show it.
    const begun = started("r290-create", { p2: AI_TUTORIAL });
    expect(begun.players.p2.hero.health).toBe(TUTORIAL_HEALTH);
    expect(begun.players.p1.hero.health).toBe(HERO_HEALTH);
    expect(viewFor(begun, "p1").opponent.hero.health).toBe(TUTORIAL_HEALTH);
    expect(viewFor(begun, "p1").you.hero.health).toBe(HERO_HEALTH);
    expect(viewFor(begun, "p2").you.hero.health).toBe(TUTORIAL_HEALTH);
  });

  it("R290 createGame: a tutorial p1 is the same, and the p2 human keeps HERO_HEALTH and its 20 cards", () => {
    const state = game("r290-create-p1", { p1: AI_TUTORIAL });
    expect(state.players.p1.library).toHaveLength(AI_TUTORIAL.deckSize);
    expect(state.players.p2.library).toHaveLength(DECK_SIZE);
    expect(state.players.p1.hero.health).toBe(TUTORIAL_HEALTH);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(state.players.p1.handicap).toEqual(AI_TUTORIAL);
    expect(Object.keys(state.players.p2)).not.toContain("handicap");
  });

  it("R290 a tutorial seat's deck is held to exactly 12 (R184): 20, 11 or 13 cards are refused, and the human is still held to 20", () => {
    registerAll();
    for (const size of [DECK_SIZE, AI_TUTORIAL.deckSize - 1, AI_TUTORIAL.deckSize + 1]) {
      expect(
        () =>
          createGame({
            seed: `r290-deck-${size}`,
            decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(size, 1)],
            handicaps: { p2: AI_TUTORIAL },
          }),
        `${size} cards`,
      ).toThrow(/p2: deck must hold exactly 12 cards \(its handicap, R184\)/);
    }
    expect(() =>
      createGame({
        seed: "r290-deck-human",
        decks: [vanillaDeck(AI_TUTORIAL.deckSize, 1), vanillaDeck(AI_TUTORIAL.deckSize, 1)],
        handicaps: { p2: AI_TUTORIAL },
      }),
    ).toThrow(/p1: deck must hold exactly 20 cards \(§2.6 L2\)/);
  });

  it("R290 heroHealth absent or equal to HERO_HEALTH stores nothing: a human's handicap with heroHealth 30 hashes like the plain game", () => {
    const decks = decksFor();
    const plain = game("r290-human", undefined, decks);
    const variants: Handicaps[] = [
      { p2: { ...HUMAN_HANDICAP, heroHealth: HERO_HEALTH } },
      { p1: { ...HUMAN_HANDICAP, heroHealth: HERO_HEALTH } },
      { p1: { ...AI_DIFFICULTY.easy, heroHealth: HERO_HEALTH }, p2: { ...HUMAN_HANDICAP, heroHealth: HERO_HEALTH } },
    ];
    for (const handicaps of variants) {
      const label = JSON.stringify(handicaps);
      const state = game("r290-human", handicaps, decks);
      for (const player of PLAYER_IDS) {
        expect(Object.keys(state.players[player]), `${label}: ${player}`).not.toContain("handicap");
        expect(handicapOf(state.players[player]), `${label}: ${player}`).toEqual(HUMAN_HANDICAP);
        expect(state.players[player].hero.health, `${label}: ${player}`).toBe(HERO_HEALTH);
      }
      expect(hashState(state), label).toBe(hashState(plain));
      expect(hashState(beginGame(state).state), label).toBe(hashState(beginGame(plain).state));
    }
  });

  it("R290 Medium and Hard store the five fields and no heroHealth key, and a heroHealth of 30 added to them changes nothing", () => {
    for (const difficulty of ["medium", "hard"] as const) {
      const h = AI_DIFFICULTY[difficulty];
      const decks = decksFor({ p2: h });
      const tier = game(`r290-${difficulty}`, { p2: h }, decks);
      expect(Object.keys(tier.players.p2.handicap ?? {}).sort(), difficulty).toEqual([...FIVE_FIELDS].sort());
      expect(tier.players.p2.handicap, difficulty).toEqual(h);
      expect(tier.players.p2.hero.health, difficulty).toBe(HERO_HEALTH);

      const explicit = game(`r290-${difficulty}`, { p2: { ...h, heroHealth: HERO_HEALTH } }, decks);
      expect(Object.keys(explicit.players.p2.handicap ?? {}).sort(), difficulty).toEqual([...FIVE_FIELDS].sort());
      expect(explicit.players.p2.handicap, difficulty).toEqual(h);
      expect(hashState(explicit), difficulty).toBe(hashState(tier));
      expect(hashState(beginGame(explicit).state), difficulty).toBe(hashState(beginGame(tier).state));
    }
  });

  it("R290 a heroHealth other than 30 is stored beside the other fields, even on a handicap that is otherwise a human's", () => {
    const decks = decksFor();
    const plain = game("r290-only-health", undefined, decks);
    const onlyHealth: Handicap = { ...HUMAN_HANDICAP, heroHealth: TUTORIAL_HEALTH };
    const state = game("r290-only-health", { p2: onlyHealth }, decks);
    expect(state.players.p2.handicap).toEqual(onlyHealth);
    expect(state.players.p2.hero.health).toBe(TUTORIAL_HEALTH);
    expect(hashState(state)).not.toBe(hashState(plain));

    const mediumAt25: Handicap = { ...AI_DIFFICULTY.medium, heroHealth: 25 };
    const medium = game("r290-medium-25", { p2: mediumAt25 });
    expect(medium.players.p2.handicap).toEqual(mediumAt25);
    expect(medium.players.p2.hero.health).toBe(25);
  });

  it("R290 validateHandicap refuses a heroHealth that is not a positive integer and accepts 1 and 20", () => {
    const bad: unknown[] = [0, -1, 2.5, Number.NaN, Number.POSITIVE_INFINITY, "20", null];
    for (const heroHealth of bad) {
      const handicap = { ...AI_TUTORIAL, heroHealth } as unknown as Handicap;
      expect(() => validateHandicap(handicap, "p2"), String(heroHealth)).toThrow(
        /p2: handicap heroHealth must be a positive integer \(R290\)/,
      );
    }
    expect(() => validateHandicap({ ...AI_TUTORIAL, heroHealth: 1 }, "p2")).not.toThrow();
    expect(() => validateHandicap({ ...AI_TUTORIAL, heroHealth: 20 }, "p2")).not.toThrow();
    expect(() => validateHandicap(withoutHeroHealth(AI_TUTORIAL), "p2")).not.toThrow();
  });

  it("R290 createGame refuses an invalid heroHealth before it looks at the deck", () => {
    registerAll();
    for (const heroHealth of [0, -1, 2.5]) {
      expect(
        () =>
          createGame({
            seed: "r290-bad-health",
            // A 20-card p2 deck is wrong for AI_TUTORIAL too; the handicap is named first (R180).
            decks: [vanillaDeck(DECK_SIZE, 1), vanillaDeck(DECK_SIZE, 1)],
            handicaps: { p2: { ...AI_TUTORIAL, heroHealth } },
          }),
        String(heroHealth),
      ).toThrow(/p2: handicap heroHealth must be a positive integer \(R290\)/);
    }
    expect(() =>
      createGame({
        seed: "r290-bad-health-p1",
        decks: [vanillaDeck(AI_TUTORIAL.deckSize, 1), vanillaDeck(DECK_SIZE, 1)],
        handicaps: { p1: { ...AI_TUTORIAL, heroHealth: 0 } },
      }),
    ).toThrow(/p1: handicap heroHealth/);
  });

  it("R290 maxManaFor a tutorial seat is min(turns started, 3): it never exceeds 3, and the human's is §2.3's", () => {
    const state = game("r290-mana-unit", { p2: AI_TUTORIAL });
    for (let turns = 0; turns <= 12; turns += 1) {
      state.players.p2.turnsStarted = turns;
      state.players.p1.turnsStarted = turns;
      expect(maxManaFor(state.players.p2), `tutorial after ${turns} turns`).toBe(Math.min(turns, AI_TUTORIAL.manaCap));
      expect(maxManaFor(state.players.p2), `tutorial after ${turns} turns`).toBeLessThanOrEqual(AI_TUTORIAL.manaCap);
      expect(maxManaFor(state.players.p1), `human after ${turns} turns`).toBe(Math.min(turns, MAX_MANA));
    }
  });

  it("R290 a tutorial seat refreshes to 1, 2, 3, 3 on its first four turns, as p2 or p1, while the human reaches 4", () => {
    const asP2 = maxesByTurn("r290-mana", { p2: AI_TUTORIAL }, 12);
    expect(asP2.p2).toEqual([1, 2, 3, 3, 3, 3]);
    expect(asP2.p1).toEqual([1, 2, 3, 4, 4, 4]);

    const asP1 = maxesByTurn("r290-mana-p1", { p1: AI_TUTORIAL }, 12);
    expect(asP1.p1).toEqual([1, 2, 3, 3, 3, 3]);
    expect(asP1.p2).toEqual([1, 2, 3, 4, 4, 4]);

    const fourth = advanceTo(started("r290-mana-current", { p2: AI_TUTORIAL }), "p2", 4);
    expect(fourth.players.p2.mana).toMatchObject({ max: 3, current: 3 });
  });

  it("R290 fold with AI_TUTORIAL reproduces a tutorial random-policy game, whose tutorial seat never had more than 3 max mana", { timeout: 120_000 }, () => {
    const cases: [string, Handicaps, PlayerId][] = [
      ["r290-fold-p2", { p2: AI_TUTORIAL }, "p2"],
      ["r290-fold-p1", { p1: AI_TUTORIAL }, "p1"],
    ];
    for (const [seed, handicaps, seat] of cases) {
      let highest = 0;
      const live = playRandom(seed, handicaps, (state) => {
        highest = Math.max(highest, state.players[seat].mana.max);
      });
      expect(highest, `${seed}: the tutorial seat reached its cap`).toBe(AI_TUTORIAL.manaCap);
      expect(live.decks[seat === "p1" ? 0 : 1], seed).toHaveLength(AI_TUTORIAL.deckSize);

      registerAll();
      const replayed = fold({ seed, decks: live.decks, log: live.log, handicaps });
      expect(replayed.errors, seed).toEqual([]);
      expect(hashState(replayed.state), seed).toBe(hashState(live.state));
      expect(replayed.state.result, seed).toEqual(live.state.result);
    }
  });

  it("R290 the same fold without the handicap throws on the 12-card deck, and without heroHealth it does not reproduce the game", { timeout: 120_000 }, () => {
    const seed = "r290-fold-missing";
    const live = playRandom(seed, { p2: AI_TUTORIAL });
    registerAll();
    expect(() => fold({ seed, decks: live.decks, log: live.log })).toThrow(/p2: deck must hold exactly 20/);

    const forgot = fold({ seed, decks: live.decks, log: live.log, handicaps: { p2: withoutHeroHealth(AI_TUTORIAL) } });
    const same = forgot.errors.length === 0 && hashState(forgot.state) === hashState(live.state);
    expect(same).toBe(false);
  });

  it("R290 a tutorial hero at 20 dies at 0 like any hero: a 20-point fatigue hit ends the game, a 19-point one leaves it at 1", () => {
    // p2's library is empty, so its turn-start draw is a fatigue step of fatigueCount + 1 (R183's
    // fatigue test reads the same rule): fatigueCount 19 makes the hit 20.
    const lethal = started("r290-death", { p2: AI_TUTORIAL });
    lethal.players.p2.library = [];
    lethal.players.p2.fatigueCount = TUTORIAL_HEALTH - 1;
    const ended = step(lethal, { type: "endTurn", playerId: "p1" });
    const hits = eventsOfType(ended.events, "damage")
      .filter((event) => event.targetId === "hero-p2")
      .map((event) => event.amount);
    expect(hits).toEqual([TUTORIAL_HEALTH]);
    expect(ended.state.players.p2.hero.health).toBe(0);
    expect(ended.state.result).toEqual({ winner: "p1", reason: "hero-death" });
    expect(eventsOfType(ended.events, "gameOver")).toHaveLength(1);

    const survives = started("r290-death", { p2: AI_TUTORIAL });
    survives.players.p2.library = [];
    survives.players.p2.fatigueCount = TUTORIAL_HEALTH - 2;
    const alive = passTurn(survives).state;
    expect(alive.players.p2.hero.health).toBe(1);
    expect(alive.result).toBeNull();
    expect(alive.active).toBe("p2");

    // The same 20-point hit on a human's hero leaves it at 10: the tutorial hero's 20 is what ended it.
    const human = started("r290-death", undefined);
    human.players.p2.library = [];
    human.players.p2.fatigueCount = TUTORIAL_HEALTH - 1;
    const humanAfter = passTurn(human).state;
    expect(humanAfter.players.p2.hero.health).toBe(HERO_HEALTH - TUTORIAL_HEALTH);
    expect(humanAfter.result).toBeNull();
  });

  it("R290 20 is where the tutorial hero starts, not a cap: a heal takes it past 20, and a heal up to 30 lifts it to 30", () => {
    const state = started("r290-heal", { p2: AI_TUTORIAL });
    const sink = { state, events: [] as GameEvent[] };
    // §3: a hero has no maximum health, so nothing holds the tutorial hero at its starting 20.
    expect(healHero(sink, "p2", 5)).toBe(5);
    expect(state.players.p2.hero.health).toBe(TUTORIAL_HEALTH + 5);
    // "Heal up to N" (#53 Reno's 30) raises the hero to N whatever it started at.
    expect(healHeroUpTo(sink, "p2", HERO_HEALTH)).toBe(HERO_HEALTH - TUTORIAL_HEALTH - 5);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    // The stored handicap is untouched by either: its heroHealth records where the hero started.
    expect(state.players.p2.handicap).toEqual(AI_TUTORIAL);
  });
});
