// BUILD M4-T2 acceptance for SPEC §5.1's one catalog query, and the reference every card agent
// copies when its card needs a random pool or a Discover.
//
// The pools below are written as explicit §5 index lists, so the test is the diff: if the filter or
// the catalog drifts, the failure names the exact card that appeared or vanished. Each pool test
// also states, in words and in code, the argument object the card script must pass — that is the
// part 30 card files are going to copy.
//
// `query` reads the *registered* catalog (`packages/engine/src/catalog.ts`), which in a real game is
// registered by `registerAll()` in `src/index.ts`; here we register the catalog data directly so
// this file does not pull in the script registry.

import { registerCatalog } from "@jackioh/engine";
import type { CardDef } from "@jackioh/shared";
import { beforeAll, describe, expect, it } from "vitest";

import { CATALOG, CATALOG_VERSION, cardDefByIndex } from "../src/catalog-data";
import { TRAP_TYPES, catalog, pool, query, queryCost } from "../src/query";

/** Results are compared by SPEC §5 index: that is how §8, BUILD and the rulings name cards. */
function indices(defs: readonly CardDef[]): string[] {
  return defs.map((def) => def.index);
}

const TOKEN_INDICES = ["51.1", "65.1", "90.1", "93.1", "95.1", "T-rush", "T-sheep", "T-felinor", "T-bread", "T-coin"];

beforeAll(() => {
  registerCatalog(CATALOG, CATALOG_VERSION);
});

describe("the cards-layer surface (§5.1: one query function)", () => {
  it("exposes query, pool, cost and trapTypes on `catalog`, the object card scripts call", () => {
    // src/index.ts re-exports `catalog`, `query` and the `CardQuery` type; everything a card script
    // needs therefore has to be reachable through `catalog`.
    expect(catalog.query).toBe(query);
    expect(catalog.pool).toBe(pool);
    expect(catalog.cost).toBe(queryCost);
    expect(catalog.trapTypes).toBe(TRAP_TYPES);
  });

  it("R35, R61 'Field Trap counts as Trap', so TRAP_TYPES names both types", () => {
    expect(TRAP_TYPES).toEqual(["Trap", "Field Trap"]);
  });
});

describe("§5.1 tokens are out of every pool unless the card names the token pool", () => {
  it("§5.1 a plain query({}) is the 100 non-token cards: no def.token, no Token tag, no Token rarity", () => {
    const all = query({});

    expect(all).toHaveLength(100);
    expect(all.filter((def) => def.token)).toEqual([]);
    expect(all.filter((def) => def.tags.includes("Token"))).toEqual([]);
    expect(all.filter((def) => def.rarity === "Token")).toEqual([]);
    // And named outright, because "never a token" is the rule cards depend on (BUILD M4-T4 row 51.1
    // wants #51.1 "absent from every random pool"):
    for (const index of TOKEN_INDICES) {
      expect(indices(all)).not.toContain(index);
    }
  });

  it("§5.1 query({ tags: ['Token'] }) does return them — the card named the pool itself", () => {
    // Sorted, because the relative order of the four shared tokens is the engine defect pinned at
    // the bottom of this file; membership is what §5.1 promises here.
    expect(indices(query({ tags: ["Token"] })).sort()).toEqual([...TOKEN_INDICES].sort());
  });

  it("§5.1 token: true and a pool named by index reach tokens too; token: false forbids them", () => {
    expect(indices(query({ token: true })).sort()).toEqual([...TOKEN_INDICES].sort());
    // A card that names its token by index (Rush Token, Sheep Token, …) names the pool itself.
    expect(indices(query({ index: ["T-rush", "T-sheep"] })).sort()).toEqual(["T-rush", "T-sheep"]);
    expect(indices(query({ token: false, tags: ["Token"] }))).toEqual([]);
  });
});

describe("§5.1 excludeIndex: a random pool never offers the card that generated it", () => {
  it("§5.1 excludeIndex removes a single index", () => {
    // #57 Conjure KY carries the KY tag itself, so without excludeIndex it is in its own pool.
    expect(indices(query({ tags: ["KY"] }))).toEqual(["31", "51", "57", "82"]);
    expect(indices(query({ tags: ["KY"], excludeIndex: "57" }))).toEqual(["31", "51", "82"]);
  });

  it("§5.1 excludeIndex removes every index in a list", () => {
    expect(indices(query({ tags: ["KY"], excludeIndex: ["57", "82"] }))).toEqual(["31", "51"]);
  });

  it("§5.1 excludeIndex composes with the type, rarity and cost filters", () => {
    expect(indices(query({ type: TRAP_TYPES, excludeIndex: "18" }))).toEqual(["41", "60", "71", "85", "96"]);
    expect(indices(query({ rarity: "Mythic", excludeIndex: "96" }))).not.toContain("96");
    expect(indices(query({ cost: 1, tags: ["KY"], excludeIndex: "31" }))).toEqual(["51", "82"]);
  });

  it("§5.1 pool(ownIndex, args) adds the caller's index to excludeIndex instead of replacing it", () => {
    expect(indices(pool("57", { tags: ["KY"] }))).toEqual(["31", "51", "82"]);
    expect(indices(pool("82", { tags: ["KY"], excludeIndex: "57" }))).toEqual(["31", "51"]);
  });
});

