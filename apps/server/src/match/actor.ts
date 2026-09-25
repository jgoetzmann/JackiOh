/**
 * One actor per match (SPEC §9.2, §9.3, §9.5, BUILD M6-T4).
 *
 * "The match actor is the only stateful component: it holds the state in memory, one WebSocket per
 * player, an alarm for the turn clock, and it appends every resolved action to the log" (§9.2).
 * This file is that, and nothing else: it owns no rules, no timer and no socket library.
 *
 *  - The rules live behind `deps.engine` (`EnginePort`). §9.3: "`reduce` refuses illegal actions
 *    itself and returns the reason", so a refusal is relayed verbatim and never re-derived here.
 *  - The clock lives behind `deps.createClock` (R79). Every expiry comes back as a `ClockExpiry`
 *    and is dispatched as a *server action* through the same path a client action takes, because
 *    "(seed, log) reconstructs any match" (§9.3) — a timeout that skipped the log would break that.
 *    The mulligan clock (R268) is the one expiry that becomes more than one action: a `timeout` for
 *    each seat still owing its mulligan, in seat order, each its own row.
 *  - The results row lives behind `deps.recordResult` (§9.5, M7-T2).
 *  - The only per-player payload is `deps.engine.viewFor(state, player)` (§9.1, §10.8). No socket
 *    ever sees a state, the other hand, library order, or the other seat's view.
 *
 * Every task runs on one serialized queue, so the actor really is single-threaded: a socket frame
 * and a clock alarm can never interleave two `reduce` calls or two log appends.
 */

import type { Action, ActionBody, PlayerId, PlayerView } from "@jackioh/shared";
import { MATCH_ACTIONS_PER_SECOND } from "../config";
import type { MatchActionRow, MatchClocks, MatchRow, MatchSeat } from "../api/ports";
import type { ActorDeps, ClockExpiry, ClockView, MatchClock, Socket } from "./contracts";
import type { EngineState, MatchSnapshot } from "./engine";
import {
  ackMessage,
  clockMessage,
  encode,
  errorMessage,
  parseClientMessage,
  promptForOpponent,
  promptForYou,
  viewMessage,
  type AckMessage,
  type ServerMessage,
} from "./protocol";

const PLAYERS = ["p1", "p2"] as const;

/** §9.8: the action flood limit, measured over this window. */
const FLOOD_WINDOW_MS = 1000;

export type MatchActorInput = {
  match: MatchRow;
  /** The live state, when the caller already has one. Omitted, the actor folds `(seed, decks, log)`. */
  state?: EngineState;
  /** The rows already in `match_actions`: the seq counter and the nonce map are rebuilt from them. */
  log?: readonly MatchActionRow[];
};

export type MatchActor = {
  readonly matchId: string;
  readonly seats: readonly [MatchSeat, MatchSeat];
  /** Which seat a profile holds, or null when it is not in this match. */
  seatOf: (profileId: string) => PlayerId | null;
  /** Hands a connection to a seat. Replaces (and closes) a socket that seat already held. */
  attach: (player: PlayerId, socket: Socket) => void;
  /** §9.5: lets go of a seat's socket and starts its disconnect grace. */
  detach: (player: PlayerId) => void;
  /**
   * Applies one action as `player` — the seat is stamped here, never taken from the client
   * (§9.1). Resolves with the `ack` or the `error` the client is sent.
   */
  submit: (player: PlayerId, nonce: string, body: ActionBody) => Promise<ServerMessage>;
  /** Resolves when the actor's queue has drained. */
  idle: () => Promise<void>;
  viewFor: (player: PlayerId) => PlayerView;
  snapshot: () => MatchSnapshot;
  /** For the registry's hash checks and the reaper; never sent to a socket. */
  engineState: () => EngineState;
  clocks: () => MatchClocks;
  /** Drops the actor: stops the clock and lets both sockets go, leaving the log alone. */
  stop: () => Promise<void>;
};

