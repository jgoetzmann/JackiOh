/**
 * BUILD M6-T4 acceptance, item 2: "killing the actor mid-game and reconnecting yields the same
 * `viewFor` for both players".
 *
 * SPEC §9.5: "A crashed actor rebuilds its state by folding `(seed, log)`", and §9.3: "`(seed, log)`
 * reconstructs any match". Dropping the actor out of the registry and leaving the log alone is
 * exactly what a crash looks like from the outside (`registry.stop`), so that is the kill used here.
 *
 * Unlike `actor.test.ts` this file drives the *real* clock (`src/match/clock.ts`) on the manual
 * `Timers` port: the view carries `clockMs` (R79), so a stub that always answers `null` would hide
 * the very field a rebuild is most likely to get wrong. No time is advanced across the crash, which
 * is M6-T4's claim; re-arming a clock from the deadlines stored on the match is M7-T1's
 * (`docs/architecture.md` §5.2, "re-arm the clocks from the stored deadlines").
 */

import { describe, expect, it, vi } from "vitest";
import type { ActionBody, PlayerView } from "@jackioh/shared";
import type { ResultRow } from "../../src/api/ports";
import type { ActorDeps, RecordResultInput } from "../../src/match/contracts";
import type { EnginePort } from "../../src/match/engine";
import type { MatchActor } from "../../src/match/actor";
import { createMatchClock } from "../../src/match/clock";
import { createMatchRegistry, type MatchRegistry } from "../../src/match/registry";
import { createFakeEngine, fakeDeck } from "../fakes/engine";
import { createFakeSocket, type FakeSocket } from "../fakes/socket";
import { createTestDeps, TEST_CATALOG_VERSION } from "../fakes/deps";

const MATCH_ID = "match-recovery";

function views(socket: FakeSocket): PlayerView[] {
  return socket.ofType<{ type: "view"; view: PlayerView }>("view").map((frame) => frame.view);
}

function lastView(socket: FakeSocket): PlayerView {
  const view = views(socket).at(-1);
  if (view === undefined) throw new Error("no view frame was sent");
  return view;
}

function acks(socket: FakeSocket): { type: "ack"; nonce: string; seq: number }[] {
  return socket.ofType<{ type: "ack"; nonce: string; seq: number }>("ack");
}

async function send(
  actor: MatchActor,
  socket: FakeSocket,
  nonce: string,
  body: ActionBody,
): Promise<void> {
  socket.receiveJson({ type: "action", action: { ...body, nonce } });
  await actor.idle();
}

/** The choiceId of the prompt this player holds; §10.6 sends it to nobody else. */
function openChoice(socket: FakeSocket): string {
  const pending = lastView(socket).pending;
  if (pending === null || !pending.forYou) throw new Error("no prompt is open for this player");
  return pending.choiceId;
}

function firstInHand(socket: FakeSocket): string {
  const cards = lastView(socket).you.hand;
  const card = Array.isArray(cards) ? cards[0] : undefined;
  if (card === undefined) throw new Error("the hand is empty");
  return card.instanceId;
}

type Harness = {
  deps: ReturnType<typeof createTestDeps>;
  registry: MatchRegistry;
  engine: EnginePort;
  recordResult: ReturnType<typeof vi.fn>;
};

async function startMatch(): Promise<Harness> {
  const deps = createTestDeps();
  const recordResult = vi.fn(
    async (input: RecordResultInput): Promise<ResultRow> => ({
      matchId: input.matchId,
      players: [input.seats[0].profileId, input.seats[1].profileId],
      winnerProfileId: null,
      reason: input.outcome.reason,
      turns: input.turns,
      endedAt: input.at,
      ratingBefore: [1000, 1000],
      ratingAfter: [1000, 1000],
    }),
  );
  const engine = createFakeEngine();
  const actorDeps: ActorDeps = {
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine,
    createClock: createMatchClock,
    recordResult: recordResult as unknown as ActorDeps["recordResult"],
  };

  const registry = createMatchRegistry(actorDeps);
  await registry.start({
    matchId: MATCH_ID,
    seed: "seed-recovery",
    catalogVersion: TEST_CATALOG_VERSION,
    seats: [
      { profileId: "profile-1", player: "p1", deck: fakeDeck(["test-prompt-self"]) },
      { profileId: "profile-2", player: "p2", deck: fakeDeck(["test-prompt-enemy"]) },
    ],
  });
  return { deps, registry, engine, recordResult };
}

