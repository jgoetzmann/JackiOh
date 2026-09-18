/**
 * The actor registry: `MatchDirectory` (src/api/ports.ts) plus the two things a socket needs.
 *
 * It is the only place that knows how a match comes into existence and how a crashed one comes
 * back:
 *
 *  - `start` writes the `matches` row and creates the actor (§9.2: one actor per match).
 *  - `actorFor` rebuilds an actor that is not in memory by folding the log — SPEC §9.5: "A crashed
 *    actor rebuilds its state by folding `(seed, log)`", which is only sound because §9.3 makes
 *    `reduce` pure and the log append-only.
 *  - `stop` drops the in-memory actor and leaves the log alone, which is exactly what a crash
 *    looks like from the outside (and how `recovery.test.ts` kills one mid-game).
 *
 * `api/queue.ts` and `rooms.ts` only ever see the `MatchDirectory` half, so neither imports the
 * actor.
 */

import type { PlayerId } from "@jackioh/shared";
import { ApiError } from "../api/http";
import type { MatchClocks, MatchDirectory, MatchRow, StartMatchInput } from "../api/ports";
import { createMatchActor, type MatchActor } from "./actor";
import type { ActorDeps, Socket } from "./contracts";

export type MatchRegistry = MatchDirectory & {
  /**
   * Hands a socket to the seat this profile holds, rebuilding the actor first if it is not in
   * memory. Resolves with the seat, so the caller can log it; the socket itself is never told
   * anything but its own `viewFor` (§10.8).
   */
  attach: (matchId: string, profileId: string, socket: Socket) => Promise<PlayerId>;
  /** The live actor, folding `(seed, log)` when it is not in memory (§9.5). */
  actorFor: (matchId: string) => Promise<MatchActor>;
  /** The match ids currently held in memory. */
  live: () => string[];
};

/** R79: the hard wall-clock ceiling is measured from the moment the match row is written. */
function initialClocks(now: number, ceilingMinutes: number): MatchClocks {
  return {
    turnDeadline: null,
    promptDeadline: null,
    graceDeadline: { p1: null, p2: null },
    ceilingAt: now + ceilingMinutes * 60_000,
  };
}

export function createMatchRegistry(deps: ActorDeps): MatchRegistry {
  const actors = new Map<string, MatchActor>();
  /** In-flight rebuilds, so two sockets arriving together fold the log once, not twice. */
  const rebuilding = new Map<string, Promise<MatchActor>>();

  async function start(input: StartMatchInput): Promise<void> {
    const [first, second] = input.seats;
    const now = deps.timers.now();
    const match: MatchRow = {
      id: input.matchId,
      seed: input.seed,
      players: [first.profileId, second.profileId],
      decks: [[...first.deck], [...second.deck]],
      catalogVersion: input.catalogVersion,
      status: "live",
      createdAt: now,
      finishedAt: null,
      clocks: initialClocks(now, deps.config.matchCeilingMinutes),
    };
    await deps.store.matches.create(match);

    // The opening draw is part of the engine, not of the log: `fold` replays `createGame` and
    // `beginGame` from `(seed, decks)` before it applies a single action (§9.3).
    const state = deps.engine.beginGame(
      deps.engine.createGame({ seed: match.seed, decks: match.decks }),
    ).state;

    actors.set(match.id, createMatchActor(deps, { match, state }));
    deps.log.info("match.started", { matchId: match.id, players: match.players });
  }

  async function rebuild(matchId: string): Promise<MatchActor> {
    const match = await deps.store.matches.get(matchId);
    if (match === null) throw new ApiError("not_found", "no such match");

    const log = await deps.store.matches.actions(matchId);
    const folded = deps.engine.fold({
      seed: match.seed,
      decks: match.decks,
      log: log.map((row) => row.action),
    });
    if (folded.errors.length > 0) {
      // An action the engine once accepted and now refuses is a determinism break: the log no
      // longer reconstructs the match (§9.3). Rebuild anyway — a live match is better than a dead
      // one — but say so loudly.
      deps.log.alert("match.fold.errors", { matchId, errors: folded.errors });
    }

    const actor = createMatchActor(deps, { match, state: folded.state, log });
    actors.set(matchId, actor);
    deps.log.info("match.rebuilt", { matchId, actions: log.length });
    return actor;
  }

  async function actorFor(matchId: string): Promise<MatchActor> {
    const existing = actors.get(matchId);
    if (existing !== undefined) return existing;

    const inFlight = rebuilding.get(matchId);
    if (inFlight !== undefined) return inFlight;

    const pending = rebuild(matchId).finally(() => {
      rebuilding.delete(matchId);
    });
    rebuilding.set(matchId, pending);
    return pending;
  }

  return {
    start,
    has: (matchId) => actors.has(matchId),
    stop: async (matchId) => {
      const actor = actors.get(matchId);
      actors.delete(matchId);
      if (actor === undefined) return;
      await actor.stop();
      deps.log.info("match.stopped", { matchId });
    },
    attach: async (matchId, profileId, socket) => {
      const actor = await actorFor(matchId);
      const seat = actor.seatOf(profileId);
      // Identical to a missing match on purpose: a socket learns nothing about matches it is not
      // a player in (§9.1).
      if (seat === null) throw new ApiError("not_found", "no such match");
      actor.attach(seat, socket);
      return seat;
    },
    actorFor,
    live: () => [...actors.keys()],
  };
}
