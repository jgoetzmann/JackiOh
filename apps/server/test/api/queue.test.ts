/**
 * SPEC §11 R165, R166 and R167 — the three rulings §9.5's queue makes that §9.5 itself does not
 * state (`src/api/queue.ts`) — and R253, R257, R258 and R264, the queue's modes.
 *
 *  - **R165**: queueing with no saved deck at all is a *loadout* failure, not a missing
 *    resource. A 404 would send a client looking for a route that is working correctly.
 *  - **R166**: a sweep pairs the oldest ticket first, against the oldest opponent its window
 *    admits — not the closest in rating — and ties break on ticket id, so a replay of the same
 *    open set pairs the same way.
 *  - **R167**: a queued player may cancel, and cancelling is idempotent. Cancel never unmakes a
 *    pairing; it only closes a ticket that is still open.
 *  - **R253**: a Best-of-1 deck is checked on L2, L3, L5, L6 and a Best-of-3 trio on L1–L6, by the
 *    real shared validator, with the decks' own names in its sentences.
 *  - **R257**: a ticket pairs only with a ticket of its own mode; a body with no mode is Best of 1
 *    and may name its deck by `deckIndex`; the population is reported per mode. A Best-of-3 pair
 *    becomes a series (R259), not a match.
 *  - **R258**: All Random deals both decks from the match seed and needs no saved deck.
 *  - **R264**: a profile in a series that is not over can neither queue nor be paired.
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

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MAX_SAVED_DECKS, MAX_SAVED_TRIOS, ratingWindow } from "../../src/config";
import { loadCatalog } from "../../src/api/catalog";
import { grantEntireCatalog, ownedMap } from "../../src/api/collection";
import { createDeckRoutes } from "../../src/api/decks";
import { createRouter, type Router } from "../../src/api/http";
import { sharedLoadoutValidator } from "../../src/api/loadout-validator";
import { createQueueRoutes, e2eSeedCount, tryPair } from "../../src/api/queue";
import type {
  CatalogInfo,
  FrozenTrio,
  LoadoutIssue,
  QueueMode,
  SeriesRow,
  Ticket,
} from "../../src/api/ports";
import {
  createFakeMatchDirectory,
  createTestDeps,
  jsonRequest,
  readJson,
  type TestDeps,
} from "../fakes/deps";

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

let nextId = 0;

/** A client-minted deck or trio id (R256): a UUID, unique within the file. */
function uuid(): string {
  nextId += 1;
  return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

/** Saves one deck for the profile, straight into the store, and returns its id. */
async function saveDeckFor(
  target: TestDeps,
  profileId: string,
  cards: readonly string[] = decksFrom(target)[0] ?? [],
  name = `${profileId}'s deck`,
): Promise<string> {
  const id = uuid();
  const now = target.timers.now();
  const outcome = await target.store.decks.upsert(
    { id, profileId, name, cards: [...cards], catalogVersion: target.catalog.version, createdAt: now, updatedAt: now },
    MAX_SAVED_DECKS,
  );
  expect(outcome).toBe("created");
  return id;
}

/** Saves a trio for the profile over the given decks (or three fresh ones) and returns its id. */
async function saveTrioFor(
  target: TestDeps,
  profileId: string,
  deckIds?: [string | null, string | null, string | null],
  name = `${profileId}'s trio`,
): Promise<string> {
  const slots =
    deckIds ??
    ([
      await saveDeckFor(target, profileId, decksFrom(target)[0], `${profileId} one`),
      await saveDeckFor(target, profileId, decksFrom(target)[1], `${profileId} two`),
      await saveDeckFor(target, profileId, decksFrom(target)[2], `${profileId} three`),
    ] as [string, string, string]);
  const id = uuid();
  const now = target.timers.now();
  const outcome = await target.store.trios.upsert(
    { id, profileId, name, deckIds: slots, createdAt: now, updatedAt: now },
    MAX_SAVED_TRIOS,
  );
  expect(outcome).toBe("created");
  return id;
}

type QueueBody = {
  ticketId?: string;
  status?: string;
  matchId?: string | null;
  seriesId?: string | null;
  population?: number;
  byMode?: Record<QueueMode, number>;
  mode?: QueueMode;
  cancelled?: boolean;
  error?: { code: string; message: string; details?: unknown };
};

/** The legacy body, `{ deckIndex }` with no mode (R257): Best of 1 on the oldest saved deck. */
async function enqueue(token: string, deckIndex = 0): Promise<Response> {
  return router(jsonRequest("POST", "/api/queue", { deckIndex }, { token }));
}

async function enqueueWith(token: string, body: Record<string, unknown>, route = router): Promise<Response> {
  return route(jsonRequest("POST", "/api/queue", body, { token }));
}

async function cancel(token: string): Promise<Response> {
  return router(jsonRequest("DELETE", "/api/queue", undefined, { token }));
}

beforeEach(() => {
  // The match directory here WRITES THE MATCH ROW, because `createMatchRegistry.start` does
  // (src/match/registry.ts) and this file's subject is what happens around that write.
  //
  // With the default store-less fake, production wrote the row twice for one id — once in
  // `startPairedMatch` and once in the registry — and every second enqueue returned 500 while
  // this file stayed green, because no test ever saw the registry's write. The row is now
  // written exactly where production writes it, so a create in `startPairedMatch` fails here
  // instead of shipping.
  deps = createTestDeps();
  deps.matches = createFakeMatchDirectory(deps.store);
  router = createRouter(createQueueRoutes(), deps);
});

// ---------------------------------------------------------------------------
// R165
// ---------------------------------------------------------------------------

describe("R165 — queueing with no saved deck at all (§9.4, §9.5)", () => {
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
    expect(body.error?.message).toMatch(/deck/iu);

    // Nothing was queued on the way to the refusal.
    expect(await deps.store.tickets.countOpen()).toBe(0);
  });

  it("R165's control: the same profile and the same route queue fine once a deck is saved", async () => {
    // Without this the 422 above could be any of a dozen things the route refuses — a bad token, a
    // pending account, a broken catalog. Only one thing changes between the two calls.
    const token = activeProfile(deps, "builder");

    expect((await enqueue(token)).status).toBe(422);

    await saveDeckFor(deps, "builder");
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
  input: { id: string; profileId: string; rating: number; waitedMs: number; mode?: QueueMode },
): Promise<Ticket> {
  target.store.seedProfile({ id: input.profileId, status: "active", rating: input.rating });
  const mode = input.mode ?? "bo1";
  const ticket: Ticket = {
    id: input.id,
    profileId: input.profileId,
    rating: input.rating,
    mode,
    deck: mode === "bo1" ? [`deck-of-${input.profileId}`] : [],
    trio: mode === "bo3" ? trioNamed(input.profileId) : null,
    catalogVersion: target.catalog.version,
    enqueuedAt: target.timers.now() - input.waitedMs,
    status: "open",
    matchId: null,
  };
  await target.store.tickets.insert(ticket);
  return ticket;
}

/** A frozen trio whose every name and card says whose it is. */
function trioNamed(owner: string): FrozenTrio {
  const deck = (n: number) => ({ name: `${owner} ${String(n)}`, cards: [`${owner}-card-${String(n)}`] });
  return { name: `${owner}'s trio`, decks: [deck(1), deck(2), deck(3)] };
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
    await saveDeckFor(deps, "leaver");

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
    await saveDeckFor(deps, "twice");

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
    await saveDeckFor(deps, "p-one");
    await saveDeckFor(deps, "p-two");

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
 * endpoints (403)". Collection and decks are checked against their own route factories in
 * `collection.test.ts` and `decks.test.ts`; the queue half was only ever checked for `DELETE`
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
    await saveDeckFor(deps, "pending");

    const response = await enqueue(token);

    expect(response.status).toBe(403);
    expect((await readJson<QueueBody>(response)).error?.code).toBe("account_pending");
    // The refusal happens before the handler, so no ticket exists and nothing was logged as queued.
    expect(deps.store.tables.tickets).toEqual([]);
    expect(await deps.store.tickets.countOpen()).toBe(0);
  });

  it("the control: the same profile and the same request queue fine once the account is active", async () => {
    // Without this, the 403 above could be any of the other things the route refuses. The deck is
    // saved first in both cases, so the only difference between the two calls is `status`.
    deps.store.seedProfile({ id: "activating", userId: "user-activating", status: "pending" });
    const token = deps.auth.addUser({ userId: "user-activating", email: "activating@example.test" });
    await saveDeckFor(deps, "activating");

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
 * claims it in its header: nothing re-reads a saved deck after the ticket exists.
 *
 * So this block runs the vector end to end and through HTTP — enqueue, then **save a different
 * deck under the same id**, then pair — with the deck routes in the same router, because "edits the
 * deck" is something the player does with `PUT /api/decks/:id` and not something a test does to
 * the store.
 *
 * Every case carries its control, and the controls are the point: an assertion that a match used
 * deck A is worthless unless the same fixture, with the save moved earlier, uses deck B.
 */
describe("§9.8 — decks are frozen into the queue ticket (§9.4, §9.5)", () => {
  /** Queue and deck routes on one router, so a player can do both things in one session. */
  function fullRouter(target: TestDeps): Router {
    return createRouter([...createQueueRoutes(), ...createDeckRoutes()], target);
  }

  async function save(
    target: TestDeps,
    route: Router,
    token: string,
    deckId: string,
    cards: string[],
  ): Promise<Response> {
    return route(
      jsonRequest(
        "PUT",
        `/api/decks/${deckId}`,
        { name: "The deck", cards, catalogVersion: target.catalog.version },
        { token },
      ),
    );
  }

  /** The deck the started match gave this profile's seat, as the actor will be handed it. */
  function deckInMatchFor(target: TestDeps, profileId: string): string[] | undefined {
    const started = target.matches.started.at(-1);
    return started?.seats.find((seat) => seat.profileId === profileId)?.deck;
  }

  it("a deck saved after enqueue does not change the match that ticket becomes (§9.8)", async () => {
    const route = fullRouter(deps);
    const swapper = activeProfile(deps, "swapper");
    const rival = activeProfile(deps, "rival");
    const [frozen = [], , substitute = []] = decksFrom(deps);
    const deckId = uuid();
    expect((await save(deps, route, swapper, deckId, frozen)).status).toBe(200);
    const rivalDeck = await saveDeckFor(deps, "rival");

    // PREMISE: the two decks share no card at all. Without this the assertions below could be
    // satisfied by a match that used the *new* deck and simply looked the same.
    expect(frozen).not.toHaveLength(0);
    expect(frozen.filter((cardId) => substitute.includes(cardId))).toEqual([]);

    // 1. Queue with the deck. The ticket freezes it here and nowhere else.
    const queued = await readJson<QueueBody>(await enqueueWith(swapper, { mode: "bo1", deckId }, route));
    const ticketId = queued.ticketId ?? "";
    expect(queued.status).toBe("open");
    expect((await deps.store.tickets.get(ticketId))?.deck).toEqual(frozen);

    // 2. The swap, through the endpoint a player would use, while the ticket is still open.
    const saved = await save(deps, route, swapper, deckId, substitute);
    expect(saved.status).toBe(200);
    // PREMISE: the save really landed. A rejected save would make every assertion below pass for
    // the wrong reason — there would be nothing to leak into the match.
    expect((await deps.store.decks.get(deckId))?.cards).toEqual(substitute);
    // …and the ticket is untouched by it.
    expect((await deps.store.tickets.get(ticketId))?.deck).toEqual(frozen);

    // 3. Someone pairs with the queued player, and the match is created.
    const paired = await readJson<QueueBody>(await enqueueWith(rival, { mode: "bo1", deckId: rivalDeck }, route));
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
    // Without this, the test above would pass against a queue that ignored saved decks entirely.
    // Exactly one thing moves between the two: whether the save happens before or after enqueue.
    const route = fullRouter(deps);
    const swapper = activeProfile(deps, "early");
    const rival = activeProfile(deps, "late");
    const [first = [], , substitute = []] = decksFrom(deps);
    const deckId = uuid();
    expect((await save(deps, route, swapper, deckId, first)).status).toBe(200);
    const rivalDeck = await saveDeckFor(deps, "late");

    expect((await save(deps, route, swapper, deckId, substitute)).status).toBe(200);

    const queued = await readJson<QueueBody>(await enqueueWith(swapper, { mode: "bo1", deckId }, route));
    expect((await deps.store.tickets.get(queued.ticketId ?? ""))?.deck).toEqual(substitute);

    expect((await readJson<QueueBody>(await enqueueWith(rival, { mode: "bo1", deckId: rivalDeck }, route))).status).toBe(
      "matched",
    );
    expect(deckInMatchFor(deps, "early")).toEqual(substitute);
  });
});

// ---------------------------------------------------------------------------
// R257 — queue modes
// ---------------------------------------------------------------------------

/** The deck the started match gave this profile's seat. */
function seatDeck(target: TestDeps, profileId: string): string[] | undefined {
  return target.matches.started.at(-1)?.seats.find((seat) => seat.profileId === profileId)?.deck;
}

/** A series row with these two profiles in it, in the given status. */
function seriesWith(target: TestDeps, p1: string, p2: string, status: SeriesRow["status"] = "picking"): SeriesRow {
  return {
    id: `series-of-${p1}`,
    sides: [
      { profileId: p1, trio: trioNamed(p1), wins: 0, pick: null },
      { profileId: p2, trio: trioNamed(p2), wins: 0, pick: null },
    ],
    catalogVersion: target.catalog.version,
    seedBase: "seed-base",
    status,
    games: [],
    nextMatchId: `reserved-${p1}`,
    pickDeadline: null,
    winner: null,
    endReason: null,
    ratingBefore: null,
    ratingAfter: null,
    createdAt: 0,
    updatedAt: 0,
    endedAt: null,
    version: 1,
  };
}

describe("R257 — queue modes (§9.5)", () => {
  it("R257 queues Best of 1 by deckId, and a legacy body with no mode by deckIndex", async () => {
    const modern = activeProfile(deps, "modern");
    const legacy = activeProfile(deps, "legacy");
    const [one = [], two = []] = decksFrom(deps);
    const deckId = await saveDeckFor(deps, "modern", one);
    // Two saved decks for the legacy player: `deckIndex: 1` is the younger one, oldest first.
    await saveDeckFor(deps, "legacy", one, "older");
    deps.timers.advance(1_000);
    await saveDeckFor(deps, "legacy", two, "younger");

    const first = await readJson<QueueBody>(await enqueueWith(modern, { mode: "bo1", deckId }));
    expect(first).toMatchObject({ status: "open", matchId: null, seriesId: null, mode: "bo1" });

    const second = await readJson<QueueBody>(await enqueue(legacy, 1));
    expect(second.status).toBe("matched");
    expect(second.mode).toBe("bo1");
    expect(second.seriesId).toBeNull();
    expect(second.matchId).toBe(deps.matches.started[0]?.matchId);

    expect(seatDeck(deps, "modern")).toEqual(one);
    expect(seatDeck(deps, "legacy")).toEqual(two);
    // §9.5: a Best-of-1 pairing puts both players in the match.
    for (const id of ["modern", "legacy"]) {
      expect(deps.store.tables.profiles.find((row) => row.id === id)?.inMatchId).toBe(second.matchId);
    }
  });

  it("R257 never pairs tickets of different modes, however long they have waited", async () => {
    // Same rating, long waits: every window admits every other ticket, so only the mode can stop a
    // pairing.
    await seedTicket(deps, { id: "t-bo1", profileId: "one", rating: 1000, waitedMs: 90_000, mode: "bo1" });
    await seedTicket(deps, { id: "t-bo3", profileId: "three", rating: 1000, waitedMs: 80_000, mode: "bo3" });
    await seedTicket(deps, { id: "t-rnd", profileId: "random", rating: 1000, waitedMs: 70_000, mode: "random" });

    expect(await tryPair(deps)).toBe(0);
    expect(deps.matches.started).toEqual([]);
    expect(deps.store.tables.series).toEqual([]);
    expect(await deps.store.tickets.countOpen()).toBe(3);

    // The control: a second All Random ticket pairs with the first one, and only with it — even
    // though the Best-of-1 and Best-of-3 tickets are older.
    await seedTicket(deps, { id: "t-rnd-2", profileId: "random-2", rating: 1000, waitedMs: 10_000, mode: "random" });
    expect(await tryPair(deps)).toBe(1);
    expect(pairedProfiles(deps)).toEqual([["random", "random-2"]]);
    expect((await deps.store.tickets.get("t-bo1"))?.status).toBe("open");
    expect((await deps.store.tickets.get("t-bo3"))?.status).toBe("open");
  });

  it("R257 reports the queue population in total and per mode", async () => {
    await seedTicket(deps, { id: "t-a", profileId: "a", rating: 1000, waitedMs: 0, mode: "bo1" });
    await seedTicket(deps, { id: "t-b", profileId: "b", rating: 1500, waitedMs: 0, mode: "bo3" });
    await seedTicket(deps, { id: "t-c", profileId: "c", rating: 2000, waitedMs: 0, mode: "bo3" });
    const token = activeProfile(deps, "watcher");

    const response = await router(jsonRequest("GET", "/api/queue/population", undefined, { token }));

    expect(response.status).toBe(200);
    expect(await readJson(response)).toEqual({ population: 3, byMode: { bo1: 1, bo3: 2, random: 0 } });
  });

  it("R257 makes a Best-of-3 pair a series (R259): the older ticket is series p1, and no match starts", async () => {
    deps.e2e = true;
    const older = activeProfile(deps, "older");
    const younger = activeProfile(deps, "younger");
    const olderTrio = await saveTrioFor(deps, "older");
    const youngerTrio = await saveTrioFor(deps, "younger");

    const first = await readJson<QueueBody>(
      await enqueueWith(older, { mode: "bo3", trioId: olderTrio, seed: "series-seed" }),
    );
    expect(first).toMatchObject({ status: "open", mode: "bo3", seriesId: null });
    // A Best-of-3 ticket freezes the trio, with the decks' names, and no single deck.
    const ticket = await deps.store.tickets.get(first.ticketId ?? "");
    expect(ticket?.deck).toEqual([]);
    expect(ticket?.trio?.decks.map((deck) => deck.name)).toEqual(["older one", "older two", "older three"]);

    deps.timers.advance(1_000);
    const second = await readJson<QueueBody>(await enqueueWith(younger, { mode: "bo3", trioId: youngerTrio }));

    const [series] = deps.store.tables.series;
    expect(series).toBeDefined();
    expect(second).toMatchObject({ status: "matched", mode: "bo3", matchId: null, seriesId: series?.id });
    expect(series?.sides.map((side) => side.profileId)).toEqual(["older", "younger"]);
    expect(series?.sides[0]?.trio).toEqual(ticket?.trio);
    expect(series?.sides[1]?.trio.name).toBe("younger's trio");
    // R263: game 1's match id is the one the claim reserved on both tickets.
    expect(series?.nextMatchId).toBe((await deps.store.tickets.get(first.ticketId ?? ""))?.matchId);
    // R143: the seed the older ticket brought is the series' seed base.
    expect(series?.seedBase).toBe("series-seed");
    expect(e2eSeedCount()).toBe(0);
    // Nobody is in a match yet: the series opens on its pick phase.
    expect(deps.matches.started).toEqual([]);
    expect(deps.store.tables.profiles.every((row) => row.inMatchId === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// R258 — All Random
// ---------------------------------------------------------------------------

describe("R258 — All Random (§9.5)", () => {
  it("R258 deals both players a deck from the match seed and the seat, with no saved deck needed", async () => {
    const one = activeProfile(deps, "rng-one");
    const two = activeProfile(deps, "rng-two");
    // PREMISE: neither player has saved anything; a Best-of-1 enqueue would be refused (R165).
    expect(deps.store.tables.decks).toEqual([]);

    const first = await readJson<QueueBody>(await enqueueWith(one, { mode: "random" }));
    expect(first).toMatchObject({ status: "open", mode: "random" });
    expect((await deps.store.tickets.get(first.ticketId ?? ""))?.deck).toEqual([]);

    const second = await readJson<QueueBody>(await enqueueWith(two, { mode: "random" }));
    expect(second).toMatchObject({ status: "matched", mode: "random", seriesId: null });

    const started = deps.matches.started[0];
    expect(started?.matchId).toBe(second.matchId);
    const seed = started?.seed ?? "";
    expect(seatDeck(deps, "rng-one")).toEqual(deps.dealRandomDeck(`${seed}:p1-deck`));
    expect(seatDeck(deps, "rng-two")).toEqual(deps.dealRandomDeck(`${seed}:p2-deck`));
    // Two seats, two different deals.
    expect(seatDeck(deps, "rng-one")).not.toEqual(seatDeck(deps, "rng-two"));
    // Frozen into the match row, so `(seed, decks, log)` replays it.
    expect(deps.store.tables.matches[0]?.decks).toEqual([
      deps.dealRandomDeck(`${seed}:p1-deck`),
      deps.dealRandomDeck(`${seed}:p2-deck`),
    ]);
  });

  it("R258 deals from the seed an end-to-end enqueue supplied (R143), so a spec can pin the decks", async () => {
    deps.e2e = true;
    const one = activeProfile(deps, "pin-one");
    const two = activeProfile(deps, "pin-two");

    await enqueueWith(one, { mode: "random", seed: "spec-seed" });
    await enqueueWith(two, { mode: "random" });

    expect(deps.matches.started[0]?.seed).toBe("spec-seed");
    expect(seatDeck(deps, "pin-one")).toEqual(deps.dealRandomDeck("spec-seed:p1-deck"));
    expect(seatDeck(deps, "pin-two")).toEqual(deps.dealRandomDeck("spec-seed:p2-deck"));
  });
});

// ---------------------------------------------------------------------------
// R264 — a profile in a series
// ---------------------------------------------------------------------------

describe("R264 — a series that is not over holds its players out of the queue", () => {
  it("R264 refuses to queue a profile whose series is not over, naming the series", async () => {
    const token = activeProfile(deps, "mid-series");
    activeProfile(deps, "opponent");
    await saveDeckFor(deps, "mid-series");
    await deps.store.series.create(seriesWith(deps, "mid-series", "opponent"));

    const response = await enqueue(token);
    const body = await readJson<QueueBody>(response);

    expect(response.status).toBe(409);
    expect(body.error?.code).toBe("already_in_match");
    expect(body.error?.message).toBe("Finish your best-of-three series first.");
    expect(body.error?.details).toEqual({ seriesId: "series-of-mid-series" });
    expect(deps.store.tables.tickets).toEqual([]);

    // The control: once the series is over the same request queues.
    const over = { ...seriesWith(deps, "mid-series", "opponent", "over"), version: 2 };
    expect(await deps.store.series.update(over)).toBe(true);
    expect((await enqueue(token)).status).toBe(200);
  });

  it("R264 never pairs a ticket whose owner entered a series after queueing", async () => {
    await seedTicket(deps, { id: "t-left", profileId: "left", rating: 1000, waitedMs: 5_000 });
    await seedTicket(deps, { id: "t-right", profileId: "right", rating: 1000, waitedMs: 4_000 });
    activeProfile(deps, "room-rival");
    // `left` joined a Best-of-3 room while the ticket sat open.
    await deps.store.series.create(seriesWith(deps, "left", "room-rival"));

    expect(await tryPair(deps)).toBe(0);
    expect((await deps.store.tickets.get("t-right"))?.status).toBe("open");
  });
});

// ---------------------------------------------------------------------------
// R253 — the real validator at enqueue
// ---------------------------------------------------------------------------

/**
 * Everything above runs on `permissiveValidator` and the 24-id test catalog, which is the right
 * double for the questions it asks (see `test/fakes/deps.ts`). This block is the production wiring:
 * the real §8 catalog (`loadCatalog()`), the real adapter (`sharedLoadoutValidator`), R111's launch
 * grant, and `POST /api/queue`. It does not re-test L1–L6 — `packages/validator` does — only that a
 * deck or trio the shared module refuses is refused at enqueue, with the module's own issues, the
 * decks' own names in them, and no ticket written. No sentence is typed out: every expectation is
 * the verdict `sharedLoadoutValidator` gives for the same input.
 */
describe("R253 — what may be queued, through the real validator", () => {
  let realCatalog: CatalogInfo;

  beforeAll(async () => {
    realCatalog = await loadCatalog();
  });

  type Real = { real: TestDeps; route: Router; token: string; pool: string[]; size: number };

  /**
   * The production wiring for one active profile that owns every card. The deck size is not
   * spelled: slices of the pool grow until the shared module stops objecting, so the number stays
   * the engine config's (BUILD §2).
   */
  async function realWiring(profileId = "real"): Promise<Real> {
    const real = createTestDeps({ catalog: realCatalog, validateLoadout: sharedLoadoutValidator });
    real.matches = createFakeMatchDirectory(real.store);
    const token = activeProfile(real, profileId);
    await grantEntireCatalog(real, profileId);
    const pool = real.catalog.cardIds.filter(
      (cardId) => !real.catalog.isToken(cardId) && !real.catalog.isBanned(cardId),
    );
    const owned = await ownedMap(real, profileId);
    for (let size = 1; size * 3 <= pool.length; size += 1) {
      const issues = sharedLoadoutValidator({
        decks: [pool.slice(0, size)],
        scope: "deck",
        catalogVersion: real.catalog.version,
        catalog: real.catalog,
        owned,
      });
      if (issues.length === 0) {
        return { real, route: createRouter(createQueueRoutes(), real), token, pool, size };
      }
    }
    throw new Error("no legal deck could be built from the real catalog");
  }

  async function verdict(
    w: Real,
    decks: string[][],
    names: string[],
    scope: "deck" | "trio",
    profileId = "real",
  ): Promise<LoadoutIssue[]> {
    return sharedLoadoutValidator({
      decks,
      names,
      scope,
      catalogVersion: w.real.catalog.version,
      catalog: w.real.catalog,
      owned: await ownedMap(w.real, profileId),
    });
  }

  type ErrorBody = { error: { code: string; message: string; details: LoadoutIssue[] } };

  async function expectRefused(
    w: Real,
    body: Record<string, unknown>,
    expected: LoadoutIssue[],
    rule: string,
  ): Promise<ErrorBody> {
    // PREMISE: the shared module really refuses this, and first for the rule named.
    expect(expected[0]?.rule).toBe(rule);
    const response = await enqueueWith(w.token, body, w.route);
    const refused = await readJson<ErrorBody>(response);
    expect(response.status).toBe(422);
    expect(refused.error.code).toBe("loadout_invalid");
    expect(refused.error.details).toEqual(expected);
    expect(refused.error.message).toBe(expected[0]?.message);
    expect(w.real.store.tables.tickets).toEqual([]);
    return refused;
  }

  it("R253 queues a legal Best-of-1 deck of real cards (the premise)", async () => {
    const w = await realWiring();
    const deckId = await saveDeckFor(w.real, "real", w.pool.slice(0, w.size), "Midrange");
    const response = await enqueueWith(w.token, { mode: "bo1", deckId }, w.route);
    expect(response.status).toBe(200);
    expect(w.real.store.tables.tickets[0]?.deck).toEqual(w.pool.slice(0, w.size));
  });

  it("R253 refuses a Best-of-1 deck one card short (L2), naming the deck as the player named it", async () => {
    const w = await realWiring();
    const short = w.pool.slice(0, w.size - 1);
    // A draft this short is saved without complaint (R250); the queue is where it is judged.
    const deckId = await saveDeckFor(w.real, "real", short, "Midrange");

    const refused = await expectRefused(
      w,
      { mode: "bo1", deckId },
      await verdict(w, [short], ["Midrange"], "deck"),
      "L2",
    );
    expect(refused.error.message).toContain("Midrange");
  });

  it("R253 refuses a Best-of-1 deck holding a Token (L3) and one the collection no longer covers (L5)", async () => {
    const w = await realWiring();
    const token = w.real.catalog.cardIds.find((cardId) => w.real.catalog.isToken(cardId)) ?? "";
    expect(token).not.toBe("");
    const withToken = [token, ...w.pool.slice(1, w.size)];
    const tokenDeck = await saveDeckFor(w.real, "real", withToken, "Sheepish");
    await expectRefused(w, { mode: "bo1", deckId: tokenDeck }, await verdict(w, [withToken], ["Sheepish"], "deck"), "L3");

    // L5: the collection is server-owned and can move after a save (§9.8).
    const legal = await saveDeckFor(w.real, "real", w.pool.slice(0, w.size), "Legal");
    w.real.store.tables.collection.length = 0;
    const refused = await expectRefused(
      w,
      { mode: "bo1", deckId: legal },
      await verdict(w, [w.pool.slice(0, w.size)], ["Legal"], "deck"),
      "L5",
    );
    expect(refused.error.message).toContain("Legal");
  });

  it("R253 refuses a Best-of-3 trio whose decks share a card (L4), naming both decks", async () => {
    const w = await realWiring();
    const one = w.pool.slice(0, w.size);
    const shared = one[0] ?? "";
    const two = [shared, ...w.pool.slice(w.size + 1, w.size * 2)];
    const three = w.pool.slice(w.size * 2, w.size * 3);
    const ids: [string, string, string] = [
      await saveDeckFor(w.real, "real", one, "Aggro"),
      await saveDeckFor(w.real, "real", two, "Control"),
      await saveDeckFor(w.real, "real", three, "Tempo"),
    ];
    // A loose trio is saved (R252) and judged here.
    const trioId = await saveTrioFor(w.real, "real", ids, "Main");

    const refused = await expectRefused(
      w,
      { mode: "bo3", trioId },
      await verdict(w, [one, two, three], ["Aggro", "Control", "Tempo"], "trio"),
      "L4",
    );
    expect(refused.error.message).toContain("Aggro");
    expect(refused.error.message).toContain("Control");
    expect(refused.error.details[0]?.cardId).toBe(shared);
  });

  it("R253 refuses a Best-of-3 trio with an empty slot as L1", async () => {
    const w = await realWiring();
    const one = w.pool.slice(0, w.size);
    const two = w.pool.slice(w.size, w.size * 2);
    const ids: [string, null, string] = [
      await saveDeckFor(w.real, "real", one, "Aggro"),
      null,
      await saveDeckFor(w.real, "real", two, "Control"),
    ];
    const trioId = await saveTrioFor(w.real, "real", ids, "Gappy");

    await expectRefused(
      w,
      { mode: "bo3", trioId },
      await verdict(w, [one, two], ["Aggro", "Control"], "trio"),
      "L1",
    );
  });

  it("R253 queues a legal trio of real cards, freezing its three decks with their names", async () => {
    const w = await realWiring();
    const decks = [0, 1, 2].map((n) => w.pool.slice(w.size * n, w.size * (n + 1)));
    const ids = [
      await saveDeckFor(w.real, "real", decks[0], "Aggro"),
      await saveDeckFor(w.real, "real", decks[1], "Control"),
      await saveDeckFor(w.real, "real", decks[2], "Tempo"),
    ] as [string, string, string];
    const trioId = await saveTrioFor(w.real, "real", ids, "Main");

    const response = await enqueueWith(w.token, { mode: "bo3", trioId }, w.route);

    expect(response.status).toBe(200);
    expect(w.real.store.tables.tickets[0]?.trio).toEqual({
      name: "Main",
      decks: [
        { name: "Aggro", cards: decks[0] },
        { name: "Control", cards: decks[1] },
        { name: "Tempo", cards: decks[2] },
      ],
    });
  });
});
