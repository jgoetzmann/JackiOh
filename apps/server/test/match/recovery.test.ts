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
 *
 * The item is made twice, for the same reason `actor.test.ts` makes its item 4 twice: the first
 * block folds the scripted port, which can be driven to a mid-prompt state in four actions, and the
 * block at the bottom folds the **real** engine, because "the same `viewFor`" is not a claim a fake
 * replaying its own scripted `reduce` can settle.
 */

import { describe, expect, it, vi } from "vitest";
import type { ActionBody, PlayerView } from "@jackioh/shared";
import { loadCatalog } from "../../src/api/catalog";
import type { ResultRow } from "../../src/api/ports";
import type { ActorDeps, RecordResultInput } from "../../src/match/contracts";
import type { EnginePort } from "../../src/match/engine";
import { enginePort } from "../../src/match/engine.real.ts";
import type { MatchActor } from "../../src/match/actor";
import { createMatchClock } from "../../src/match/clock";
import { createMatchRegistry, type MatchRegistry } from "../../src/match/registry";
import { createFakeEngine, decksTheEngineAccepts, fakeDeck } from "../fakes/engine";
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

function handIds(socket: FakeSocket): string[] {
  const cards = lastView(socket).you.hand;
  return Array.isArray(cards) ? cards.map((card) => card.instanceId) : [];
}

function firstInHand(socket: FakeSocket): string {
  const card = handIds(socket)[0];
  if (card === undefined) throw new Error("the hand is empty");
  return card;
}

type Harness = {
  deps: ReturnType<typeof createTestDeps>;
  registry: MatchRegistry;
  engine: EnginePort;
  recordResult: ReturnType<typeof vi.fn>;
};

