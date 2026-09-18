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
 *
 * `createRoomRoutes` takes its loadout module as a parameter (`LoadLoadouts`), which is the seam
 * these tests drive it through: the room rules are what is under test, not the ledger behind them.
 */

import { describe, expect, it } from "vitest";

import { createRouter, type Router } from "../../src/api/http";
import { createLoadoutRoutes, deckFor, validateStoredLoadout } from "../../src/api/loadouts";
import type { Ids, ServerDeps, StoredLoadout } from "../../src/api/ports";
import { CODE_ALPHABET, ROOM_CODE_LENGTH } from "../../src/config";
import {
  createRoomRoutes,
  e2eRoomSeedCount,
  type LoadLoadouts,
} from "../../src/match/rooms";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

const DECK = ["core-001", "core-002", "core-003"];
const HOST = "host";
const GUEST = "guest";

type ErrorBody = { error: { code: string; message: string } };

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

/** The `LoadoutsModule` seam: one stored loadout whose deck 0 is `DECK`. */
const loadouts: LoadLoadouts = async () => ({
  validateStoredLoadout: async (deps: ServerDeps): Promise<StoredLoadout> => ({
    catalogVersion: deps.catalog.version,
    decks: [[...DECK], [], []],
    updatedAt: 0,
  }),
  deckFor: (loadout, deckIndex) => [...(loadout.decks[deckIndex] ?? [])],
});

function harness(
  options: { e2e?: boolean; codes?: readonly string[] } = {},
): { deps: TestDeps; router: Router; host: string; guest: string } {
  const deps = createTestDeps({ ids: roomIds(options.codes) });
  if (options.e2e === true) deps.e2e = true;
  const host = deps.auth.addUser({ userId: "user-host", email: "host@example.test" });
  const guest = deps.auth.addUser({ userId: "user-guest", email: "guest@example.test" });
  deps.store.seedProfile({ id: HOST, userId: "user-host", status: "active" });
  deps.store.seedProfile({ id: GUEST, userId: "user-guest", status: "active" });
  return { deps, router: createRouter(createRoomRoutes(loadouts), deps), host, guest };
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
  h: ReturnType<typeof harness>,
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
    const h = harness();
    const { code } = await playThrough(h);

    expect(code).toHaveLength(ROOM_CODE_LENGTH);
    const started = h.deps.matches.started[0];
    expect(started?.seats.map((seat) => seat.profileId)).toEqual([HOST, GUEST]);
    expect(started?.seats.map((seat) => seat.player)).toEqual(["p1", "p2"]);
    // §9.5: both ends of the lifecycle read the in-match flag.
    expect((await h.deps.store.profiles.getById(HOST))?.inMatchId).toBe(started?.matchId);
    expect((await h.deps.store.profiles.getById(GUEST))?.inMatchId).toBe(started?.matchId);
  });
});

