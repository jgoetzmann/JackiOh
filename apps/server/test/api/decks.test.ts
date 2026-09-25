/**
 * Saved decks and trios (`src/api/decks.ts`, SPEC §9.4, R250–R256) and the queue-time helpers the
 * queue and the rooms share (`readModeChoice`, `freezeChoice`, `assertNotInSeries`; R253, R257,
 * R264).
 *
 * What this file is NOT: a test of D1–D4, T1–T3 or L1–L6. Those rules live in `@jackioh/validator`
 * and are tested there, rule by rule and message by message. Here the questions are the endpoints'
 * own: is the id a UUID, is the catalog current, are the draft issues passed through untouched, what
 * does each store outcome answer, and is another profile's id indistinguishable from a missing one.
 * Every expected issue below is the shared module's own verdict for the same input, computed here,
 * never a sentence typed out.
 *
 * The rulings, by their test titles:
 *  - R250: a save checks structure only (D1–D4), at most `MAX_SAVED_DECKS` decks;
 *  - R252: T1–T3, at most `MAX_SAVED_TRIOS` trios, a deleted deck empties its slots;
 *  - R256: `PUT` is an idempotent upsert keyed by the client's id;
 *  - R341: a trio import is checked like every save and written all or nothing, under both caps
 *    (R340);
 *  - R165: a profile with nothing saved is refused as a deck failure, not a missing resource.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
  assertNotInSeries,
  createDeckRoutes,
  freezeChoice,
  readModeChoice,
  type DeckView,
  type TrioView,
} from "../../src/api/decks";
import { ApiError, createRouter, type Router } from "../../src/api/http";
import { checkDeckDraft, checkImportRoom, checkTrioDraft, normalizeName } from "../../src/api/loadout-validator";
import type { FrozenTrio, LoadoutValidateInput, SavedDeck, SeriesRow } from "../../src/api/ports";
import {
  DECK_NAME_MAX_LENGTH,
  DRAFT_ISSUES_REPORTED_MAX,
  MAX_SAVED_DECKS,
  MAX_SAVED_TRIOS,
} from "../../src/config";
import { createTestDeps, jsonRequest, readJson, type TestDeps } from "../fakes/deps";

const PROFILE = "p1";
const OTHER = "p2";

/** A client-minted id (R256): a UUID, made readable by its last digits. */
function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

type ErrorBody = { error: { code: string; message: string; details?: unknown } };
type DecksBody = {
  catalogVersion: string;
  decks: DeckView[];
  trios: TrioView[];
  limits: { decks: number; trios: number; nameLength: number };
};

let deps: TestDeps;
let router: Router;
let token: string;
let otherToken: string;

function activeProfile(target: TestDeps, id: string): string {
  const userId = `user-${id}`;
  target.store.seedProfile({ id, userId, status: "active" });
  return target.auth.addUser({ userId, email: `${id}@example.test` });
}

/** Distinct playable ids of the test catalog, from `start`. */
function cards(target: TestDeps, count: number, start = 0): string[] {
  return target.catalog.cardIds
    .filter((cardId) => !target.catalog.isToken(cardId))
    .slice(start, start + count);
}

function putDeck(body: Record<string, unknown>, id = uuid(1), bearer = token): Promise<Response> {
  return router(jsonRequest("PUT", `/api/decks/${id}`, body, { token: bearer }));
}

function putTrio(body: Record<string, unknown>, id = uuid(101), bearer = token): Promise<Response> {
  return router(jsonRequest("PUT", `/api/trios/${id}`, body, { token: bearer }));
}

function deckBody(target: TestDeps, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { name: "Aggro", cards: cards(target, 4), catalogVersion: target.catalog.version, ...overrides };
}

/** A trio import's body (R341): three decks of disjoint cards, ids from `base`, and the trio. */
function importBody(target: TestDeps, base = 500, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    catalogVersion: target.catalog.version,
    trio: { id: uuid(base), name: "Shared trio" },
    slots: [0, 1, 2].map((slot) => ({
      id: uuid(base + 1 + slot),
      name: `Imported ${String(slot + 1)}`,
      cards: cards(target, 3, slot * 3),
    })),
    ...overrides,
  };
}

function postImport(body: Record<string, unknown>, bearer = token): Promise<Response> {
  return router(jsonRequest("POST", "/api/trios/import", body, { token: bearer }));
}

async function getDecks(bearer = token): Promise<DecksBody> {
  const response = await router(jsonRequest("GET", "/api/decks", undefined, { token: bearer }));
  expect(response.status).toBe(200);
  return readJson<DecksBody>(response);
}

/** The shared module's verdict for a deck draft, exactly as the route must pass it on. */
function draftIssues(target: TestDeps, name: string, deck: readonly string[]): ReturnType<typeof checkDeckDraft> {
  const known = new Set(target.catalog.cardIds);
  return checkDeckDraft({
    name: normalizeName(name),
    cards: deck,
    isDeckable: (cardId) => known.has(cardId) && !target.catalog.isToken(cardId),
    nameMaxLength: DECK_NAME_MAX_LENGTH,
  });
}

async function apiError(fn: () => Promise<unknown>): Promise<ApiError> {
  try {
    await fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    return error as ApiError;
  }
  throw new Error("expected the call to reject");
}

beforeEach(() => {
  deps = createTestDeps();
  router = createRouter(createDeckRoutes(), deps);
  token = activeProfile(deps, PROFILE);
  otherToken = activeProfile(deps, OTHER);
});

