// The card registry (BUILD M4-T2, SPEC §10.9): the one place that turns 109 script files plus
// `catalog.json` into what the engine, the harness, the validator and the client consume.
//
//   CARDS       Record<catalog id, { def, base, radiant }> — one entry per script file present
//   CATALOG     every def in catalog.json (109), script or no script
//   registerAll() registers the catalog and the scripts with the engine
//   query / catalog.query  SPEC §5.1's single pool source, re-exported from ./query
//
// Two invariants hold the contract together, and both are checked here rather than in a test, so a
// mistake in one of 109 card files fails loudly at load instead of quietly at play time:
//   1. a script's `def` names a real catalog card (`export const def = cardDef("core-043")`), and
//   2. no two scripts claim the same card.
//
// The engine gets the WHOLE catalog and only the scripts that exist. A catalog id with no script is
// a playable card with no text: `scriptsFor` falls back to `EMPTY_SCRIPT` (engine/src/scripts.ts),
// so a missing card file can never crash a game or a test — it just does nothing.

import { catalogVersion, registerCatalog, registerScripts, registeredCatalog, registeredScripts } from "@jackioh/engine";
import type { CardScripts } from "@jackioh/engine";
import type { CardDef } from "@jackioh/shared";
// Imported BEFORE the script barrel on purpose. A card file may reach `cardDef` through this module
// (`import { cardDef } from "../index"`) instead of through `./catalog-data`, which makes
// index -> _generated -> 001-big-d-fender -> index a runtime import cycle; because ESM evaluates a
// module's imports in source order, `./catalog-data` is fully evaluated before the first card file
// runs, so `cardDef` is callable at that point either way. Card files should still prefer
// `import { cardDef } from "../catalog-data";` — no cycle at all.
import { CATALOG, CATALOG_IDS, CATALOG_VERSION, cardDef, cardDefByIndex } from "./catalog-data";
import { SCRIPT_MODULES } from "./scripts/_generated";

export { CATALOG, CATALOG_IDS, CATALOG_VERSION, cardDef, cardDefByIndex };
export { catalog, query } from "./query";
export type { CardQuery } from "./query";

/** One card file's exports (SPEC §10.9). */
export type CardModule = { def: CardDef; base: CardScripts["base"]; radiant: CardScripts["radiant"] };

/**
 * Folds the generated barrel into the registry, keyed by each module's own `def.id`.
 *
 * Exported for `test/registry.test.ts`, which proves the two throws without needing 109 files;
 * `CARDS` below is this function applied to `SCRIPT_MODULES`.
 */
export function buildRegistry(modules: readonly CardModule[]): Record<string, CardModule> {
  const cards: Record<string, CardModule> = {};
  for (const mod of modules) {
    const id = mod.def.id;
    if (CATALOG[id] === undefined) {
      throw new Error(
        `card script def.id "${id}" is not in packages/cards/catalog.json: a script gets its def ` +
          `from the catalog (\`export const def = cardDef("core-043")\`), never by hand`,
      );
    }
    if (cards[id] !== undefined) {
      throw new Error(
        `two card scripts claim "${id}" (${CATALOG[id].name}): one card, one script file ` +
          `(CLAUDE.md rule 6) — delete or rename the duplicate in src/scripts/ and rerun ` +
          `\`pnpm exec tsx packages/cards/scripts/gen-registry.ts\``,
      );
    }
    cards[id] = mod;
  }
  return cards;
}

/**
 * Every card whose script file exists, by catalog id. Empty until BUILD M4-T4 lands the script
 * files; `CATALOG` is the full 109 either way.
 */
export const CARDS: Record<string, CardModule> = buildRegistry(SCRIPT_MODULES);

/**
 * The registry as the engine wants it. Built once, at load: `registerAll` compares identities to
 * stay cheap, and the harness calls it before every card test.
 */
const SCRIPTS: Readonly<Record<string, CardScripts>> = Object.freeze(
  Object.fromEntries(
    Object.entries(CARDS).map(([id, mod]) => [id, { base: mod.base, radiant: mod.radiant }]),
  ),
);

export function scriptsOf(): Readonly<Record<string, CardScripts>> {
  return SCRIPTS;
}

/**
 * Registers the shipped catalog (§9.4) and the card scripts with the engine. Idempotent: the engine
 * holds the very objects registered here, so identity says whether the work is already done. It is
 * not a one-shot flag — an engine test that registers a fixture catalog replaces both registries,
 * and the next `registerAll()` must put the real ones back.
 */
export function registerAll(): void {
  if (
    registeredCatalog() === CATALOG &&
    registeredScripts() === SCRIPTS &&
    catalogVersion() === CATALOG_VERSION
  ) {
    return;
  }
  registerCatalog(CATALOG, CATALOG_VERSION);
  registerScripts(SCRIPTS);
}
