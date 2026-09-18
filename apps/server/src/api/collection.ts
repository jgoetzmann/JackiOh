/**
 * The collection: SPEC §9.4's entitlement ledger.
 *
 * "Collection is an entitlement ledger (`collection` plus append-only `collection_grants`) ...
 * Every collection change writes `collection` and `collection_grants` in one transaction, and no
 * client path writes either."
 *
 * Two consequences shape this file.
 *
 * 1. There is exactly one mutation path, `grantCards`, and it makes both writes inside one
 *    `Store.tx`. `CollectionStore` exposes `upsertQuantities` and `appendGrants` separately, so
 *    nothing stops a caller from making one without the other — which is why every caller goes
 *    through here instead, and why the fault-injection test in `test/api/collection.test.ts`
 *    asserts "both tables or neither" for a fault on either write (BUILD M6-T2).
 * 2. The route table holds a single `GET`. §9.8's first row ("Claiming unowned cards → the
 *    collection is server-owned") and M6-T2's acceptance item ("a direct insert attempt through
 *    the public API is impossible — no endpoint") are both satisfied by an absence, so the test
 *    asserts over `createCollectionRoutes()` itself: a mutating route cannot be added without a
 *    test going red.
 *
 * The ledger's two writes mean two different numbers. `upsertQuantities` takes the new *absolute*
 * quantity for each card (that is the projection the client reads), while a `CollectionGrant`'s
 * `delta` is the change this grant applied — the db agent's `collection_grants.delta` column,
 * which carries `check (delta <> 0)`. So a grant that would change nothing writes no row at all.
 */

import { badRequest, ok, route, type ApiRequest, type Route } from "./http";
import type { CollectionEntry, CollectionGrant, Profile, ServerDeps, Store } from "./ports";

/**
 * SPEC §11 R111 fixes this: the launch grant is "one copy of every non-token card". The reason the
 * row gives for one — L3 caps a deck at `MAX_COPIES` and L4 forbids a card id in two decks, so one
 * copy already builds all three decks legally and a second would be unreachable — is R111's, not
 * this file's, and R141 then leans on it ("L5 is never a sole failure"). Nothing here re-derives
 * the quantity; this is the TypeScript half of a value SPEC already owns.
 *
 * The db agent stores the same value as `app.settings('launch_quantity') = 1` in migration
 * `0002_collection.sql`, which cites R111 in the same words; it is not exported from
 * `src/config.ts`, so it cannot be imported here yet. Import it the day it is.
 *
 * Exported because R111's grant is a *database trigger* in production ("written by a trigger on
 * the `pending → active` transition"), so the end-to-end mode's in-memory store has to carry the
 * same trigger — see `e2e-store.ts`. It reads this value rather than restating it, so the
 * application path and the trigger path cannot drift.
 */
export const LAUNCH_COPIES = 1;

/**
 * Not in SPEC, and no R-row: this string is forced, not decided. `collection_grants.reason` carries
 * a closed-set CHECK constraint in migration `0002_collection.sql`
 * (`pack | craft | reward | refund | admin | launch`), so the launch path must use `"launch"` or
 * every insert fails at runtime, and that migration's own comment already cites R111 for why the
 * ledger distinguishes a launch grant from a later `admin` correction. This is the one string in
 * this file that has to agree with a value the db agent owns and `src/config.ts` does not export.
 */
export const LAUNCH_GRANT_REASON = "launch";

export type GrantInput = {
  profileId: string;
  /** Each entry's `quantity` is a positive delta: how many copies to add. */
  entries: readonly CollectionEntry[];
  /** Why, for the append-only ledger (§9.4). */
  reason: string;
};

/**
 * The caller behind a route that declares `auth: "active"`. `createRouter` has already resolved
 * and gated the profile by then (`assertActive`), so this only re-states that for the type
 * checker. It belongs in `http.ts` next to `assertActive`, which another agent owns; `loadouts.ts`
 * imports it from here rather than keeping a second copy.
 */
export function callerProfile(req: ApiRequest): Profile {
  if (req.profile === null) {
    throw badRequest("this endpoint needs a signed-in profile");
  }
  return req.profile;
}

/**
 * Sums repeated ids and rejects a delta that is not a positive whole number.
 *
 * Not in SPEC, and no R-row: an input-shape check that mirrors a table constraint. §9.4 describes
 * grants and never revocation, and `collection.quantity >= 0` plus `collection_grants.delta <> 0`
 * are constraints migration `0002_collection.sql` already enforces, so a zero or negative delta
 * has no meaning this function could give it — rejecting it here only turns a constraint violation
 * into a named 400. Revocation, if it ever lands, is its own path with its own `reason`, and that
 * would be a ruling; this is not.
 */
