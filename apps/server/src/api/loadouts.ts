/**
 * Loadouts: SPEC §9.4's save and the queue-time re-check.
 *
 * §9.4: "Loadout rules, checked by one validator module shared by client and server, at save and
 * again at queue ... Saving is `saveLoadout(profileId, catalogVersion, decks[3])`, which writes
 * all three decks in one transaction or nothing; there is no per-deck save. A queue-time failure
 * names the deck and the card."
 *
 * So this file holds no rule. L1–L6 live in `@jackioh/validator`, which the composition root
 * adapts onto the `LoadoutValidator` port; every check here is one call to `deps.validateLoadout`
 * and the issues it returns are passed through as the error's `details`, which is what lets the
 * same sentence appear in the deckbuilder at save time and in a queue rejection later. Two rules
 * of thumb keep it that way: nothing in this file counts cards, and nothing in it names a card.
 *
 * The one check that is *not* one of L1–L6 is the catalog version. §9.4: "catalog is static,
 * versioned, shipped with the client; stale catalog version is rejected at save and queue." That
 * is a client-freshness question, not a deck-legality one — a stale client may be sending a
 * perfectly legal deck of ids that have since been reprinted — so it is answered here, with
 * `update_required` (409) and BUILD M6-T2's literal wording, before the validator runs.
 */

import { callerProfile, ownedMap } from "./collection";
import { ApiError, deckList, ok, route, str, type Route } from "./http";
import type { LoadoutIssue, ServerDeps, Store, StoredLoadout } from "./ports";

export type SaveLoadoutInput = {
  profileId: string;
  /** The version the client believes it is holding (§9.4). */
  catalogVersion: string;
  /** §9.4 L1/L2 decide the shape; this signature does not. */
  decks: readonly (readonly string[])[];
};

/**
 * §9.4: "stale catalog version is rejected at save and queue". BUILD M6-T2's acceptance item is
 * literally 'a stale `catalogVersion` gets "update required"', so that is the message.
 */
export function assertCurrentCatalog(deps: ServerDeps, catalogVersion: string): void {
  if (catalogVersion !== deps.catalog.version) {
    throw new ApiError("update_required", "update required", {
      expected: deps.catalog.version,
      received: catalogVersion,
    });
  }
}

/**
 * The single call to the shared validator. L5 needs the entitlements, so the collection ledger is
 * read here and handed in (§9.4: "copies across the loadout never exceed the quantity owned").
 *
 * The first issue's message becomes the error's message verbatim and every issue rides along in
 * `details` exactly as the validator reported it — no renumbering, no recomposed sentence. The
 * validator's own messages already name the deck and the card in prose, which is what §9.4's last
 * line asks for, and the deckbuilder wants to show all of them at once.
 */
async function assertLegal(
  deps: ServerDeps,
  profileId: string,
  catalogVersion: string,
  decks: readonly (readonly string[])[],
): Promise<void> {
  const issues: LoadoutIssue[] = deps.validateLoadout({
    decks,
    catalogVersion,
    catalog: deps.catalog,
    owned: await ownedMap(deps, profileId),
  });
  const first = issues[0];
  if (first !== undefined) {
    throw new ApiError("loadout_invalid", first.message, issues);
  }
}

/**
 * §9.4's `saveLoadout(profileId, catalogVersion, decks[3])`: all three decks in one transaction
 * or nothing. `LoadoutStore.replace` is the whole write — there is no per-deck save to add, and
 * the db implementation leans on the unique index on `(profile_id, card_id)` to catch L4 even if
 * the application check above were bypassed (BUILD M6-T3).
 */
export async function saveLoadout(
  deps: ServerDeps,
  input: SaveLoadoutInput,
): Promise<StoredLoadout> {
  assertCurrentCatalog(deps, input.catalogVersion);
  await assertLegal(deps, input.profileId, input.catalogVersion, input.decks);

  const at = deps.timers.now();
  await deps.store.tx(async (t: Store) => {
    await t.loadouts.replace(input.profileId, input.catalogVersion, input.decks, at);
  });
  deps.log.info("loadout.saved", { profileId: input.profileId, decks: input.decks.length });
  return {
    catalogVersion: input.catalogVersion,
    decks: input.decks.map((deck) => [...deck]),
    updatedAt: at,
  };
}

