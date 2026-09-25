// Polish 6, slice D: the deck builder's filter and sort semantics, pure (docs/polish/6-cards.md,
// B31–B36; the DOM half is browse.test.tsx).
//
// `filters.ts` is the only place these semantics live. The catalog below is built inline on
// purpose: it has every cost shape the Surface names (0, 1, 6, 100, "X" and two embiggen cards),
// all five types, several tags and rarities, a card with no text, a card nobody owns, a token, and
// two cards that tie on cost and name so the index tie-break is visible.

import type { CardCost, CardDef, CardFace, CardType, Rarity, Tag } from "@jackioh/shared";
import type { CatalogSnapshot, Collection } from "@jackioh/validator";
import { describe, expect, it } from "vitest";

import { CATALOG as CORE_CATALOG } from "@jackioh/cards";

import {
  COST_BUCKETS,
  CURVE_TOP,
  DEFAULT_FILTER,
  DEFAULT_SORT,
  FILTER_RARITIES,
  FILTER_TAGS,
  FILTER_TYPES,
  SORT_KEYS,
  costBucket,
  costOrder,
  deckListOrder,
  manaCurve,
  matchesFilter,
  searchMatches,
  sortPool,
  visiblePool,
  type CostBucket,
  type PoolFilter,
  type PoolSort,
  type SortKey,
} from "./filters.ts";
import { filterCostId, filterRarityId, filterTagId, filterTypeId, slugOf } from "./testids.ts";

// ---------------------------------------------------------------------------------------------
// The inline catalog
// ---------------------------------------------------------------------------------------------

type DefInput = {
  id: string;
  index: string;
  name: string;
  type: CardType;
  rarity: Rarity;
  cost: CardCost;
  tags?: Tag[];
  token?: boolean;
  base?: Partial<CardFace>;
  radiant?: Partial<CardFace>;
};

function def(input: DefInput): CardDef {
  return {
    id: input.id,
    index: input.index,
    name: input.name,
    set: "Core",
    type: input.type,
    tags: input.tags ?? [],
    rarity: input.rarity,
    token: input.token ?? false,
    cost: input.cost,
    base: { keywords: [], text: "", ...input.base },
    radiant: { keywords: [], text: "", ...input.radiant },
  };
}