// ---------------------------------------------------------------------------
// Decks
// ---------------------------------------------------------------------------

describe("saved decks (§9.4, R250, R256)", () => {
  it("R250 creates a deck, reads it back and replaces it, keeping when it was made", async () => {
    const created = await putDeck(deckBody(deps));
    expect(created.status).toBe(200);
    const first = (await readJson<{ deck: DeckView }>(created)).deck;
    expect(first).toEqual({
      id: uuid(1),
      name: "Aggro",
      cards: cards(deps, 4),
      catalogVersion: deps.catalog.version,
      createdAt: deps.timers.now(),
      updatedAt: deps.timers.now(),
    });
    // The owner is the caller; the answer carries no profile id (`SavedDeck` in apps/web's api.ts).
    expect(first).not.toHaveProperty("profileId");

    deps.timers.advance(5_000);
    const renamed = await putDeck(deckBody(deps, { name: "  Aggro   v2 ", cards: cards(deps, 2, 10) }));
    expect(renamed.status).toBe(200);
    const second = (await readJson<{ deck: DeckView }>(renamed)).deck;
    // Stored as `normalizeName` leaves it; the same row, made when it was made, changed now.
    expect(second.name).toBe("Aggro v2");
    expect(second.cards).toEqual(cards(deps, 2, 10));
    expect(second.createdAt).toBe(first.createdAt);
    expect(second.updatedAt).toBe(deps.timers.now());

    const listed = await getDecks();
    expect(listed.catalogVersion).toBe(deps.catalog.version);
    expect(listed.decks).toEqual([second]);
    expect(listed.trios).toEqual([]);
    expect(listed.limits).toEqual({
      decks: MAX_SAVED_DECKS,
      trios: MAX_SAVED_TRIOS,
      nameLength: DECK_NAME_MAX_LENGTH,
    });
  });

  it("R250 saves a draft: an incomplete deck and an unowned card are both kept", async () => {
    // Nothing is granted to this profile, and one card is far short of a legal deck: the save
    // judges neither (L2, L5 are the queue's), only D1–D4.
    const response = await putDeck(deckBody(deps, { cards: cards(deps, 1) }));
    expect(response.status).toBe(200);
    expect(await deps.store.collection.get(PROFILE)).toEqual([]);
    expect(deps.store.tables.decks).toHaveLength(1);
  });

  it("R256 is an idempotent upsert: the same PUT twice makes one deck, not two", async () => {
    const body = deckBody(deps);
    const once = await readJson<{ deck: DeckView }>(await putDeck(body));
    // A retry after a dropped connection: same id, same body.
    const again = await putDeck(body);
    expect(again.status).toBe(200);
    expect((await readJson<{ deck: DeckView }>(again)).deck).toEqual(once.deck);
    expect(deps.store.tables.decks).toHaveLength(1);
    expect((await getDecks()).decks).toHaveLength(1);
  });

  it("R256 answers an id that is not even valid percent-encoding as a bad id (400), never a 500", async () => {
    for (const raw of ["%E0%A4%A", "%ZZ", "%"]) {
      const put = await router(jsonRequest("PUT", `/api/decks/${raw}`, deckBody(deps), { token }));
      expect(put.status, `PUT /api/decks/${raw}`).toBe(400);
      const removed = await router(jsonRequest("DELETE", `/api/trios/${raw}`, undefined, { token }));
      expect(removed.status, `DELETE /api/trios/${raw}`).toBe(400);
    }
    expect(deps.store.tables.decks).toEqual([]);
  });

  it("R256 lists decks oldest first, the order a legacy deckIndex counts in", async () => {
    await putDeck(deckBody(deps, { name: "First" }), uuid(9));
    deps.timers.advance(1_000);
    await putDeck(deckBody(deps, { name: "Second" }), uuid(3));
    deps.timers.advance(1_000);
    // Updating the first does not move it: the order is by creation.
    await putDeck(deckBody(deps, { name: "First again" }), uuid(9));

    expect((await getDecks()).decks.map((deck) => deck.name)).toEqual(["First again", "Second"]);
  });

  describe("R250 refuses a draft that breaks D1–D4, with the shared module's own issues", () => {
    const cases: { rule: string; build: (target: TestDeps) => { name: string; cards: string[] } }[] = [
      { rule: "D1", build: (target) => ({ name: "   ", cards: cards(target, 2) }) },
      { rule: "D1", build: (target) => ({ name: "x".repeat(DECK_NAME_MAX_LENGTH + 1), cards: cards(target, 2) }) },
      { rule: "D1", build: (target) => ({ name: "Bad\u0007name", cards: cards(target, 2) }) },
      // A right-to-left override makes a name show text it does not hold; a zero-width space hides one.
      { rule: "D1", build: (target) => ({ name: "Aggro\u202eorez", cards: cards(target, 2) }) },
      { rule: "D1", build: (target) => ({ name: "\u200b", cards: cards(target, 2) }) },
      // One more than any deck holds: the test catalog has room for it.
      { rule: "D2", build: (target) => ({ name: "Big", cards: cards(target, 21) }) },
      { rule: "D3", build: (target) => ({ name: "Token", cards: [...cards(target, 2), "token-sheep"] }) },
      { rule: "D3", build: (target) => ({ name: "Unknown", cards: [...cards(target, 2), "core-does-not-exist"] }) },
      { rule: "D4", build: (target) => ({ name: "Twice", cards: [...cards(target, 2), ...cards(target, 1)] }) },
    ];

    for (const [index, { rule, build }] of cases.entries()) {
      it(`R250 ${rule} (case ${String(index + 1)}) is a 400 carrying every issue, and writes nothing`, async () => {
        const draft = build(deps);
        const expected = draftIssues(deps, draft.name, draft.cards);
        // PREMISE: the shared module really refuses this draft, and for the rule named.
        expect(expected.map((issue) => issue.rule)).toContain(rule);

        const response = await putDeck(deckBody(deps, draft));
        const body = await readJson<ErrorBody>(response);

        expect(response.status).toBe(400);
        expect(body.error.code).toBe("bad_request");
        expect(body.error.details).toEqual(expected);
        expect(body.error.message).toBe(expected[0]?.message);
        expect(deps.store.tables.decks).toEqual([]);
      });
    }
  });

  it("R250 lists at most DRAFT_ISSUES_REPORTED_MAX issues, so a body of junk cannot buy a huge answer", async () => {
    const junk = Array.from({ length: DRAFT_ISSUES_REPORTED_MAX * 4 }, (_, i) => `junk-${String(i)}`);
    const response = await putDeck(deckBody(deps, { cards: junk }));
    const body = await readJson<ErrorBody>(response);
    expect(response.status).toBe(400);
    expect(body.error.details).toHaveLength(DRAFT_ISSUES_REPORTED_MAX);
    // The first issue is still the message: the one a player reads.
    expect(body.error.message).toBe(draftIssues(deps, "Aggro", junk)[0]?.message);
    expect(deps.store.tables.decks).toEqual([]);
  });

  it('refuses a stale catalogVersion with 409 "update required", before judging the cards', async () => {
    // A card the stale client knows and this catalog does not: the useful answer is the update,
    // not D3's "not a card a deck can hold".
    const response = await putDeck(
      deckBody(deps, { catalogVersion: "stale-0", cards: ["core-from-the-future"] }),
    );
    const body = await readJson<ErrorBody>(response);
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("update_required");
    expect(body.error.message).toBe("update required");
    expect(deps.store.tables.decks).toEqual([]);
  });

  it("R250 refuses a deck past MAX_SAVED_DECKS with a 409 naming the limit", async () => {
    for (let n = 1; n <= MAX_SAVED_DECKS; n += 1) {
      expect((await putDeck(deckBody(deps, { name: `Deck ${String(n)}` }), uuid(n))).status).toBe(200);
    }
    const response = await putDeck(deckBody(deps, { name: "One too many" }), uuid(MAX_SAVED_DECKS + 1));
    const body = await readJson<ErrorBody>(response);

    expect(response.status).toBe(409);
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({ limit: MAX_SAVED_DECKS });
    expect(deps.store.tables.decks).toHaveLength(MAX_SAVED_DECKS);

    // The control: at the cap, an existing deck can still be saved — the cap is on creating.
    expect((await putDeck(deckBody(deps, { name: "Renamed" }), uuid(1))).status).toBe(200);
  });

  it("answers another profile's deck id as 404, and leaves that deck alone", async () => {
    expect((await putDeck(deckBody(deps, { name: "Mine" }), uuid(1), otherToken)).status).toBe(200);

    const response = await putDeck(deckBody(deps, { name: "Hijacked" }), uuid(1));
    expect(response.status).toBe(404);
    expect((await readJson<ErrorBody>(response)).error.code).toBe("not_found");
    expect((await deps.store.decks.get(uuid(1)))?.name).toBe("Mine");

    // DELETE of it is "nothing to delete", exactly as for an id nobody has.
    const removed = await router(jsonRequest("DELETE", `/api/decks/${uuid(1)}`, undefined, { token }));
    expect(await readJson(removed)).toEqual({ deleted: false });
    const missing = await router(jsonRequest("DELETE", `/api/decks/${uuid(77)}`, undefined, { token }));
    expect(await readJson(missing)).toEqual({ deleted: false });
    expect(deps.store.tables.decks).toHaveLength(1);
    // …and GET never lists it for the wrong profile.
    expect((await getDecks()).decks).toEqual([]);
  });

  it("deletes a deck idempotently", async () => {
    await putDeck(deckBody(deps));
    const first = await router(jsonRequest("DELETE", `/api/decks/${uuid(1)}`, undefined, { token }));
    expect(await readJson(first)).toEqual({ deleted: true });
    const second = await router(jsonRequest("DELETE", `/api/decks/${uuid(1)}`, undefined, { token }));
    expect(second.status).toBe(200);
    expect(await readJson(second)).toEqual({ deleted: false });
  });

  it("refuses an id that is not a UUID, and a malformed body, before touching the store", async () => {
    let touched = 0;
    deps.store.onCall = (method) => {
      if (method.startsWith("decks.") || method.startsWith("trios.")) touched += 1;
    };
    for (const id of ["not-a-uuid", "1234", `${uuid(1)}x`]) {
      expect((await putDeck(deckBody(deps), id)).status).toBe(400);
      const removed = await router(jsonRequest("DELETE", `/api/decks/${id}`, undefined, { token }));
      expect(removed.status).toBe(400);
    }
    for (const body of [
      { cards: [], catalogVersion: deps.catalog.version },
      { name: 7, cards: [], catalogVersion: deps.catalog.version },
      { name: "A", cards: "core-001", catalogVersion: deps.catalog.version },
      { name: "A", cards: [1, 2], catalogVersion: deps.catalog.version },
      { name: "A", cards: [] },
    ]) {
      expect((await putDeck(body)).status).toBe(400);
    }
    expect(touched).toBe(0);
  });

  it("accepts an upper-case UUID as the same id Postgres would print", async () => {
    const upper = uuid(5).toUpperCase();
    expect((await putDeck(deckBody(deps), upper)).status).toBe(200);
    expect(deps.store.tables.decks[0]?.id).toBe(uuid(5));
  });
});

