/**
 * Saved decks and trios (SPEC §9.4, R250–R256), and what a queue ticket or a room is made with
 * (R253, R257, R264).
 *
 * This file replaces the single three-deck loadout. A profile keeps up to `MAX_SAVED_DECKS` named
 * decks and up to `MAX_SAVED_TRIOS` trios built from them, and both are DRAFTS (R250, R252): a
 * save checks structure only — D1–D4 for a deck, T1–T3 for a trio — and legality is judged when a
 * deck or a trio is queued (R253). So the save routes below never call the L1–L6 validator, and
 * the queue-time helpers at the bottom always do.
 *
 * No rule is written here. D1–D4, T1–T3 and `normalizeName` are `@jackioh/validator`'s, reached
 * through `loadout-validator.ts` (the server's one importer of that package); L1–L6 are the
 * `LoadoutValidator` port. Every refusal passes the shared module's issues through untouched as
 * `details`, with the first one's sentence as the message, so the deck builder and the server say
 * the same words (§9.4: "one validator module shared by client and server").
 *
 * Ids are minted by the client (`crypto.randomUUID()`), which is what makes `PUT` an idempotent
 * upsert a dropped connection can simply retry (R256). The store decides create-or-update, the
 * cap and ownership in one statement under a lock on the profile (`app.upsert_deck`,
 * `app.upsert_trio`), so nothing here reads before it writes.
 */

import {
  DECK_NAME_MAX_LENGTH,
  DRAFT_ISSUES_REPORTED_MAX,
  MAX_SAVED_DECKS,
  MAX_SAVED_TRIOS,
} from "../config";
import { callerProfile, ownedMap } from "./collection";
import { ApiError, badRequest, ok, route, str, stringList, type Route } from "./http";
import { checkDeckDraft, checkImportRoom, checkTrioDraft, normalizeName, TRIO_DECKS } from "./loadout-validator";
import type {
  FrozenDeck,
  FrozenTrio,
  SavedDeck,
  SavedTrio,
  ServerDeps,
  Store,
  TrioSlots,
} from "./ports";

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

/**
 * A deck or trio id is a UUID (R256: the client mints it with `crypto.randomUUID()`). Checked
 * before any store call, because Postgres would answer a malformed one with a type error — a 500
 * for what is a malformed request. Case-insensitive on the way in and lower case from then on,
 * which is how Postgres prints a `uuid`, so both stores hold the same string for the same id.
 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

function savedIdOf(raw: unknown): string | null {
  return typeof raw === "string" && UUID_SHAPE.test(raw) ? raw.toLowerCase() : null;
}

function pathIdOf(raw: string | undefined, what: "deck" | "trio"): string {
  const id = savedIdOf(raw);
  if (id === null) throw badRequest(`that is not a ${what} id`);
  return id;
}

// ---------------------------------------------------------------------------
// What the client sees
// ---------------------------------------------------------------------------

/** `SavedDeck` in `apps/web/src/net/api.ts`: the row without its owner, who is the caller. */
export type DeckView = Omit<SavedDeck, "profileId">;
/** `SavedTrio` in `apps/web/src/net/api.ts`. */
export type TrioView = Omit<SavedTrio, "profileId">;

function deckView(deck: SavedDeck): DeckView {
  return {
    id: deck.id,
    name: deck.name,
    cards: [...deck.cards],
    catalogVersion: deck.catalogVersion,
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
  };
}

function trioView(trio: SavedTrio): TrioView {
  return {
    id: trio.id,
    name: trio.name,
    deckIds: [...trio.deckIds],
    createdAt: trio.createdAt,
    updatedAt: trio.updatedAt,
  };
}

/** The caps the builder lives under (`DecksResponse.limits`): R250's and R252's numbers. */
const LIMITS = {
  decks: MAX_SAVED_DECKS,
  trios: MAX_SAVED_TRIOS,
  nameLength: DECK_NAME_MAX_LENGTH,
} as const;

/**
 * Another profile's id is answered as if it did not exist (the store's `not_owner`), so an id
 * reveals nothing about anyone else's decks. With client-minted UUIDs no one can guess one anyway;
 * this keeps the answer honest if one ever leaks.
 */
/**
 * A save refused by D1–D4 or T1–T3: the first issue's sentence, and the issues in `details`, at
 * most `DRAFT_ISSUES_REPORTED_MAX` of them so a body of junk cannot buy an answer many times its
 * own size.
 */