describe("M6-T4 crash recovery", () => {
  it("killing the actor mid-game and reconnecting yields the same viewFor for both players", async () => {
    const { deps, registry, engine, recordResult } = await startMatch();
    const actor = await registry.actorFor(MATCH_ID);
    const p1 = createFakeSocket();
    const p2 = createFakeSocket();
    actor.attach("p1", p1);
    actor.attach("p2", p2);
    await actor.idle();

    // Mid-game, and deliberately mid-*prompt*: p1 plays and answers its own prompt, ends the turn,
    // and p2 then opens a prompt p1 still owes an answer to (a trap firing on your turn, R79). A
    // rebuild has to bring back the open choice, not just the board (§10.6, e2e `05`).
    await send(actor, p1, "n1", { type: "play", instanceId: firstInHand(p1) });
    await send(actor, p1, "n2", {
      type: "answer",
      choiceId: openChoice(p1),
      selection: [{ pick: "none" }],
    });
    await send(actor, p1, "n3", { type: "endTurn" });
    await send(actor, p2, "n4", { type: "play", instanceId: firstInHand(p2) });

    const before = { p1: actor.viewFor("p1"), p2: actor.viewFor("p2") };
    expect(before.p1.pending).toMatchObject({ forYou: true });
    expect(before.p2.pending).toMatchObject({ forYou: false, pendingFor: "p1" });
    // R79: the view carries a clock, and the paused turn clock and the prompt clock are both live.
    expect(before.p1.clockMs).toBe(deps.config.promptClockSeconds * 1000);
    expect(before.p2.clockMs).toBe(deps.config.turnClockSeconds * 1000);
    const beforeSnapshot = actor.snapshot();
    const beforeStateHash = engine.hashState(actor.engineState());

    // The crash: the actor leaves memory, the log stays exactly where it was.
    await registry.stop(MATCH_ID);
    expect(registry.live()).toEqual([]);
    expect(p1.isOpen).toBe(false);
    expect(p2.isOpen).toBe(false);
    const log = deps.store.tables.matchActions.filter((row) => row.matchId === MATCH_ID);
    expect(log.map((row) => row.action.nonce)).toEqual(["n1", "n2", "n3", "n4"]);
    expect(deps.store.tables.matches[0]?.status).toBe("live");

    // The rebuild: `(seed, decks, log)` and nothing else. No derived state was persisted.
    const revived = await registry.actorFor(MATCH_ID);
    expect(deps.log.entries.some((entry) => entry.event === "match.rebuilt")).toBe(true);
    expect(deps.log.entries.some((entry) => entry.event === "match.fold.errors")).toBe(false);
    expect(engine.hashState(revived.engineState())).toBe(beforeStateHash);
    expect(revived.snapshot()).toEqual(beforeSnapshot);

    // §9.5: "Reconnect gets a fresh full view, never a log replay" — one view frame each, and the
    // same one both players had before the kill, `clockMs` included.
    const backP1 = createFakeSocket();
    const backP2 = createFakeSocket();
    revived.attach("p1", backP1);
    revived.attach("p2", backP2);
    await revived.idle();

    expect(views(backP1)).toHaveLength(1);
    expect(views(backP2)).toHaveLength(1);
    expect(lastView(backP1)).toEqual(before.p1);
    expect(lastView(backP2)).toEqual(before.p2);
    // The open prompt is the same prompt, still owed by the same player.
    expect(lastView(backP1).pending).toMatchObject({ forYou: true });
    expect(lastView(backP2).pending).toMatchObject({ forYou: false, pendingFor: "p1" });

    // §9.3: the nonce map is rebuilt from the log, so a client retrying an action it sent before
    // the crash gets its original ack and appends no second row.
    await send(revived, backP1, "n3", { type: "endTurn" });
    expect(acks(backP1)).toEqual([{ type: "ack", nonce: "n3", seq: 3 }]);
    expect(deps.store.tables.matchActions).toHaveLength(4);

    // And the rebuilt actor carries the match on at the next gapless seq.
    await send(revived, backP1, "n5", {
      type: "answer",
      choiceId: openChoice(backP1),
      selection: [{ pick: "none" }],
    });
    expect(acks(backP1).at(-1)).toEqual({ type: "ack", nonce: "n5", seq: 5 });
    expect(revived.snapshot().pendingFor).toBeNull();
    expect(recordResult).not.toHaveBeenCalled();
  });

  it("rebuilds an actor for a socket that arrives when nothing is in memory", async () => {
    const { deps, registry } = await startMatch();
    await registry.stop(MATCH_ID);
    expect(registry.live()).toEqual([]);

    // The upgrade path (`wsServer.ts`) only ever calls `attach`; folding is the registry's job.
    const socket = createFakeSocket();
    const seat = await registry.attach(MATCH_ID, "profile-2", socket);
    expect(seat).toBe("p2");
    const actor = await registry.actorFor(MATCH_ID);
    await actor.idle();
    expect(lastView(socket).viewer).toBe("p2");

    // §9.1: a profile that is not in this match learns only that there is no such match.
    await expect(registry.attach(MATCH_ID, "profile-99", createFakeSocket())).rejects.toThrow(
      "no such match",
    );
    expect(deps.store.tables.matchActions).toEqual([]);
  });

  it("folds the log once when both sockets arrive together", async () => {
    const { deps, registry } = await startMatch();
    await registry.stop(MATCH_ID);

    const [first, second] = await Promise.all([
      registry.actorFor(MATCH_ID),
      registry.actorFor(MATCH_ID),
    ]);
    expect(first).toBe(second);
    expect(deps.log.entries.filter((entry) => entry.event === "match.rebuilt")).toHaveLength(1);
  });
});