export function createMatchActor(deps: ActorDeps, input: MatchActorInput): MatchActor {
  const { match } = input;
  const seats: [MatchSeat, MatchSeat] = [
    { profileId: match.players[0], player: "p1", deck: match.decks[0] },
    { profileId: match.players[1], player: "p2", deck: match.decks[1] },
  ];
  const log = input.log ?? [];

  // ---------------------------------------------------------------------
  // In-memory state (§9.2) and the append-only log's bookkeeping (§9.3)
  // ---------------------------------------------------------------------

  let state: EngineState =
    input.state ??
    deps.engine.fold({
      seed: match.seed,
      decks: match.decks,
      log: log.map((row) => row.action),
    }).state;

  let nextSeq = log.reduce((highest, row) => Math.max(highest, row.seq), 0) + 1;

  /**
   * §9.3: "every action carries a client nonce, deduped server-side". `reduce` dedupes internally
   * too, but the actor must not write a second log row or push a second view, so it keeps the ack
   * it already answered with. Rebuilt from the log, so a client that reconnects and retries an
   * action from before the crash still gets its original ack.
   */
  const acks = new Map<string, AckMessage>(
    log.map((row) => [row.action.nonce, ackMessage(row.action.nonce, row.seq)]),
  );

  const sockets: Record<PlayerId, Socket | null> = { p1: null, p2: null };
  /** One window per seat; see `floodExceeded`. */
  const recentActions: Record<PlayerId, number[]> = { p1: [], p2: [] };
  /**
   * A rebuilt actor whose log already ends in a result and whose row is already `finished` has
   * nothing left to record. One that is still `live` crashed between the terminal action and the
   * results write, so it heals itself on arming below (§9.5: every ending records a result).
   */
  let finished = match.status === "finished";
  let stopped = false;
  let persistedClocks = match.clocks;
  const opening = deps.engine.snapshot(state);
  let lastPendingFor: PlayerId | null = opening.pendingFor;
  /** R265: which seats owed a mulligan at the last push, so a `prompt` frame goes out on a change. */
  let lastMulliganOwed = mulliganWindow(opening).join(",");

  // ---------------------------------------------------------------------
  // The serialized queue: one task at a time, so nothing interleaves
  // ---------------------------------------------------------------------

  let tail: Promise<unknown> = Promise.resolve();

  function enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = tail.then(task, task);
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  function fireAndForget(task: () => Promise<void>, what: string): void {
    void enqueue(task).catch((error: unknown) => {
      deps.log.alert("match.task.threw", {
        matchId: match.id,
        what,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  // ---------------------------------------------------------------------
  // Sending. §10.8: a socket only ever carries this player's own view.
  // ---------------------------------------------------------------------

  function send(player: PlayerId, message: ServerMessage): void {
    const socket = sockets[player];
    if (socket === null || !socket.isOpen) return;
    try {
      socket.send(encode(message));
    } catch (error: unknown) {
      deps.log.warn("match.send.failed", {
        matchId: match.id,
        player,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  function viewOf(player: PlayerId): PlayerView {
    // R79: the engine never reads a clock, so the view's `clockMs` is filled in here from the one
    // component that knows. Nothing else about the view is touched.
    return { ...deps.engine.viewFor(state, player), clockMs: clock.remainingFor(player) };
  }

  /**
   * §10.8's view and, beside it, BUILD M5-T2's array ("the client never computes legality itself;
   * it asks `legalActions` and greys out the rest").
   *
   * `player` is passed to BOTH calls, which is the whole security property: a socket is only ever
   * handed the actions its own seat may take. `legalActions(state, other(player))` would name every
   * `play` in the opponent's hand and so hand over the hidden information §9.1 lists first.
   *
   * Both are read off the same `state` binding in the same tick, so the array is always true of the
   * view it travels with — the actor's queue means no `reduce` can land between them.
   */
  function pushView(player: PlayerId): void {
    send(player, viewMessage(viewOf(player), deps.engine.legalActions(state, player)));
  }

  function pushClock(player: PlayerId): void {
    send(player, clockMessage(deps.timers.now(), clock.snapshot()));
  }

  // ---------------------------------------------------------------------
  // The clock (R79, §9.5)
  // ---------------------------------------------------------------------

  const clock: MatchClock = deps.createClock({
    timers: deps.timers,
    config: deps.config,
    startedAt: match.createdAt,
    onExpire: (expiry) => {
      fireAndForget(() => onExpire(expiry), `expiry:${expiry.kind}`);
    },
  });

  /**
   * R79, exactly: the turn clock ends the active player's turn; a prompt clock answers only that
   * prompt; grace becomes a loss; the ceiling becomes a draw. R268 adds the mulligan clock, which
   * times out every seat still owing its mulligan. Each one is a real action, appended to the log
   * like any other, because `(seed, log)` must reconstruct the match (§9.3).
   */
  function serverActionsFor(expiry: ClockExpiry): { player: PlayerId; body: ActionBody }[] {
    const snapshot = deps.engine.snapshot(state);
    switch (expiry.kind) {
      case "turn":
      case "prompt":
        return [{ player: expiry.player, body: { type: "timeout" } }];
      case "mulligan":
        // R268: one clock for both seats, so on expiry every seat still owing is timed out — read
        // when the expiry runs, since a seat may have answered between the alarm and this task — in
        // seat order, each stamped with its own seat (R146: a timeout belongs to the player whose
        // clock ran out). What a timed-out mulligan keeps is the engine's business (R268: the whole
        // hand); a seat that has already answered is owed nothing and gets no row.
        return mulliganWindow(snapshot).map((player) => ({ player, body: { type: "timeout" } }));
      case "grace":
        // SPEC §11 R146: "a disconnect timeout belongs to the player who disconnected, because the
        // loss is theirs". `disconnectExpired` names the player in its body (§10.2), so the seat
        // the action is *stamped* with would otherwise be free; R146 fixes it so folding the log
        // reads one seat rather than "whoever happened to be active".
        return [{ player: expiry.player, body: { type: "disconnectExpired", player: expiry.player } }];
      case "ceiling":
        // SPEC §11 R146: reaching the turn ceiling "belongs to neither and is stamped with the
        // active seat as a convention", so a fold never has to guess. R79 makes it a draw and R112
        // covers the reaper's version of the same ending.
        return [{ player: snapshot.active, body: { type: "ceilingReached" } }];
    }
  }

  async function onExpire(expiry: ClockExpiry): Promise<void> {
    if (stopped || finished) return;
    for (const { player, body } of serverActionsFor(expiry)) {
      // `stop()` sets `stopped` from outside the queue, so it can land between two of R268's
      // timeouts; nothing is dispatched into an actor that is going away or a match that is over.
      if (stopped || finished) return;
      deps.log.info("match.clock.expired", { matchId: match.id, kind: expiry.kind, player });
      // The nonce is derived from the seq this action will occupy: unique, and stable across a
      // rebuild, so a rebuilt actor cannot collide with a nonce already in the log.
      await applyAction(player, `srv-${expiry.kind}-${String(nextSeq)}`, body);
    }
  }

  function clockViewFor(snapshot: MatchSnapshot): ClockView {
    return {
      turn: snapshot.turn,
      active: snapshot.active,
      pendingFor: snapshot.pendingFor,
      mulliganOwed: snapshot.mulliganOwed,
      over: snapshot.result !== null || snapshot.phase === "over",
    };
  }

  async function persistClocks(): Promise<void> {
    const clocks = clock.snapshot();
    if (JSON.stringify(clocks) === JSON.stringify(persistedClocks)) return;
    persistedClocks = clocks;
    try {
      // §9.5: "the grace countdown is stored on the match so both clients show it".
      await deps.store.matches.setClocks(match.id, clocks);
    } catch (error: unknown) {
      deps.log.warn("match.clocks.persistFailed", {
        matchId: match.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ---------------------------------------------------------------------
  // Applying an action
  // ---------------------------------------------------------------------

  /** Pushes everything the clients need after a state change, in one order for both seats. */
  async function afterChange(): Promise<void> {
    const snapshot = deps.engine.snapshot(state);
    clock.sync(clockViewFor(snapshot));
    await persistClocks();

    for (const player of PLAYERS) pushView(player);
    pushPrompts(snapshot);
    for (const player of PLAYERS) pushClock(player);

    if (snapshot.result !== null) await onTerminal(snapshot);
  }

  /**
   * The `prompt` frames for a change in who owes an answer. Each is built off that seat's own
   * `viewFor`, so a frame never carries more than the view it travels with (§10.8).
   */
  function pushPrompts(snapshot: MatchSnapshot): void {
    const deadline = clock.snapshot().promptDeadline;

    // R265, R266: while both mulligans are open neither seat holds `pending`, and each is sent the
    // frame that fits it — a seat that owes its mulligan its own prompt, a seat that has answered
    // only that the other seat still owes one. The sealed answer is in neither: R266 makes that a
    // seat is ready public and what it kept private, and the opponent's frame names no choice.
    const owed = mulliganWindow(snapshot);
    const owedKey = owed.join(",");
    if (owed.length > 0 && owedKey !== lastMulliganOwed) {
      for (const player of PLAYERS) {
        if (!owed.includes(player)) {
          send(player, promptForOpponent(other(player), deadline));
          continue;
        }
        const view = deps.engine.viewFor(state, player);
        if (view.pending !== null && view.pending.forYou) {
          send(player, promptForYou(player, view.pending.choiceId, view.pending.kind, deadline));
        }
      }
    }
    lastMulliganOwed = owedKey;

    // §10.6: one prompt at a time; the player who does not hold it learns only that it is open.
    const pendingFor = snapshot.pendingFor;
    if (pendingFor !== null && pendingFor !== lastPendingFor) {
      const view = deps.engine.viewFor(state, pendingFor);
      if (view.pending !== null && view.pending.forYou) {
        send(pendingFor, promptForYou(pendingFor, view.pending.choiceId, view.pending.kind, deadline));
      }
      send(other(pendingFor), promptForOpponent(pendingFor, deadline));
    }
    lastPendingFor = pendingFor;
  }

  /** §9.5: "Every ending records a result and clears both players' in-match state." Once. */
  async function onTerminal(snapshot: MatchSnapshot): Promise<void> {
    if (finished || snapshot.result === null) return;
    finished = true;
    clock.stop();
    const at = deps.timers.now();

    try {
      // The results row, the Elo update and clearing `inMatchId` are `api/results.ts` (M7-T2)
      // behind the `RecordResult` port; the actor never writes them itself.
      await deps.recordResult({
        matchId: match.id,
        seats,
        outcome: snapshot.result,
        turns: snapshot.turn,
        at,
      });
    } catch (error: unknown) {
      deps.log.alert("match.recordResult.failed", {
        matchId: match.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      await deps.store.matches.finish(match.id, at);
    } catch (error: unknown) {
      deps.log.warn("match.finish.failed", {
        matchId: match.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }

    deps.log.info("match.over", {
      matchId: match.id,
      winner: snapshot.result.winner,
      reason: snapshot.result.reason,
      turns: snapshot.turn,
    });
  }

  /**
   * The one path every action takes — a client's and the clock's alike. Reduce, append exactly one
   * log row at the next gapless seq, then push.
   */
  async function applyAction(
    player: PlayerId,
    nonce: string,
    body: ActionBody,
  ): Promise<ServerMessage> {
    const existing = acks.get(nonce);
    if (existing !== undefined) return existing;

    if (finished) {
      return errorMessage("match_over", "this match already has a result", nonce);
    }

    // §9.1: the seat is the server's, never the client's.
    const action = { ...body, playerId: player, nonce } as Action;
    const result = deps.engine.reduce(state, action);

    if (result.error !== undefined) {
      // §9.8: "Every rejected action is logged with its reason."
      deps.log.warn("match.action.rejected", {
        matchId: match.id,
        player,
        type: body.type,
        reason: result.error,
      });
      return errorMessage("illegal_action", result.error, nonce);
    }

    const seq = nextSeq;
    try {
      // §9.3: append-only. The row goes in *before* the new state is committed, so a failed write
      // can never leave the in-memory state ahead of the log that has to reconstruct it.
      await deps.store.matches.appendActions([
        { matchId: match.id, seq, action, at: deps.timers.now() },
      ]);
    } catch (error: unknown) {
      deps.log.alert("match.append.failed", {
        matchId: match.id,
        seq,
        message: error instanceof Error ? error.message : String(error),
      });
      return errorMessage("internal", "the action could not be recorded; try again", nonce);
    }

    state = result.state;
    nextSeq = seq + 1;
    const ack = ackMessage(nonce, seq);
    acks.set(nonce, ack);

    await afterChange();
    return ack;
  }

  // ---------------------------------------------------------------------
  // Sockets
  // ---------------------------------------------------------------------

  function onFrame(player: PlayerId, text: string): void {
    const message = parseClientMessage(text);

    switch (message.type) {
      case "malformed":
        // A bad frame is answered, not fatal: the actor stays up and the other seat is untouched.
        deps.log.warn("match.frame.malformed", { matchId: match.id, player, reason: message.reason });
        send(player, errorMessage("malformed", message.reason));
        return;

      case "hello":
        // §9.5: "Reconnect gets a fresh full view, never a log replay."
        fireAndForget(async () => {
          pushView(player);
          pushClock(player);
        }, "hello");
        return;

      case "joinRoom":
        send(
          player,
          errorMessage("unsupported", "join a room with POST /api/rooms/:code/join, not over the socket"),
        );
        return;

      case "action": {
        const now = deps.timers.now();
        if (floodExceeded(player, now)) {
          // §9.8: reject the overflow; the socket stays open.
          deps.log.warn("match.action.flooded", { matchId: match.id, player });
          send(
            player,
            errorMessage("rate_limited", "too many actions; slow down", message.nonce),
          );
          return;
        }
        fireAndForget(async () => {
          const reply = await applyAction(player, message.nonce, message.body);
          send(player, reply);
        }, `action:${message.body.type}`);
        return;
      }
    }
  }

  /**
   * §9.8's action flood limit, `MATCH_ACTIONS_PER_SECOND` from `src/config.ts` (R109), held as one
   * window *per seat*.
   *
   * SPEC §11 R137 settles the scope of the counter: "Per seat, not per match." §9.8 says
   * "per-match rate limit in the actor" and R109 says "5 actions per second per match", but one
   * shared per-match counter lets a flooding player spend the *opponent's* budget and have the
   * victim's legitimate clicks refused, "turning an anti-abuse limit into the abuse". So R137 gives
   * each socket the allowance R109 names and makes the match's aggregate ceiling twice it, which is
   * also the per-socket reading `docs/architecture.md` §5.1 step 1 asks for ("rate-limit the
   * socket"). R157 applies the same reasoning to §9.8's per-account half in `api/http.ts`.
   */
  function floodExceeded(player: PlayerId, now: number): boolean {
    const recent = recentActions[player];
    while (recent.length > 0 && (recent[0] ?? 0) <= now - FLOOD_WINDOW_MS) recent.shift();
    if (recent.length >= MATCH_ACTIONS_PER_SECOND) return true;
    recent.push(now);
    return false;
  }

  function onSocketGone(player: PlayerId, socket: Socket): void {
    // A socket that has already been replaced or dropped by `stop()` is not a disconnect.
    if (sockets[player] !== socket) return;
    sockets[player] = null;
    if (stopped || finished) return;
    deps.log.info("match.socket.closed", { matchId: match.id, player });
    fireAndForget(async () => {
      // §9.5: grace starts, and "the clock keeps running while a player is disconnected".
      clock.startGrace(player);
      await persistClocks();
      pushClock(other(player));
    }, "disconnect");
  }

  function attach(player: PlayerId, socket: Socket): void {
    const previous = sockets[player];
    sockets[player] = socket;
    socket.attach({
      message: (text) => {
        onFrame(player, text);
      },
      close: () => {
        onSocketGone(player, socket);
      },
    });
    if (previous !== null && previous !== socket) previous.close(1000, "replaced by a new socket");

    deps.log.info("match.socket.attached", { matchId: match.id, player });
    fireAndForget(async () => {
      clock.clearGrace(player);
      await persistClocks();
      // §9.5: a fresh full view, never a log replay.
      pushView(player);
      pushClock(player);
      pushClock(other(player));
    }, "attach");
  }

  function detach(player: PlayerId): void {
    const socket = sockets[player];
    if (socket === null) return;
    if (socket.isOpen) {
      socket.close(1000, "detached");
      // A transport that does not call back synchronously still leaves the seat empty.
      onSocketGone(player, socket);
      return;
    }
    onSocketGone(player, socket);
  }

  // The clock has to be armed before the first action, not on the first one (R79: the turn clock
  // is already running when the match opens).
  fireAndForget(async () => {
    const snapshot = deps.engine.snapshot(state);
    clock.sync(clockViewFor(snapshot));
    await persistClocks();
    if (snapshot.result !== null) await onTerminal(snapshot);
  }, "arm");

  return {
    matchId: match.id,
    seats,
    seatOf: (profileId) => seats.find((seat) => seat.profileId === profileId)?.player ?? null,
    attach,
    detach,
    submit: (player, nonce, body) => enqueue(() => applyAction(player, nonce, body)),
    idle: () => tail.then(() => undefined),
    viewFor: viewOf,
    snapshot: () => deps.engine.snapshot(state),
    engineState: () => state,
    clocks: () => clock.snapshot(),
    stop: async () => {
      stopped = true;
      clock.stop();
      for (const player of PLAYERS) {
        const socket = sockets[player];
        sockets[player] = null;
        if (socket !== null && socket.isOpen) socket.close(1001, "the actor is going away");
      }
      await tail.then(
        () => undefined,
        () => undefined,
      );
    },
  };
}

function other(player: PlayerId): PlayerId {
  return player === "p1" ? "p2" : "p1";
}

/**
 * R265: the seats that owe a mulligan while the window is open — both mulligans open and no other
 * prompt in front of them — and nothing otherwise. The engine never reports both at once; the
 * clock (`clock.ts`) reads the window the same way.
 */
function mulliganWindow(snapshot: MatchSnapshot): readonly PlayerId[] {
  return snapshot.pendingFor === null && snapshot.result === null ? snapshot.mulliganOwed : [];
}
