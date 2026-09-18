/**
 * SPEC §11 R165, R166 and R167 — the three rulings §9.5's queue makes that §9.5 itself does not
 * state (`src/api/queue.ts`).
 *
 *  - **R165**: queueing with no saved loadout at all is a *loadout* failure, not a missing
 *    resource. A 404 would send a client looking for a route that is working correctly.
 *  - **R166**: a sweep pairs the oldest ticket first, against the oldest opponent its window
 *    admits — not the closest in rating — and ties break on ticket id, so a replay of the same
 *    open set pairs the same way.
 *  - **R167**: a queued player may cancel, and cancelling is idempotent. Cancel never unmakes a
 *    pairing; it only closes a ticket that is still open.
 *
 * Everything runs on `createManualTimers()` through `createTestDeps()`, so `enqueuedAt` and the
 * widening window are set by this file rather than by the host clock, and `deps.ids` is the
 * counting fake — no wall clock, no randomness, no network.
 *
 * R166's fixture is built by writing tickets straight into the store. That is deliberate: the
 * ruling is about *which* qualifying opponent `tryPair` picks, and the only way to ask that
 * question is to control each ticket's age and rating exactly. The endpoint-driven tests below
 * (R165, R167) go through `createRouter` instead, so the route's auth declaration and §9.4's gate
 * take part.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { ratingWindow } from "../../src/config";
import { createRouter, type Router } from "../../src/api/http";
import { createLoadoutRoutes } from "../../src/api/loadouts";
import { createQueueRoutes, tryPair } from "../../src/api/queue";
import type { Ticket } from "../../src/api/ports";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let deps: TestDeps;
let router: Router;

/** The catalog's playable ids, sliced into three disjoint decks the permissive validator accepts. */
function decksFrom(target: TestDeps): string[][] {
  const playable = target.catalog.cardIds.filter((cardId) => !target.catalog.isToken(cardId));
  const per = Math.floor(playable.length / 3);
  return [0, 1, 2].map((index) => playable.slice(index * per, (index + 1) * per));
}

/** An active profile with a token that verifies as it. */
function activeProfile(target: TestDeps, id: string, rating = 1000): string {
  const userId = `user-${id}`;
  target.store.seedProfile({ id, userId, status: "active", rating });
  return target.auth.addUser({ userId, email: `${id}@example.test` });
}

async function saveLoadoutFor(target: TestDeps, profileId: string): Promise<void> {
  await target.store.loadouts.replace(
    profileId,
    target.catalog.version,
    decksFrom(target),
    target.timers.now(),
  );
}

type QueueBody = {
  ticketId?: string;
  status?: string;
  matchId?: string | null;
  population?: number;
  cancelled?: boolean;
  error?: { code: string; message: string };
};

async function enqueue(token: string, deckIndex = 0): Promise<Response> {
  return router(jsonRequest("POST", "/api/queue", { deckIndex }, { token }));
}

async function cancel(token: string): Promise<Response> {
  return router(jsonRequest("DELETE", "/api/queue", undefined, { token }));
}

beforeEach(() => {
  deps = createTestDeps();
  router = createRouter(createQueueRoutes(), deps);
});

// ---------------------------------------------------------------------------
// R165
// ---------------------------------------------------------------------------