function draftRefused(message: string, issues: readonly unknown[]): ApiError {
  return new ApiError("bad_request", message, issues.slice(0, DRAFT_ISSUES_REPORTED_MAX));
}

function notFound(what: "deck" | "trio"): ApiError {
  return new ApiError("not_found", `There is no such ${what}.`);
}

// ---------------------------------------------------------------------------
// Body readers
// ---------------------------------------------------------------------------

/**
 * A name must be a string, and that is all this checks: an empty or over-long one is D1's (or
 * T1's) to refuse, in the shared module's own sentence, so `str` — which refuses an empty string
 * with a sentence of its own — is not used here.
 */
function nameOf(body: Readonly<Record<string, unknown>>): string {
  const value = body["name"];
  if (typeof value !== "string") throw badRequest('"name" must be a string');
  return value;
}

/** A trio's slots: deck ids or `null`. How many there are is T2's to judge. */
function slotsOf(body: Readonly<Record<string, unknown>>): (string | null)[] {
  const value = body["deckIds"];
  const bad = badRequest('"deckIds" must be a list of deck ids or null');
  if (!Array.isArray(value)) throw bad;
  return value.map((entry: unknown) => {
    if (entry === null) return null;
    const id = savedIdOf(entry);
    if (id === null) throw bad;
    return id;
  });
}

/**
 * §9.4: the catalog is "static, versioned, shipped with the client", and R253 checks the version a
 * client sends at save: a builder one release behind would otherwise save ids it cannot know are
 * gone. Checked before D3, which would call those ids undeckable when the real problem is the
 * client. BUILD M6-T2's acceptance item is literally 'a stale `catalogVersion` gets "update
 * required"', so that is the message.
 */
function assertCurrentCatalog(deps: ServerDeps, catalogVersion: string): void {
  if (catalogVersion !== deps.catalog.version) {
    throw new ApiError("update_required", "update required", {
      expected: deps.catalog.version,
      received: catalogVersion,
    });
  }
}

/** R250 D3, R251: a deckable card is one the current catalog has and that is not a Token. */
function deckableIn(deps: ServerDeps): (cardId: string) => boolean {
  const known = new Set(deps.catalog.cardIds);
  return (cardId) => known.has(cardId) && !deps.catalog.isToken(cardId);
}


// ---------------------------------------------------------------------------
// A trio import (R340, R341)
// ---------------------------------------------------------------------------

/** One deck of an imported trio, as the body carries it: its client-minted id, name and cards. */
type ImportedDeckInput = { id: string; name: string; cards: string[] };

type TrioImportInput = {
  catalogVersion: string;
  trio: { id: string; name: string };
  /** Slot by slot; null is a slot the code left empty. */
  slots: (ImportedDeckInput | null)[];
};

const IMPORT_SHAPE =
  'A trio import is { catalogVersion, trio: { id, name }, slots: [3 × ({ id, name, cards } or null)] }';

function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/**
 * R341: the body, read without trusting any of it. Shapes are checked here (ids are UUIDs, names
 * are strings, cards are lists of strings, exactly `TRIO_DECKS` slots); what the shapes hold is the
 * draft rules' to judge, in their own words.
 */
function importOf(body: Readonly<Record<string, unknown>>): TrioImportInput {
  const catalogVersion = str(body, "catalogVersion");
  const trio = recordOf(body["trio"]);
  const trioId = savedIdOf(trio?.["id"]);
  if (trio === null || trioId === null || typeof trio["name"] !== "string") throw badRequest(IMPORT_SHAPE);
  const rawSlots = body["slots"];
  if (!Array.isArray(rawSlots) || rawSlots.length !== TRIO_DECKS) throw badRequest(IMPORT_SHAPE);
  const slots = rawSlots.map((raw: unknown): ImportedDeckInput | null => {
    if (raw === null) return null;
    const deck = recordOf(raw);
    const id = savedIdOf(deck?.["id"]);
    if (deck === null || id === null || typeof deck["name"] !== "string") throw badRequest(IMPORT_SHAPE);
    return { id, name: deck["name"], cards: stringList(deck, "cards") };
  });
  return { catalogVersion, trio: { id: trioId, name: trio["name"] }, slots };
}

/** "Deck 2 (“Aggro”)": which of the code's decks a refusal is about. */
function importedDeckLabel(slot: number, name: string): string {
  return `Deck ${String(slot + 1)} (“${name}”)`;
}

/**
 * R340: the room check, in the words the workshop shows, against what `t` holds now. Ids the
 * caller already owns are a retry of an import that landed (R256's idempotent upsert): they take no
 * new slot.
 */