const DEFS: CardDef[] = [
  // Cost 0, no text on either face. Its radiant stats are the biggest in the set, so a sort that
  // read the radiant face instead of the base one would move it.
  def({ id: "x-01", index: "1", name: "Acorn Scout", type: "Unit", tags: ["Human"], rarity: "Common", cost: 0,
    base: { attack: 1, health: 1 }, radiant: { attack: 20, health: 20 } }),
  def({ id: "x-02", index: "2", name: "Bramble Cat", type: "Unit", tags: ["Felinor"], rarity: "Rare", cost: 1,
    base: { attack: 2, health: 3, keywords: [{ kind: "Taunt" }], text: "Taunt" },
    radiant: { attack: 4, health: 6, keywords: [{ kind: "Taunt" }, { kind: "Lifesteal" }], text: "Plus Lifesteal" } }),
  def({ id: "x-03", index: "3", name: "Cinder Wave", type: "Spell", tags: ["Call to Chaos"], rarity: "Epic", cost: 6,
    base: { text: "Deal 3 damage to every unit" }, radiant: { text: "Deal 6 damage to every unit" } }),
  def({ id: "x-04", index: "4", name: "Deep Void", type: "Unit", rarity: "Mythic", cost: 100,
    base: { attack: 10, health: 10, text: "Cry: exile every other permanent" },
    radiant: { attack: 10, health: 10, keywords: [{ kind: "Charge" }], text: "Plus Charge" } }),
  def({ id: "x-05", index: "5", name: "Echo Market", type: "Field Spell", tags: ["Fruit"], rarity: "Legendary", cost: "X",
    base: { text: "Draw X cards" }, radiant: { text: "Draw X cards, then gain a Banana" } }),
  def({ id: "x-06", index: "6", name: "Fuse Box", type: "Trap", tags: ["KY"], rarity: "Common", cost: { base: 2, embiggen: 4 },
    base: { text: "When an enemy attacks: deal 2 (paid 4: deal 5)" }, radiant: { text: "Deal 4 (paid 4: deal 10)" } }),
  def({ id: "x-07", index: "7", name: "Grove Ward", type: "Field Trap", tags: ["CN", "Human"], rarity: "Rare",
    cost: { base: 3, embiggen: 5 },
    base: { text: "Your units have Lifesteal" }, radiant: { text: "Your units have Lifesteal and Rush" } }),
  def({ id: "x-08", index: "8", name: "Hollow Squire", type: "Unit", tags: ["Quickdraw"], rarity: "Epic", cost: 3,
    base: { attack: 5, health: 2, keywords: [{ kind: "Rush" }], text: "Rush" },
    radiant: { attack: 10, health: 4, keywords: [{ kind: "Charge" }], text: "Charge" } }),
  // Nobody owns this one (see COLLECTION).
  def({ id: "x-09", index: "9", name: "Iron Sentry", type: "Unit", tags: ["Human"], rarity: "Common", cost: 2,
    base: { attack: 0, health: 8, keywords: [{ kind: "Armor", n: 2 }], text: "Armor 2" },
    radiant: { attack: 0, health: 16, keywords: [{ kind: "Armor", n: 4 }], text: "Armor 4" } }),
  // The twins tie on cost and (case-insensitively) on name, so the numeric index decides: 12
  // before 100, which a string comparison of "100" and "12" would get backwards. Each carries a
  // keyword its text never mentions: Divine Shield on the radiant face, Poisonous on the base one.
  def({ id: "x-10", index: "100", name: "Mirror Twin", type: "Unit", rarity: "Common", cost: 4,
    base: { attack: 4, health: 4, text: "Reflects light" },
    radiant: { attack: 8, health: 8, keywords: [{ kind: "Divine Shield" }], text: "Reflects more light" } }),
  def({ id: "x-11", index: "12", name: "mirror twin", type: "Unit", rarity: "Common", cost: 4,
    base: { attack: 4, health: 4, keywords: [{ kind: "Poisonous" }], text: "Reflects light" },
    radiant: { attack: 8, health: 8, text: "Reflects more light" } }),
  def({ id: "x-t1", index: "T-1", name: "Sprout Token", type: "Unit", tags: ["Token"], rarity: "Token", token: true, cost: 1,
    base: { attack: 1, health: 1 }, radiant: { attack: 2, health: 2 } }),
];

const CATALOG: CatalogSnapshot = {
  version: "polish-6-filters",
  cards: Object.fromEntries(DEFS.map((d) => [d.id, d])),
};

/** Everything but x-09. The token is owned too, to prove it is left out as a token. */
const COLLECTION: Collection = Object.fromEntries(DEFS.filter((d) => d.id !== "x-09").map((d) => [d.id, 1]));

const ALL_IDS: readonly string[] = DEFS.filter((d) => !d.token).map((d) => d.id);
const UNOWNED = "x-09";
const TOKEN = "x-t1";

function card(id: string): CardDef {
  const found = CATALOG.cards[id];
  if (found === undefined) throw new Error(`inline catalog has no ${id}`);
  return found;
}

function filter(over: Partial<PoolFilter> = {}): PoolFilter {
  return { ...DEFAULT_FILTER, ...over };
}

function owned(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== UNOWNED);
}

/**
 * Every non-token card under each sort, worked out by hand from the rules the Surface states:
 * the primary key flips with `dir`; ties break ascending by cost, then name (case-insensitive),
 * then numeric index; for attack and health the three cards with no stats go last either way.
 */
