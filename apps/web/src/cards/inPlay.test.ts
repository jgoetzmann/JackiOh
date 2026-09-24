// inPlay.ts: the words a face in play prints where play and print part ways (SPEC §10.10).
//
// `POWER_WORDS` is the client's copy of §8 #98's seven clauses, keyed by the name the view gives a
// rolled power (R243). The engine holds the same clauses beside each power's effects, and the
// client cannot load the engine online, so this test is what keeps the two tables one table.

import { describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import { subsystems } from "@jackioh/engine";

import { CONCEALED_TAG, HEROIC_POWER_ID, POWER_WORDS, concealedInPlay, powerText } from "./inPlay.ts";

describe("#98 Heroic Power's rolled power, in words", () => {
  it("names every power the engine can roll, in the engine's own words, base and radiant", () => {
    expect(Object.keys(POWER_WORDS).sort()).toEqual([...subsystems.HERO_POWER_NAMES].sort());
    for (const power of subsystems.HERO_POWERS) {
      expect(POWER_WORDS[power.name], power.name).toEqual({ base: power.label, radiant: power.radiantLabel });
    }
  });

  it("prints the keyword line, then the one power with its X, and nothing of the other six", () => {
    const text = powerText({ name: "recruit", x: 3 }, false, "Indestructible");
    expect(text).toBe("Indestructible. Once per turn, spend 3: Recruit a permanent. Playing it activates it once");
    for (const other of ["Lose 2 health", "Deal 1 damage", "Rush Token", "Felinor Token", "Discover a Unit"]) {
      expect(text).not.toContain(other);
    }
  });

  it("prints the radiant clause on a radiant face", () => {
    expect(powerText({ name: "discover", x: 2 }, true, "Indestructible")).toBe(
      "Indestructible. Once per turn, spend 2: Discover a Radiant Unit. Playing it activates it once",
    );
  });

  it("leaves a name it does not know to the printed text", () => {
    expect(powerText({ name: "not-a-power", x: 1 }, false, "Indestructible")).toBeNull();
  });

  it("is the card the catalog calls #98", () => {
    expect(CATALOG[HEROIC_POWER_ID]?.index).toBe("98");
  });
});

describe("Call to Chaos in play", () => {
  it("conceals exactly the cards that carry the Call to Chaos tag: #95", () => {
    const concealed = Object.values(CATALOG).filter((def) => concealedInPlay(def.tags));
    expect(concealed.map((def) => def.id)).toEqual(["core-095"]);
    expect(CATALOG["core-095"]?.tags).toContain(CONCEALED_TAG);
  });
});
