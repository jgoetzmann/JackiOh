/**
 * SPEC §11 R171 — the deck library's routes (`src/api/decks.ts`, BUILD M9-T1).
 *
 * Not a test of L2–L6: those live in `@jackioh/validator`, which tests them rule by rule, and R171's
 * single-deck check has its own block there. The questions here are the routes' own — §9.4's gate,
 * ownership, the cap, the catalog version, the name — and whether a refusal carries the shared
 * module's sentences out verbatim. So these deps run the real catalog and the real adapter
 * (`sharedDeckValidator`) over R111's launch grant, and every expected message is what the adapter
 * says for the same input, never a typed copy of it.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadCatalog } from "../../src/api/catalog";
import { grantEntireCatalog, ownedMap } from "../../src/api/collection";
import { createDeckRoutes } from "../../src/api/decks";
import { createRouter, type Router } from "../../src/api/http";
import { sharedDeckValidator } from "../../src/api/loadout-validator";
import type { CatalogInfo, LoadoutIssue, StoredDeck } from "../../src/api/ports";
import {
  completeDeck,
  createTestDeps,
  jsonRequest,
  readJson,
  testLimits,
  type TestDeps,
} from "../fakes/deps";

const ME = "me";
const OTHER = "other";

type Body = {
  catalogVersion?: string;
  maxDecks?: number;
  decks?: StoredDeck[];
  deck?: StoredDeck;
  deleted?: boolean;
  error?: { code: string; message: string; details?: unknown };
};

let catalog: CatalogInfo;
let deps: TestDeps;
let router: Router;
let mine: string;
let theirs: string;
/** A deck the shared validator passes strictly, so anything shorter is "incomplete" by its count. */
let full: string[];

beforeAll(async () => {
  catalog = await loadCatalog();
});

async function activeProfile(target: TestDeps, id: string): Promise<string> {
  target.store.seedProfile({ id, userId: `user-${id}`, status: "active" });
  await grantEntireCatalog(target, id);
  return target.auth.addUser({ userId: `user-${id}`, email: `${id}@example.test` });
}

async function wire(libraryDecks?: number): Promise<void> {
  deps = createTestDeps({
    catalog,
    validateDeck: sharedDeckValidator,
    ...(libraryDecks === undefined ? {} : { limits: testLimits({ libraryDecks }) }),
  });
  router = createRouter(createDeckRoutes(), deps);
  mine = await activeProfile(deps, ME);
  theirs = await activeProfile(deps, OTHER);
  full = await completeDeck(deps, ME);
}

beforeEach(async () => {
  await wire();
});

function send(method: string, path: string, token: string, body?: unknown): Promise<Response> {
  return router(jsonRequest(method, path, body, { token }));
}

/** POST without an id, PUT with one; the catalog version is the server's unless a test says not. */
function save(
  token: string,
  draft: Record<string, unknown>,
  deckId?: string,
): Promise<Response> {
  const body = { catalogVersion: deps.catalog.version, ...draft };
  return deckId === undefined
    ? send("POST", "/api/decks", token, body)
    : send("PUT", `/api/decks/${deckId}`, token, body);
}

async function created(token: string, name: string, cards: readonly string[]): Promise<StoredDeck> {
  const response = await save(token, { name, cards });
  expect(response.status).toBe(200);
  const deck = (await readJson<Body>(response)).deck;
  if (deck === undefined) throw new Error("the create returned no deck");
  return deck;
}

async function listed(token: string): Promise<Body> {
  return readJson<Body>(await send("GET", "/api/decks", token));
}

/** What the shared module says about a deck at save time, for the route's answer to be held to. */
async function saveIssues(cards: readonly string[], name: string): Promise<LoadoutIssue[]> {
  return sharedDeckValidator({
    cards,
    name,
    catalogVersion: deps.catalog.version,
    catalog: deps.catalog,
    owned: await ownedMap(deps, ME),
    allowIncomplete: true,
  });
}