async function assertImportRoom(
  t: Store,
  profileId: string,
  deckIds: readonly string[],
  trioId: string,
): Promise<void> {
  const decks = await t.decks.list(profileId);
  const trios = await t.trios.list(profileId);
  const heldDecks = new Set(decks.map((deck) => deck.id));
  const room = checkImportRoom({
    saved: { decks: decks.length, trios: trios.length },
    limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS },
    adding: {
      decks: deckIds.filter((id) => !heldDecks.has(id)).length,
      trios: trios.some((trio) => trio.id === trioId) ? 0 : 1,
    },
  });
  if (!room.ok) {
    throw new ApiError("conflict", `${room.message} Nothing was imported.`, {
      decksShort: room.decksShort,
      triosShort: room.triosShort,
      limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS },
    });
  }
}

/** Thrown inside the import's transaction to roll back every write made before it. */
function importOutcomeRefused(what: "deck" | "trio", outcome: string): ApiError {
  if (outcome === "not_owner") return notFound(what);
  // A cap reached between the room check and the write: another tab or device saved meanwhile.
  return new ApiError("conflict", "Your decks changed while this import was on its way. Nothing was imported; try again.");
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `GET /api/decks`, `PUT`/`DELETE /api/decks/:id`, `PUT`/`DELETE /api/trios/:id` and
 * `POST /api/trios/import` (R341). All `active`, so a pending account gets 403 from each (§9.4:
 * "no collection, loadout, queue or match").
 */
export function createDeckRoutes(): Route[] {
  return [
    /**
     * Everything the builder opens on, oldest first (the order a legacy `deckIndex` reads), with the
     * server's catalog version so a stale client finds out before it builds rather than at save.
     */
    route("GET", "/api/decks", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const decks = await deps.store.decks.list(profile.id);
      const trios = await deps.store.trios.list(profile.id);
      return ok({
        catalogVersion: deps.catalog.version,
        decks: decks.map(deckView),
        trios: trios.map(trioView),
        limits: LIMITS,
      });
    }),

    /** R250, R256: create or replace one deck. D1–D4 only: a draft may be incomplete or unowned. */
    route("PUT", "/api/decks/:id", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const id = pathIdOf(req.params["id"], "deck");
      const rawName = nameOf(req.body);
      const cards = stringList(req.body, "cards");
      const catalogVersion = str(req.body, "catalogVersion");

      assertCurrentCatalog(deps, catalogVersion);
      const name = normalizeName(rawName);
      const issues = checkDeckDraft({
        name,
        cards,
        isDeckable: deckableIn(deps),
        nameMaxLength: DECK_NAME_MAX_LENGTH,
      });
      const first = issues[0];
      if (first !== undefined) throw draftRefused(first.message, issues);

      const now = deps.timers.now();
      // `createdAt` is only read on a create; an update keeps the stored one (the store's contract).
      const outcome = await deps.store.decks.upsert(
        {
          id,
          profileId: profile.id,
          name,
          cards: [...cards],
          catalogVersion,
          createdAt: now,
          updatedAt: now,
        },
        MAX_SAVED_DECKS,
      );
      if (outcome === "not_owner") throw notFound("deck");
      if (outcome === "limit") {
        throw new ApiError(
          "conflict",
          `You can keep ${String(MAX_SAVED_DECKS)} decks at most; delete one to save another.`,
          { limit: MAX_SAVED_DECKS },
        );
      }

      // Read back rather than echo the request, so the answer carries the kept `createdAt`.
      const saved = await deps.store.decks.get(id);
      // Deleted between the write and the read by the same player's other tab: say so plainly.
      if (saved === null || saved.profileId !== profile.id) throw notFound("deck");
      deps.log.info("deck.saved", { profileId: profile.id, deckId: id, outcome, cards: cards.length });
      return ok({ deck: deckView(saved) });
    }),

    /**
     * Idempotent: `deleted: false` when this profile has no deck with that id, whoever else might.
     * Every trio slot that named the deck becomes empty in the same statement (R252).
     */
    route("DELETE", "/api/decks/:id", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const id = pathIdOf(req.params["id"], "deck");
      const deleted = await deps.store.decks.remove(profile.id, id);
      if (deleted) deps.log.info("deck.deleted", { profileId: profile.id, deckId: id });
      return ok({ deleted });
    }),

    /**
     * R252, R256: create or replace one trio. T1–T3 only: its decks may be incomplete or share
     * cards, which R253 judges at queue. A slot naming a deck this profile has not saved (yet) is a
     * conflict the client resolves by saving that deck first — an offline draft syncing out of order.
     */
    route("PUT", "/api/trios/:id", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const id = pathIdOf(req.params["id"], "trio");
      const rawName = nameOf(req.body);
      const deckIds = slotsOf(req.body);

      const name = normalizeName(rawName);
      const issues = checkTrioDraft({ name, deckIds, nameMaxLength: DECK_NAME_MAX_LENGTH });
      const first = issues[0];
      if (first !== undefined) throw draftRefused(first.message, issues);
      // T2 has passed, so there are exactly three slots.
      const slots = deckIds as TrioSlots;

      const now = deps.timers.now();
      const outcome = await deps.store.trios.upsert(
        { id, profileId: profile.id, name, deckIds: slots, createdAt: now, updatedAt: now },
        MAX_SAVED_TRIOS,
      );
      if (outcome === "not_owner") throw notFound("trio");
      if (outcome === "limit") {
        throw new ApiError(
          "conflict",
          `You can keep ${String(MAX_SAVED_TRIOS)} trios at most; delete one to save another.`,
          { limit: MAX_SAVED_TRIOS },
        );
      }
      if (outcome === "unknown_deck") {
        throw new ApiError(
          "conflict",
          "This trio names a deck that is not saved yet; save the deck first.",
          { unknownDeck: true },
        );
      }

      const saved = await deps.store.trios.get(id);
      if (saved === null || saved.profileId !== profile.id) throw notFound("trio");
      deps.log.info("trio.saved", { profileId: profile.id, trioId: id, outcome });
      return ok({ trio: trioView(saved) });
    }),

    /**
     * R340, R341: import a trio code's decks and the trio naming them, all or nothing. The client
     * decoded the code (R339) and minted every id; this checks all of it as any save would — the
     * catalog version, D1–D4 for each deck, T1–T3 for the trio — and then the room under both caps
     * (R340). A refusal names what to fix and nothing is written; otherwise every deck and then the
     * trio are upserted in one transaction, so a write that fails part-way rolls the others back.
     * Sending the same ids again (a retry after a dropped answer) updates what the first attempt
     * made and takes no new slot. Unowned cards and cards the decks share are kept: both are
     * judged at queue (R253), and the workshop marks them.
     */
    route("POST", "/api/trios/import", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const input = importOf(req.body);
      assertCurrentCatalog(deps, input.catalogVersion);

      const isDeckable = deckableIn(deps);
      const decks = input.slots.map((deck, slot) => {
        if (deck === null) return null;
        const name = normalizeName(deck.name);
        const issues = checkDeckDraft({ name, cards: deck.cards, isDeckable, nameMaxLength: DECK_NAME_MAX_LENGTH });
        const first = issues[0];
        if (first !== undefined) {
          throw draftRefused(`${importedDeckLabel(slot, name)}: ${first.message}`, issues);
        }
        return { id: deck.id, name, cards: [...deck.cards] };
      });
      const deckIds = decks.map((deck) => deck?.id ?? null);
      const trioName = normalizeName(input.trio.name);
      const trioIssues = checkTrioDraft({ name: trioName, deckIds, nameMaxLength: DECK_NAME_MAX_LENGTH });
      const firstTrioIssue = trioIssues[0];
      if (firstTrioIssue !== undefined) throw draftRefused(firstTrioIssue.message, trioIssues);
      const filledIds = deckIds.filter((id): id is string => id !== null);

      const now = deps.timers.now();
      await deps.store.tx(async (t) => {
        await assertImportRoom(t, profile.id, filledIds, input.trio.id);
        // Each deck one millisecond after the one before: the list is oldest first with ties broken
        // on the id, and the ids are random, so one instant for all three would list them in any
        // order rather than in their slots' (R341).
        let order = 0;
        for (const deck of decks) {
          if (deck === null) continue;
          const at = now + order;
          order += 1;
          const outcome = await t.decks.upsert(
            { ...deck, profileId: profile.id, catalogVersion: input.catalogVersion, createdAt: at, updatedAt: at },
            MAX_SAVED_DECKS,
          );
          if (outcome !== "created" && outcome !== "updated") throw importOutcomeRefused("deck", outcome);
        }
        const outcome = await t.trios.upsert(
          {
            id: input.trio.id,
            profileId: profile.id,
            name: trioName,
            deckIds: deckIds as TrioSlots,
            createdAt: now,
            updatedAt: now,
          },
          MAX_SAVED_TRIOS,
        );
        if (outcome !== "created" && outcome !== "updated") throw importOutcomeRefused("trio", outcome);
      });

      // Read back, as a single save does, so the answer carries the kept `createdAt`s.
      const savedDecks: DeckView[] = [];
      for (const id of filledIds) {
        const saved = await deps.store.decks.get(id);
        if (saved === null || saved.profileId !== profile.id) throw notFound("deck");
        savedDecks.push(deckView(saved));
      }
      const savedTrio = await deps.store.trios.get(input.trio.id);
      if (savedTrio === null || savedTrio.profileId !== profile.id) throw notFound("trio");
      deps.log.info("trio.imported", { profileId: profile.id, trioId: input.trio.id, decks: filledIds.length });
      return ok({ decks: savedDecks, trio: trioView(savedTrio) });
    }),

    /** Idempotent, as the deck's. The decks it named are untouched. */
    route("DELETE", "/api/trios/:id", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const id = pathIdOf(req.params["id"], "trio");
      const deleted = await deps.store.trios.remove(profile.id, id);
      if (deleted) deps.log.info("trio.deleted", { profileId: profile.id, trioId: id });
      return ok({ deleted });
    }),
  ];
}

