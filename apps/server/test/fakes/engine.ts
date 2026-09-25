/**
 * A scripted `EnginePort` for the server tests.
 *
 * WHY IT STILL EXISTS. Not because the engine is unavailable — `packages/engine` has been complete
 * since M3 closed, `viewFor` included, and `src/match/engine.real.ts` binds it (with its own tests
 * in `test/match/engine.real.test.ts`). It exists because what M6-T4 and M7 have to prove is about
 * the actor, the clock, the log and the results writer, and each of those needs a *terminal state
 * on demand*: `test-lethal` reaches `hero-death` in one action and `test-mutual-lethal`
 * `both-heroes-dead`, where the real engine would need a whole game of real cards to get there and
 * the test would then be measuring the rules. It keeps the real engine's contract exactly where the
 * server relies on it:
 *
 *  - `reduce` is pure, returns `{ state, events, error? }` and refuses illegal actions itself;
 *  - a reused nonce returns the original events and does not advance the state (SPEC §9.3);
 *  - `viewFor` shows the viewer's hand in full and the opponent's as a count (§10.8);
 *  - `fold({ seed, decks, log })` rebuilds the same state, so crash recovery is testable;
 *  - a prompt is state, answered by another action (§9.3);
 *  - with `{ mulligan: true }`, the game opens on the concurrent mulligan (R265): both seats' prompts
 *    open at once outside `pending`, either seat answers first, an answer is sealed until the other
 *    is in (R266), a `timeout` answers only the timing-out seat's own mulligan by keeping the whole
 *    hand (R268), and `snapshot().mulliganOwed` names who still owes one. Without the option the
 *    game opens straight on turn 1, which is what every test that is not about the mulligan wants.
 *
 * WHAT IT MAY NOT BE USED TO PROVE. Its `viewFor` is written here, so a test that asserts the
 * redaction against this port is asserting this file. The hidden-information claim (§10.8,
 * CLAUDE.md rule 7) is therefore made against the **real** engine, in the last `describe` of
 * `test/match/actor.test.ts`: the real port under the real actor, two disjoint decks of real §8
 * ids, and the leak scan run over the bytes the sockets received. What the fake's own leak scan
 * shows is the remaining half — that the actor and the protocol add nothing on top of a redaction.
 *
 * Scripted cards, so a test can reach a situation without the real catalog:
 *  - `test-prompt-self`   opens a prompt for the player who played it;
 *  - `test-prompt-enemy`  opens a prompt for the other player (a trap firing on your turn, R79);
 *  - `test-lethal`        ends the match: the player who played it wins by `hero-death`;
 *  - `test-mutual-lethal` ends the match: both heroes die in the same check, a draw by
 *                         `both-heroes-dead` (§2.5's second row — the one ending no other scripted
 *                         card can reach, and the seventh of the reasons `api/results.ts` writes).
 */

import type { Action, GameEvent, PlayerId, PlayerView, SideView } from "@jackioh/shared";
import type { EnginePort, EngineState, MatchSnapshot } from "../../src/match/engine";

export const FAKE_HAND_SIZE = 3;
/** Mirrors `TURN_CAP_PLAYER_TURNS` (§2.5) so a test can reach the `turn-cap` ending. */
export const FAKE_TURN_CAP = 30;

type FakeState = {
  seed: string;
  decks: [string[], string[]];
  turn: number;
  active: PlayerId;
  phase: MatchSnapshot["phase"];
  result: MatchSnapshot["result"];
  hands: Record<PlayerId, string[]>;
  libraries: Record<PlayerId, string[]>;
  played: Record<PlayerId, string[]>;
  pending: { id: string; playerId: PlayerId } | null;
  /** R265: both mulligans while they are open, each with its sealed answer (R266); null otherwise. */
  mulligan: Record<PlayerId, { id: string; keep: string[] | null }> | null;
  applied: { nonce: string; events: GameEvent[] }[];
  nextChoice: number;
};

export type FakeEngineOptions = {
  /** Open the game on both seats' mulligans (R265) instead of on turn 1. */
  mulligan?: boolean;
};

/** R265: what may be sent while both mulligans are open, as the real reducer allows. */
const MULLIGAN_OPEN_ACTIONS: readonly Action["type"][] = [
  "mulligan",
  "concede",
  "timeout",
  "disconnectExpired",
  "ceilingReached",
];

const other = (player: PlayerId): PlayerId => (player === "p1" ? "p2" : "p1");
const clone = <T>(value: T): T => structuredClone(value);