// ---------------------------------------------------------------------------
// Trios
// ---------------------------------------------------------------------------

describe("saved trios (§9.4, R252)", () => {
  async function threeDecks(bearer = token, base = 1): Promise<[string, string, string]> {
    const ids: [string, string, string] = [uuid(base), uuid(base + 1), uuid(base + 2)];
    for (const [index, id] of ids.entries()) {
      const response = await putDeck(deckBody(deps, { name: `Deck ${String(index + 1)}` }), id, bearer);
      expect(response.status).toBe(200);
    }
    return ids;
  }

  it("R252 saves a trio of three slots, any of them empty, and reads it back", async () => {
    const [a, , c] = await threeDecks();
    const response = await putTrio({ name: " Main  trio ", deckIds: [a, null, c] });
    expect(response.status).toBe(200);
    const saved = (await readJson<{ trio: TrioView }>(response)).trio;
    expect(saved).toEqual({
      id: uuid(101),
      name: "Main trio",
      deckIds: [a, null, c],
      createdAt: deps.timers.now(),
      updatedAt: deps.timers.now(),
    });
    expect((await getDecks()).trios).toEqual([saved]);
  });

  it("R252 saves a trio whose decks share cards: that is the queue's to judge (R253)", async () => {
    // `deckBody` gives every deck the same four cards, so all three decks overlap completely.
    const ids = await threeDecks();
    expect((await putTrio({ name: "Loose", deckIds: ids })).status).toBe(200);
  });

  it("R256 re-PUTs a trio idempotently", async () => {
    const ids = await threeDecks();
    const body = { name: "Trio", deckIds: ids };
    const once = await readJson<{ trio: TrioView }>(await putTrio(body));
    const again = await putTrio(body);
    expect(again.status).toBe(200);
    expect((await readJson<{ trio: TrioView }>(again)).trio).toEqual(once.trio);
    expect(deps.store.tables.trios).toHaveLength(1);
  });

  it("R252 refuses T1–T3 with the shared module's own issues", async () => {
    const [a, b] = await threeDecks();
    const drafts = [
      { name: "", deckIds: [a, b, null] },
      { name: "Two slots", deckIds: [a, b] },
      { name: "Twice", deckIds: [a, a, b] },
    ];
    for (const draft of drafts) {
      const expected = checkTrioDraft({
        name: normalizeName(draft.name),
        deckIds: draft.deckIds,
        nameMaxLength: DECK_NAME_MAX_LENGTH,
      });
      expect(expected).not.toEqual([]);
      const response = await putTrio(draft);
      const body = await readJson<ErrorBody>(response);
      expect(response.status).toBe(400);
      expect(body.error.code).toBe("bad_request");
      expect(body.error.details).toEqual(expected);
      expect(body.error.message).toBe(expected[0]?.message);
    }
    expect(deps.store.tables.trios).toEqual([]);
  });

  it("R252 refuses a trio past MAX_SAVED_TRIOS with a 409 naming the limit", async () => {
    const ids = await threeDecks();
    for (let n = 1; n <= MAX_SAVED_TRIOS; n += 1) {
      expect((await putTrio({ name: `Trio ${String(n)}`, deckIds: ids }, uuid(200 + n))).status).toBe(200);
    }
    const response = await putTrio({ name: "Too many", deckIds: ids }, uuid(300));
    const body = await readJson<ErrorBody>(response);
    expect(response.status).toBe(409);
    expect(body.error.code).toBe("conflict");
    expect(body.error.details).toEqual({ limit: MAX_SAVED_TRIOS });
    expect(deps.store.tables.trios).toHaveLength(MAX_SAVED_TRIOS);
  });

  it("R252 refuses a slot naming a deck this profile has not saved, with details.unknownDeck", async () => {
    const [a, b] = await threeDecks();
    const [foreign] = await threeDecks(otherToken, 50);

    for (const stranger of [uuid(999), foreign]) {
      const response = await putTrio({ name: "Trio", deckIds: [a, b, stranger] });
      const body = await readJson<ErrorBody>(response);
      expect(response.status).toBe(409);
      expect(body.error.code).toBe("conflict");
      expect(body.error.details).toEqual({ unknownDeck: true });
    }
    expect(deps.store.tables.trios).toEqual([]);
  });

  it("answers another profile's trio id as 404", async () => {
    const theirs = await threeDecks(otherToken, 50);
    expect((await putTrio({ name: "Theirs", deckIds: theirs }, uuid(101), otherToken)).status).toBe(200);
    const mine = await threeDecks();

    const response = await putTrio({ name: "Mine now", deckIds: mine }, uuid(101));
    expect(response.status).toBe(404);
    expect((await deps.store.trios.get(uuid(101)))?.name).toBe("Theirs");
    const removed = await router(jsonRequest("DELETE", `/api/trios/${uuid(101)}`, undefined, { token }));
    expect(await readJson(removed)).toEqual({ deleted: false });
  });

  it("R252 empties every slot that named a deleted deck, and keeps the trio", async () => {
    const [a, b, c] = await threeDecks();
    await putTrio({ name: "Keeps", deckIds: [a, b, c] });
    await putTrio({ name: "Also", deckIds: [b, null, a] }, uuid(102));

    const removed = await router(jsonRequest("DELETE", `/api/decks/${a}`, undefined, { token }));
    expect(await readJson(removed)).toEqual({ deleted: true });

    const trios = (await getDecks()).trios;
    expect(trios.map((trio) => trio.deckIds)).toEqual([
      [null, b, c],
      [b, null, null],
    ]);
  });

  it("deletes a trio idempotently and leaves its decks", async () => {
    const ids = await threeDecks();
    await putTrio({ name: "Gone", deckIds: ids });
    const first = await router(jsonRequest("DELETE", `/api/trios/${uuid(101)}`, undefined, { token }));
    expect(await readJson(first)).toEqual({ deleted: true });
    const second = await router(jsonRequest("DELETE", `/api/trios/${uuid(101)}`, undefined, { token }));
    expect(await readJson(second)).toEqual({ deleted: false });
    expect((await getDecks()).decks).toHaveLength(3);
  });

  it("refuses slots that are not deck ids or null", async () => {
    for (const deckIds of ["nope", [1, null, null], ["not-a-uuid", null, null]]) {
      expect((await putTrio({ name: "Bad", deckIds })).status).toBe(400);
    }
  });
});