describe("the KY pool (#57 Conjure KY) is exactly #31, #51, #82 (BUILD M4-T4 row 57)", () => {
  // THE ARGUMENTS A CARD SCRIPT PASSES:
  //     catalog.query({ tags: ["KY"], excludeIndex: "57" })
  //   or, equivalently and harder to get wrong,
  //     catalog.pool("57", { tags: ["KY"] })
  // Nothing else is needed: tokens are excluded by default (§5.1), which is what keeps #51.1 KY's
  // Empty Notebook — a token that also carries the KY tag — out of the pool.
  const KY_POOL = ["31", "51", "82"];

  it("BUILD row 57 the query a card script writes returns exactly those three defs", () => {
    expect(indices(catalog.query({ tags: ["KY"], excludeIndex: "57" }))).toEqual(KY_POOL);
    expect(indices(catalog.pool("57", { tags: ["KY"] }))).toEqual(KY_POOL);
  });

  it("BUILD row 51.1 the KY pool excludes the KY-tagged token #51.1 and the generator #57", () => {
    const names = catalog.pool("57", { tags: ["KY"] }).map((def) => def.name);

    expect(names).toEqual(["KY's Math Equation", "KY's Private Tutor", "KY's Trial"]);
    expect(cardDefByIndex("51.1").tags).toContain("KY"); // it really is in the tag …
    expect(cardDefByIndex("51.1").token).toBe(true); // … and it really is a token
    expect(indices(catalog.pool("57", { tags: ["KY"] }))).not.toContain("51.1");
    expect(indices(catalog.pool("57", { tags: ["KY"] }))).not.toContain("57");
  });
});

describe("the trap pool (#67 Zoomerbin Oomen) is exactly #18, #41, #60, #71, #85, #96", () => {
  // THE ARGUMENTS A CARD SCRIPT PASSES:
  //     catalog.query({ type: catalog.trapTypes })      // TRAP_TYPES = ["Trap", "Field Trap"]
  //   or catalog.pool("67", { type: TRAP_TYPES })       // #67 is not itself a trap, but §5.1 anyway
  // Both types, because SPEC says "Field Trap counts as Trap" (§8 #51, #85, R35, R61) while the
  // filter matches `def.type` exactly.
  const TRAP_POOL = ["18", "41", "60", "71", "85", "96"];

  it("BUILD row 67 the query a card script writes returns exactly those six defs", () => {
    expect(indices(catalog.query({ type: TRAP_TYPES }))).toEqual(TRAP_POOL);
    expect(indices(catalog.pool("67", { type: TRAP_TYPES }))).toEqual(TRAP_POOL);
  });

  it("§8 #67 base asks for a 1-cost Trap, and all six Core traps cost 1, so both forms share the pool", () => {
    expect(indices(catalog.query({ type: TRAP_TYPES, cost: 1 }))).toEqual(TRAP_POOL);
  });

  it("§5.1 the pool mixes both types: #18 and #71 are Field Traps, the other four are Traps", () => {
    const byType = (type: string): string[] =>
      indices(catalog.query({ type: TRAP_TYPES }).filter((def) => def.type === type));

    expect(byType("Field Trap")).toEqual(["18", "71"]);
    expect(byType("Trap")).toEqual(["41", "60", "85", "96"]);
  });

  it("§5.1 asking for type 'Trap' alone drops the Field Traps — why TRAP_TYPES exists", () => {
    expect(indices(catalog.query({ type: "Trap" }))).toEqual(["41", "60", "85", "96"]);
  });
});

describe("R35 the Transmogulate pool (#83) is exactly #52, #85, #87, #92, #93, #95", () => {
  // THE ARGUMENTS A CARD SCRIPT PASSES:
  //     catalog.query({ rarity: "Legendary", excludeIndex: "83" })
  //   or catalog.pool("83", { rarity: "Legendary" })
  // R35: "Pool: the §8 Legendary-rarity cards except #83". For replacing a card on the board, the
  // script narrows the same pool by type and asks for TRAP_TYPES when the board card is a trap
  // ("Field Trap counts as Trap").
  const R35_POOL = ["52", "85", "87", "92", "93", "95"];

  it("R35 the filter a card script writes returns exactly the six-index list", () => {
    expect(indices(catalog.query({ rarity: "Legendary", excludeIndex: "83" }))).toEqual(R35_POOL);
    expect(indices(catalog.pool("83", { rarity: "Legendary" }))).toEqual(R35_POOL);
  });

  it("R35 the pool is the §8 Legendary rarity set minus #83, and nothing else", () => {
    expect(indices(catalog.query({ rarity: "Legendary" }))).toEqual(["52", "83", "85", "87", "92", "93", "95"]);
    expect(indices(catalog.pool("83", { rarity: "Legendary" }))).not.toContain("83");
    expect(catalog.pool("83", { rarity: "Legendary" }).every((def) => def.rarity === "Legendary")).toBe(true);
    expect(catalog.pool("83", { rarity: "Legendary" }).every((def) => !def.token)).toBe(true);
  });

  it("R35 narrowed by type for a board replacement, with Field Trap counting as Trap", () => {
    // Only #85 is a Legendary trap, so a board trap — Trap or Field Trap — is replaced by it.
    expect(indices(catalog.pool("83", { rarity: "Legendary", type: TRAP_TYPES }))).toEqual(["85"]);
    expect(indices(catalog.pool("83", { rarity: "Legendary", type: "Unit" }))).toEqual(["52", "92"]);
  });
});

