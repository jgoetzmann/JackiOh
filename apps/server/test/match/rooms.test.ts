/**
 * The room-code challenge (`src/match/rooms.ts`, SPEC §9.5, R79, BUILD M6-T4).
 *
 * Two rulings own this file:
 *
 *  - **R143**, the optional seed. A room's match is not created until someone joins, so the seed
 *    the host posts to `POST /api/rooms` has to survive until `POST /api/rooms/:code/join` — and
 *    outside end-to-end mode the field is refused at both doors. BUILD M8 requires every spec to
 *    set a seed, and `e2e/cypress/e2e/05-reconnect.cy.ts` and `06-room-code.cy.ts` both post one.
 *  - **R149**, the bounded mint: a code is retried a fixed number of times against the codes still
 *    in use, and then the caller is told none is available rather than the server retrying for ever.
 *  - **R264**, the room's mode: a room is made in the host's mode with their deck or trio frozen
 *    into it, a join in another mode is refused with the room's mode named, a Best-of-3 join makes
 *    the series and an All Random join deals both decks.
 *
 * The rooms run the real `freezeChoice` (`src/api/decks.ts`) over decks saved straight into the
 * store, with the permissive validator: the room rules are what is under test, not L1–L6.
 */

import { describe, expect, it } from "vitest";

import { createDeckRoutes } from "../../src/api/decks";
import { createRouter, type Router } from "../../src/api/http";
import type { FrozenTrio, Ids } from "../../src/api/ports";
import { CODE_ALPHABET, MAX_SAVED_DECKS, MAX_SAVED_TRIOS, ROOM_CODE_LENGTH } from "../../src/config";
import { createQueueRoutes } from "../../src/api/queue";
import { createSeriesRoutes } from "../../src/api/series";
import { createRoomRoutes, e2eRoomSeedCount } from "../../src/match/rooms";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

const DECK = ["core-001", "core-002", "core-003"];
const HOST = "host";
const GUEST = "guest";

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

/** A client-minted id (R256). */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** Saves a deck for a profile straight into the store. */
async function saveDeck(
  deps: TestDeps,
  profileId: string,
  id: string,
  cards: readonly string[],
  name = `${profileId}'s deck`,
): Promise<void> {
  const at = deps.timers.now();
  const outcome = await deps.store.decks.upsert(
    { id, profileId, name, cards: [...cards], catalogVersion: deps.catalog.version, createdAt: at, updatedAt: at },
    MAX_SAVED_DECKS,
  );
  expect(outcome).toBe("created");
}

/**
 * `createFakeIds().code()` emits codes containing `1`, which §9.4's alphabet excludes and which
 * `joinableRoom` would (correctly) refuse as malformed. These are the shape the real `systemIds`
 * emits: `ROOM_CODE_LENGTH` symbols, all inside `CODE_ALPHABET`.
 */
function roomIds(codes?: readonly string[]): Ids {
  let n = 0;
  let minted = 0;
  const next = (): number => {
    n += 1;
    return n;
  };
  return {
    uuid: () => `id-${String(next())}`,
    seed: () => `seed-${String(next())}`,
    code: (length) => {
      const scripted = codes?.[Math.min(minted, codes.length - 1)];
      minted += 1;
      if (scripted !== undefined) return scripted;
      const head = CODE_ALPHABET[next() % CODE_ALPHABET.length] ?? "A";
      return `${head}${CODE_ALPHABET.slice(0, length - 1)}`.slice(0, length);
    },
  };
}

/**
 * Host and guest, active, each with one saved deck — `DECK` — so the legacy `{ deckIndex: 0 }` the
 * helpers below send is Best of 1 on it (R257).
 */