describe("R171 — the deck library (§9.4, BUILD M9-T1)", () => {
  it("R171 creates, lists, updates and deletes a deck, most recently saved first", async () => {
    expect(await listed(mine)).toEqual({
      catalogVersion: deps.catalog.version,
      maxDecks: deps.limits.libraryDecks,
      decks: [],
    });

    const aggro = await created(mine, "  Aggro  ", full);
    expect(aggro.name).toBe("Aggro");
    expect(aggro.cards).toEqual(full);

    deps.timers.advance(1_000);
    const control = await created(mine, "Control", full.slice(1));
    expect((await listed(mine)).decks?.map((deck) => deck.id)).toEqual([control.id, aggro.id]);

    deps.timers.advance(1_000);
    const edited = await save(mine, { name: "Aggro v2", cards: full.slice(2) }, aggro.id);
    expect(edited.status).toBe(200);
    expect((await readJson<Body>(edited)).deck).toMatchObject({
      id: aggro.id,
      name: "Aggro v2",
      cards: full.slice(2),
    });
    expect((await listed(mine)).decks?.map((deck) => deck.name)).toEqual(["Aggro v2", "Control"]);

    const gone = await send("DELETE", `/api/decks/${control.id}`, mine);
    expect(gone.status).toBe(200);
    expect(await readJson<Body>(gone)).toEqual({ deleted: true });
    expect((await listed(mine)).decks?.map((deck) => deck.id)).toEqual([aggro.id]);
    expect((await send("DELETE", `/api/decks/${control.id}`, mine)).status).toBe(404);
  });

  it("R171 saves an incomplete deck, which a match would refuse", async () => {
    const short = full.slice(0, -1);
    // PREMISE: the strict check refuses it, so the save below passes because of R171's allowance.
    const strict = sharedDeckValidator({
      cards: short,
      catalogVersion: deps.catalog.version,
      catalog: deps.catalog,
      owned: await ownedMap(deps, ME),
      allowIncomplete: false,
    });
    expect(strict.map((issue) => issue.rule)).toEqual(["L2"]);

    expect((await created(mine, "Half done", short)).cards).toEqual(short);
    expect((await created(mine, "Empty", [])).cards).toEqual([]);
  });

  it("R171 refuses an illegal deck with 422 and the shared validator's own sentences", async () => {
    const token = catalog.cardIds.find((cardId) => catalog.isToken(cardId)) ?? "";
    const extra = catalog.cardIds.find(
      (cardId) => !full.includes(cardId) && !catalog.isToken(cardId) && !catalog.isBanned(cardId),
    );
    const first = full[0] ?? "";
    const illegal: Record<string, string[]> = {
      oversize: [...full, extra ?? ""],
      duplicate: [first, first],
      token: [first, token],
      unknown: [first, "core-does-not-exist"],
    };

    for (const [name, cards] of Object.entries(illegal)) {
      const expected = await saveIssues(cards, name);
      // PREMISE: the validator objects, so the refusal is its verdict and not the route's.
      expect(expected, name).not.toEqual([]);

      const response = await save(mine, { name, cards });
      const body = await readJson<Body>(response);
      expect(response.status, name).toBe(422);
      expect(body.error?.code).toBe("loadout_invalid");
      expect(body.error?.message).toBe(expected[0]?.message);
      expect(body.error?.details).toEqual(expected);
    }
    expect(deps.store.tables.decks).toEqual([]);
  });

  it("R171 answers another profile's deck id with 404, never 403, and leaves it alone", async () => {
    const theirDeck = await created(theirs, "Theirs", full);

    for (const response of [
      await save(mine, { name: "Mine now", cards: [] }, theirDeck.id),
      await send("DELETE", `/api/decks/${theirDeck.id}`, mine),
      await save(mine, { name: "Nobody's", cards: [] }, "not-a-deck-id"),
    ]) {
      expect(response.status).toBe(404);
      expect((await readJson<Body>(response)).error?.code).toBe("not_found");
    }

    expect((await listed(mine)).decks).toEqual([]);
    expect((await listed(theirs)).decks).toEqual([theirDeck]);
  });

  it("R171 refuses a create at the cap with 409, and takes one again after a delete", async () => {
    await wire(2);
    const one = await created(mine, "One", full);
    await created(mine, "Two", full);

    const refused = await save(mine, { name: "Three", cards: full });
    const body = await readJson<Body>(refused);
    expect(refused.status).toBe(409);
    expect(body.error?.code).toBe("conflict");
    expect(body.error?.message).toContain(String(deps.limits.libraryDecks));
    expect((await listed(mine)).decks).toHaveLength(2);
    // The cap is per account: another profile's library is not full.
    expect((await save(theirs, { name: "Theirs", cards: full })).status).toBe(200);

    expect((await send("DELETE", `/api/decks/${one.id}`, mine)).status).toBe(200);
    expect((await save(mine, { name: "Three", cards: full })).status).toBe(200);
  });

  it("R171 refuses a stale catalog version with 409 update_required, before anything else", async () => {
    const deck = await created(mine, "Current", full);
    // An empty name as well: the version is checked first, so a stale client hears "update".
    const stale = { catalogVersion: "stale-version", name: "", cards: full };

    for (const response of [
      await save(mine, stale),
      await save(mine, stale, deck.id),
    ]) {
      const body = await readJson<Body>(response);
      expect(response.status).toBe(409);
      expect(body.error?.code).toBe("update_required");
      expect(body.error?.message).toBe("update required");
    }
    expect((await listed(mine)).decks).toEqual([deck]);
  });

  it("R171 trims the name and bounds it to deckNameMaxLength", async () => {
    const max = deps.limits.deckNameMaxLength;
    for (const name of ["", "   ", "x".repeat(max + 1), 7]) {
      const response = await save(mine, { name, cards: full });
      expect(response.status, String(name)).toBe(400);
      expect((await readJson<Body>(response)).error?.code).toBe("bad_request");
    }
    expect((await created(mine, ` ${"x".repeat(max)} `, full)).name).toBe("x".repeat(max));
  });

  it("R171 requires the cards to be an array of card ids", async () => {
    for (const cards of [undefined, "core-001", [1, 2], [["core-001"]]]) {
      const response = await save(mine, { name: "Shape", cards });
      expect(response.status, JSON.stringify(cards)).toBe(400);
    }
    expect(deps.store.tables.decks).toEqual([]);
  });

  it("R171's routes are all `active`: a pending account gets 403 from each", async () => {
    expect(createDeckRoutes().map((entry) => `${entry.method} ${entry.path} ${entry.auth}`)).toEqual([
      "GET /api/decks active",
      "POST /api/decks active",
      "PUT /api/decks/:id active",
      "DELETE /api/decks/:id active",
    ]);

    deps.store.seedProfile({ id: "pending", userId: "user-pending", status: "pending" });
    const pending = deps.auth.addUser({ userId: "user-pending", email: "pending@example.test" });
    for (const response of [
      await send("GET", "/api/decks", pending),
      await save(pending, { name: "Early", cards: [] }),
    ]) {
      expect(response.status).toBe(403);
      expect((await readJson<Body>(response)).error?.code).toBe("account_pending");
    }
    expect(deps.store.tables.decks).toEqual([]);
  });
});