const SORTED: Record<SortKey, { asc: string[]; desc: string[] }> = {
  cost: {
    asc: ["x-01", "x-02", "x-06", "x-09", "x-07", "x-08", "x-11", "x-10", "x-03", "x-04", "x-05"],
    desc: ["x-05", "x-04", "x-03", "x-11", "x-10", "x-07", "x-08", "x-06", "x-09", "x-02", "x-01"],
  },
  name: {
    asc: ["x-01", "x-02", "x-03", "x-04", "x-05", "x-06", "x-07", "x-08", "x-09", "x-11", "x-10"],
    desc: ["x-11", "x-10", "x-09", "x-08", "x-07", "x-06", "x-05", "x-04", "x-03", "x-02", "x-01"],
  },
  rarity: {
    asc: ["x-01", "x-06", "x-09", "x-11", "x-10", "x-02", "x-07", "x-08", "x-03", "x-05", "x-04"],
    desc: ["x-04", "x-05", "x-08", "x-03", "x-02", "x-07", "x-01", "x-06", "x-09", "x-11", "x-10"],
  },
  attack: {
    asc: ["x-09", "x-01", "x-02", "x-11", "x-10", "x-08", "x-04", "x-06", "x-07", "x-03", "x-05"],
    desc: ["x-04", "x-08", "x-11", "x-10", "x-02", "x-01", "x-09", "x-06", "x-07", "x-03", "x-05"],
  },
  health: {
    asc: ["x-01", "x-08", "x-02", "x-11", "x-10", "x-09", "x-04", "x-06", "x-07", "x-03", "x-05"],
    desc: ["x-04", "x-09", "x-11", "x-10", "x-02", "x-08", "x-01", "x-06", "x-07", "x-03", "x-05"],
  },
  type: {
    asc: ["x-01", "x-02", "x-09", "x-08", "x-11", "x-10", "x-04", "x-03", "x-05", "x-06", "x-07"],
    desc: ["x-07", "x-06", "x-05", "x-03", "x-01", "x-02", "x-09", "x-08", "x-11", "x-10", "x-04"],
  },
};

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

describe("the filter vocabulary (B31, B34)", () => {
  it("B31 COST_BUCKETS runs 0 to 5, then 6+, then X, and CURVE_TOP is 6", () => {
    expect([...COST_BUCKETS]).toEqual(["0", "1", "2", "3", "4", "5", "6+", "X"]);
    expect(CURVE_TOP).toBe(6);
  });

  it("B31 the type, tag and rarity chips cover the deckable vocabulary and never Token", () => {
    expect([...FILTER_TYPES]).toEqual(["Unit", "Spell", "Field Spell", "Trap", "Field Trap"]);
    expect([...FILTER_TAGS]).toEqual(["Human", "Felinor", "KY", "CN", "Fruit", "Call to Chaos", "Quickdraw", "Jlockeed"]);
    expect([...FILTER_RARITIES]).toEqual(["Common", "Rare", "Epic", "Legendary", "Mythic"]);
    expect(FILTER_TAGS).not.toContain("Token");
    expect(FILTER_RARITIES).not.toContain("Token");
  });

  it("B31 DEFAULT_FILTER constrains nothing but ownership", () => {
    expect(DEFAULT_FILTER.costs.size).toBe(0);
    expect(DEFAULT_FILTER.types.size).toBe(0);
    expect(DEFAULT_FILTER.tags.size).toBe(0);
    expect(DEFAULT_FILTER.rarities.size).toBe(0);
    expect(DEFAULT_FILTER.search).toBe("");
    expect(DEFAULT_FILTER.ownedOnly).toBe(true);
  });

  it("B34 there are six sort keys, and the default sort is cost ascending", () => {
    expect([...SORT_KEYS].sort()).toEqual(["attack", "cost", "health", "name", "rarity", "type"]);
    expect(SORT_KEYS).toHaveLength(6);
    expect(DEFAULT_SORT).toEqual({ key: "cost", dir: "asc" });
  });

  it("B31 chip testids slug their value, and the cost chips keep 6+ and X as they are", () => {
    expect(slugOf("Call to Chaos")).toBe("call-to-chaos");
    expect(slugOf("Field Trap")).toBe("field-trap");
    expect(slugOf("KY")).toBe("ky");
    expect(slugOf("Field Spell")).toBe("field-spell");
    expect(filterCostId("6+")).toBe("db-filter-cost-6+");
    expect(filterCostId("X")).toBe("db-filter-cost-X");
    expect(filterCostId("0")).toBe("db-filter-cost-0");
    expect(filterTypeId("Field Spell")).toBe("db-filter-type-field-spell");
    expect(filterTagId("Call to Chaos")).toBe("db-filter-tag-call-to-chaos");
    expect(filterRarityId("Legendary")).toBe("db-filter-rarity-legendary");
  });
});