const asFake = (state: EngineState): FakeState => state as unknown as FakeState;
const asEngine = (state: FakeState): EngineState => state as unknown as EngineState;

const handIds = (fake: FakeState, player: PlayerId): string[] =>
  fake.hands[player].map((_, i) => `${player}-h${String(i)}`);

/** R265: the seats whose mulligan is open and unanswered, in seat order. */
function owedOf(fake: FakeState): PlayerId[] {
  const open = fake.mulligan;
  if (open === null) return [];
  return (["p1", "p2"] as const).filter((player) => open[player].keep === null);
}

/**
 * R265, R266: seals one seat's answer; the second answer resolves both in seat order (each
 * returned card goes to the bottom of its library and is replaced off the top, R9's order) and
 * starts turn 1.
 */
function answerMulligan(next: FakeState, player: PlayerId, keep: readonly string[], events: GameEvent[]): void {
  const open = next.mulligan;
  if (open === null) return;
  const seat = open[player];
  seat.keep = [...keep];
  events.push({ type: "promptAnswered", player, choiceId: seat.id });
  if (owedOf(next).length > 0) return;

  for (const side of ["p1", "p2"] as const) {
    const kept = new Set(open[side].keep);
    const hand = next.hands[side];
    const returned = hand.filter((_, i) => !kept.has(`${side}-h${String(i)}`));
    const stays = hand.filter((_, i) => kept.has(`${side}-h${String(i)}`));
    const drawn = next.libraries[side].splice(0, returned.length);
    next.hands[side] = [...stays, ...drawn];
    next.libraries[side].push(...returned);
  }
  next.mulligan = null;
  next.turn = 1;
  next.phase = "main";
  events.push({ type: "turnStarted", player: next.active, turn: next.turn });
}

function emptySide(player: PlayerId, fake: FakeState, viewer: PlayerId): SideView {
  const hand = fake.hands[player];
  return {
    player,
    hero: { health: 30, armor: 0, powers: [], power: null },
    // R169: `SideView.modifiers`. The fake runs no card scripts, so no modifier is ever installed.
    modifiers: [],
    mana: { current: 4, max: 4 },
    hand:
      player === viewer
        ? hand.map((defId, i) => ({
            instanceId: `${player}-h${i}`,
            defId,
            radiant: false,
            cost: 1,
          }))
        : { count: hand.length },
    libraryCount: fake.libraries[player].length,
    graveyard: fake.played[player].map((defId, i) => ({
      instanceId: `${player}-g${i}`,
      defId,
      radiant: false,
      cost: 1,
    })),
    exile: [],
    resolving: [],
    units: [null, null, null, null, null],
    backrow: [null, null, null, null, null],
    locks: { units: [false, false, false, false, false], backrow: [false, false, false, false, false] },
    reserved: { units: [false, false, false, false, false], backrow: [false, false, false, false, false] },
    fatigueCount: 0,
  };
}