async function harness(
  options: { e2e?: boolean; codes?: readonly string[] } = {},
): Promise<{ deps: TestDeps; router: Router; host: string; guest: string }> {
  const deps = createTestDeps({ ids: roomIds(options.codes) });
  if (options.e2e === true) deps.e2e = true;
  const host = deps.auth.addUser({ userId: "user-host", email: "host@example.test" });
  const guest = deps.auth.addUser({ userId: "user-guest", email: "guest@example.test" });
  deps.store.seedProfile({ id: HOST, userId: "user-host", status: "active" });
  deps.store.seedProfile({ id: GUEST, userId: "user-guest", status: "active" });
  await saveDeck(deps, HOST, uuid(1), DECK);
  await saveDeck(deps, GUEST, uuid(2), DECK);
  return { deps, router: createRouter(createRoomRoutes(), deps), host, guest };
}

function create(router: Router, token: string, body: Record<string, unknown>): Promise<Response> {
  return router(jsonRequest("POST", "/api/rooms", { deckIndex: 0, ...body }, { token }));
}

function join(
  router: Router,
  token: string,
  code: string,
  body: Record<string, unknown> = {},
): Promise<Response> {
  return router(
    jsonRequest("POST", `/api/rooms/${code}/join`, { deckIndex: 0, ...body }, { token }),
  );
}

/** Creates a room and joins it, returning the code and the match the join started. */
async function playThrough(
  h: Awaited<ReturnType<typeof harness>>,
  body: Record<string, unknown> = {},
  joinBody: Record<string, unknown> = {},
): Promise<{ code: string; seed: string }> {
  const created = await create(h.router, h.host, body);
  expect(created.status).toBe(200);
  const { code } = await readJson<{ code: string }>(created);

  const joined = await join(h.router, h.guest, code, joinBody);
  expect(joined.status).toBe(200);

  const started = h.deps.matches.started.at(-1);
  expect(started).toBeDefined();
  return { code, seed: started?.seed ?? "" };
}

describe("the room-code challenge (§9.5)", () => {
  it("creates a room and starts the match on the join, with the host as p1", async () => {
    const h = await harness();
    const { code } = await playThrough(h);

    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    const started = h.deps.matches.started[0];
    // The frozen decks, host first.
    expect(started?.seats.map((seat) => seat.deck)).toEqual([DECK, DECK]);
    expect(started?.seats.map((seat) => seat.profileId)).toEqual([HOST, GUEST]);
    expect(started?.seats.map((seat) => seat.player)).toEqual(["p1", "p2"]);
    // §9.5: both ends of the lifecycle read the in-match flag.
    expect((await h.deps.store.profiles.getById(HOST))?.inMatchId).toBe(started?.matchId);
    expect((await h.deps.store.profiles.getById(GUEST))?.inMatchId).toBe(started?.matchId);
  });
});