/**
 * The queue-time half of §9.4's "at save and again at queue". `queue.ts` and the room endpoints
 * call this before freezing a deck into a ticket, because everything the save checked can have
 * moved since: the catalog can have shipped a new version, and the collection is server-owned and
 * can change without the client's knowledge.
 *
 * `catalogVersion` is the version the *request* claims; the stored loadout's own version is
 * checked too, since a loadout saved under an older catalog is exactly the stale case §9.4 names.
 *
 * NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
 *   Topic: Queueing with no loadout at all
 *   Ruling: A profile that has never saved a loadout fails the queue-time check as a loadout
 *     failure, not as a missing resource. §9.4's L1 ("exactly 3 decks") assumes a loadout exists
 *     and so cannot state the case, but the player is in exactly the position L1 describes — they
 *     do not have three decks — and the thing to do about it is the same: go and build one. A 404
 *     would say the *endpoint* found nothing, which sends a client looking for a route that is
 *     working correctly, and it is not a staleness problem either, so it is not an "update
 *     required". The rule generalises: a queue-time refusal that the player fixes in the
 *     deckbuilder reports as `loadout_invalid`, and only a catalog mismatch reports as stale.
 *   Affects: §9.4 (L1–L6, "at save and again at queue"), §9.5, R141; `api/loadouts.ts`,
 *     `api/queue.ts`, `match/rooms.ts`.
 */
export async function validateStoredLoadout(
  deps: ServerDeps,
  profileId: string,
  catalogVersion: string,
): Promise<StoredLoadout> {
  assertCurrentCatalog(deps, catalogVersion);
  const stored = await deps.store.loadouts.get(profileId);
  if (stored === null) {
    throw new ApiError("loadout_invalid", "build and save a loadout before queueing");
  }
  assertCurrentCatalog(deps, stored.catalogVersion);
  await assertLegal(deps, profileId, stored.catalogVersion, stored.decks);
  return stored;
}

/**
 * Picks the deck the player chose, for freezing into a queue ticket or a room (§9.4: "Decks are
 * frozen into the queue ticket").
 *
 * The index is 0-based, because it indexes `StoredLoadout.decks` directly. Note that this is the
 * opposite convention to `LoadoutIssue.deck`, which is 1-based "exactly as `@jackioh/validator`
 * reports it": a validator issue and a `deckIndex` describing the same deck differ by one, so the
 * client must not feed one to the other. A copy is returned so a frozen deck can never alias the
 * stored loadout.
 */
export function deckFor(loadout: StoredLoadout, deckIndex: number): string[] {
  const deck = Number.isInteger(deckIndex) ? loadout.decks[deckIndex] : undefined;
  if (deck === undefined) {
    throw new ApiError(
      "bad_request",
      `"deckIndex" must name one of this loadout's ${String(loadout.decks.length)} decks`,
    );
  }
  return [...deck];
}

/**
 * §9.4: both routes are `active`, so a pending account gets 403 from each (BUILD M6-T1).
 *
 * `GET` answers `null` for a profile that has never saved, so the deckbuilder opens empty instead
 * of on an error, and always reports the server's catalog version so a stale client can find out
 * before it starts building rather than at save time.
 */
export function createLoadoutRoutes(): Route[] {
  return [
    route("GET", "/api/loadout", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const loadout = await deps.store.loadouts.get(profile.id);
      return ok({ catalogVersion: deps.catalog.version, loadout });
    }),
    route("PUT", "/api/loadout", "active", async (req, deps) => {
      const profile = callerProfile(req);
      const loadout = await saveLoadout(deps, {
        profileId: profile.id,
        catalogVersion: str(req.body, "catalogVersion"),
        decks: deckList(req.body, "decks"),
      });
      return ok({ catalogVersion: deps.catalog.version, loadout });
    }),
  ];
}
