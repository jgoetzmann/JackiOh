// Script-less definitions for engine tests: real cards arrive in M4, so M1–M3 tests use these
// (BUILD §0). Each helper returns plain CardDefs, registered through createGame.

import type { CardDef, CardDefs, Keyword, Tag } from "@jackioh/shared";

export function unitDef(
  index: number,
  overrides: Partial<CardDef> & { attack?: number; health?: number; keywords?: Keyword[] } = {},
): CardDef {
  const { attack = 2, health = 2, keywords = [], ...rest } = overrides;
  return {
    id: `fx-${index}`,
    index: String(index),
    name: `Fixture Unit ${index}`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack, health, keywords, text: "vanilla" },
    radiant: { attack: attack * 2, health: health * 2, keywords, text: "vanilla" },
    ...rest,
  };
}

export function spellDef(index: number, overrides: Partial<CardDef> = {}): CardDef {
  return {
    id: `fx-${index}`,
    index: String(index),
    name: `Fixture Spell ${index}`,
    set: "Core",
    type: "Spell",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: "does nothing" },
    radiant: { keywords: [], text: "does nothing" },
    ...overrides,
  };
}

export function tokenDef(name: string, tags: Tag[] = ["Token"]): CardDef {
  return {
    id: `fx-token-${name}`,
    index: `T-${name}`,
    name: `Fixture ${name} Token`,
    set: "Core",
    type: "Unit",
    tags,
    rarity: "Token",
    token: true,
    cost: 1,
    base: { attack: 3, health: 3, keywords: [{ kind: "Rush" }], text: "token" },
    radiant: { attack: 3, health: 3, keywords: [{ kind: "Rush" }], text: "token" },
  };
}

/** `count` distinct vanilla units, indexed from `from`. */
export function vanillaCatalog(count = 40, from = 1): CardDefs {
  const defs: Record<string, CardDef> = {};
  for (let i = from; i < from + count; i += 1) {
    const def = unitDef(i);
    defs[def.id] = def;
  }
  const token = tokenDef("rush");
  defs[token.id] = token;
  return defs;
}

/** The first `size` ids of a vanilla catalog, as a legal deck. */
export function vanillaDeck(size = 20, from = 1): string[] {
  return Array.from({ length: size }, (_, i) => `fx-${from + i}`);
}