// ---------------------------------------------------------------------------
// The queue-time half: what a ticket or a room is made with (R253, R257, R264)
// ---------------------------------------------------------------------------

/**
 * What `POST /api/queue`, `POST /api/rooms` and `POST /api/rooms/:code/join` were asked for, parsed
 * but not yet looked up. R257's legacy form — no `mode`, and a `deckIndex` in place of `deckId` —
 * is the second Best-of-1 shape.
 */
export type ModeChoiceInput =
  | { mode: "bo1"; deckId: string }
  | { mode: "bo1"; deckIndex: number }
  | { mode: "bo3"; trioId: string }
  | { mode: "random" };

/** What a ticket or a room freezes (§9.4: "Decks are frozen into the queue ticket"). */
export type FrozenChoice =
  | { mode: "bo1"; deck: FrozenDeck }
  | { mode: "bo3"; trio: FrozenTrio }
  | { mode: "random" };

/**
 * R257: `{ mode: "bo1", deckId } | { mode: "bo3", trioId } | { mode: "random" }`. A body with no
 * `mode` is Best-of-1, and a `deckIndex` (0-based, in `decks.list` order, oldest first) may stand
 * in for `deckId` — what a client from before the modes sends. Only the fields the mode needs are
 * read; anything malformed among them is a 400.
 */