describe("R143 — the optional seed on the room endpoints", () => {
  it("R143 rejects `seed` on POST /api/rooms outside end-to-end mode, and mints no room", async () => {
    const h = await harness();

    const response = await create(h.router, h.host, { seed: "05-reconnect" });

    expect(response.status).toBe(400);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toMatch(/seed/u);
    // Refused, never ignored: the request bought nothing.
    expect(h.deps.store.tables.rooms).toHaveLength(0);
  });

  it("R143 rejects `seed` on the join endpoint outside end-to-end mode", async () => {
    const h = await harness();
    const created = await create(h.router, h.host, {});
    const { code } = await readJson<{ code: string }>(created);

    const response = await join(h.router, h.guest, code, { seed: "05-reconnect" });

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toMatch(/seed/u);
    expect(h.deps.matches.started).toHaveLength(0);
  });

  it("R143 uses the host's seed verbatim for the match the join creates, in end-to-end mode", async () => {
    const h = await harness({ e2e: true });

    const { seed } = await playThrough(h, { seed: "06-room-code" });

    expect(seed).toBe("06-room-code");
    // Consumed with the room, so nothing accumulates across a long-running server.
    expect(e2eRoomSeedCount()).toBe(0);
  });

  it("R143 takes the joiner's seed when the host supplied none, and the host's when both did", async () => {
    const joinerOnly = await harness({ e2e: true });
    expect((await playThrough(joinerOnly, {}, { seed: "from-the-joiner" })).seed).toBe(
      "from-the-joiner",
    );

    // Both: the room was created first, so its seed is the one the match runs on.
    const both = await harness({ e2e: true });
    expect((await playThrough(both, { seed: "from-the-host" }, { seed: "from-the-joiner" })).seed)
      .toBe("from-the-host");
    expect(e2eRoomSeedCount()).toBe(0);
  });

  it("R143 still mints a seed when none is supplied (§9.3: the server owns it)", async () => {
    const h = await harness({ e2e: true });
    expect((await playThrough(h)).seed).toMatch(/^seed-/u);
  });

  it("R143 refuses a `seed` that is not a non-empty string, even in end-to-end mode", async () => {
    const h = await harness({ e2e: true });

    expect((await create(h.router, h.host, { seed: 7 })).status).toBe(400);
    expect((await create(h.router, h.host, { seed: "" })).status).toBe(400);
    expect(h.deps.store.tables.rooms).toHaveLength(0);
  });

  it("R143 drops a seed whose room expired, so an unjoined room cannot leak one", async () => {
    const h = await harness({ e2e: true, codes: ["AAA234", "BBB234"] });
    await create(h.router, h.host, { seed: "never-joined" });
    expect(e2eRoomSeedCount()).toBe(1);

    // Past the room's TTL, a second room is created: the stale entry goes with it.
    h.deps.timers.advance(h.deps.limits.roomCodeTtlMs + 1);
    await create(h.router, h.host, { seed: "the-live-one" });

    expect(e2eRoomSeedCount()).toBe(1);
    const joined = await join(h.router, h.guest, "BBB234");
    expect(joined.status).toBe(200);
    expect(h.deps.matches.started.at(-1)?.seed).toBe("the-live-one");
  });
});