describe("R165 — queueing with no loadout at all (§9.4, §9.5)", () => {
  it("R165 reports a loadout failure, never a 404, for a profile that has never saved one", async () => {
    const token = activeProfile(deps, "never-built");

    const refused = await enqueue(token);
    const body = await readJson<QueueBody>(refused);

    // The ruling, exactly: "a queue-time refusal the player fixes in the deckbuilder reports as a
    // loadout failure". 422, alongside the L1–L6 failures.
    expect(body.error?.code).toBe("loadout_invalid");
    expect(refused.status).toBe(422);
    // A 404 would say the *endpoint* found nothing, sending a client after a route that works.
    expect(refused.status).not.toBe(404);
    expect(body.error?.code).not.toBe("not_found");
    // Nor is it a staleness problem: the remedy is the deckbuilder, not a client update.
    expect(body.error?.code).not.toBe("stale_catalog");
    expect(body.error?.message).toMatch(/loadout/iu);

    // Nothing was queued on the way to the refusal.
    expect(await deps.store.tickets.countOpen()).toBe(0);
  });

  it("R165's control: the same profile and the same route queue fine once a loadout exists", async () => {
    // Without this the 422 above could be any of a dozen things the route refuses — a bad token, a
    // pending account, a broken catalog. Only one thing changes between the two calls.
    const token = activeProfile(deps, "builder");

    expect((await enqueue(token)).status).toBe(422);

    await saveLoadoutFor(deps, "builder");
    const queued = await enqueue(token);

    expect(queued.status).toBe(200);
    expect((await readJson<QueueBody>(queued)).status).toBe("open");
    expect(await deps.store.tickets.countOpen()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// R166
// ---------------------------------------------------------------------------

/**
 * Writes a ticket straight into the store, with the age and rating the case needs.
 *
 * `enqueuedAt` is an offset from the clock's start, so "older" reads as a smaller number and the
 * widening window (`ratingWindow`) sees exactly the wait this test intends.
 */
async function seedTicket(
  target: TestDeps,
  input: { id: string; profileId: string; rating: number; waitedMs: number },
): Promise<Ticket> {
  target.store.seedProfile({ id: input.profileId, status: "active", rating: input.rating });
  const ticket: Ticket = {
    id: input.id,
    profileId: input.profileId,
    rating: input.rating,
    deck: [`deck-of-${input.profileId}`],
    catalogVersion: target.catalog.version,
    enqueuedAt: target.timers.now() - input.waitedMs,
    status: "open",
    matchId: null,
  };
  await target.store.tickets.insert(ticket);
  return ticket;
}

/** The two profile ids of the match this sweep created, in seat order. */
function pairedProfiles(target: TestDeps): string[][] {
  return target.store.tables.matches.map((match) => [...match.players]);
}

/**
 * §9.5's mutual-window test, spelled out: the gap has to sit inside *both* windows.
 *
 * Every "was left waiting" assertion below needs this first, or it would be satisfied by an
 * opponent the window excluded anyway — and the test would no longer be about R166's *choice*.
 */
function expectQualifies(
  a: { rating: number; waitedMs: number },
  b: { rating: number; waitedMs: number },
): void {
  const gap = Math.abs(a.rating - b.rating);
  expect(gap).toBeLessThanOrEqual(ratingWindow(a.waitedMs / 1000));
  expect(gap).toBeLessThanOrEqual(ratingWindow(b.waitedMs / 1000));
}

describe("R166 — which qualifying opponent a sweep pairs (§9.5, R108)", () => {
  it("R166 pairs the oldest ticket against the oldest opponent its window admits, not the closest", async () => {
    // The whole point of the fixture: `near` is a far better rating match for `oldest` than `mid`
    // is, and it is the one R166 must NOT choose, because it queued later.
    //
    //   oldest  rating 1000, waited 30 s   <- paired first
    //   mid     rating 1080, waited 20 s   <- qualifies (gap 80), and is the oldest that does
    //   near    rating 1005, waited  1 s   <- qualifies (gap 5) and is far closer in rating
    //
    // Every wait is under 10 s of widening apart, so all three windows are ±100 at sweep time and
    // the choice is genuinely between "oldest" and "closest" rather than between "qualifies" and
    // "does not".
    const oldest = { rating: 1000, waitedMs: 30_000 };
    const mid = { rating: 1080, waitedMs: 20_000 };
    const near = { rating: 1005, waitedMs: 1_000 };

    // PREMISE: both candidates really are inside both windows, so what follows is R166's *choice*
    // and not §9.5's window quietly excluding one of them.
    expectQualifies(oldest, mid);
    expectQualifies(oldest, near);
    // …and `near` is the better rating match by a wide margin, which is what it must not win on.
    expect(Math.abs(oldest.rating - near.rating)).toBeLessThan(
      Math.abs(oldest.rating - mid.rating),
    );

    await seedTicket(deps, { id: "t-oldest", profileId: "oldest", ...oldest });
    await seedTicket(deps, { id: "t-mid", profileId: "mid", ...mid });
    await seedTicket(deps, { id: "t-near", profileId: "near", ...near });

    const made = await tryPair(deps);

    // PREMISE: a pair really was made, and exactly one — three tickets cannot make two.
    expect(made).toBe(1);
    expect(pairedProfiles(deps)).toEqual([["oldest", "mid"]]);

    // The closer-rated newcomer is still waiting, which is the half that discriminates: a
    // closest-rating matcher would have paired `oldest` with `near` and left `mid`.
    const stillWaiting = await deps.store.tickets.get("t-near");
    expect(stillWaiting?.status).toBe("open");
    expect(stillWaiting?.matchId).toBeNull();
    expect((await deps.store.tickets.get("t-mid"))?.status).toBe("matched");
  });

  it("R166 pairs the oldest ticket first when two pairs are available in one sweep", async () => {
    // Four tickets, all mutually in window, so the only question is the order the sweep works in.
    await seedTicket(deps, { id: "t-1", profileId: "first", rating: 1000, waitedMs: 40_000 });
    await seedTicket(deps, { id: "t-2", profileId: "second", rating: 1010, waitedMs: 30_000 });
    await seedTicket(deps, { id: "t-3", profileId: "third", rating: 1020, waitedMs: 20_000 });
    await seedTicket(deps, { id: "t-4", profileId: "fourth", rating: 1030, waitedMs: 10_000 });

    const made = await tryPair(deps);

    expect(made).toBe(2);
    // The oldest pair is made first, and each ticket takes the oldest opponent left to it.
    expect(pairedProfiles(deps)).toEqual([
      ["first", "second"],
      ["third", "fourth"],
    ]);
    expect(await deps.store.tickets.countOpen()).toBe(0);
  });

  it("R166 breaks a tie on ticket id, so the same open set always pairs the same way", async () => {
    // `t-zebra` is inserted before `t-alpha` and they queued at the very same instant. Insertion
    // order would pair `oldest` with `t-zebra`; the id tie-break pairs it with `t-alpha`.
    const oldest = { rating: 1000, waitedMs: 30_000 };
    const zebra = { rating: 1010, waitedMs: 5_000 };
    const alpha = { rating: 1020, waitedMs: 5_000 };

    // PREMISE: both tie-ed candidates qualify, so the loser below loses on its id and nothing else.
    expectQualifies(oldest, zebra);
    expectQualifies(oldest, alpha);

    await seedTicket(deps, { id: "t-oldest", profileId: "oldest", ...oldest });
    await seedTicket(deps, { id: "t-zebra", profileId: "zebra", ...zebra });
    await seedTicket(deps, { id: "t-alpha", profileId: "alpha", ...alpha });

    // PREMISE: the store really does hand them over in insertion order for an equal `enqueuedAt`,
    // so the assertion below is about `tryPair`'s sort and not about the store's.
    const open = await deps.store.tickets.listOpen();
    expect(open.map((ticket) => ticket.id)).toEqual(["t-oldest", "t-zebra", "t-alpha"]);

    expect(await tryPair(deps)).toBe(1);
    expect(pairedProfiles(deps)).toEqual([["oldest", "alpha"]]);
    expect((await deps.store.tickets.get("t-zebra"))?.status).toBe("open");
  });

  it("R166 stays inside §9.5's window: an opponent both windows refuse is not paired at all", async () => {
    // The control on "oldest first": it never drags in someone the window excludes. Both have
    // waited under 10 s, so both windows are ±100 and a gap of 300 is outside them.
    await seedTicket(deps, { id: "t-low", profileId: "low", rating: 1000, waitedMs: 1_000 });
    await seedTicket(deps, { id: "t-high", profileId: "high", rating: 1300, waitedMs: 500 });

    expect(await tryPair(deps)).toBe(0);
    expect(deps.store.tables.matches).toEqual([]);
    expect(await deps.store.tickets.countOpen()).toBe(2);

    // …and once the older one has waited long enough for its window to widen past the gap, the
    // same two pair. (§9.5: uncapped after 60 s, so both windows admit the gap by then.)
    deps.timers.advance(120_000);
    expect(await tryPair(deps)).toBe(1);
    expect(pairedProfiles(deps)).toEqual([["low", "high"]]);
  });
});

// ---------------------------------------------------------------------------
// R167
// ---------------------------------------------------------------------------

describe("R167 — how a player leaves the queue (§9.5, R108, R143)", () => {
  it("R167 cancels an open ticket, and says so", async () => {
    const token = activeProfile(deps, "leaver");
    await saveLoadoutFor(deps, "leaver");

    // PREMISE: there is something to cancel. Every negative below is vacuous without it.
    const queued = await enqueue(token);
    const ticketId = (await readJson<QueueBody>(queued)).ticketId ?? "";
    expect(queued.status).toBe(200);
    expect(ticketId.length).toBeGreaterThan(0);
    expect(await deps.store.tickets.countOpen()).toBe(1);

    const left = await cancel(token);
    const body = await readJson<QueueBody>(left);

    expect(left.status).toBe(200);
    expect(body).toEqual({ cancelled: true, ticketId });
    expect((await deps.store.tickets.get(ticketId))?.status).toBe("cancelled");
    expect(await deps.store.tickets.countOpen()).toBe(0);

    // §9.5's enqueue condition — active and not in a match — is satisfiable again, which is the
    // reason R167 exists: without cancel, a player who queued by mistake waits to be paired.
    const again = await enqueue(token);
    expect(again.status).toBe(200);
    expect((await readJson<QueueBody>(again)).ticketId).not.toBe(ticketId);
  });

  it("R167 is idempotent: a second cancel is told nothing was cancelled, not given an error", async () => {
    const token = activeProfile(deps, "twice");
    await saveLoadoutFor(deps, "twice");

    // PREMISE, again: cancel the real thing first, so "cancelled: false" below means "already
    // gone" rather than "nothing was ever queued".
    const ticketId = (await readJson<QueueBody>(await enqueue(token))).ticketId ?? "";
    expect((await readJson<QueueBody>(await cancel(token))).cancelled).toBe(true);

    const second = await cancel(token);

    expect(second.status).toBe(200);
    expect(await readJson<QueueBody>(second)).toEqual({ cancelled: false });
    // The first cancel is not undone or re-applied by the second.
    expect((await deps.store.tickets.get(ticketId))?.status).toBe("cancelled");
    expect(deps.store.tables.tickets).toHaveLength(1);
  });

  it("R167 never unmakes a pairing: a ticket paired a moment earlier reports nothing cancelled", async () => {
    const one = activeProfile(deps, "p-one");
    const two = activeProfile(deps, "p-two");
    await saveLoadoutFor(deps, "p-one");
    await saveLoadoutFor(deps, "p-two");

    const firstTicket = (await readJson<QueueBody>(await enqueue(one))).ticketId ?? "";
    const paired = await readJson<QueueBody>(await enqueue(two));

    // PREMISE: the race R167 is about really happened — the sweeper on enqueue paired them.
    expect(paired.status).toBe("matched");
    expect(paired.matchId).not.toBeNull();
    expect((await deps.store.tickets.get(firstTicket))?.status).toBe("matched");

    // The client's cancel arrives after the pairing. It closes nothing.
    const late = await cancel(one);

    expect(late.status).toBe(200);
    expect(await readJson<QueueBody>(late)).toEqual({ cancelled: false });
    // The match stands, and the player still belongs in it.
    const ticket = await deps.store.tickets.get(firstTicket);
    expect(ticket?.status).toBe("matched");
    expect(ticket?.matchId).toBe(paired.matchId);
    expect(deps.store.tables.matches).toHaveLength(1);
    expect(deps.store.tables.profiles.find((row) => row.id === "p-one")?.inMatchId).toBe(
      paired.matchId,
    );
  });

  it("R167 answers a player who was never queued the same way, with no error to act on", async () => {
    const token = activeProfile(deps, "never-queued");

    const response = await cancel(token);

    expect(response.status).toBe(200);
    expect(await readJson<QueueBody>(response)).toEqual({ cancelled: false });
    expect(deps.store.tables.tickets).toEqual([]);
  });

  it("R167's cancel is §9.4-gated like the rest of the queue: a pending account gets 403", async () => {
    // The control on "always 200": `DELETE /api/queue` is not an open door that answers
    // `cancelled: false` to anybody who asks.
    deps.store.seedProfile({ id: "pending", userId: "user-pending", status: "pending" });
    const token = deps.auth.addUser({ userId: "user-pending", email: "pending@example.test" });

    const response = await cancel(token);

    expect(response.status).toBe(403);
    expect((await readJson<QueueBody>(response)).error?.code).toBe("account_pending");
  });
});

// ---------------------------------------------------------------------------
// §9.4's gate on the queue (BUILD M6-T1)
// ---------------------------------------------------------------------------

/**
 * BUILD M6-T1's last acceptance item: "a pending account cannot call collection, loadout or queue
 * endpoints (403)". Collection and loadout are checked against their own route factories in
 * `collection.test.ts` and `loadouts.test.ts`; the queue half was only ever checked for `DELETE`
 * (R167's test above), which left enqueueing — the endpoint §9.4 actually names when it says a
 * pending account gets "no collection, loadout, queue or match" — asserted by nobody.
 *
 * Its own block rather than a sixth test inside R167's: R167 is a ruling about *leaving* the
 * queue, and this is M6-T1's gate on entering it.
 */
describe("§9.4's gate on the queue (BUILD M6-T1)", () => {
  it("declares both queue mutations `active`, so the gate is on the route and not in a handler", () => {
    const declared = createQueueRoutes()
      .filter((entry) => entry.path === "/api/queue")
      .map((entry) => `${entry.method}:${entry.auth}`);
    // `src/api/queue.ts` says the gate "is §9.4's gate ... so a pending account gets 403 here
    // without this handler saying anything about it". That is only true while these say `active`.
    expect(declared).toEqual(["POST:active", "DELETE:active"]);
  });

  it("a pending account gets 403 from POST /api/queue, and nothing is queued on the way out", async () => {
    deps.store.seedProfile({ id: "pending", userId: "user-pending", status: "pending" });
    const token = deps.auth.addUser({ userId: "user-pending", email: "pending@example.test" });
    await saveLoadoutFor(deps, "pending");

    const response = await enqueue(token);

    expect(response.status).toBe(403);
    expect((await readJson<QueueBody>(response)).error?.code).toBe("account_pending");
    // The refusal happens before the handler, so no ticket exists and nothing was logged as queued.
    expect(deps.store.tables.tickets).toEqual([]);
    expect(await deps.store.tickets.countOpen()).toBe(0);
  });

  it("the control: the same profile and the same request queue fine once the account is active", async () => {
    // Without this, the 403 above could be any of the other things the route refuses. The loadout
    // is saved first in both cases, so the only difference between the two calls is `status`.
    deps.store.seedProfile({ id: "activating", userId: "user-activating", status: "pending" });
    const token = deps.auth.addUser({ userId: "user-activating", email: "activating@example.test" });
    await saveLoadoutFor(deps, "activating");

    expect((await enqueue(token)).status).toBe(403);

    await deps.store.profiles.setStatus("activating", "active");
    const queued = await enqueue(token);

    expect(queued.status).toBe(200);
    expect((await readJson<QueueBody>(queued)).status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// §9.4 / §9.5 / §9.8 — the deck is frozen into the ticket
// ---------------------------------------------------------------------------

/**
 * §9.8's abuse vector, by its own name: "Deck swapped after matchmaking → decks are frozen into the
 * ticket". §9.4 states the rule ("Decks are frozen into the queue ticket") and `src/api/queue.ts`
 * claims it in its header: "Nothing below re-reads `loadouts` after the ticket exists, so a loadout
 * edited while queued cannot change the match that ticket becomes."
 *
 * That claim was only ever checked at the level of `deckFor` returning a non-aliased array
 * (`loadouts.test.ts`), which is a claim about JavaScript rather than about the queue: it would
 * hold just as well if `startPairedMatch` re-read the loadout it had already frozen. So this block
 * runs the vector end to end and through HTTP — enqueue, then **save a different loadout**, then
 * pair — with the loadout routes in the same router, because "saves a different loadout" is
 * something the player does with `PUT /api/loadout` and not something a test does to the store.
 *
 * Every case carries its control, and the controls are the point: an assertion that a match used
 * deck A is worthless unless the same fixture, with the save moved earlier, uses deck B.
 */
describe("§9.8 — decks are frozen into the queue ticket (§9.4, §9.5)", () => {
  /** Queue and loadout routes on one router, so a player can do both things in one session. */
  function fullRouter(target: TestDeps): Router {
    return createRouter([...createQueueRoutes(), ...createLoadoutRoutes()], target);
  }

  /**
   * The same three decks, with deck 0 and deck 2 exchanged. Slot 0 — the one every enqueue below
   * asks for — therefore holds a set of ids disjoint from the one it held before, so "the match
   * used the frozen deck" and "the match used the current loadout" can never both be true.
   */
  function swapped(target: TestDeps): string[][] {
    const [first, second, third] = decksFrom(target);
    return [third ?? [], second ?? [], first ?? []];
  }

  async function save(
    target: TestDeps,
    route: Router,
    token: string,
    decks: string[][],
  ): Promise<Response> {
    return route(
      jsonRequest("PUT", "/api/loadout", { catalogVersion: target.catalog.version, decks }, { token }),
    );
  }

  /** The deck the started match gave this profile's seat, as the actor will be handed it. */
  function deckInMatchFor(target: TestDeps, profileId: string): string[] | undefined {
    const started = target.matches.started.at(-1);
    return started?.seats.find((seat) => seat.profileId === profileId)?.deck;
  }

  it("a loadout saved after enqueue does not change the match that ticket becomes (§9.8)", async () => {
    const route = fullRouter(deps);
    const swapper = activeProfile(deps, "swapper");
    const rival = activeProfile(deps, "rival");
    await saveLoadoutFor(deps, "swapper");
    await saveLoadoutFor(deps, "rival");

    const frozen = decksFrom(deps)[0] ?? [];
    const substitute = swapped(deps)[0] ?? [];

    // PREMISE: the two decks share no card at all. Without this the assertions below could be
    // satisfied by a match that used the *new* loadout and simply looked the same.
    expect(frozen).not.toHaveLength(0);
    expect(frozen.filter((cardId) => substitute.includes(cardId))).toEqual([]);

    // 1. Queue with deck 0. The ticket freezes it here and nowhere else.
    const queued = await readJson<QueueBody>(await enqueue(swapper, 0));
    const ticketId = queued.ticketId ?? "";
    expect(queued.status).toBe("open");
    expect((await deps.store.tickets.get(ticketId))?.deck).toEqual(frozen);

    // 2. The swap, through the endpoint a player would use, while the ticket is still open.
    const saved = await save(deps, route, swapper, swapped(deps));
    expect(saved.status).toBe(200);
    // PREMISE: the save really landed. A rejected save would make every assertion below pass for
    // the wrong reason — there would be nothing to leak into the match.
    expect((await deps.store.loadouts.get("swapper"))?.decks[0]).toEqual(substitute);
    // …and the ticket is untouched by it.
    expect((await deps.store.tickets.get(ticketId))?.deck).toEqual(frozen);

    // 3. Someone pairs with the queued player, and the match is created.
    const paired = await readJson<QueueBody>(await enqueue(rival, 0));
    expect(paired.status).toBe("matched");

    // §9.4, §9.5: the match runs the deck the ticket froze, not the one the player is holding now.
    expect(deckInMatchFor(deps, "swapper")).toEqual(frozen);
    const row = deps.store.tables.matches.at(-1);
    const seat = row?.players.indexOf("swapper") ?? -1;
    expect(seat).toBeGreaterThanOrEqual(0);
    expect(row?.decks[seat]).toEqual(frozen);
    // The substitute deck reached neither the match row nor the actor's seats.
    expect(JSON.stringify([row?.decks, deps.matches.started])).not.toContain(substitute[0] ?? "");
  });

  it("the control: the same swap made BEFORE the enqueue is the deck the match uses", async () => {
    // Without this, the test above would pass against a queue that ignored loadouts entirely.
    // Exactly one thing moves between the two: whether the save happens before or after enqueue.
    const route = fullRouter(deps);
    const swapper = activeProfile(deps, "early");
    const rival = activeProfile(deps, "late");
    await saveLoadoutFor(deps, "early");
    await saveLoadoutFor(deps, "late");

    const substitute = swapped(deps)[0] ?? [];
    expect((await save(deps, route, swapper, swapped(deps))).status).toBe(200);

    const queued = await readJson<QueueBody>(await enqueue(swapper, 0));
    expect((await deps.store.tickets.get(queued.ticketId ?? ""))?.deck).toEqual(substitute);

    expect((await readJson<QueueBody>(await enqueue(rival, 0))).status).toBe("matched");
    expect(deckInMatchFor(deps, "early")).toEqual(substitute);
  });
});
