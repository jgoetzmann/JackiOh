// The hotseat session (BUILD M5-T3): one device, two seats, one engine.
//
// Framework-free and deterministic on purpose. No React, no timers, no `Math.random`, no `Date`:
// the whole point of the M5-T3 acceptance — "the same seed and actions reproduce the same final
// state hash in the browser and in vitest" — is that this object is a pure function of
// (seed, decks, the ordered list of dispatched bodies). A random or clock-derived nonce would
// break that, because the nonce travels inside the recorded `Action` that `replay.fold` folds.
//
// It holds no rules. `legal()` is `legalActions`, `view()` is `viewFor`, and `dispatch` hands the
// action straight to `reduce` without pre-validating it (CLAUDE.md rule 7). `EngineState` stays
// opaque: this file never reads a field off it, so it cannot leak hidden information — every
// question it asks about the game it asks through `view()`.

import { opponentOf } from "@jackioh/shared";
import type { Action, ActionBody, CardDefs, GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import type { EnginePort, EngineState } from "./engine.ts";

/** Seat order: `decks[0]` is p1's library, `decks[1]` is p2's (SPEC §10.1, `createGame`). */
export const SEATS: readonly [PlayerId, PlayerId] = ["p1", "p2"];

/** The seat the device starts on. p1 moves first (§2.1), so p1 holds it first. */
export const FIRST_SEAT: PlayerId = "p1";

export type HotseatOptions = {
  seed: string;
  decks: [string[], string[]];
  engine: EnginePort;
  catalog?: CardDefs;
  /** Override only in tests that want to prove the nonces are ours; the default is `n0`, `n1`, … */
  nonce?: (n: number) => string;
};

export type DispatchResult = { events: GameEvent[]; error?: string };

export type HotseatSession = {
  seed: string;
  /** The seat whose device this is. */
  seat: PlayerId;
  setSeat(seat: PlayerId): void;
  /** `viewFor(state, seat)` — the only thing the UI may render. */
  view(): PlayerView;
  /** `legalActions(state, seat)` — the only source of legality the client has. */
  legal(): ActionBody[];
  dispatch(body: ActionBody): DispatchResult;
  /** For Cypress and the vitest replay: the ordered action log and the state hash. */
  log(): readonly Action[];
  hash(): string;
  state(): EngineState;
  subscribe(fn: () => void): () => void;
};

/** The default nonce sequence. Deterministic by contract — see the header. */
export function defaultNonce(n: number): string {
  return `n${n}`;
}

/**
 * `ActionBody` is a union, so the stamp is written once here: spreading the union distributes,
 * which keeps every member's own fields intact instead of collapsing to the shared ones.
 */
function stamp(body: ActionBody, playerId: PlayerId, nonce: string): Action {
  return { ...body, playerId, nonce };
}

export function createHotseat(options: HotseatOptions): HotseatSession {
  const { engine } = options;
  const nonceFor = options.nonce ?? defaultNonce;

  // `createGame` throws on an illegal deck (`validateDeck`, §2.6 L2/L3) and `beginGame` reports a
  // refusal in `error`. A game that cannot start is not a session, so both surface as a throw and
  // the route renders the message; nothing here decides whether a deck is legal.
  const created = engine.createGame({
    seed: options.seed,
    decks: options.decks,
    ...(options.catalog === undefined ? {} : { catalog: options.catalog }),
  });
  const begun = engine.beginGame(created);
  if (begun.error !== undefined) {
    throw new Error(`the engine refused to begin the game: ${begun.error}`);
  }

  let state: EngineState = begun.state;
  let seat: PlayerId = FIRST_SEAT;
  /** Advanced only by an action the engine accepted — see `dispatch`. */
  let nonceCount = 0;
  const actions: Action[] = [];
  const subscribers = new Set<() => void>();

  function notify(): void {
    // Copy first: a subscriber is allowed to unsubscribe itself while being notified.
    for (const fn of [...subscribers]) fn();
  }

  /**
   * "Prompts for the non-active player switch seats automatically" (BUILD M5-T3).
   *
   * Only a question moves the device by itself. A change of ACTIVE player does not: BUILD gives the
   * hotseat a manual seat-switch button precisely so that ending a turn hands the device over
   * deliberately, with the board hidden in between. A question is different — the other player is
   * being asked something and the game waits on the answer, so waiting for a button press as well
   * would deadlock the loop. There are two kinds:
   *
   *  - a prompt the other seat holds. The opening mulligans are both seats' at once (R265): each
   *    seat still owing one sees its own prompt, and a seat that has answered sees the other's as
   *    pending, so the device goes to whichever seat has not answered yet, in either order;
   *  - a draw offer the seat holding the device has just made (§2.5, R36): the other seat answers
   *    it, and its answer hands the device back to the player whose turn it is (`dispatch`). Only
   *    the offer itself hands the device over: if the players pass it back unanswered with the seat
   *    switch, the offerer's next moves keep it, and the offer lapses with the turn (R269).
   *
   * Whose question it is comes from the VIEW, never from the state: `view().pending` is either
   * `{ forYou: true, … }` or `{ forYou: false, pendingFor }` and `view().drawOffer` names the
   * offerer (SPEC §10.8), and `EngineState` is opaque to this file.
   */
  function followQuestion(offered = false): void {
    const view = engine.viewFor(state, seat);
    const pending = view.pending;
    if (pending !== null) {
      if (!pending.forYou && pending.pendingFor !== seat) seat = pending.pendingFor;
      return;
    }
    if (offered && view.result === null && view.drawOffer?.by === seat) seat = opponentOf(seat);
  }

  // The opening mulligans (§2.1, R9, R265) are open for both seats; p1 holds the device and answers
  // first unless the prompt says otherwise, and the same rule applies before the first render.
  followQuestion();

  const session: HotseatSession = {
    seed: options.seed,

    get seat(): PlayerId {
      return seat;
    },

    setSeat(next: PlayerId): void {
      if (next === seat) return;
      seat = next;
      notify();
    },

    view(): PlayerView {
      return engine.viewFor(state, seat);
    },

    legal(): ActionBody[] {
      return engine.legalActions(state, seat);
    },

    dispatch(body: ActionBody): DispatchResult {
      const action = stamp(body, seat, nonceFor(nonceCount));
      const result = engine.reduce(state, action);

      if (result.error !== undefined) {
        // Rejected: the old state stands, the action is NOT logged, and the nonce is NOT consumed.
        // The engine remembers a nonce only for an action it accepted (`reduce` records it after
        // `applyAction` succeeds), so a rejected nonce was never spent and the next dispatch may
        // reuse it. Keeping the counter in step with the log is what makes `log()` fold to the
        // browser's own hash: `replay.fold` replays exactly the logged actions, and spec 01
        // asserts that fold rejects none of them.
        return { events: result.events, error: result.error };
      }

      state = result.state;
      nonceCount += 1;
      actions.push(action);
      // The answer to a draw offer goes back to the player whose turn it is — the offerer — with
      // "declined" (or the drawn game) on its own screen.
      if (body.type === "answerDraw") seat = engine.viewFor(state, seat).active;
      followQuestion(body.type === "offerDraw");
      notify();
      return { events: result.events };
    },

    log(): readonly Action[] {
      return actions;
    },

    hash(): string {
      return engine.hashState(state);
    },

    state(): EngineState {
      return state;
    },

    subscribe(fn: () => void): () => void {
      subscribers.add(fn);
      return () => {
        subscribers.delete(fn);
      };
    },
  };

  return session;
}

/** The other seat. Re-exported so the route does not reach into `@jackioh/shared` for one helper. */
export function otherSeat(seat: PlayerId): PlayerId {
  return opponentOf(seat);
}