function deltasFrom(entries: readonly CollectionEntry[]): Map<string, number> {
  const deltas = new Map<string, number>();
  for (const entry of entries) {
    if (entry.cardId.length === 0) throw badRequest("a collection entry needs a card id");
    if (!Number.isInteger(entry.quantity) || entry.quantity <= 0) {
      throw badRequest(`the grant for "${entry.cardId}" must be a positive whole number of copies`);
    }
    deltas.set(entry.cardId, (deltas.get(entry.cardId) ?? 0) + entry.quantity);
  }
  return deltas;
}

/**
 * §9.4's one collection mutation: reads the current quantities, adds the deltas and writes both
 * `collection` and `collection_grants` inside a single transaction. If either write throws, the
 * transaction rolls back and neither table moves.
 */
export async function grantCards(deps: ServerDeps, input: GrantInput): Promise<void> {
  const deltas = deltasFrom(input.entries);
  // No delta, no write: `collection_grants.delta <> 0` forbids an empty audit row, and an empty
  // transaction would be a lie in the ledger.
  if (deltas.size === 0) return;

  const at = deps.timers.now();
  await deps.store.tx(async (t: Store) => {
    const current = await ownedIn(t, input.profileId);
    const quantities: CollectionEntry[] = [];
    const grants: CollectionGrant[] = [];
    for (const [cardId, delta] of deltas) {
      quantities.push({ cardId, quantity: (current.get(cardId) ?? 0) + delta });
      grants.push({ profileId: input.profileId, cardId, delta, reason: input.reason, at });
    }
    await t.collection.upsertQuantities(input.profileId, quantities);
    await t.collection.appendGrants(grants);
  });
  deps.log.info("collection.granted", {
    profileId: input.profileId,
    cards: deltas.size,
    reason: input.reason,
  });
}

/**
 * BUILD M6-T2: "launch mode grants every card to every active profile." One copy of every
 * playable id in the catalog — tokens are skipped (§9.4 L3 bans them from a deck, so owning one
 * would be meaningless) and so are banned ids (L6).
 *
 * Idempotent by topping up to `LAUNCH_COPIES` rather than adding: a second call computes a delta
 * of zero for everything already owned, those entries drop out, and neither table is touched.
 */
export async function grantEntireCatalog(
  deps: ServerDeps,
  profileId: string,
  reason: string = LAUNCH_GRANT_REASON,
): Promise<void> {
  const owned = await ownedMap(deps, profileId);
  const entries: CollectionEntry[] = [];
  for (const cardId of deps.catalog.cardIds) {
    if (deps.catalog.isToken(cardId) || deps.catalog.isBanned(cardId)) continue;
    const missing = LAUNCH_COPIES - (owned.get(cardId) ?? 0);
    if (missing > 0) entries.push({ cardId, quantity: missing });
  }
  if (entries.length === 0) return;
  await grantCards(deps, { profileId, entries, reason });
}

/** Shared by `ownedMap` and `grantCards`, which needs the read inside its own transaction. */
async function ownedIn(store: Store, profileId: string): Promise<Map<string, number>> {
  const owned = new Map<string, number>();
  for (const entry of await store.collection.get(profileId)) {
    owned.set(entry.cardId, (owned.get(entry.cardId) ?? 0) + entry.quantity);
  }
  return owned;
}

/**
 * cardId → quantity owned. This is the `owned` input L5 is checked against ("copies across the
 * loadout never exceed the quantity owned"), so `loadouts.ts` builds the validator's input from
 * here and never reads `collection` itself.
 */
export async function ownedMap(deps: ServerDeps, profileId: string): Promise<Map<string, number>> {
  return ownedIn(deps.store, profileId);
}

/**
 * §9.4: read-only, and deliberately the whole route table. There is no POST, PUT, PATCH or
 * DELETE: the ledger moves only through `grantCards`, which no request reaches.
 *
 * The response carries the catalog version the server is holding, because the client's catalog is
 * "static, versioned, shipped with the client" (§9.4) and a client one release behind needs to
 * find that out before it builds a loadout, not at save time. Only owned rows are sent; an id the
 * client does not see here is owned zero times.
 */
export function createCollectionRoutes(): Route[] {
  return [
    route("GET", "/api/collection", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const entries = [...(await deps.store.collection.get(profile.id))].sort((a, b) =>
        a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0,
      );
      return ok({ catalogVersion: deps.catalog.version, entries });
    }),
  ];
}