// ---------------------------------------------------------------------------
// A trio import (R340, R341)
// ---------------------------------------------------------------------------

describe("a trio import (§9.4, R340, R341)", () => {
  type ImportAnswer = { decks: DeckView[]; trio: TrioView };

  it("R341 makes the code's decks and the trio naming them, in one request", async () => {
    const answer = await postImport(importBody(deps));
    expect(answer.status).toBe(200);
    const body = await readJson<ImportAnswer>(answer);
    expect(body.decks.map((deck) => [deck.id, deck.name, deck.cards])).toEqual([
      [uuid(501), "Imported 1", cards(deps, 3, 0)],
      [uuid(502), "Imported 2", cards(deps, 3, 3)],
      [uuid(503), "Imported 3", cards(deps, 3, 6)],
    ]);
    expect(body.trio).toMatchObject({ id: uuid(500), name: "Shared trio", deckIds: [uuid(501), uuid(502), uuid(503)] });
    const listed = await getDecks();
    expect(listed.decks.map((deck) => deck.id)).toEqual([uuid(501), uuid(502), uuid(503)]);
    expect(listed.trios.map((trio) => trio.id)).toEqual([uuid(500)]);
  });

  it("R341 keeps an empty slot empty, unowned cards and cards the decks share: drafts, judged at queue", async () => {
    const shared = cards(deps, 2, 0);
    const body = importBody(deps, 600, {
      slots: [
        { id: uuid(601), name: "One", cards: shared },
        null,
        { id: uuid(603), name: "Three", cards: shared },
      ],
    });
    const answer = await postImport(body);
    expect(answer.status).toBe(200);
    const saved = await readJson<ImportAnswer>(answer);
    expect(saved.trio.deckIds).toEqual([uuid(601), null, uuid(603)]);
    expect(saved.decks.map((deck) => deck.cards)).toEqual([shared, shared]);
  });

  it("R341 is idempotent: the same ids again update what the first attempt made and take no new slot", async () => {
    expect((await postImport(importBody(deps))).status).toBe(200);
    for (let n = 0; n < MAX_SAVED_DECKS - 3; n += 1) {
      expect((await putDeck(deckBody(deps, { name: `Filler ${String(n)}` }), uuid(700 + n))).status).toBe(200);
    }
    // At the deck cap now, and the retry still lands: its decks are already this profile's.
    const retry = await postImport(importBody(deps));
    expect(retry.status).toBe(200);
    const listed = await getDecks();
    expect(listed.decks).toHaveLength(MAX_SAVED_DECKS);
    expect(listed.trios).toHaveLength(1);
  });

  it("R340 refuses an import past the deck cap with exactly the slots it needs, and writes nothing", async () => {
    for (let n = 0; n < MAX_SAVED_DECKS - 1; n += 1) {
      expect((await putDeck(deckBody(deps, { name: `Deck ${String(n)}` }), uuid(700 + n))).status).toBe(200);
    }
    const answer = await postImport(importBody(deps));
    expect(answer.status).toBe(409);
    const body = await readJson<ErrorBody>(answer);
    const room = checkImportRoom({
      saved: { decks: MAX_SAVED_DECKS - 1, trios: 0 },
      limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS },
      adding: { decks: 3, trios: 1 },
    });
    expect(room.ok).toBe(false);
    expect(body.error).toEqual({
      code: "conflict",
      message: `${room.ok ? "" : room.message} Nothing was imported.`,
      details: { decksShort: 2, triosShort: 0, limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS } },
    });
    const listed = await getDecks();
    expect(listed.decks).toHaveLength(MAX_SAVED_DECKS - 1);
    expect(listed.trios).toEqual([]);
  });

  it("R340 refuses an import past the trio cap the same way", async () => {
    for (let n = 0; n < MAX_SAVED_TRIOS; n += 1) {
      expect((await putTrio({ name: `Trio ${String(n)}`, deckIds: [null, null, null] }, uuid(800 + n))).status).toBe(200);
    }
    const answer = await postImport(importBody(deps));
    expect(answer.status).toBe(409);
    expect((await readJson<ErrorBody>(answer)).error.details).toMatchObject({ decksShort: 0, triosShort: 1 });
    expect(deps.store.tables.decks).toEqual([]);
  });

  it("R341 rolls every deck back when a later write fails, so a failure part-way leaves nothing", async () => {
    let upserts = 0;
    deps.store.onCall = (method) => {
      if (method === "trios.upsert") throw new Error("the database went away");
      if (method === "decks.upsert") upserts += 1;
    };
    const answer = await postImport(importBody(deps));
    expect(answer.status).toBe(500);
    expect(upserts).toBe(3);
    deps.store.onCall = () => undefined;
    expect(deps.store.tables.decks).toEqual([]);
    expect(deps.store.tables.trios).toEqual([]);
  });

  it("R341 checks what the client sends like any save: D1–D4 per deck, T1 for the trio, the catalog, the shape", async () => {
    const unknownCard = await postImport(
      importBody(deps, 500, {
        slots: [
          { id: uuid(501), name: "Fine", cards: cards(deps, 2) },
          { id: uuid(502), name: "Bad", cards: ["core-999"] },
          null,
        ],
      }),
    );
    expect(unknownCard.status).toBe(400);
    const issue = draftIssues(deps, "Bad", ["core-999"])[0];
    expect((await readJson<ErrorBody>(unknownCard)).error.message).toBe(`Deck 2 (“Bad”): ${issue?.message ?? ""}`);

    const noName = await postImport(importBody(deps, 500, { trio: { id: uuid(500), name: "   " } }));
    expect(noName.status).toBe(400);
    const trioIssue = checkTrioDraft({ name: "", deckIds: [null, null, null], nameMaxLength: DECK_NAME_MAX_LENGTH })[0];
    expect((await readJson<ErrorBody>(noName)).error.message).toBe(trioIssue?.message);

    const stale = await postImport(importBody(deps, 500, { catalogVersion: "stale" }));
    expect(stale.status).toBe(409);
    expect((await readJson<ErrorBody>(stale)).error.code).toBe("update_required");

    const twice = await postImport(
      importBody(deps, 500, {
        slots: [
          { id: uuid(501), name: "A", cards: [] },
          { id: uuid(501), name: "B", cards: [] },
          null,
        ],
      }),
    );
    expect(twice.status).toBe(400);
    expect((await readJson<ErrorBody>(twice)).error.message).toBe(
      checkTrioDraft({ name: "T", deckIds: [uuid(501), uuid(501), null], nameMaxLength: DECK_NAME_MAX_LENGTH })[0]?.message,
    );

    for (const bad of [
      { ...importBody(deps), slots: [null, null] },
      { ...importBody(deps), slots: "three" },
      { ...importBody(deps), trio: { id: "not-a-uuid", name: "T" } },
      { ...importBody(deps), trio: null },
      { ...importBody(deps), slots: [{ id: uuid(1), name: 5, cards: [] }, null, null] },
      { ...importBody(deps), slots: [{ id: uuid(1), name: "N", cards: [7] }, null, null] },
    ]) {
      const refused = await postImport(bad);
      expect(refused.status).toBe(400);
    }
    expect(deps.store.tables.decks).toEqual([]);
    expect(deps.store.tables.trios).toEqual([]);
  });

  it("R341 answers ids another profile owns as missing, and writes nothing of the import", async () => {
    expect((await putDeck(deckBody(deps), uuid(502), otherToken)).status).toBe(200);
    const answer = await postImport(importBody(deps));
    expect(answer.status).toBe(404);
    expect(deps.store.tables.decks.map((deck) => deck.id)).toEqual([uuid(502)]);
    expect(deps.store.tables.trios).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §9.4's gate
// ---------------------------------------------------------------------------

describe("the routes (§9.4: a pending account sees no decks)", () => {
  it("declares every deck and trio route `active`", () => {
    const routes = createDeckRoutes();
    expect(routes.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "GET /api/decks",
      "PUT /api/decks/:id",
      "DELETE /api/decks/:id",
      "PUT /api/trios/:id",
      "POST /api/trios/import",
      "DELETE /api/trios/:id",
    ]);
    expect(routes.every((entry) => entry.auth === "active")).toBe(true);
  });

  it("a pending account gets 403 from each, and nothing is written", async () => {
    deps.store.seedProfile({ id: "pending", userId: "user-pending", status: "pending" });
    const pending = deps.auth.addUser({ userId: "user-pending", email: "pending@example.test" });

    const responses = [
      await router(jsonRequest("GET", "/api/decks", undefined, { token: pending })),
      await putDeck(deckBody(deps), uuid(1), pending),
      await router(jsonRequest("DELETE", `/api/decks/${uuid(1)}`, undefined, { token: pending })),
      await putTrio({ name: "T", deckIds: [null, null, null] }, uuid(101), pending),
      await router(jsonRequest("DELETE", `/api/trios/${uuid(101)}`, undefined, { token: pending })),
      await router(jsonRequest("POST", "/api/trios/import", importBody(deps), { token: pending })),
    ];
    for (const response of responses) {
      expect(response.status).toBe(403);
      expect((await readJson<ErrorBody>(response)).error.code).toBe("account_pending");
    }
    expect(deps.store.tables.decks).toEqual([]);
    expect(deps.store.tables.trios).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The queue-time helpers
// ---------------------------------------------------------------------------

describe("readModeChoice (R257)", () => {
  it("reads the three modes, and a body with no mode as Best of 1", () => {
    expect(readModeChoice({ mode: "bo1", deckId: uuid(1) })).toEqual({ mode: "bo1", deckId: uuid(1) });
    expect(readModeChoice({ deckId: uuid(1) })).toEqual({ mode: "bo1", deckId: uuid(1) });
    expect(readModeChoice({ mode: "bo3", trioId: uuid(2) })).toEqual({ mode: "bo3", trioId: uuid(2) });
    expect(readModeChoice({ mode: "random" })).toEqual({ mode: "random" });
    // Fields another mode would need are not read, so a lobby that sends them does no harm.
    expect(readModeChoice({ mode: "random", deckId: "whatever" })).toEqual({ mode: "random" });
  });

  it("R257 takes a legacy deckIndex in place of deckId, and deckId when both are sent", () => {
    expect(readModeChoice({ deckIndex: 0 })).toEqual({ mode: "bo1", deckIndex: 0 });
    expect(readModeChoice({ mode: "bo1", deckIndex: 4 })).toEqual({ mode: "bo1", deckIndex: 4 });
    expect(readModeChoice({ deckId: uuid(3), deckIndex: 0 })).toEqual({ mode: "bo1", deckId: uuid(3) });
  });

  it("refuses anything malformed with a 400", () => {
    for (const body of [
      { mode: "bo5" },
      { mode: 1 },
      {},
      { mode: "bo1" },
      { deckId: "not-a-uuid" },
      { deckId: 7 },
      { deckIndex: -1 },
      { deckIndex: 1.5 },
      { deckIndex: "0" },
      { mode: "bo3" },
      { mode: "bo3", trioId: "nope" },
      { mode: "bo3", deckId: uuid(1) },
    ]) {
      let caught: unknown;
      try {
        readModeChoice(body);
      } catch (error) {
        caught = error;
      }
      expect(caught, JSON.stringify(body)).toBeInstanceOf(ApiError);
      expect((caught as ApiError).status).toBe(400);
    }
  });
});

describe("freezeChoice (R253: what a ticket or a room keeps)", () => {
  function savedDeck(id: string, name: string, deck: string[], profileId = PROFILE, at = 0): SavedDeck {
    return { id, profileId, name, cards: deck, catalogVersion: "old-0", createdAt: at, updatedAt: at };
  }

  /** A validator that approves and remembers what it was asked. */
  function recording(target: TestDeps): Omit<LoadoutValidateInput, "catalog">[] {
    const seen: Omit<LoadoutValidateInput, "catalog">[] = [];
    target.validateLoadout = ({ catalog: _catalog, ...rest }) => {
      seen.push(rest);
      return [];
    };
    return seen;
  }

  it("R253 freezes a Best-of-1 deck by id, checked as one deck with its own name", async () => {
    const seen = recording(deps);
    await deps.store.decks.upsert(savedDeck(uuid(1), "Aggro", cards(deps, 3)), MAX_SAVED_DECKS);

    const frozen = await freezeChoice(deps, PROFILE, { mode: "bo1", deckId: uuid(1) });

    expect(frozen).toEqual({ mode: "bo1", deck: { name: "Aggro", cards: cards(deps, 3) } });
    expect(seen).toEqual([
      {
        decks: [cards(deps, 3)],
        names: ["Aggro"],
        scope: "deck",
        // The CURRENT catalog, whatever the deck was saved under (R253).
        catalogVersion: deps.catalog.version,
        owned: new Map(),
      },
    ]);
  });

  it("R253 freezes a copy: editing the saved deck afterwards cannot reach it", async () => {
    await deps.store.decks.upsert(savedDeck(uuid(1), "Aggro", cards(deps, 3)), MAX_SAVED_DECKS);
    const frozen = await freezeChoice(deps, PROFILE, { mode: "bo1", deckId: uuid(1) });
    await deps.store.decks.upsert(savedDeck(uuid(1), "Changed", cards(deps, 3, 10)), MAX_SAVED_DECKS);
    expect(frozen).toEqual({ mode: "bo1", deck: { name: "Aggro", cards: cards(deps, 3) } });
  });

  it("R257 reads a legacy deckIndex as a position in the saved list, oldest first", async () => {
    await deps.store.decks.upsert(savedDeck(uuid(7), "Newer", cards(deps, 2, 5), PROFILE, 20), MAX_SAVED_DECKS);
    await deps.store.decks.upsert(savedDeck(uuid(8), "Older", cards(deps, 2), PROFILE, 10), MAX_SAVED_DECKS);

    expect(await freezeChoice(deps, PROFILE, { mode: "bo1", deckIndex: 0 })).toEqual({
      mode: "bo1",
      deck: { name: "Older", cards: cards(deps, 2) },
    });
    expect(await freezeChoice(deps, PROFILE, { mode: "bo1", deckIndex: 1 })).toEqual({
      mode: "bo1",
      deck: { name: "Newer", cards: cards(deps, 2, 5) },
    });
    const past = await apiError(() => freezeChoice(deps, PROFILE, { mode: "bo1", deckIndex: 2 }));
    expect(past.code).toBe("loadout_invalid");
  });

  it("R165 makes queueing with nothing saved a deck failure (422), not a missing resource", async () => {
    const error = await apiError(() => freezeChoice(deps, PROFILE, { mode: "bo1", deckIndex: 0 }));
    expect(error.code).toBe("loadout_invalid");
    expect(error.status).toBe(422);
    expect(error.status).not.toBe(404);
    expect(error.message).toMatch(/deck/iu);
    // The premise: this profile really has saved nothing.
    expect(await deps.store.decks.list(PROFILE)).toEqual([]);
  });

  it("R165 answers a deck or trio that is gone, or is another profile's, the same way", async () => {
    await deps.store.decks.upsert(savedDeck(uuid(1), "Theirs", cards(deps, 2), OTHER), MAX_SAVED_DECKS);
    for (const choice of [
      { mode: "bo1", deckId: uuid(1) },
      { mode: "bo1", deckId: uuid(2) },
      { mode: "bo3", trioId: uuid(3) },
    ] as const) {
      const error = await apiError(() => freezeChoice(deps, PROFILE, choice));
      expect(error.code).toBe("loadout_invalid");
      expect(error.status).toBe(422);
    }
  });

  it("R253 passes the validator's issues through as a 422, first sentence as the message", async () => {
    await deps.store.decks.upsert(savedDeck(uuid(1), "Aggro", cards(deps, 3)), MAX_SAVED_DECKS);
    const issues = [
      { rule: "L2", message: "Aggro is short.", deck: 1 },
      { rule: "L5", message: "Aggro uses a card you do not own.", deck: 1, cardId: "core-001" },
    ];
    deps.validateLoadout = () => issues;

    const error = await apiError(() => freezeChoice(deps, PROFILE, { mode: "bo1", deckId: uuid(1) }));
    expect(error.code).toBe("loadout_invalid");
    expect(error.message).toBe("Aggro is short.");
    expect(error.details).toEqual(issues);
  });

  it("R253 freezes a trio's three decks in slot order, checked together with their names", async () => {
    const seen = recording(deps);
    await deps.store.decks.upsert(savedDeck(uuid(1), "One", cards(deps, 2, 0)), MAX_SAVED_DECKS);
    await deps.store.decks.upsert(savedDeck(uuid(2), "Two", cards(deps, 2, 2)), MAX_SAVED_DECKS);
    await deps.store.decks.upsert(savedDeck(uuid(3), "Three", cards(deps, 2, 4)), MAX_SAVED_DECKS);
    await deps.store.trios.upsert(
      { id: uuid(9), profileId: PROFILE, name: "Main", deckIds: [uuid(3), uuid(1), uuid(2)], createdAt: 0, updatedAt: 0 },
      MAX_SAVED_TRIOS,
    );

    const frozen = await freezeChoice(deps, PROFILE, { mode: "bo3", trioId: uuid(9) });

    expect(frozen).toEqual({
      mode: "bo3",
      trio: {
        name: "Main",
        decks: [
          { name: "Three", cards: cards(deps, 2, 4) },
          { name: "One", cards: cards(deps, 2, 0) },
          { name: "Two", cards: cards(deps, 2, 2) },
        ],
      },
    });
    expect(seen.map(({ decks, names, scope }) => ({ decks, names, scope }))).toEqual([
      {
        decks: [cards(deps, 2, 4), cards(deps, 2, 0), cards(deps, 2, 2)],
        names: ["Three", "One", "Two"],
        scope: "trio",
      },
    ]);
  });

  it("R253 hands the validator only the filled slots, so an empty one is L1's to refuse", async () => {
    const seen = recording(deps);
    await deps.store.decks.upsert(savedDeck(uuid(1), "One", cards(deps, 2)), MAX_SAVED_DECKS);
    await deps.store.trios.upsert(
      { id: uuid(9), profileId: PROFILE, name: "Gappy", deckIds: [uuid(1), null, null], createdAt: 0, updatedAt: 0 },
      MAX_SAVED_TRIOS,
    );
    // The recording validator approves everything, so what follows is the wiring guard: a port that
    // lets a two-deck trio through is a fault, never a frozen trio with a hole in it.
    await expect(freezeChoice(deps, PROFILE, { mode: "bo3", trioId: uuid(9) })).rejects.toThrow();
    expect(seen[0]?.decks).toEqual([cards(deps, 2)]);
    expect(seen[0]?.scope).toBe("trio");
  });

  it("R258 freezes nothing for All Random, and asks the validator nothing", async () => {
    const seen = recording(deps);
    expect(await freezeChoice(deps, PROFILE, { mode: "random" })).toEqual({ mode: "random" });
    expect(seen).toEqual([]);
  });
});

describe("assertNotInSeries (R264)", () => {
  function series(status: SeriesRow["status"]): SeriesRow {
    const trio: FrozenTrio = { name: "T", decks: [{ name: "a", cards: [] }, { name: "b", cards: [] }, { name: "c", cards: [] }] };
    return {
      id: `series-${status}`,
      sides: [
        { profileId: PROFILE, trio, wins: 0, pick: null },
        { profileId: OTHER, trio, wins: 0, pick: null },
      ],
      catalogVersion: deps.catalog.version,
      seedBase: "seed",
      status,
      games: [],
      nextMatchId: `match-${status}`,
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

  it("R264 refuses a profile in a series that is not over, naming the series", async () => {
    await deps.store.series.create(series("picking"));
    const error = await apiError(() => assertNotInSeries(deps, PROFILE));
    expect(error.code).toBe("already_in_match");
    expect(error.status).toBe(409);
    expect(error.message).toBe("Finish your Conquest series first.");
    expect(error.details).toEqual({ seriesId: "series-picking" });
  });

  it("R264's control: a series that is over holds nobody", async () => {
    await deps.store.series.create(series("over"));
    await expect(assertNotInSeries(deps, PROFILE)).resolves.toBeUndefined();
  });
});