describe("R149 — the bounded room-code mint (§9.5, R110)", () => {
  it("R149 retries past a code that is already in use and mints the next one", async () => {
    // The first two attempts collide with the room the host already opened; the third is free.
    const h = await harness({ codes: ["AAA234", "AAA234", "AAA234", "BBB234"] });

    const first = await create(h.router, h.host, {});
    expect((await readJson<{ code: string }>(first)).code).toBe("AAA234");

    const second = await create(h.router, h.guest, {});
    expect(second.status).toBe(200);
    expect((await readJson<{ code: string }>(second)).code).toBe("BBB234");
  });

  it("R149 gives up after a bounded number of collisions and says no code is available", async () => {
    // Every attempt mints the same code, which the host's room already holds.
    const h = await harness({ codes: ["AAA234"] });
    expect((await create(h.router, h.host, {})).status).toBe(200);

    const response = await create(h.router, h.guest, {});

    expect(response.status).toBe(503);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("unavailable");
    expect(body.error.message).toMatch(/could not allocate a room code/u);
    // Bounded, and loud: an exhausted code space is an operator's problem, not a silent retry loop.
    const alerts = h.deps.log.entries.filter((entry) => entry.event === "room.code.exhausted");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.level).toBe("alert");
    expect(h.deps.store.tables.rooms).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// §9.4 / §9.5 / §9.8 — the host's deck is frozen into the room
// ---------------------------------------------------------------------------

/**
 * The room half of §9.8's "Deck swapped after matchmaking → decks are frozen into the ticket". A
 * room has the same exposure as a queue ticket and a wider window for it: `src/match/rooms.ts`
 * freezes the host's deck at `POST /api/rooms` and the match is not created until somebody joins —
 * which may be up to `roomCodeTtlMs` later, with the deck builder open the whole time.
 *
 * These put the real `PUT /api/decks/:id` on the same router, so "the host edits the deck" is the
 * endpoint a player would use and the freeze under test is the production one.
 */
describe("§9.8 — the host's deck is frozen into the room (§9.4, §9.5)", () => {
  /** Three disjoint decks out of the test catalog: A, B and C, eight ids each. */
  function decksOf(target: TestDeps): [string[], string[], string[]] {
    const playable = target.catalog.cardIds.filter((cardId) => !target.catalog.isToken(cardId));
    const per = Math.floor(playable.length / 3);
    return [
      playable.slice(0, per),
      playable.slice(per, per * 2),
      playable.slice(per * 2, per * 3),
    ];
  }

  const HOST_DECK = uuid(11);
  const GUEST_DECK = uuid(12);

  function freezeHarness(): {
    deps: TestDeps;
    router: Router;
    host: string;
    guest: string;
    decks: [string[], string[], string[]];
  } {
    const deps = createTestDeps({ ids: roomIds() });
    const host = deps.auth.addUser({ userId: "user-host", email: "host@example.test" });
    const guest = deps.auth.addUser({ userId: "user-guest", email: "guest@example.test" });
    deps.store.seedProfile({ id: HOST, userId: "user-host", status: "active" });
    deps.store.seedProfile({ id: GUEST, userId: "user-guest", status: "active" });
    return {
      deps,
      router: createRouter([...createRoomRoutes(), ...createDeckRoutes()], deps),
      host,
      guest,
      decks: decksOf(deps),
    };
  }

  function save(
    h: ReturnType<typeof freezeHarness>,
    token: string,
    deckId: string,
    cards: string[],
  ): Promise<Response> {
    return h.router(
      jsonRequest(
        "PUT",
        `/api/decks/${deckId}`,
        { name: "Deck", cards, catalogVersion: h.deps.catalog.version },
        { token },
      ),
    );
  }

  /** The deck the started match gave this profile's seat. */
  function deckInMatchFor(h: ReturnType<typeof freezeHarness>, profileId: string): string[] | undefined {
    const started = h.deps.matches.started.at(-1);
    return started?.seats.find((seat) => seat.profileId === profileId)?.deck;
  }

  it("a deck saved between the create and the join does not change the host's deck (§9.8)", async () => {
    const h = freezeHarness();
    const [a, b, c] = h.decks;

    // PREMISE: the deck the host freezes and the one they swap to share no card, so "the match used
    // the frozen deck" and "the match used the saved deck" cannot both be true.
    expect(a).not.toHaveLength(0);
    expect(a.filter((cardId) => c.includes(cardId))).toEqual([]);

    expect((await save(h, h.host, HOST_DECK, a)).status).toBe(200);
    expect((await save(h, h.guest, GUEST_DECK, b)).status).toBe(200);

    // 1. The host opens a room on the deck. The freeze happens here.
    const created = await create(h.router, h.host, { mode: "bo1", deckId: HOST_DECK });
    expect(created.status).toBe(200);
    const { code } = await readJson<{ code: string }>(created);
    expect(h.deps.store.tables.rooms.at(-1)?.hostDeck).toEqual(a);

    // 2. The swap, while the room sits open waiting for somebody to type the code.
    expect((await save(h, h.host, HOST_DECK, c)).status).toBe(200);
    // PREMISE: the save landed — otherwise there is nothing that could leak into the match.
    expect((await h.deps.store.decks.get(HOST_DECK))?.cards).toEqual(c);
    // …and the room is untouched by it.
    expect(h.deps.store.tables.rooms.at(-1)?.hostDeck).toEqual(a);

    // 3. The guest joins on their own deck, so each seat is identifiable.
    expect((await join(h.router, h.guest, code, { mode: "bo1", deckId: GUEST_DECK })).status).toBe(200);

    expect(deckInMatchFor(h, HOST)).toEqual(a);
    expect(deckInMatchFor(h, GUEST)).toEqual(b);
    // The substitute deck reached no seat at all.
    expect(JSON.stringify(h.deps.matches.started)).not.toContain(c[0] ?? "");
  });

  it("the control: the same swap made BEFORE the create is the deck the room freezes", async () => {
    // Without this, the test above would pass against a room that ignored saved decks entirely.
    // Exactly one thing moves between the two: whether the save happens before or after the create.
    const h = freezeHarness();
    const [a, b, c] = h.decks;

    expect((await save(h, h.host, HOST_DECK, a)).status).toBe(200);
    expect((await save(h, h.guest, GUEST_DECK, b)).status).toBe(200);
    expect((await save(h, h.host, HOST_DECK, c)).status).toBe(200);

    const created = await create(h.router, h.host, { mode: "bo1", deckId: HOST_DECK });
    const { code } = await readJson<{ code: string }>(created);
    expect(h.deps.store.tables.rooms.at(-1)?.hostDeck).toEqual(c);

    expect((await join(h.router, h.guest, code, { mode: "bo1", deckId: GUEST_DECK })).status).toBe(200);
    expect(deckInMatchFor(h, HOST)).toEqual(c);
  });
});

// ---------------------------------------------------------------------------
// R264 — rooms carry a mode
// ---------------------------------------------------------------------------

describe("R264 — rooms carry a mode (§9.5, R257)", () => {
  /** Saves three decks and a trio for a profile, returning the trio's id. */
  async function saveTrio(deps: TestDeps, profileId: string, base: number): Promise<string> {
    const ids = [uuid(base), uuid(base + 1), uuid(base + 2)] as [string, string, string];
    for (const [index, id] of ids.entries()) {
      await saveDeck(deps, profileId, id, [`core-00${String(index + 1)}`], `${profileId} ${String(index + 1)}`);
    }
    const trioId = uuid(base + 3);
    const outcome = await deps.store.trios.upsert(
      { id: trioId, profileId, name: `${profileId}'s trio`, deckIds: ids, createdAt: 0, updatedAt: 0 },
      MAX_SAVED_TRIOS,
    );
    expect(outcome).toBe("created");
    return trioId;
  }

  async function createIn(h: Awaited<ReturnType<typeof harness>>, body: Record<string, unknown>): Promise<string> {
    const response = await h.router(jsonRequest("POST", "/api/rooms", body, { token: h.host }));
    expect(response.status).toBe(200);
    return (await readJson<{ code: string }>(response)).code;
  }

  function joinWith(h: Awaited<ReturnType<typeof harness>>, code: string, body: Record<string, unknown>): Promise<Response> {
    return h.router(jsonRequest("POST", `/api/rooms/${code}/join`, body, { token: h.guest }));
  }

  it("R264 answers a create with the room's code, expiry and mode, and freezes the choice", async () => {
    const h = await harness();
    const response = await h.router(
      jsonRequest("POST", "/api/rooms", { mode: "bo1", deckId: uuid(1) }, { token: h.host }),
    );
    const body = await readJson(response);
    const room = h.deps.store.tables.rooms[0];
    // `CreateRoomResponse` in apps/web's api.ts, exactly.
    expect(body).toEqual({ code: room?.code, expiresAt: room?.expiresAt, mode: "bo1" });
    expect(room).toMatchObject({ mode: "bo1", hostDeck: DECK, hostTrio: null });
  });

  it("R264 refuses a join in another mode than the room's, naming the room's mode", async () => {
    const h = await harness();
    const hostTrio = await saveTrio(h.deps, HOST, 20);
    const code = await createIn(h, { mode: "bo3", trioId: hostTrio });

    // A Best-of-1 joiner, and a legacy body with no mode at all (which is Best of 1).
    for (const body of [{ mode: "bo1", deckId: uuid(2) }, { deckIndex: 0 }, { mode: "random" }]) {
      const response = await joinWith(h, code, body);
      const refused = await readJson<ErrorBody>(response);
      expect(response.status).toBe(409);
      expect(refused.error.code).toBe("conflict");
      expect(refused.error.message).toBe("This room plays Conquest: pick one of your trios.");
      expect(refused.error.details).toEqual({ mode: "bo3" });
    }
    // Refused before anything was claimed: the room is still open to the right choice.
    expect(h.deps.store.tables.rooms[0]?.guestProfileId).toBeNull();

    // An All Random room names its own mode the same way.
    const random = await createIn(h, { mode: "random" });
    const wrong = await joinWith(h, random, { deckIndex: 0 });
    expect(wrong.status).toBe(409);
    expect((await readJson<ErrorBody>(wrong)).error.details).toEqual({ mode: "random" });
  });

  it("R264 makes the series when a Best-of-3 room is joined, the host as series p1 and no match yet", async () => {
    const h = await harness({ e2e: true });
    const hostTrio = await saveTrio(h.deps, HOST, 20);
    const guestTrio = await saveTrio(h.deps, GUEST, 30);
    const code = await createIn(h, { mode: "bo3", trioId: hostTrio, seed: "room-series" });
    const room = h.deps.store.tables.rooms[0];
    expect(room?.mode).toBe("bo3");
    expect(room?.hostDeck).toEqual([]);
    expect(room?.hostTrio?.decks.map((deck) => deck.name)).toEqual(["host 1", "host 2", "host 3"]);

    const response = await joinWith(h, code, { mode: "bo3", trioId: guestTrio });
    expect(response.status).toBe(200);

    const [series] = h.deps.store.tables.series;
    expect(await readJson(response)).toEqual({
      matchId: null,
      seriesId: series?.id,
      code,
      seat: "p2",
      mode: "bo3",
    });
    expect(series?.sides.map((side) => side.profileId)).toEqual([HOST, GUEST]);
    expect(series?.sides[0]?.trio).toEqual(room?.hostTrio);
    expect(series?.sides[1]?.trio.name).toBe("guest's trio");
    // R263: game 1's match id is the one the claim reserved; R143: the host's seed is the base.
    expect(series?.nextMatchId).toBe(h.deps.store.tables.rooms[0]?.matchId);
    expect(series?.seedBase).toBe("room-series");
    expect(e2eRoomSeedCount()).toBe(0);
    // The series opens on its pick phase: no match, nobody in one.
    expect(h.deps.matches.started).toEqual([]);
    expect(h.deps.store.tables.profiles.every((row) => row.inMatchId === null)).toBe(true);
  });

  it("R264 deals both decks when an All Random room is joined, and needs no saved deck", async () => {
    const h = await harness();
    // Neither player's saved deck is used: All Random asks for none (R258).
    h.deps.store.tables.decks.length = 0;
    const code = await createIn(h, { mode: "random" });
    expect(h.deps.store.tables.rooms[0]).toMatchObject({ mode: "random", hostDeck: [], hostTrio: null });

    const response = await joinWith(h, code, { mode: "random" });
    expect(response.status).toBe(200);

    const started = h.deps.matches.started[0];
    const seed = started?.seed ?? "";
    expect(await readJson(response)).toEqual({
      matchId: started?.matchId,
      seriesId: null,
      code,
      seat: "p2",
      mode: "random",
    });
    expect(started?.seats.map((seat) => seat.profileId)).toEqual([HOST, GUEST]);
    expect(started?.seats.map((seat) => seat.deck)).toEqual([
      h.deps.dealRandomDeck(`${seed}:p1-deck`),
      h.deps.dealRandomDeck(`${seed}:p2-deck`),
    ]);
    expect((await h.deps.store.profiles.getById(HOST))?.inMatchId).toBe(started?.matchId);
    expect((await h.deps.store.profiles.getById(GUEST))?.inMatchId).toBe(started?.matchId);
  });

  it("R264 keeps a profile in a series from creating or joining a room", async () => {
    const h = await harness();
    const code = await createIn(h, { deckIndex: 0 });
    const trio: FrozenTrio = { name: "t", decks: [{ name: "a", cards: [] }, { name: "b", cards: [] }, { name: "c", cards: [] }] };
    await h.deps.store.series.create({
      id: "series-1",
      sides: [
        { profileId: GUEST, trio, wins: 0, pick: null },
        { profileId: "someone", trio, wins: 0, pick: null },
      ],
      catalogVersion: h.deps.catalog.version,
      seedBase: "s",
      status: "picking",
      games: [],
      nextMatchId: "reserved",
      pickDeadline: null,
      winner: null,
      endReason: null,
      ratingBefore: null,
      ratingAfter: null,
      createdAt: 0,
      updatedAt: 0,
      endedAt: null,
      version: 1,
    });

    const joined = await join(h.router, h.guest, code);
    expect(joined.status).toBe(409);
    const body = await readJson<ErrorBody>(joined);
    expect(body.error.code).toBe("already_in_match");
    expect(body.error.details).toEqual({ seriesId: "series-1" });
    expect(h.deps.store.tables.rooms[0]?.guestProfileId).toBeNull();

    const created = await create(h.router, h.guest, {});
    expect(created.status).toBe(409);
    expect((await readJson<ErrorBody>(created)).error.code).toBe("already_in_match");
    expect(h.deps.store.tables.rooms).toHaveLength(1);
  });

  it("R264 a player queued before joining a Best-of-3 room leaves the queue, so a series that ends before game 1 pairs no one later", async () => {
    const h = await harness();
    const router = createRouter([...createRoomRoutes(), ...createQueueRoutes(), ...createSeriesRoutes()], h.deps);
    const third = h.deps.auth.addUser({ userId: "user-third", email: "third@example.test" });
    h.deps.store.seedProfile({ id: "third", userId: "user-third", status: "active" });
    await saveDeck(h.deps, "third", uuid(90), DECK);

    // The guest waits in the Best-of-1 queue, alone, and meanwhile takes a Best-of-3 challenge.
    const queued = await router(jsonRequest("POST", "/api/queue", { mode: "bo1", deckId: uuid(2) }, { token: h.guest }));
    expect(queued.status).toBe(200);
    const hostTrio = await saveTrio(h.deps, HOST, 20);
    const guestTrio = await saveTrio(h.deps, GUEST, 30);
    const code = await createIn(h, { mode: "bo3", trioId: hostTrio });
    const joined = await router(jsonRequest("POST", `/api/rooms/${code}/join`, { mode: "bo3", trioId: guestTrio }, { token: h.guest }));
    expect(joined.status).toBe(200);
    const { seriesId } = await readJson<{ seriesId: string }>(joined);

    // The series ends before its first game: the guest forfeits at the pick.
    const forfeited = await router(jsonRequest("POST", `/api/series/${seriesId}/forfeit`, undefined, { token: h.guest }));
    expect(forfeited.status).toBe(200);

    // Someone queues for Best of 1. The ticket the guest left behind must not become a match.
    const other = await router(jsonRequest("POST", "/api/queue", { mode: "bo1", deckId: uuid(90) }, { token: third }));
    expect(other.status).toBe(200);
    expect(await readJson(other)).toMatchObject({ status: "open", matchId: null });
    expect(h.deps.matches.started).toEqual([]);
    expect((await h.deps.store.profiles.getById(GUEST))?.inMatchId).toBeNull();
    expect(await h.deps.store.tickets.openForProfile(GUEST)).toBeNull();
  });

  it("a join whose host has gone into another game is refused, and the room stays open", async () => {
    const h = await harness();
    const code = await createIn(h, { deckIndex: 0 });
    await h.deps.store.profiles.setInMatch(HOST, "elsewhere");

    const refused = await join(h.router, h.guest, code);
    expect(refused.status).toBe(409);
    expect((await readJson<ErrorBody>(refused)).error.code).toBe("conflict");
    expect(h.deps.store.tables.rooms[0]?.guestProfileId).toBeNull();
    expect(h.deps.matches.started).toEqual([]);

    // The control: once the host is free the same join goes through.
    await h.deps.store.profiles.setInMatch(HOST, null);
    expect((await join(h.router, h.guest, code)).status).toBe(200);
  });
});
