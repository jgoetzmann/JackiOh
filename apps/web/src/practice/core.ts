// The practice game itself: the one `GameState`, both seats' actions and the AI (SPEC §9.9, R187).
//
// This is the ONLY practice file that imports `@jackioh/engine`, `@jackioh/cards` or `@jackioh/ai`,
// and only two things load it: the worker entry (`practice.worker.ts`) and the in-thread host that
// jsdom tests use (`host.ts`). The page never does. That is the whole of rule 7 here: the state,
// both hands and both libraries live on this side of `handle`, and what crosses it is a
// `PracticeSnapshot` — `viewFor(state, human)`, the human's `legalActions`, whether the AI owes an
// action, and the engine's refusal of the human's last action. The worker stands where §9.1 puts
// the server.
//
// Nonces: `h<n>` for the human's accepted actions and `a<n>` for the AI's, each counting only
// actions the engine accepted, so a refused action spends nothing and the log folds exactly
// (`fold({ seed, decks, handicaps, log })`, R187). The AI draws from its own stream,
// `createRng(`${seed}:ai`)`, kept for the whole game; the match rng in state is never touched by it.

import { registerAll } from "@jackioh/cards";
import {
  beginGame,
  createGame,
  createRng,
  hashState,
  legalActions,
  reduce,
  registeredCatalog,
  viewFor,
  type GameState,
  type Rng,
} from "@jackioh/engine";
import { AI_DIFFICULTY, DECK_SIZE, type Handicap } from "@jackioh/engine/config";
import { AI_BUDGET, aiToAct, buildAiDeck, decide, type SearchBudget } from "@jackioh/ai";
import { opponentOf, type Action, type ActionBody, type PlayerId } from "@jackioh/shared";

import { PRACTICE_AI_CLOCK_MS } from "./config.ts";
import { presetById } from "./decks.ts";
import type {
  PracticeDebug,
  PracticeDeckChoice,
  PracticeRequest,
  PracticeResponse,
  PracticeSnapshot,
  PracticeStartConfig,
} from "./protocol.ts";

// `createGame` reads card definitions from the engine's registry, and the card scripts must be
// registered or every Cry fizzles differently than the replay does (SPEC §10.9). Idempotent.
registerAll();

export type PracticeCoreEnv = {
  /** worker: performance.now */
  now: () => number;
  /** answer `debug` only when true */
  dev: boolean;
  /** default AI_BUDGET */
  budget?: SearchBudget;
};

/** `handle` never throws: anything that goes wrong comes back as `"failed"`. */
export type PracticeCore = { handle(request: PracticeRequest): PracticeResponse };

type PracticeGame = {
  config: PracticeStartConfig;
  aiSeat: PlayerId;
  decks: [string[], string[]];
  handicaps: Partial<Record<PlayerId, Handicap>>;
  state: GameState;
  log: Action[];
  /** The AI's own stream, `${seed}:ai`, for the whole game. */
  rng: Rng;
  humanCount: number;
  aiCount: number;
  /** The engine's refusal of the human's last action, until the board moves on. */
  error: string | null;
};