export function readModeChoice(body: Readonly<Record<string, unknown>>): ModeChoiceInput {
  const mode = body["mode"] ?? "bo1";
  if (mode !== "bo1" && mode !== "bo3" && mode !== "random") {
    throw badRequest('"mode" must be "bo1", "bo3" or "random"');
  }
  if (mode === "random") return { mode };

  if (mode === "bo3") {
    const trioId = savedIdOf(body["trioId"]);
    if (trioId === null) throw badRequest('Conquest needs "trioId", the id of one of your trios');
    return { mode, trioId };
  }

  const rawDeckId = body["deckId"];
  if (rawDeckId !== undefined && rawDeckId !== null) {
    const deckId = savedIdOf(rawDeckId);
    if (deckId === null) throw badRequest('"deckId" must be the id of one of your decks');
    return { mode, deckId };
  }
  const deckIndex = body["deckIndex"];
  if (deckIndex === undefined || deckIndex === null) {
    throw badRequest('Best of 1 needs "deckId", the id of one of your decks');
  }
  if (typeof deckIndex !== "number" || !Number.isInteger(deckIndex) || deckIndex < 0) {
    throw badRequest('"deckIndex" must be a whole number, counting your decks from 0');
  }
  return { mode, deckIndex };
}

/**
 * R165, generalised by R253: every refusal the player fixes in the deck builder is a
 * `loadout_invalid` (422), never a 404 — a missing deck, a deleted trio and a profile with nothing
 * saved at all are all "go and build one", and a 404 would send a client looking for a route that
 * is working correctly.
 */
const DECK_GONE = "That deck is no longer saved; pick another.";
const TRIO_GONE = "That trio is no longer saved; pick another.";
const NOTHING_SAVED = "Build and save a deck before queueing.";

function refused(message: string): ApiError {
  return new ApiError("loadout_invalid", message);
}

