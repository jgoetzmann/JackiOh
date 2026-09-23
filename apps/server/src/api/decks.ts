/**
 * The deck library: SPEC §11 R171 and R172, BUILD M9-T1.
 *
 * R171: beside §9.4's one loadout, an account keeps up to `limits.libraryDecks` named decks, each
 * saved on its own. Like `loadouts.ts`, this file holds no deck rule. A save is one call to
 * `deps.validateDeck` with `allowIncomplete`, and its issues travel out verbatim as the error's
 * `details` under the same `loadout_invalid` (422) `PUT /api/loadout` answers with, so the client
 * shows the shared module's sentences and never composes its own. What is this file's own is the
 * request's shape (the catalog version, checked first exactly as a loadout save checks it; the
 * name; the card list) and the cap.
 *
 * R172: `frozenDeckFor` is the one door from a request's deck choice to a frozen deck, shared by the
 * queue and both room endpoints. A `deckIndex` takes the loadout path unchanged
 * (`validateStoredLoadout` + `deckFor`); a `deckId` takes one of the caller's own library decks,
 * validated strictly against the current catalog and collection, and never reads the loadout.
 *
 * Every `DeckStore` method is scoped by profile, so another profile's deck id and one that never
 * existed are the same miss: `not_found`, never forbidden (R172's last sentence).
 */

import { callerProfile, ownedMap } from "./collection";
import { ApiError, badRequest, ok, route, str, stringList, type Route } from "./http";
import { assertCurrentCatalog, deckFor, validateStoredLoadout } from "./loadouts";
import type { DeckChoice, DeckDraft, ServerDeps } from "./ports";

/** A deck ready to freeze into a ticket or a room: a copy, and the catalog it was checked against. */
export type FrozenDeck = { deck: string[]; catalogVersion: string };

const missingDeck = (): ApiError => new ApiError("not_found", "no such deck in your library");

/**
 * The one call to the shared validator, the library's `assertLegal`: the first issue's message is
 * the error's message and every issue rides along in `details` as the validator reported it. The
 * deck's own name goes in too, so the validator's sentences name the deck the player named.
 */
async function assertDeckLegal(
  deps: ServerDeps,
  profileId: string,
  draft: DeckDraft,
  allowIncomplete: boolean,
): Promise<void> {
  const issues = deps.validateDeck({
    cards: draft.cards,
    name: draft.name,
    catalogVersion: deps.catalog.version,
    catalog: deps.catalog,
    owned: await ownedMap(deps, profileId),
    allowIncomplete,
  });
  const first = issues[0];
  if (first !== undefined) throw new ApiError("loadout_invalid", first.message, issues);
}

/**
 * A save's body, `{ catalogVersion, name, cards }`, checked in that order: a stale client is told
 * so before anything else (§9.4), a name is trimmed and bounded, and only a well-formed card list
 * reaches the validator, with a short deck allowed (R171).
 */
async function savableDraft(
  deps: ServerDeps,
  profileId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<DeckDraft> {
  assertCurrentCatalog(deps, str(body, "catalogVersion"));
  const max = deps.limits.deckNameMaxLength;
  const name = typeof body["name"] === "string" ? body["name"].trim() : "";
  if (name.length === 0 || name.length > max) {
    throw badRequest(`"name" must be 1 to ${String(max)} characters`);
  }
  const draft = { name, cards: stringList(body, "cards") };
  await assertDeckLegal(deps, profileId, draft, true);
  return draft;
}

/**
 * R172: which deck a queue or room request names. Exactly one of the two fields: a loadout
 * `deckIndex`, read by the endpoint's own `indexOf` so each keeps its existing range and message,
 * or a library `deckId`.
 */
export function deckChoiceOf(
  body: Readonly<Record<string, unknown>>,
  indexOf: (body: Readonly<Record<string, unknown>>) => number,
): DeckChoice {
  const hasIndex = body["deckIndex"] !== undefined;
  if (hasIndex === (body["deckId"] !== undefined)) {
    throw badRequest('send exactly one of "deckIndex" (a loadout deck) or "deckId" (a library deck)');
  }
  if (hasIndex) return { deckIndex: indexOf(body) };
  return { deckId: str(body, "deckId") };
}

/**
 * §9.4 "Decks are frozen into the queue ticket", for either kind of deck (R172).
 *
 * The loadout path is exactly what the queue and the rooms did before: the stored loadout is
 * re-validated and its version is the one the ticket records. The library path re-validates the
 * deck strictly (L2 exactly, not as a ceiling) against the current catalog, which is therefore its
 * version: a library deck stores none (R171). Either way the deck returned is a copy, so editing or
 * deleting its source afterwards reaches nothing already frozen (§9.8).
 */
export async function frozenDeckFor(
  deps: ServerDeps,
  profileId: string,
  choice: DeckChoice,
): Promise<FrozenDeck> {
  if ("deckIndex" in choice) {
    const loadout = await validateStoredLoadout(deps, profileId, deps.catalog.version);
    return { deck: deckFor(loadout, choice.deckIndex), catalogVersion: loadout.catalogVersion };
  }
  const stored = await deps.store.decks.get(profileId, choice.deckId);
  if (stored === null) throw missingDeck();
  await assertDeckLegal(deps, profileId, stored, false);
  return { deck: [...stored.cards], catalogVersion: deps.catalog.version };
}

/**
 * R171's four routes, all `active` (§9.4's gate: a pending account gets 403 from each).
 *
 * `GET` answers the server's catalog version and the cap with the list, so the library screen can
 * show "k of n" and a stale client learns it before it builds rather than at save time.
 */
export function createDeckRoutes(): Route[] {
  return [
    route("GET", "/api/decks", "active", async (req, deps) => {
      const profile = callerProfile(req);
      return ok({
        catalogVersion: deps.catalog.version,
        maxDecks: deps.limits.libraryDecks,
        decks: await deps.store.decks.list(profile.id),
      });
    }),

    // No `tx` around the write: `decks.create` counts and inserts as one atomic step by contract
    // (ports.ts; the Postgres store does both under a lock on the profile row), so two concurrent
    // creates cannot both land the deck past the cap.
    route("POST", "/api/decks", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const draft = await savableDraft(deps, profile.id, req.body);
      const max = deps.limits.libraryDecks;
      const deck = await deps.store.decks.create(profile.id, draft, deps.timers.now(), max);
      if (deck === null) {
        throw new ApiError(
          "conflict",
          `your library already holds ${String(max)} decks; delete one first`,
        );
      }
      deps.log.info("deck.created", { profileId: profile.id, deckId: deck.id });
      return ok({ deck });
    }),

    route("PUT", "/api/decks/:id", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const draft = await savableDraft(deps, profile.id, req.body);
      const deckId = req.params.id ?? "";
      const deck = await deps.store.decks.update(profile.id, deckId, draft, deps.timers.now());
      if (deck === null) throw missingDeck();
      return ok({ deck });
    }),

    route("DELETE", "/api/decks/:id", "active", async (req, deps) => {
      const profile = callerProfile(req);
      if (!(await deps.store.decks.delete(profile.id, req.params.id ?? ""))) throw missingDeck();
      return ok({ deleted: true });
    }),
  ];
}
