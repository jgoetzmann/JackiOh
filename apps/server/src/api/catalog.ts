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
 * NOT IN SPEC: how the catalog version is derived. §9.4 requires that client and server agree on
 * one, and rejects a stale one at save and at queue, but names no format. A content hash of the
 * data both halves ship means the version cannot drift from the data it describes, and no
 * release step has to remember to bump it. `CATALOG_VERSION` in the environment overrides it.
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
    // §9.4 L6: "every card exists in the current catalog version and is not banned". Nothing in
    // SPEC §8 is banned at launch and `CardDef` carries no ban flag, so the ban list is a server
    // concern. NOT IN SPEC: where it is stored. This is the single hook for it; empty until
    // there is something to ban, at which point it reads the db agent's `cards` table.
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
 * NOT IN SPEC, and reported as such. SPEC §9.4 says the catalog is "static, versioned, shipped
 * with the client", which describes the end state; today the client ships none of its own, and the
 * deckbuilder needs every card's name and cost before any engine is loaded. The server already
 * holds `deps.catalog` for L3/L6 and the version check, so it serves it. `apps/web/src/net/api.ts`
 * already calls exactly this shape:
 *
 *     export type CatalogResponse = { version: string; defs: CardDefs };
 *
 * The whole `CardDefs` record goes out rather than a projection, because `@jackioh/validator`'s
 * `CatalogSnapshot.cards` *is* a `CardDefs`: §9.4 requires "one validator module shared by client
 * and server", so the deckbuilder's own verdict (UX) runs the same module the save runs (law), and
 * a trimmed card would be a second, weaker copy of the catalog.
 *
 * `auth: "none"`, like the catalog file it stands in for: it is the same bytes for everybody, it
 * names no profile, and §9.4's gate is about "no collection, loadout, queue or match" — a pending
 * account looking at card art is none of those. The version it carries is what a stale client
 * compares against before it starts building, instead of finding out at save time.
 */
export function createCatalogRoutes(): Route[] {
  return [
    route("GET", "/api/catalog", "none", async (_req, deps) =>
      ok({ version: deps.catalog.version, defs: deps.catalog.defs }),
    ),
  ];
}
