/**
 * The card catalog the server checks loadouts and queue requests against (SPEC §9.4: "catalog is
 * static, versioned, shipped with the client; stale catalog version is rejected at save and
 * queue").
 *
 * It is loaded from `packages/cards/catalog.json`, which is already a `defId -> CardDef` map —
 * i.e. exactly `CardDefs`. Reading the data file rather than importing `@jackioh/cards` keeps the
 * server out of that package's TypeScript (M4's card scripts are in flight and do not compile
 * yet) and matches what the catalog is: static, versioned data shipped to both halves.
 *
 * Everything downstream depends only on `CatalogInfo` from ports.ts.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { CardDef, CardDefs } from "@jackioh/shared";
import { ok, route, type Route } from "./http";
import type { CatalogInfo } from "./ports";

export class CatalogUnavailableError extends Error {
  constructor(where: string, cause?: unknown) {
    super(
      `the card catalog could not be read from ${where}: ${String(cause)}. ` +
        "It is the 100 cards plus 9 tokens of SPEC §8; the server will not invent them.",
    );
    this.name = "CatalogUnavailableError";
  }
}

/** Where `catalog.json` lives, resolved through the workspace link rather than a relative walk. */
export function catalogUrl(): URL {
  // `@jackioh/cards` exports "./src/index.ts"; the data file sits one level up from it.
  return new URL("../catalog.json", import.meta.resolve("@jackioh/cards"));
}

function isCardDef(value: unknown): value is CardDef {
  const def = value as Partial<CardDef> | null;
  return (
    typeof def === "object" &&
    def !== null &&
    typeof def.id === "string" &&
    typeof def.name === "string" &&
    Array.isArray(def.tags) &&
    typeof def.base === "object"
  );
}

/**
 * The FALLBACK version, for a caller that configures none. SPEC §11 R105 already fixes what a
 * catalog version is — "a short opaque string stamped on every `cards` row and mirrored in the
 * server's settings", compared for equality only, never parsed or ordered, and `core-1` for the
 * Core set — so nothing here re-decides it. `CATALOG_VERSION` is a required variable (`env.ts`)
 * and `index.ts` always passes it, which is the path R105 describes and the value migration
 * `0001_profiles_and_invites.sql` seeds into `app.settings`.
 *
 * This hash exists only for a direct `loadCatalog()` with no version — tests and tooling. Its
 * `c1-` prefix cannot collide with a configured one, and being derived from the bytes it describes
 * it cannot drift from them. It is opaque and equality-compared like any other R105 version.
 */
export function versionOf(json: string): string {
  return `c1-${createHash("sha256").update(json).digest("hex").slice(0, 12)}`;
}

/** `CatalogInfo` over a `defId -> CardDef` map. */
export function catalogFrom(defs: CardDefs, version: string): CatalogInfo {
  const cardIds = Object.keys(defs);
  return {
    version,
    defs,
    cardIds,
    isToken: (cardId) => {
      const def = defs[cardId];
      if (def === undefined) return false;
      return def.token || def.tags.includes("Token");
    },
    // §9.4 L6: "every card exists in the current catalog version and is not banned".
    //
    // NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
    //   Topic: Where L6's ban list lives
    //   Ruling: A ban is server state, not catalog data. Nothing in §8 is banned at launch and a
    //     `CardDef` carries no ban flag, so L6's two halves are answered from two places: catalog
    //     membership from the catalog both sides ship, and the ban list from the server alone. The
    //     alternative — a flag on the card — would put a ban inside the catalog data itself, so
    //     banning one card would mean a new R105 version, and §9.4's stale-version rejection would
    //     then turn every saved loadout in the game invalid at once. It would also hand the client
    //     a copy of a list it has no business being able to disagree with. The shared validator
    //     therefore reads bannedness through `CatalogInfo` and never off a `CardDef`, and the list
    //     is empty until there is something to ban.
    //   Affects: §9.4 (L6), R105; `api/catalog.ts`, `packages/validator`.
    isBanned: () => false,
  };
}

export async function loadCatalog(
  options: { version?: string | undefined; url?: URL | undefined } = {},
): Promise<CatalogInfo> {
  const url = options.url ?? catalogUrl();
  let json: string;
  try {
    json = await readFile(url, "utf8");
  } catch (cause) {
    throw new CatalogUnavailableError(url.pathname, cause);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (cause) {
    throw new CatalogUnavailableError(url.pathname, cause);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CatalogUnavailableError(url.pathname, "expected a defId -> CardDef object");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length === 0) {
    throw new CatalogUnavailableError(url.pathname, "the catalog is empty");
  }
  const bad = entries.find(([, value]) => !isCardDef(value));
  if (bad !== undefined) {
    throw new CatalogUnavailableError(url.pathname, `"${bad[0]}" is not a CardDef`);
  }

  return catalogFrom(parsed as CardDefs, options.version ?? versionOf(json));
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/**
 * `GET /api/catalog`.
 *
 * NOT IN SPEC, and no R-row yet — PROPOSED RULING for §11:
 *   Topic: The catalog a client that ships none can read
 *   Ruling: §9.4's "static, versioned, shipped with the client" describes the end state, and until
 *     the client ships one the server serves the same bytes from `GET /api/catalog`, whole and
 *     unprojected. Whole, because §9.4 requires "one validator module shared by client and
 *     server" and `@jackioh/validator`'s `CatalogSnapshot.cards` *is* a `CardDefs`: a trimmed card
 *     would be a second, weaker copy of the catalog, and the deckbuilder's verdict (UX) would stop
 *     being the verdict the save runs (law). Unauthenticated, like the file it stands in for: it
 *     is the same bytes for everybody, it names no profile, and §9.4's gate on a pending account
 *     is about "no collection, loadout, queue or match" — card art is none of those. The endpoint
 *     carries R105's version, so a stale client learns it is stale before it builds a deck rather
 *     than at save time. The endpoint is the transport, never a second source of truth: the day
 *     the client ships its own catalog this route may go away without a rule changing.
 *   Affects: §9.1, §9.4, R105; `api/catalog.ts`, `apps/web/src/net/api.ts`, `packages/validator`.
 *
 * `apps/web/src/net/api.ts` already calls exactly this shape:
 *
 *     export type CatalogResponse = { version: string; defs: CardDefs };
 *
 * That is the whole `CardDefs` record and `auth: "none"`, both for the reasons the proposal above
 * states; they are not restated here, so there is one place to change if the ruling changes.
 */
export function createCatalogRoutes(): Route[] {
  return [
    route("GET", "/api/catalog", "none", async (_req, deps) =>
      ok({ version: deps.catalog.version, defs: deps.catalog.defs }),
    ),
  ];
}
