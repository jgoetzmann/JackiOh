// The landing fan's cards are copies of catalog entries (landingFan.ts says why), so each copy is
// held equal to its entry in packages/cards/catalog.json, read from disk as the audio tests read it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { LANDING_FAN } from "./landingFan.ts";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const CATALOG = JSON.parse(readFileSync(resolve(REPO, "packages/cards/catalog.json"), "utf8")) as Record<string, unknown>;

describe("the landing fan", () => {
  it("draws four real Core cards, each exactly as the catalog holds it", () => {
    expect(LANDING_FAN).toHaveLength(4);
    for (const { def } of LANDING_FAN) {
      expect(def.token, def.id).toBe(false);
      expect(def, def.id).toEqual(CATALOG[def.id]);
    }
  });

  it("shows four rarities and one Radiant face, the middle card", () => {
    expect(new Set(LANDING_FAN.map(({ def }) => def.rarity)).size).toBe(4);
    expect(LANDING_FAN.map(({ radiant }) => radiant)).toEqual([false, false, true, false]);
  });
});