/** R188: the action types the AI never takes on its own, even as a fallback. */
function isForbiddenAiAction(action: ActionBody): boolean {
  if (action.type === "concede" || action.type === "offerDraw") return true;
  return action.type === "answerDraw" && action.accept;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The human's deck: a random draw at the spec's own size, a named preset's list, or a saved
 * loadout deck. `createGame` checks a preset or a saved deck like any other (§2.6): the engine's
 * ruling, printed as given.
 */
function humanDeckFor(seed: string, choice: PracticeDeckChoice): string[] {
  switch (choice.kind) {
    case "random":
      return buildAiDeck(createRng(`${seed}:human-deck`), DECK_SIZE, { banned: [] });
    case "preset": {
      const preset = presetById(choice.id);
      if (preset === undefined) throw new Error(`unknown preset deck "${choice.id}"`);
      return [...preset.cards];
    }
    case "saved":
      return [...choice.cards];
  }
}

function startGame(config: PracticeStartConfig): PracticeGame {
  const aiSeat = opponentOf(config.humanSeat);
  const handicap = AI_DIFFICULTY[config.difficulty];

  const humanDeck = humanDeckFor(config.seed, config.deck);
  const aiDeck = buildAiDeck(createRng(`${config.seed}:ai-deck`), handicap.deckSize, { manaCap: handicap.manaCap });
  const decks: [string[], string[]] = config.humanSeat === "p1" ? [humanDeck, aiDeck] : [aiDeck, humanDeck];
  const handicaps: Partial<Record<PlayerId, Handicap>> = { [aiSeat]: { ...handicap } };

  // `createGame` throws on an illegal deck and `beginGame` reports a refusal in `error`; either way
  // there is no game, and `handle` turns the throw into "failed".
  const created = createGame({ seed: config.seed, decks, handicaps });
  const begun = beginGame(created);
  if (begun.error !== undefined) throw new Error(`the engine refused to begin the game: ${begun.error}`);

  return {
    config: { ...config },
    aiSeat,
    decks: [[...decks[0]], [...decks[1]]],
    handicaps,
    state: begun.state,
    log: [],
    rng: createRng(`${config.seed}:ai`),
    humanCount: 0,
    aiCount: 0,
    error: null,
  };
}

/** One action for a seat; null when the engine accepted it, else the engine's reason. */
function apply(game: PracticeGame, body: ActionBody, seat: PlayerId): string | null {
  const human = seat === game.config.humanSeat;
  const nonce = human ? `h${String(game.humanCount)}` : `a${String(game.aiCount)}`;
  const action = { ...body, playerId: seat, nonce } as Action;

  let result: ReturnType<typeof reduce>;
  try {
    result = reduce(game.state, action);
  } catch (cause) {
    return `the engine failed on ${body.type}: ${messageOf(cause)}`;
  }
  if (result.error !== undefined) return result.error;

  game.state = result.state;
  game.log.push(action);
  if (human) game.humanCount += 1;
  else game.aiCount += 1;
  return null;
}

function snapshotOf(game: PracticeGame): PracticeSnapshot {
  const human = game.config.humanSeat;
  return {
    view: viewFor(game.state, human),
    legal: legalActions(game.state, human),
    aiToAct: aiToAct(game.state, game.aiSeat),
    error: game.error,
  };
}

/**
 * The AI's fallback when `decide` gave nothing usable: `endTurn` when legal, else the first legal
 * action the engine accepts, never one R188 forbids.
 */
function fallbackActions(game: PracticeGame): ActionBody[] {
  const legal = legalActions(game.state, game.aiSeat).filter((action) => !isForbiddenAiAction(action));
  const endTurn = legal.filter((action) => action.type === "endTurn");
  const rest = legal.filter((action) => action.type !== "endTurn");
  return [...endTurn, ...rest];
}

export function createPracticeCore(env: PracticeCoreEnv): PracticeCore {
  const budget = env.budget ?? AI_BUDGET;
  let game: PracticeGame | null = null;

  function current(): PracticeGame {
    if (game === null) throw new Error("no practice game is running: send start first");
    return game;
  }

  /** One AI action, or nothing when the AI owes none. Throws only when no action is possible. */
  function aiStep(active: PracticeGame): void {
    if (!aiToAct(active.state, active.aiSeat)) return;

    let chosen: ActionBody | null;
    try {
      const t0 = env.now();
      const decision = decide(active.state, active.aiSeat, {
        rng: active.rng,
        budget,
        shouldStop: () => env.now() - t0 > PRACTICE_AI_CLOCK_MS,
      });
      chosen = decision?.action ?? null;
    } catch {
      // `decide` promises never to throw; if it does anyway, the fallback below still moves the game.
      chosen = null;
    }

    if (chosen !== null && !isForbiddenAiAction(chosen) && apply(active, chosen, active.aiSeat) === null) {
      active.error = null;
      return;
    }

    let lastRefusal = "no legal action";
    for (const candidate of fallbackActions(active)) {
      const refusal = apply(active, candidate, active.aiSeat);
      if (refusal === null) {
        active.error = null;
        return;
      }
      lastRefusal = refusal;
    }
    throw new Error(`the AI owes an action and the engine accepts none of its legal ones (${lastRefusal})`);
  }

  function debugOf(active: PracticeGame): PracticeDebug {
    // JSON copies: the in-thread host hands these to the caller by reference, and the live state
    // and log must not be reachable from the page.
    return {
      seed: active.config.seed,
      decks: [[...active.decks[0]], [...active.decks[1]]],
      handicaps: JSON.parse(JSON.stringify(active.handicaps)) as Partial<Record<PlayerId, Handicap>>,
      log: JSON.parse(JSON.stringify(active.log)) as Action[],
      state: JSON.parse(JSON.stringify(active.state)) as unknown,
      hash: hashState(active.state),
      difficulty: active.config.difficulty,
      humanSeat: active.config.humanSeat,
    };
  }

  function handleUnsafe(request: PracticeRequest): PracticeResponse {
    switch (request.type) {
      case "start": {
        // A start replaces whatever was running, even when it fails: no request may land on the
        // previous game after the page asked for a new one.
        game = null;
        const next = startGame(request.config);
        game = next;
        return {
          id: request.id,
          type: "started",
          snapshot: snapshotOf(next),
          defs: registeredCatalog(),
          aiSeat: next.aiSeat,
        };
      }
      case "act": {
        const active = current();
        const refusal = apply(active, request.action, active.config.humanSeat);
        active.error = refusal;
        return { id: request.id, type: "snapshot", snapshot: snapshotOf(active) };
      }
      case "aiStep": {
        const active = current();
        aiStep(active);
        return { id: request.id, type: "snapshot", snapshot: snapshotOf(active) };
      }
      case "catalog":
        // The card data the setup screen previews decks with, before any game exists (§5.1: the
        // catalog is public). The same map `started` carries.
        return { id: request.id, type: "catalog", defs: registeredCatalog() };
      case "debug": {
        if (!env.dev) return { id: request.id, type: "failed", message: "debug is available only in a development build" };
        return { id: request.id, type: "debug", debug: debugOf(current()) };
      }
    }
  }

  return {
    handle(request: PracticeRequest): PracticeResponse {
      try {
        return handleUnsafe(request);
      } catch (cause) {
        return { id: request.id, type: "failed", message: messageOf(cause) };
      }
    },
  };
}