// ---------------------------------------------------------------------------------------------
// costBucket and costOrder
// ---------------------------------------------------------------------------------------------

describe("costBucket and costOrder (B31)", () => {
  const BUCKETS: [CardCost, CostBucket][] = [
    [0, "0"],
    [1, "1"],
    [5, "5"],
    [6, "6+"],
    [7, "6+"],
    [100, "6+"],
    ["X", "X"],
    [{ base: 2, embiggen: 4 }, "2"],
    [{ base: 5, embiggen: 7 }, "5"],
    [{ base: 6, embiggen: 8 }, "6+"],
  ];

  for (const [cost, bucket] of BUCKETS) {
    it(`B31 costBucket(${JSON.stringify(cost)}) is "${bucket}"`, () => {
      expect(costBucket(cost)).toBe(bucket);
    });
  }

  it("B31 an embiggen card is never filed under its embiggen price", () => {
    expect(costBucket({ base: 2, embiggen: 4 })).not.toBe("4");
    expect(costBucket({ base: 3, embiggen: 5 })).not.toBe("5");
  });

  it("B31 costOrder is the number, the embiggen base, and +Infinity for X", () => {
    expect(costOrder(0)).toBe(0);
    expect(costOrder(3)).toBe(3);
    expect(costOrder(100)).toBe(100);
    expect(costOrder({ base: 2, embiggen: 4 })).toBe(2);
    expect(costOrder("X")).toBe(Number.POSITIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------------------------
// matchesFilter
// ---------------------------------------------------------------------------------------------

function matching(f: PoolFilter): string[] {
  return ALL_IDS.filter((id) => matchesFilter(card(id), f));
}

describe("matchesFilter (B31)", () => {
  it("B31 the default filter matches every card", () => {
    expect(matching(DEFAULT_FILTER)).toEqual(ALL_IDS);
  });

  it("B31 ownership is not matchesFilter's job: an unowned card still matches with ownedOnly on", () => {
    expect(matchesFilter(card(UNOWNED), filter({ ownedOnly: true }))).toBe(true);
  });

  it("B31 cost 6+ holds 6 and 100", () => {
    expect(matching(filter({ costs: new Set<CostBucket>(["6+"]) }))).toEqual(["x-03", "x-04"]);
  });

  it("B31 cost X holds only the X card", () => {
    expect(matching(filter({ costs: new Set<CostBucket>(["X"]) }))).toEqual(["x-05"]);
  });

  it("B31 an embiggen card is found under its base price and not its embiggen price", () => {
    expect(matching(filter({ costs: new Set<CostBucket>(["2"]) }))).toEqual(["x-06", "x-09"]);
    expect(matching(filter({ costs: new Set<CostBucket>(["4"]) }))).toEqual(["x-10", "x-11"]);
    expect(matching(filter({ costs: new Set<CostBucket>(["5"]) }))).toEqual([]);
  });

  it("B31 chips in one group OR together", () => {
    expect(matching(filter({ costs: new Set<CostBucket>(["0", "1"]) }))).toEqual(["x-01", "x-02"]);
    expect(matching(filter({ tags: new Set<Tag>(["Felinor", "Fruit"]) }))).toEqual(["x-02", "x-05"]);
  });

  it("B31 groups AND together", () => {
    expect(matching(filter({ costs: new Set<CostBucket>(["3"]), types: new Set<CardType>(["Unit"]) }))).toEqual(["x-08"]);
    expect(matching(filter({ tags: new Set<Tag>(["Human"]), rarities: new Set<Rarity>(["Rare"]) }))).toEqual(["x-07"]);
  });

  it("B31 groups that share no card give nothing", () => {
    expect(matching(filter({ types: new Set<CardType>(["Spell"]), rarities: new Set<Rarity>(["Mythic"]) }))).toEqual([]);
  });

  it("B31 a Trap chip does not take Field Traps, nor a Spell chip Field Spells", () => {
    expect(matching(filter({ types: new Set<CardType>(["Trap"]) }))).toEqual(["x-06"]);
    expect(matching(filter({ types: new Set<CardType>(["Spell"]) }))).toEqual(["x-03"]);
    expect(matching(filter({ types: new Set<CardType>(["Field Trap"]) }))).toEqual(["x-07"]);
  });

  it("B31 a tag chip matches any card carrying that tag among others", () => {
    expect(matching(filter({ tags: new Set<Tag>(["Human"]) }))).toEqual(["x-01", "x-07", "x-09"]);
    expect(matching(filter({ tags: new Set<Tag>(["CN"]) }))).toEqual(["x-07"]);
  });

  it("B31 an untagged card never passes a tag chip", () => {
    expect(card("x-04").tags).toEqual([]);
    for (const tag of FILTER_TAGS) {
      expect(matchesFilter(card("x-04"), filter({ tags: new Set<Tag>([tag]) })), tag).toBe(false);
    }
  });

  it("B31 a rarity chip matches that rarity only", () => {
    expect(matching(filter({ rarities: new Set<Rarity>(["Mythic"]) }))).toEqual(["x-04"]);
    expect(matching(filter({ rarities: new Set<Rarity>(["Legendary", "Epic"]) }))).toEqual(["x-03", "x-05", "x-08"]);
  });

  it("B32 the search is part of the filter", () => {
    expect(matching(filter({ search: "bramble" }))).toEqual(["x-02"]);
    expect(matching(filter({ search: "bramble", costs: new Set<CostBucket>(["0"]) }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// searchMatches
// ---------------------------------------------------------------------------------------------

function found(query: string): string[] {
  return ALL_IDS.filter((id) => searchMatches(card(id), query));
}

describe("searchMatches (B32)", () => {
  it("B32 matches the name, ignoring case", () => {
    expect(found("bramble")).toEqual(["x-02"]);
    expect(found("BRAMBLE")).toEqual(["x-02"]);
    expect(found("aCoRn")).toEqual(["x-01"]);
  });

  it("B32 matches the type", () => {
    expect(found("spell")).toEqual(["x-03", "x-05"]);
  });

  it("B32 matches a tag", () => {
    expect(found("felinor")).toEqual(["x-02"]);
    expect(found("call to chaos")).toEqual(["x-03"]);
  });

  it("B32 matches the rarity", () => {
    expect(found("legendary")).toEqual(["x-05"]);
    expect(found("mythic")).toEqual(["x-04"]);
  });

  it("B32 matches the base text", () => {
    expect(found("exile")).toEqual(["x-04"]);
  });

  it("B32 matches the radiant text", () => {
    expect(found("banana")).toEqual(["x-05"]);
  });

  it("B32 matches a printed keyword kind on either face, even one the text never names", () => {
    expect(found("divine")).toEqual(["x-10"]);
    expect(found("poisonous")).toEqual(["x-11"]);
  });

  it("B32 every whitespace-separated term must occur, in any order and anywhere in the haystack", () => {
    expect(found("field trap")).toEqual(["x-07"]);
    expect(found("rare cat")).toEqual(["x-02"]);
    expect(found("cat rare")).toEqual(["x-02"]);
  });

  it("B32 the query is trimmed and runs of whitespace split it", () => {
    expect(found("   cat \t  rare   ")).toEqual(["x-02"]);
  });

  it("B32 an empty or all-blank query matches everything", () => {
    expect(found("")).toEqual(ALL_IDS);
    expect(found("   ")).toEqual(ALL_IDS);
  });

  it("B32 one term that occurs nowhere rules the card out", () => {
    expect(found("bramble zzz")).toEqual([]);
    expect(found("zzz")).toEqual([]);
  });

  it("B32 the cost and the catalog index are not in the haystack", () => {
    // Deep Void costs 100 and Mirror Twin's index is "100"; neither number is in any text.
    expect(found("100")).toEqual([]);
    expect(found("12")).toEqual([]);
  });

  it("B32 the set name and the card id are not in the haystack", () => {
    expect(found("core")).toEqual([]);
    expect(found("x-01")).toEqual([]);
  });

  it("B32 finds a card with no text by its name, and not by text it does not have", () => {
    expect(found("scout")).toEqual(["x-01"]);
    expect(found("scout damage")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// sortPool
// ---------------------------------------------------------------------------------------------

describe("sortPool (B34)", () => {
  for (const key of ["cost", "name", "rarity", "attack", "health", "type"] as const) {
    for (const dir of ["asc", "desc"] as const) {
      it(`B34 sorts by ${key} ${dir}`, () => {
        const sort: PoolSort = { key, dir };
        // Fed in reverse catalog order, so an identity sort cannot pass.
        expect(sortPool([...ALL_IDS].reverse(), CATALOG, sort)).toEqual(SORTED[key][dir]);
      });
    }
  }

  it("B34 ties break by cost, then name, then numeric index, ascending even when the key is descending", () => {
    // Cost 3: Grove Ward before Hollow Squire both ways. Cost 4: index 12 before index 100.
    const desc = sortPool(ALL_IDS, CATALOG, { key: "cost", dir: "desc" });
    expect(desc.indexOf("x-07")).toBeLessThan(desc.indexOf("x-08"));
    expect(desc.indexOf("x-11")).toBeLessThan(desc.indexOf("x-10"));
  });

  it("B34 cards without stats go last for attack and health, in both directions", () => {
    const statless = ["x-03", "x-05", "x-06", "x-07"];
    for (const key of ["attack", "health"] as const) {
      for (const dir of ["asc", "desc"] as const) {
        const tail = sortPool(ALL_IDS, CATALOG, { key, dir }).slice(-statless.length);
        expect([...tail].sort(), `${key} ${dir}`).toEqual(statless);
      }
    }
  });

  it("B34 attack and health read the base face, not the radiant one", () => {
    // x-01 is 1/1 on its base face and 20/20 radiant.
    expect(sortPool(["x-04", "x-01"], CATALOG, { key: "attack", dir: "asc" })).toEqual(["x-01", "x-04"]);
    expect(sortPool(["x-04", "x-01"], CATALOG, { key: "health", dir: "asc" })).toEqual(["x-01", "x-04"]);
  });

  it("B34 an empty list sorts to an empty list", () => {
    expect(sortPool([], CATALOG, DEFAULT_SORT)).toEqual([]);
  });

  it("B34 sortPool leaves the list it was given untouched", () => {
    const ids = [...ALL_IDS].reverse();
    const copy = [...ids];
    sortPool(ids, CATALOG, { key: "name", dir: "asc" });
    expect(ids).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------------------------
// visiblePool
// ---------------------------------------------------------------------------------------------

describe("visiblePool (B31, B33, B34)", () => {
  it("B33 by default it shows the owned non-token cards, cost ascending", () => {
    expect(visiblePool(CATALOG, COLLECTION, DEFAULT_FILTER, DEFAULT_SORT)).toEqual(owned(SORTED.cost.asc));
  });

  it("B33 never offers a token, even an owned one", () => {
    expect(visiblePool(CATALOG, COLLECTION, DEFAULT_FILTER, DEFAULT_SORT)).not.toContain(TOKEN);
    expect(visiblePool(CATALOG, COLLECTION, filter({ ownedOnly: false }), DEFAULT_SORT)).not.toContain(TOKEN);
    expect(visiblePool(CATALOG, null, filter({ ownedOnly: false }), DEFAULT_SORT)).not.toContain(TOKEN);
  });

  it("B33 with ownedOnly off it shows every non-token card", () => {
    expect(visiblePool(CATALOG, COLLECTION, filter({ ownedOnly: false }), DEFAULT_SORT)).toEqual(SORTED.cost.asc);
  });

  it("B33 with no collection it shows every non-token card, whatever ownedOnly says", () => {
    expect(visiblePool(CATALOG, null, DEFAULT_FILTER, DEFAULT_SORT)).toEqual(SORTED.cost.asc);
  });

  it("B33 an id only the collection knows never reaches the pool", () => {
    const collection: Collection = { ...COLLECTION, "ghost-001": 1 };
    expect(visiblePool(CATALOG, collection, DEFAULT_FILTER, DEFAULT_SORT)).not.toContain("ghost-001");
  });

  it("B31 filters, then sorts by the sort it is given", () => {
    const f = filter({ costs: new Set<CostBucket>(["3", "4"]) });
    expect(visiblePool(CATALOG, COLLECTION, f, { key: "name", dir: "desc" })).toEqual(["x-11", "x-10", "x-08", "x-07"]);
  });

  it("B31 an owned-only search for an unowned card finds nothing", () => {
    expect(visiblePool(CATALOG, COLLECTION, filter({ search: "iron" }), DEFAULT_SORT)).toEqual([]);
    expect(visiblePool(CATALOG, COLLECTION, filter({ search: "iron", ownedOnly: false }), DEFAULT_SORT)).toEqual([UNOWNED]);
  });

  it("B31 a filter nothing passes gives an empty pool", () => {
    expect(visiblePool(CATALOG, COLLECTION, filter({ costs: new Set<CostBucket>(["5"]) }), DEFAULT_SORT)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// manaCurve
// ---------------------------------------------------------------------------------------------

describe("manaCurve (B36)", () => {
  it("B36 counts a deck's cards per bucket, embiggen under the base price", () => {
    const deck = ["x-05", "x-08", "x-01", "x-07", "x-02", "x-04", "x-06"];
    expect(manaCurve(deck, CATALOG)).toEqual({ "0": 1, "1": 1, "2": 1, "3": 2, "4": 0, "5": 0, "6+": 1, X: 1 });
  });

  it("B36 an empty deck has every bucket at zero", () => {
    expect(manaCurve([], CATALOG)).toEqual({ "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6+": 0, X: 0 });
  });

  it("B36 skips ids the catalog does not know", () => {
    expect(manaCurve(["x-03", "core-999", "x-04"], CATALOG)).toEqual({
      "0": 0, "1": 0, "2": 0, "3": 0, "4": 0, "5": 0, "6+": 2, X: 0,
    });
  });

  it("B36 has exactly the eight COST_BUCKETS keys", () => {
    expect(Object.keys(manaCurve(["x-01"], CATALOG)).sort()).toEqual([...COST_BUCKETS].sort());
  });
});

// ---------------------------------------------------------------------------------------------
// deckListOrder
// ---------------------------------------------------------------------------------------------

describe("deckListOrder (B35)", () => {
  it("B35 orders tiles by cost, then name, with unknown ids last", () => {
    const draft = ["x-05", "core-999", "x-01", "x-08", "x-07", "x-04", "x-06"];
    expect(deckListOrder(draft, CATALOG)).toEqual(["x-01", "x-06", "x-07", "x-08", "x-04", "x-05", "core-999"]);
  });

  it("B35 breaks a tie on cost and name by id", () => {
    const twins: CatalogSnapshot = {
      version: "polish-6-twins",
      cards: {
        "y-2": def({ id: "y-2", index: "2", name: "Same Card", type: "Unit", rarity: "Common", cost: 1 }),
        "y-1": def({ id: "y-1", index: "1", name: "Same Card", type: "Unit", rarity: "Common", cost: 1 }),
      },
    };
    expect(deckListOrder(["y-2", "y-1"], twins)).toEqual(["y-1", "y-2"]);
  });

  it("B35 leaves the draft it was given in draft order", () => {
    const draft = ["x-05", "x-01", "x-08"];
    const copy = [...draft];
    deckListOrder(draft, CATALOG);
    expect(draft).toEqual(copy);
  });

  it("B35 an empty deck has no tiles", () => {
    expect(deckListOrder([], CATALOG)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// R278: the Jlockeed tag
// ---------------------------------------------------------------------------------------------

describe("the Jlockeed tag (R278)", () => {
  const REAL: CatalogSnapshot = { version: "core-test", cards: CORE_CATALOG };

  it("R278 offers a Jlockeed chip, and filtering on it keeps #13 and #14 of the real catalog and nothing else", () => {
    expect(FILTER_TAGS).toContain("Jlockeed");
    expect(filterTagId("Jlockeed")).toBe("db-filter-tag-jlockeed");
    const kept = visiblePool(REAL, null, { ...DEFAULT_FILTER, ownedOnly: false, tags: new Set<Tag>(["Jlockeed"]) }, DEFAULT_SORT);
    expect([...kept].sort()).toEqual(["core-013", "core-014"]);
  });
});
