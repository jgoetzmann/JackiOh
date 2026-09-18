/**
 * A scripted `EnginePort` for the server tests.
 *
 * `packages/engine` is mid-build (M3 in flight: `viewFor`, `prompts`, `traps` and `combat` do not
 * exist yet), and a server test should not depend on the rules anyway: what M6-T4 and M7 have to
 * prove is about the actor, the clock and the log, not about JackiOh's rules. This fake keeps the
 * real engine's contract exactly where the server relies on it:
 *
 *  - `reduce` is pure, returns `{ state, events, error? }` and refuses illegal actions itself;
 *  - a reused nonce returns the original events and does not advance the state (SPEC §9.3);
 *  - `viewFor` shows the viewer's hand in full and the opponent's as a count (§10.8);
 *  - `fold({ seed, decks, log })` rebuilds the same state, so crash recovery is testable;
 *  - a prompt is state, answered by another action (§9.3).
 *
 * Scripted cards, so a test can reach a situation without the real catalog:
 *  - `test-prompt-self`   opens a prompt for the player who played it;
 *  - `test-prompt-enemy`  opens a prompt for the other player (a trap firing on your turn, R79);
 *  - `test-lethal`        ends the match: the player who played it wins by `hero-death`.
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
  applied: { nonce: string; events: GameEvent[] }[];
  nextChoice: number;
};

const other = (player: PlayerId): PlayerId => (player === "p1" ? "p2" : "p1");
const clone = <T>(value: T): T => structuredClone(value);

const asFake = (state: EngineState): FakeState => state as unknown as FakeState;
const asEngine = (state: FakeState): EngineState => state as unknown as EngineState;

function emptySide(player: PlayerId, fake: FakeState, viewer: PlayerId): SideView {
  const hand = fake.hands[player];
  return {
    player,
    hero: { health: 30, armor: 0, powers: [], power: null },
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

export function createFakeEngine(): EnginePort {
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
        case "mulligan":
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
            ? null
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
        phase: fake.phase,
        result: fake.result,
      };
    },
  };

  return port;
}

/** A 20-card deck of scripted ids, with `extra` cards placed in the opening hand. */
export function fakeDeck(extra: readonly string[] = []): string[] {
  const filler = Array.from({ length: 20 - extra.length }, (_, i) => `test-card-${i}`);
  return [...extra, ...filler];
}