describe("R143 — the optional seed on the room endpoints", () => {
  it("R143 rejects `seed` on POST /api/rooms outside end-to-end mode, and mints no room", async () => {
    const h = harness();

    const response = await create(h.router, h.host, { seed: "05-reconnect" });

    expect(response.status).toBe(400);
    const body = await readJson<ErrorBody>(response);
    expect(body.error.code).toBe("bad_request");
    expect(body.error.message).toMatch(/seed/u);
    // Refused, never ignored: the request bought nothing.
    expect(h.deps.store.tables.rooms).toHaveLength(0);
  });

  it("R143 rejects `seed` on the join endpoint outside end-to-end mode", async () => {
    const h = harness();
    const created = await create(h.router, h.host, {});
    const { code } = await readJson<{ code: string }>(created);

    const response = await join(h.router, h.guest, code, { seed: "05-reconnect" });

    expect(response.status).toBe(400);
    expect((await readJson<ErrorBody>(response)).error.message).toMatch(/seed/u);
    expect(h.deps.matches.started).toHaveLength(0);
  });

  it("R143 uses the host's seed verbatim for the match the join creates, in end-to-end mode", async () => {
    const h = harness({ e2e: true });

    const { seed } = await playThrough(h, { seed: "06-room-code" });

    expect(seed).toBe("06-room-code");
    // Consumed with the room, so nothing accumulates across a long-running server.
    expect(e2eRoomSeedCount()).toBe(0);
  });

  it("R143 takes the joiner's seed when the host supplied none, and the host's when both did", async () => {
    const joinerOnly = harness({ e2e: true });
    expect((await playThrough(joinerOnly, {}, { seed: "from-the-joiner" })).seed).toBe(
      "from-the-joiner",
    );

    // Both: the room was created first, so its seed is the one the match runs on.
    const both = harness({ e2e: true });
    expect((await playThrough(both, { seed: "from-the-host" }, { seed: "from-the-joiner" })).seed)
      .toBe("from-the-host");
    expect(e2eRoomSeedCount()).toBe(0);
  });

  it("R143 still mints a seed when none is supplied (§9.3: the server owns it)", async () => {
    const h = harness({ e2e: true });
    expect((await playThrough(h)).seed).toMatch(/^seed-/u);
  });

  it("R143 refuses a `seed` that is not a non-empty string, even in end-to-end mode", async () => {
    const h = harness({ e2e: true });

    expect((await create(h.router, h.host, { seed: 7 })).status).toBe(400);
    expect((await create(h.router, h.host, { seed: "" })).status).toBe(400);
    expect(h.deps.store.tables.rooms).toHaveLength(0);
  });

  it("R143 drops a seed whose room expired, so an unjoined room cannot leak one", async () => {
    const h = harness({ e2e: true, codes: ["AAA234", "BBB234"] });
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
    const h = harness({ codes: ["AAA234", "AAA234", "AAA234", "BBB234"] });

    const first = await create(h.router, h.host, {});
    expect((await readJson<{ code: string }>(first)).code).toBe("AAA234");

    const second = await create(h.router, h.guest, {});
    expect(second.status).toBe(200);
    expect((await readJson<{ code: string }>(second)).code).toBe("BBB234");
  });

  it("R149 gives up after a bounded number of collisions and says no code is available", async () => {
    // Every attempt mints the same code, which the host's room already holds.
    const h = harness({ codes: ["AAA234"] });
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
 * freezes the host's deck at `POST /api/rooms` ("the chosen deck is frozen into the room the moment
 * it is created, so editing the loadout afterwards cannot change the match") and the match is not
 * created until somebody joins — which may be up to `roomCodeTtlMs` later, with the deckbuilder
 * open the whole time.
 *
 * Unlike the blocks above, these run the **real** `src/api/loadouts.ts` through the `LoadLoadouts`
 * seam and put the real `PUT /api/loadout` on the same router, so "the host saves a different
 * loadout" is the endpoint a player would use and the freeze under test is the production one. The
 * stub `loadouts` the rest of this file uses answers with a constant and could not express a swap.
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

  /** The real loadout module behind the seam `createRoomRoutes` was given for exactly this. */
  const realLoadouts: LoadLoadouts = async () => ({ validateStoredLoadout, deckFor });

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
      router: createRouter([...createRoomRoutes(realLoadouts), ...createLoadoutRoutes()], deps),
      host,
      guest,
      decks: decksOf(deps),
    };
  }

  function save(
    h: ReturnType<typeof freezeHarness>,
    token: string,
    decks: string[][],
  ): Promise<Response> {
    return h.router(
      jsonRequest(
        "PUT",
        "/api/loadout",
        { catalogVersion: h.deps.catalog.version, decks },
        { token },
      ),
    );
  }

  /** The deck the started match gave this profile's seat. */
  function deckInMatchFor(h: ReturnType<typeof freezeHarness>, profileId: string): string[] | undefined {
    const started = h.deps.matches.started.at(-1);
    return started?.seats.find((seat) => seat.profileId === profileId)?.deck;
  }

  it("a loadout saved between the create and the join does not change the host's deck (§9.8)", async () => {
    const h = freezeHarness();
    const [a, b, c] = h.decks;

    // PREMISE: the deck the host freezes and the one they swap to share no card, so "the match used
    // the frozen deck" and "the match used the current loadout" cannot both be true.
    expect(a).not.toHaveLength(0);
    expect(a.filter((cardId) => c.includes(cardId))).toEqual([]);

    expect((await save(h, h.host, [a, b, c])).status).toBe(200);
    expect((await save(h, h.guest, [a, b, c])).status).toBe(200);

    // 1. The host opens a room on deck 0. The freeze happens here.
    const created = await create(h.router, h.host, { deckIndex: 0 });
    expect(created.status).toBe(200);
    const { code } = await readJson<{ code: string }>(created);
    expect(h.deps.store.tables.rooms.at(-1)?.hostDeck).toEqual(a);

    // 2. The swap, while the room sits open waiting for somebody to type the code.
    expect((await save(h, h.host, [c, b, a])).status).toBe(200);
    // PREMISE: the save landed — otherwise there is nothing that could leak into the match.
    expect((await h.deps.store.loadouts.get(HOST))?.decks[0]).toEqual(c);
    // …and the room is untouched by it.
    expect(h.deps.store.tables.rooms.at(-1)?.hostDeck).toEqual(a);

    // 3. The guest joins on deck 1, which is neither of the host's two, so each seat is identifiable.
    expect((await join(h.router, h.guest, code, { deckIndex: 1 })).status).toBe(200);

    expect(deckInMatchFor(h, HOST)).toEqual(a);
    expect(deckInMatchFor(h, GUEST)).toEqual(b);
    // The substitute deck reached no seat at all.
    expect(JSON.stringify(h.deps.matches.started)).not.toContain(c[0] ?? "");
  });

  it("the control: the same swap made BEFORE the create is the deck the room freezes", async () => {
    // Without this, the test above would pass against a room that ignored loadouts entirely.
    // Exactly one thing moves between the two: whether the save happens before or after the create.
    const h = freezeHarness();
    const [a, b, c] = h.decks;

    expect((await save(h, h.host, [a, b, c])).status).toBe(200);
    expect((await save(h, h.guest, [a, b, c])).status).toBe(200);
    expect((await save(h, h.host, [c, b, a])).status).toBe(200);

    const created = await create(h.router, h.host, { deckIndex: 0 });
    const { code } = await readJson<{ code: string }>(created);
    expect(h.deps.store.tables.rooms.at(-1)?.hostDeck).toEqual(c);

    expect((await join(h.router, h.guest, code, { deckIndex: 1 })).status).toBe(200);
    expect(deckInMatchFor(h, HOST)).toEqual(c);
  });
});