async function startMatch(options: { engine?: EnginePort; decks?: [string[], string[]] } = {}): Promise<Harness> {
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
  const engine = options.engine ?? createFakeEngine();
  const actorDeps: ActorDeps = {
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine,
    createClock: createMatchClock,
    recordResult: recordResult as unknown as ActorDeps["recordResult"],
  };

  const decks = options.decks ?? [fakeDeck(["test-prompt-self"]), fakeDeck(["test-prompt-enemy"])];
  const registry = createMatchRegistry(actorDeps);
  await registry.start({
    matchId: MATCH_ID,
    seed: "seed-recovery",
    catalogVersion: TEST_CATALOG_VERSION,
    seats: [
      { profileId: "profile-1", player: "p1", deck: decks[0] },
      { profileId: "profile-2", player: "p2", deck: decks[1] },
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

/**
 * The same acceptance item against `packages/engine` itself.
 *
 * The block above runs on `test/fakes/engine.ts`, whose `fold` and `viewFor` are both written by
 * this test suite — so "the same `viewFor`" is a claim about a fake replaying its own scripted
 * `reduce`. What §9.5 and §9.3 actually promise is that the *real* engine is deterministic enough
 * for `(seed, decks, log)` to be the whole truth, and that is the property a crash depends on.
 *
 * So this one deals two decks of real §8 card ids, walks the real opening through the socket
 * protocol, kills the actor and folds the log back. Only real behaviour can satisfy it: the shuffle
 * is the match rng replayed from `seed` (`setup.ts`), the opening draw is §2.1's table, and the
 * mulligan answers in the log have to land on the same instances they did the first time or the
 * two hands — and therefore the two views — come back different.
 */
describe("M6-T4 crash recovery with the real engine (§9.3, §9.5)", () => {
  async function realMatch(): Promise<
    Harness & { actor: MatchActor; p1: FakeSocket; p2: FakeSocket; pool: string[] }
  > {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const engine = enginePort();
    const { decks } = decksTheEngineAccepts(engine, pool, "seed-recovery");
    const harness = await startMatch({ engine, decks });

    const actor = await harness.registry.actorFor(MATCH_ID);
    const p1 = createFakeSocket();
    const p2 = createFakeSocket();
    actor.attach("p1", p1);
    actor.attach("p2", p2);
    await actor.idle();
    return { ...harness, actor, p1, p2, pool };
  }

  it("R265 folding (seed, decks, log) through the real engine yields the same viewFor, whichever seat mulliganed first", async () => {
    for (const first of ["p1", "p2"] as const) {
      const { deps, registry, engine, actor, p1, p2 } = await realMatch();
      const socket = { p1, p2 };
      const second = first === "p1" ? "p2" : "p1";

      // §2.1, R265: both mulligans open at once; `first` keeps everything and `second` keeps
      // nothing, so the fold has to replay R9's "draw the replacements, then shuffle the returned
      // cards back" in seat order whichever order the answers were logged in — the one step in setup
      // where the rng is consulted *after* an action in the log, and so the step a fold that merely
      // re-dealt, or resolved in log order, would get wrong.
      expect(actor.snapshot().phase).toBe("mulligan");
      expect(actor.snapshot().mulliganOwed).toEqual(["p1", "p2"]);
      const keep = handIds(socket[first]);
      expect(keep.length).toBeGreaterThan(0);
      expect(handIds(socket[second]).length).toBeGreaterThan(0);
      await send(actor, socket[first], `m-${first}`, { type: "mulligan", keep });
      await send(actor, socket[second], `m-${second}`, { type: "mulligan", keep: [] });
      expect(actor.snapshot().phase).toBe("main");

      const before = { p1: actor.viewFor("p1"), p2: actor.viewFor("p2") };
      const beforeHash = engine.hashState(actor.engineState());
      await registry.stop(MATCH_ID);
      const revived = await registry.actorFor(MATCH_ID);
      expect(deps.log.entries.some((entry) => entry.event === "match.fold.errors")).toBe(false);
      expect(engine.hashState(revived.engineState())).toBe(beforeHash);
      expect(revived.viewFor("p1")).toEqual(before.p1);
      expect(revived.viewFor("p2")).toEqual(before.p2);
      await registry.stop(MATCH_ID);
    }
  });

  it("R266 a crash while one mulligan answer is sealed brings back the same sealed window", async () => {
    const { deps, registry, engine, actor, p2 } = await realMatch();

    // p2 answers first and p1 has not: the answer is sealed, in the log, and in no hand yet.
    const p2Hand = handIds(p2);
    await send(actor, p2, "sealed", { type: "mulligan", keep: p2Hand.slice(1) });
    expect(actor.snapshot().mulliganOwed).toEqual(["p1"]);
    const before = { p1: actor.viewFor("p1"), p2: actor.viewFor("p2") };
    expect(before.p2.mulligan).toEqual({ youReady: true, opponentReady: false, kept: p2Hand.slice(1) });
    expect(before.p1.mulligan).toEqual({ youReady: false, opponentReady: true });
    const beforeHash = engine.hashState(actor.engineState());

    await registry.stop(MATCH_ID);
    const revived = await registry.actorFor(MATCH_ID);
    expect(engine.hashState(revived.engineState())).toBe(beforeHash);
    expect(revived.snapshot().mulliganOwed).toEqual(["p1"]);

    const backP1 = createFakeSocket();
    const backP2 = createFakeSocket();
    revived.attach("p1", backP1);
    revived.attach("p2", backP2);
    await revived.idle();
    // A rebuilt clock arms a fresh mulligan window (the NOT IN SPEC note in `clock.ts`), so `clockMs`
    // is the one field that could differ — and no time passed across this crash, so it does not.
    expect(lastView(backP1)).toEqual(before.p1);
    expect(lastView(backP2)).toEqual(before.p2);

    // p1 answers on the rebuilt actor, and the sealed answer resolves with it at the next seq.
    await send(revived, backP1, "after-crash", { type: "mulligan", keep: handIds(backP1) });
    expect(acks(backP1).at(-1)).toEqual({ type: "ack", nonce: "after-crash", seq: 2 });
    expect(revived.snapshot()).toMatchObject({ phase: "main", mulliganOwed: [] });
    // Only now does p2's sealed answer act: the one card it did not keep has left its hand.
    expect(handIds(backP2)).not.toContain(p2Hand[0]);
    expect(deps.log.entries.some((entry) => entry.event === "match.fold.errors")).toBe(false);
  });

  it("folding (seed, decks, log) through the real engine yields the same viewFor for both players", async () => {
    const { deps, registry, engine, actor, p1, p2, pool } = await realMatch();

    // §2.1, R265: both mulligans open at once. p1 keeps everything and p2 keeps nothing, so the
    // fold replays R9's replacement draws and shuffle-back (see the test above for either order).
    expect(actor.snapshot().phase).toBe("mulligan");
    const p1Keep = handIds(p1);
    expect(p1Keep.length).toBeGreaterThan(0);
    await send(actor, p1, "m1", { type: "mulligan", keep: p1Keep });
    expect(handIds(p2).length).toBeGreaterThan(0);
    await send(actor, p2, "m2", { type: "mulligan", keep: [] });

    expect(actor.snapshot().phase).toBe("main");
    await send(actor, p1, "t1", { type: "endTurn" });

    const before = { p1: actor.viewFor("p1"), p2: actor.viewFor("p2") };
    const beforeSnapshot = actor.snapshot();
    const beforeStateHash = engine.hashState(actor.engineState());
    // PREMISE: the views really carry the real game — hands of real ids and a redacted count for
    // the other side — so the deep-equals below are comparing something. p1 holds what it kept plus
    // the card §2.1's first turn drew for it (R10).
    const p1Cards = before.p1.you.hand;
    if (!Array.isArray(p1Cards)) throw new Error("p1's own hand came back as a count");
    expect(p1Cards).toHaveLength(p1Keep.length + 1);
    expect(before.p2.opponent.hand).toEqual({ count: p1Cards.length });
    for (const card of p1Cards) expect(pool).toContain(card.defId);
    // p2 mulliganed its whole hand away, so its cards are ones the fold had to redraw in R9's order.
    expect(before.p2.you.hand).not.toHaveLength(0);

    // The crash: the actor leaves memory, the log stays.
    await registry.stop(MATCH_ID);
    expect(registry.live()).toEqual([]);
    const log = deps.store.tables.matchActions.filter((row) => row.matchId === MATCH_ID);
    expect(log.map((row) => row.action.nonce)).toEqual(["m1", "m2", "t1"]);

    // The rebuild: `(seed, decks, log)` and nothing else.
    const revived = await registry.actorFor(MATCH_ID);
    // The real engine accepted every action on the way back; an action it once took and now
    // refuses is the determinism break `registry.rebuild` shouts about.
    expect(deps.log.entries.some((entry) => entry.event === "match.fold.errors")).toBe(false);
    expect(engine.hashState(revived.engineState())).toBe(beforeStateHash);
    expect(revived.snapshot()).toEqual(beforeSnapshot);

    const backP1 = createFakeSocket();
    const backP2 = createFakeSocket();
    revived.attach("p1", backP1);
    revived.attach("p2", backP2);
    await revived.idle();

    // M6-T4, in full: the same `viewFor` for both players, built by the real `viewFor` off a state
    // that was rebuilt from the log — hands, libraries, redacted event stream and all.
    expect(views(backP1)).toHaveLength(1);
    expect(views(backP2)).toHaveLength(1);
    expect(lastView(backP1)).toEqual(before.p1);
    expect(lastView(backP2)).toEqual(before.p2);
  });
});