export function createFakeEngine(options: FakeEngineOptions = {}): EnginePort {
  const port: EnginePort = {
    createGame: ({ seed, decks }) => {
      const state: FakeState = {
        seed,
        decks: [[...decks[0]], [...decks[1]]],
        turn: 0,
        active: "p1",
        phase: "setup",
        result: null,
        hands: { p1: [], p2: [] },
        libraries: { p1: [...decks[0]], p2: [...decks[1]] },
        played: { p1: [], p2: [] },
        pending: null,
        mulligan: null,
        applied: [],
        nextChoice: 1,
      };
      return asEngine(state);
    },

    beginGame: (state) => {
      const next = clone(asFake(state));
      const events: GameEvent[] = [];
      for (const player of ["p1", "p2"] as const) {
        next.hands[player] = next.libraries[player].splice(0, FAKE_HAND_SIZE);
        for (const [i, defId] of next.hands[player].entries()) {
          events.push({ type: "drawn", player, instanceId: `${player}-h${i}`, defId });
        }
      }
      if (options.mulligan === true) {
        // R265: both prompts open together, in seat order, and setup is nobody's turn.
        const open = { p1: { id: "", keep: null }, p2: { id: "", keep: null } } as NonNullable<
          FakeState["mulligan"]
        >;
        for (const player of ["p1", "p2"] as const) {
          open[player].id = `choice-${String(next.nextChoice)}`;
          next.nextChoice += 1;
          events.push({ type: "promptOpened", player, choiceId: open[player].id, kind: "mulligan" });
        }
        next.mulligan = open;
        next.phase = "mulligan";
        return { state: asEngine(next), events };
      }
      next.turn = 1;
      next.phase = "main";
      events.push({ type: "turnStarted", player: next.active, turn: next.turn });
      return { state: asEngine(next), events };
    },

    reduce: (state, action: Action) => {
      const current = asFake(state);
      // §9.3: a reused nonce returns the original events and does not advance the state.
      const seen = current.applied.find((entry) => entry.nonce === action.nonce);
      if (seen !== undefined) return { state, events: seen.events };
      if (current.result !== null) return { state, events: [], error: "the game is over" };

      const next = clone(current);
      const events: GameEvent[] = [];
      const player = action.playerId;

      const fail = (error: string): { state: EngineState; events: GameEvent[]; error: string } => ({
        state,
        events: [],
        error,
      });

      // R265: while both mulligans are open nothing but a mulligan and the actions that end a game
      // or answer for a clock move — whoever sends it, since setup is nobody's turn.
      if (next.pending === null && next.mulligan !== null && !MULLIGAN_OPEN_ACTIONS.includes(action.type)) {
        return fail("the mulligan is open: answer it first");
      }

      if (next.pending !== null) {
        const answering = action.type === "answer" || action.type === "mulligan";
        const terminal =
          action.type === "concede" ||
          action.type === "timeout" ||
          action.type === "disconnectExpired" ||
          action.type === "ceilingReached";
        if (!answering && !terminal) {
          // §9.1: the refusal a player gets is about their own seat. Whose turn it is outranks
          // whose prompt is open, so a player who is not the active player hears only that — the
          // open prompt is the other seat's business and never the reason they are refused.
          return fail(player === next.active ? "a prompt is open: answer it first" : "it is not your turn");
        }
        if (answering && next.pending.playerId !== player) {
          return fail("that prompt belongs to the other player");
        }
      }

      switch (action.type) {
        case "play": {
          if (player !== next.active) return fail("it is not your turn");
          const index = Number(action.instanceId.split("h")[1] ?? "-1");
          const defId = next.hands[player][index];
          if (defId === undefined) return fail("that card is not in your hand");
          next.hands[player].splice(index, 1);
          next.played[player].push(defId);
          events.push({
            type: "cardPlayed",
            player,
            instanceId: action.instanceId,
            defId,
            costPaid: 1,
          });
          if (defId === "test-prompt-self" || defId === "test-prompt-enemy") {
            const holder = defId === "test-prompt-self" ? player : other(player);
            const choiceId = `choice-${next.nextChoice}`;
            next.nextChoice += 1;
            next.pending = { id: choiceId, playerId: holder };
            events.push({ type: "promptOpened", player: holder, choiceId, kind: "target" });
          }
          if (defId === "test-lethal") {
            next.result = { winner: player, reason: "hero-death" };
            events.push({ type: "gameOver", winner: player, reason: "hero-death" });
          }
          if (defId === "test-mutual-lethal") {
            // §2.5: "Both heroes at 0 or less in the same check" is a draw, not a win for whoever
            // struck. `packages/engine/src/stateCheck.ts` picks the reason the same way — two dead
            // heroes in one check, so nobody is named the winner.
            next.result = { winner: "draw", reason: "both-heroes-dead" };
            events.push({ type: "gameOver", winner: "draw", reason: "both-heroes-dead" });
          }
          break;
        }
        case "answer": {
          if (next.pending === null) return fail("no prompt is open");
          if (next.pending.id !== action.choiceId) return fail("that prompt is not open");
          events.push({ type: "promptAnswered", player, choiceId: action.choiceId });
          next.pending = null;
          break;
        }
        case "endTurn": {
          if (player !== next.active) return fail("it is not your turn");
          events.push({ type: "turnEnded", player, turn: next.turn, unspentMana: 0 });
          next.active = other(player);
          next.turn += 1;
          // §2.5: the player-turn cap ends the match in a draw.
          if (next.turn > FAKE_TURN_CAP) {
            next.result = { winner: "draw", reason: "turn-cap" };
            events.push({ type: "gameOver", winner: "draw", reason: "turn-cap" });
            break;
          }
          events.push({ type: "turnStarted", player: next.active, turn: next.turn });
          break;
        }
        case "concede": {
          next.result = { winner: other(player), reason: "concede" };
          events.push({ type: "gameOver", winner: other(player), reason: "concede" });
          break;
        }
        case "answerDraw": {
          if (action.accept) {
            next.result = { winner: "draw", reason: "draw-accepted" };
            events.push({ type: "drawAnswered", player, accept: true });
            events.push({ type: "gameOver", winner: "draw", reason: "draw-accepted" });
          } else {
            events.push({ type: "drawAnswered", player, accept: false });
          }
          break;
        }
        case "offerDraw": {
          events.push({ type: "drawOffered", player });
          break;
        }
        case "timeout": {
          // R268: while both mulligans are open the clock that ran out is the mulligan's. It answers
          // only this seat's own mulligan, keeping the whole hand, and ends no turn.
          if (next.pending === null && next.mulligan !== null) {
            if (next.mulligan[player].keep === null) {
              answerMulligan(next, player, handIds(next, player), events);
            }
            break;
          }
          // R79: answer only the prompts of the player whose clock ran out, and end the turn
          // only when that is the active player.
          if (next.pending !== null && next.pending.playerId === player) {
            events.push({ type: "promptAnswered", player, choiceId: next.pending.id });
            next.pending = null;
          }
          if (player === next.active) {
            events.push({ type: "turnEnded", player, turn: next.turn, unspentMana: 0 });
            next.active = other(player);
            next.turn += 1;
            events.push({ type: "turnStarted", player: next.active, turn: next.turn });
          }
          break;
        }
        case "disconnectExpired": {
          next.result = { winner: other(action.player), reason: "disconnect" };
          events.push({ type: "gameOver", winner: other(action.player), reason: "disconnect" });
          break;
        }
        case "ceilingReached": {
          next.result = { winner: "draw", reason: "match-ceiling" };
          events.push({ type: "gameOver", winner: "draw", reason: "match-ceiling" });
          break;
        }
        case "mulligan": {
          // R265, R266: each seat answers its own, in either order; the answer is sealed.
          if (next.mulligan === null) return fail("no mulligan is open");
          if (next.mulligan[player].keep !== null) return fail("you have already answered your mulligan");
          const hand = new Set(handIds(next, player));
          for (const id of action.keep) if (!hand.has(id)) return fail(`${id} is not in your hand`);
          answerMulligan(next, player, action.keep, events);
          break;
        }
        case "attack":
        case "switchPosition":
        case "activatePower": {
          return fail(`the fake engine does not script "${action.type}"`);
        }
      }

      if (next.result !== null) next.phase = "over";
      next.applied.push({ nonce: action.nonce, events });
      return { state: asEngine(next), events };
    },

    legalActions: (state, player) => {
      const fake = asFake(state);
      if (fake.result !== null) return [];
      if (fake.pending !== null) {
        return fake.pending.playerId === player
          ? [{ type: "answer", choiceId: fake.pending.id, selection: [{ pick: "none" }] }]
          : [];
      }
      if (fake.mulligan !== null) {
        // R265: a seat that owes is offered keeping everything or nothing (the real engine offers
        // every subset) and concede; a seat that has answered, concede alone.
        return fake.mulligan[player].keep === null
          ? [
              { type: "mulligan", keep: handIds(fake, player) },
              { type: "mulligan", keep: [] },
              { type: "concede" },
            ]
          : [{ type: "concede" }];
      }
      if (player !== fake.active) return [{ type: "concede" }];
      return [
        ...fake.hands[player].map((_, i) => ({
          type: "play" as const,
          instanceId: `${player}-h${i}`,
        })),
        { type: "endTurn" },
        { type: "concede" },
      ];
    },

    viewFor: (state, viewer): PlayerView => {
      const fake = asFake(state);
      const opponent = other(viewer);
      return {
        viewer,
        turn: fake.turn,
        active: fake.active,
        phase: fake.phase,
        you: emptySide(viewer, fake, viewer),
        opponent: emptySide(opponent, fake, viewer),
        pending:
          fake.pending === null
            ? mulliganPending(fake, viewer)
            : fake.pending.playerId === viewer
              ? {
                  forYou: true,
                  choiceId: fake.pending.id,
                  kind: "target",
                  options: [{ key: "none", label: "none" }],
                  min: 1,
                  max: 1,
                  prompt: "pick one",
                }
              : { forYou: false, pendingFor: fake.pending.playerId },
        events: [],
        result: fake.result,
        clockMs: null,
        ...(fake.mulligan === null
          ? {}
          : {
              mulligan: {
                youReady: fake.mulligan[viewer].keep !== null,
                opponentReady: fake.mulligan[opponent].keep !== null,
                ...(fake.mulligan[viewer].keep === null ? {} : { kept: [...(fake.mulligan[viewer].keep ?? [])] }),
              },
            }),
      };
    },

    fold: ({ seed, decks, log }) => {
      let state = port.beginGame(port.createGame({ seed, decks })).state;
      const errors: { nonce: string; error: string }[] = [];
      for (const action of log) {
        const result = port.reduce(state, action);
        if (result.error !== undefined) {
          errors.push({ nonce: action.nonce, error: result.error });
          continue;
        }
        state = result.state;
      }
      return { state, errors };
    },

    hashState: (state) => {
      const { applied: _applied, ...rest } = asFake(state);
      return JSON.stringify(rest);
    },

    snapshot: (state) => {
      const fake = asFake(state);
      return {
        turn: fake.turn,
        active: fake.active,
        pendingFor: fake.pending === null ? null : fake.pending.playerId,
        mulliganOwed: owedOf(fake),
        phase: fake.phase,
        result: fake.result,
      };
    },

    // R258's port method, scripted: `fakeDeck()` rotated by a hash of the seed, so the same seed
    // deals the same deck and two seeds (almost always) deal two orders of it.
    dealRandomDeck: (seed) => {
      const deck = fakeDeck();
      const offset = seedHash(seed) % deck.length;
      return [...deck.slice(offset), ...deck.slice(0, offset)];
    },
  };

  return port;
}

