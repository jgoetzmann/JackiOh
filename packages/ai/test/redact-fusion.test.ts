// `redact` and fused cards (R185, R77). A fusion of a fusion names its older ingredient in
// `fusedFrom`, and the engine rebuilds the fused scripts from that chain whenever it is entered, so
// the redacted state must keep the whole chain behind every card the seat can see, and drop the
// chain behind a card it cannot.

import { describe, expect, it } from "vitest";
import type { CardDef } from "@jackioh/shared";
import { legalActions, registeredCatalog, viewFor, type GameState } from "@jackioh/engine";
import { redact } from "../src/index";
import { AI, HUMAN, scenario } from "./_support";

/** A transient def as `subsystems.fuse` builds one: a real card's faces under a `t-<n>` id. */
function fusedDef(id: string, from: readonly string[]): CardDef & { fusedFrom: readonly string[] } {
  const base = registeredCatalog()["core-008"] as CardDef;
  return { ...base, id, index: id, name: `fused ${id}`, fusedFrom: from };
}

/** p2 holds a `t-2` fused from `t-1` (itself core-008 + core-011) and core-020, somewhere. */
function withChain(where: "field" | "hand"): GameState {
  const state = scenario({
    active: AI,
    p1: { field: ["core-011"] },
    p2: where === "field" ? { field: ["core-019"] } : { hand: ["core-019"] },
  }).state;
  state.transientDefs["t-1"] = fusedDef("t-1", ["core-008", "core-011"]);
  state.transientDefs["t-2"] = fusedDef("t-2", ["t-1", "core-020"]);
  const side = state.players[HUMAN];
  const card = where === "field" ? side.units.flat().find((c) => c !== null) : side.hand[0];
  if (card === undefined || card === null) throw new Error("the scenario placed no p2 card");
  card.defId = "t-2";
  return state;
}

describe("redact keeps what a fused card is built from (R185)", () => {
  it("R185 a visible fusion of a fusion keeps its older ingredient, and the redacted state still runs", () => {
    const pub = redact(withChain("field"), AI);
    expect(Object.keys(pub.transientDefs).sort()).toEqual(["t-1", "t-2"]);
    expect(() => legalActions(pub, AI)).not.toThrow();
    expect(() => viewFor(pub, AI)).not.toThrow();
  });

  it("R185 a fusion in the hidden hand takes its whole chain with it", () => {
    const pub = redact(withChain("hand"), AI);
    expect(pub.transientDefs).toEqual({});
    expect(() => legalActions(pub, AI)).not.toThrow();
  });
});