/** One of this profile's own decks by id, or null — another profile's deck is not theirs to play. */
async function ownDeck(deps: ServerDeps, profileId: string, deckId: string): Promise<SavedDeck | null> {
  const deck = await deps.store.decks.get(deckId);
  return deck !== null && deck.profileId === profileId ? deck : null;
}

async function chosenDeck(
  deps: ServerDeps,
  profileId: string,
  choice: Extract<ModeChoiceInput, { mode: "bo1" }>,
): Promise<SavedDeck> {
  if ("deckId" in choice) {
    const deck = await ownDeck(deps, profileId, choice.deckId);
    if (deck === null) throw refused(DECK_GONE);
    return deck;
  }
  const decks = await deps.store.decks.list(profileId);
  if (decks.length === 0) throw refused(NOTHING_SAVED);
  const deck = decks[choice.deckIndex];
  if (deck === undefined) throw refused(DECK_GONE);
  return deck;
}

/**
 * The single call to the shared validator at queue time (§9.4: "at save and again at queue").
 * R253: `scope` picks the rules — L2, L3, L5, L6 for one deck, L1–L6 for a trio — and `names`
 * lets every sentence name the deck as the player named it. L5 needs the entitlements, so the
 * collection is read and handed in; L6 is checked against the CURRENT catalog, whatever version the
 * deck was saved under (R253: a saved deck's own version is no reason to refuse it).
 *
 * The first issue's message becomes the error's and every issue rides along as `details`, exactly
 * as reported: no renumbering, no recomposed sentence.
 */
function assertLegal(
  deps: ServerDeps,
  owned: ReadonlyMap<string, number>,
  decks: readonly SavedDeck[],
  scope: "deck" | "trio",
): void {
  const issues = deps.validateLoadout({
    decks: decks.map((deck) => deck.cards),
    names: decks.map((deck) => deck.name),
    scope,
    catalogVersion: deps.catalog.version,
    catalog: deps.catalog,
    owned,
  });
  const first = issues[0];
  if (first !== undefined) throw new ApiError("loadout_invalid", first.message, issues);
}

/** A copy, so a frozen deck can never alias the stored one. */
function freeze(deck: SavedDeck): FrozenDeck {
  return { name: deck.name, cards: [...deck.cards] };
}

/**
 * Loads the chosen deck or trio, checks it by R253 and returns the frozen copy the ticket or the
 * room keeps. Nothing after this reads the saved deck again, so editing it while queued (or while
 * a room waits) cannot change the game it becomes (§9.8: "Deck swapped after matchmaking").
 *
 * An empty trio slot is not skipped: the filled decks go to the validator as they are, so a trio
 * with two decks fails L1 in the shared module's own words. All Random freezes nothing (R258).
 */
export async function freezeChoice(
  deps: ServerDeps,
  profileId: string,
  choice: ModeChoiceInput,
): Promise<FrozenChoice> {
  if (choice.mode === "random") return { mode: "random" };
  const owned = await ownedMap(deps, profileId);

  if (choice.mode === "bo1") {
    const deck = await chosenDeck(deps, profileId, choice);
    assertLegal(deps, owned, [deck], "deck");
    return { mode: "bo1", deck: freeze(deck) };
  }

  const trio = await deps.store.trios.get(choice.trioId);
  if (trio === null || trio.profileId !== profileId) throw refused(TRIO_GONE);
  const filled: SavedDeck[] = [];
  for (const deckId of trio.deckIds) {
    // A slot's deck is this profile's by the store's own constraint; `ownDeck` says so again.
    const deck = deckId === null ? null : await ownDeck(deps, profileId, deckId);
    if (deck !== null) filled.push(deck);
  }
  assertLegal(deps, owned, filled, "trio");

  const [first, second, third] = filled;
  if (first === undefined || second === undefined || third === undefined) {
    // L1 passed, so the validator port is not the shared module: a wiring fault, not a player's.
    throw new Error(`the validator passed trio ${trio.id} with ${String(filled.length)} decks`);
  }
  return {
    mode: "bo3",
    trio: { name: trio.name, decks: [freeze(first), freeze(second), freeze(third)] },
  };
}

/**
 * R264: a profile in a series that is not over can neither queue nor create or join a room — its
 * next game is already decided by the series, and a second one would make it two places at once.
 * `already_in_match`, like being in a match, with the series to go back to in `details`.
 */
export async function assertNotInSeries(deps: ServerDeps, profileId: string): Promise<void> {
  const series = await deps.store.series.activeFor(profileId);
  if (series !== null) {
    throw new ApiError("already_in_match", "Finish your Conquest series first.", {
      seriesId: series.id,
    });
  }
}