/**
 * R265, R266: a seat that still owes its mulligan sees its own prompt; a seat that has answered sees
 * only that the other still owes one, never its options or its answer.
 */
function mulliganPending(fake: FakeState, viewer: PlayerId): PlayerView["pending"] {
  const open = fake.mulligan;
  if (open === null) return null;
  const opponent = other(viewer);
  if (open[viewer].keep === null) {
    const ids = handIds(fake, viewer);
    return {
      forYou: true,
      choiceId: open[viewer].id,
      kind: "mulligan",
      options: ids.map((id, i) => ({ key: id, label: fake.hands[viewer][i] ?? id, instanceId: id })),
      min: 0,
      max: ids.length,
      prompt: "keep",
    };
  }
  return open[opponent].keep === null ? { forYou: false, pendingFor: opponent } : null;
}

/** A small, stable string hash for the scripted deals (FNV-1a); not a random source. */
export function seedHash(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** A 20-card deck of scripted ids, with `extra` cards placed in the opening hand. */
export function fakeDeck(extra: readonly string[] = []): string[] {
  const filler = Array.from({ length: 20 - extra.length }, (_, i) => `test-card-${i}`);
  return [...extra, ...filler];
}

/**
 * Two legal, disjoint decks for the **real** engine port — the counterpart of `fakeDeck` for the
 * three files that drive `src/match/engine.real.ts` (`engine.real.test.ts`, and the real-engine
 * blocks of `actor.test.ts` and `recovery.test.ts`).
 *
 * It takes the port as a parameter and imports nothing from `@jackioh/engine`, so a test that only
 * wants the scripted port above still does not pull the engine and `packages/cards`' 110 scripts
 * into its process — which is the whole reason `src/match/engine.ts` loads the real binding lazily.
 *
 * The deck size is not written here and not imported either: BUILD §2 keeps `DECK_SIZE` in
 * `packages/engine/src/config.ts`, nothing restates it, and `engine.real.ts` is meant to be the only
 * file in `apps/server` that reaches `@jackioh/engine`. So the size is whatever the engine accepts:
 * the slices grow until `createGame` stops objecting.
 *
 * That loop is also an assertion. With the card catalog unregistered *every* size is refused, so
 * that failure surfaces here as "the real engine refused every deck size", with the engine's own
 * sentences attached, rather than as a shapeless throw inside whatever called this.
 */
export function decksTheEngineAccepts(
  port: EnginePort,
  pool: readonly string[],
  seed: string,
): { state: EngineState; decks: [string[], string[]] } {
  const refusals = new Set<string>();
  for (let size = 1; size * 2 <= pool.length; size += 1) {
    const decks: [string[], string[]] = [pool.slice(0, size), pool.slice(size, size * 2)];
    try {
      return { state: port.createGame({ seed, decks }), decks };
    } catch (error) {
      refusals.add(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `the real engine refused every deck size built from the catalog:\n  ${[...refusals].join("\n  ")}`,
  );
}