describe("R65 pools and filters read a definition's cost out of play", () => {
  it("R65 an X-cost card's queryCost is 0 and it answers a cost-0 query", () => {
    // #24 Efficiency Dividend, #74 Adaptive UI, #98 Heroic Power are the catalog's X-cost cards.
    expect(queryCost(cardDefByIndex("24"))).toBe(0);
    expect(queryCost(cardDefByIndex("74"))).toBe(0);
    expect(queryCost(cardDefByIndex("98"))).toBe(0);

    const cost0 = indices(query({ cost: 0 }));
    expect(cost0).toContain("24");
    expect(cost0).toContain("74");
    expect(cost0).toContain("98");
  });

  it("R65 an embiggen card's queryCost is its base price, and it answers that cost's query", () => {
    // #46 Suppressive Aura, #59 Unbiased Immigration, #84 Going Long are "2 embiggen 4".
    for (const index of ["46", "59", "84"]) {
      const def = cardDefByIndex(index);
      expect(def.cost).toEqual({ base: 2, embiggen: 4 });
      expect(queryCost(def)).toBe(2);
      expect(indices(query({ cost: 2 }))).toContain(index);
      expect(indices(query({ cost: 4 }))).not.toContain(index);
    }
  });

  it("R65 costRange reads the same number, so a bracket agrees with queryCost (#7, #51)", () => {
    // #7 Jewelosco Scarab's "2-cost" Discover and #51's 0-1 / 2 / 3 / 4+ brackets share this read.
    const bracket0to1 = query({ costRange: { min: 0, max: 1 } });
    expect(indices(bracket0to1)).toEqual(indices(query({}).filter((def) => queryCost(def) <= 1)));
    expect(indices(bracket0to1)).toContain("24"); // an X card reads as 0
    expect(indices(query({ costRange: { min: 4 } }))).not.toContain("46"); // an embiggen card reads as 2
  });
});

describe("§9.3, R60 pool order is deterministic, so a seeded pick replays", () => {
  it("§9.3 two identical calls return the same defs in the same order", () => {
    const first = query({ type: "Unit", costRange: { min: 2, max: 3 } });
    const second = query({ type: "Unit", costRange: { min: 2, max: 3 } });

    expect(first.map((def) => def.id)).toEqual(second.map((def) => def.id));
    expect(first.length).toBeGreaterThan(1);
  });

  it("R60 a multi-result pool comes back in §5 index order, ascending", () => {
    const ranks = query({ type: "Unit" }).map((def) => Number.parseFloat(def.index));

    expect(ranks.length).toBeGreaterThan(1);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Spot-checked against the catalog so "ascending" cannot be satisfied by an empty result:
    expect(indices(query({ rarity: "Legendary" }))[0]).toBe("52");
  });

  it("§9.3 the order does not depend on the order the registry handed the defs over", () => {
    const forward = query({}).map((def) => def.id);
    const reversedCatalog = Object.fromEntries(Object.entries(CATALOG).reverse());

    try {
      registerCatalog(reversedCatalog, CATALOG_VERSION);
      expect(query({}).map((def) => def.id)).toEqual(forward);
      expect(indices(query({ tags: ["KY"], excludeIndex: "57" }))).toEqual(["31", "51", "82"]);
    } finally {
      registerCatalog(CATALOG, CATALOG_VERSION);
    }
  });

  // ENGINE DEFECT, reported to the lead and NOT worked around in src/query.ts.
  // §9.3, R60: the pool order is "a strict total order … never depends on the order the registry
  // happened to hand the defs over", which is what makes a seeded `rng.pick`/`shuffle` over a pool
  // replay identically. This was pinned as `it.fails` while the engine's comparator subtracted two
  // `indexRank`s: both are +Infinity for a non-numeric index, `Infinity - Infinity` is NaN, and
  // `NaN !== 0` returned NaN, which `sort` reads as 0 — so both tie-breaks were skipped and the
  // four shared tokens came back in insertion order. The comparator now compares instead of
  // subtracting, so this is a plain `it`; registering the catalog reversed is the regression guard.
  it("§9.3 the token pool's order is insertion-independent", () => {
    const forward = indices(query({ tags: ["Token"] }));
    const reversedCatalog = Object.fromEntries(Object.entries(CATALOG).reverse());

    try {
      registerCatalog(reversedCatalog, CATALOG_VERSION);
      expect(indices(query({ tags: ["Token"] }))).toEqual(forward);
    } finally {
      registerCatalog(CATALOG, CATALOG_VERSION);
    }
  });
});
