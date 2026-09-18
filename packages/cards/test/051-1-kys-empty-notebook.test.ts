// #51.1 KY's Empty Notebook (SPEC §8.3, §7, §5.1, §6.3 Draw; R4, R11, R50, R60).
// BUILD M4-T4 row 51.1: "Draw 1; radiant 2; absent from every random pool".

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { pool, query } from "../src/query";

/** Two ordinary library cards, top first, so a draw is visible as an id moving to the hand. */
const LIBRARY = ["core-005", "core-016", "core-010"];

describe("#51.1 KY's Empty Notebook — base", () => {
  it("draws 1: the top library card moves to hand", () => {
    const s = scenario({ p1: { hand: ["core-051-1"], library: LIBRARY } });
    const top = s.pile("p1", "library")[0];

    s.play("core-051-1");

    expect(s.state.players.p1.library).toHaveLength(2);
    expect(top).toBeDefined();
    if (top !== undefined) s.expectInZone(top, "hand");
    s.expectEvents("cardPlayed", "drawn");
  });

  it("R11 a spell token goes to the graveyard like any spell", () => {
    const s = scenario({ p1: { hand: ["core-051-1"], library: LIBRARY } });

    s.play("core-051-1").expectInZone("core-051-1", "graveyard");
    // R50: which is why #72 Reminisce can then Discover it back out of the graveyard.
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).toContain("core-051-1");
  });

  it("§2.4 an empty library draws nothing but fatigue, and the token still counts as played", () => {
    const s = scenario({ p1: { hand: ["core-051-1"], library: [] } });

    s.play("core-051-1");

    expect(s.state.players.p1.hand).toHaveLength(0);
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    // §2.4/R3: no card is drawn, so no `drawn` event — the fatigue damage instance is what happened.
    s.expectHealth("p1", 29).expectEvents("damage");
  });
});

describe("#51.1 KY's Empty Notebook — radiant", () => {
  it("§8 Conventions: only the number changes, so it draws 2", () => {
    const s = scenario({ p1: { hand: ["core-051-1"], library: LIBRARY } });
    // HARNESS GAP (reported): `SideSetup.hand` takes no `{ def, radiant }` form.
    s.card("core-051-1").radiant = true;

    s.play("core-051-1");

    expect(s.state.players.p1.library).toHaveLength(1);
    expect(s.state.players.p1.hand).toHaveLength(2);
    expect(s.pile("p1", "hand").map((card) => card.defId)).toEqual(["core-005", "core-016"]);
  });

  it("R4 the hand caps at 10, so the second draw of a nine-card hand is burned", () => {
    // Nine other cards plus the Notebook is a full hand (HAND_CAP 10); playing it leaves nine, so the
    // first draw fills the tenth slot and the second is burned to the graveyard (R4).
    const s = scenario({
      p1: {
        hand: [
          "core-051-1",
          "core-001",
          "core-002",
          "core-003",
          "core-004",
          "core-005",
          "core-006",
          "core-007",
          "core-008",
          "core-009",
        ],
        library: LIBRARY,
      },
    });
    s.card("core-051-1").radiant = true;

    s.play("core-051-1");

    expect(s.state.players.p1.hand).toHaveLength(10);
    s.expectEvents("burned");
  });
});

describe("#51.1 KY's Empty Notebook — §5.1 absent from every random pool", () => {
  it("§5.1 the whole non-token catalog leaves it out, and holds #51 that generates it", () => {
    const ids = query({}).map((card) => card.id);

    expect(ids).not.toContain("core-051-1");
    expect(ids).toContain("core-051");
  });

  it("§5.1 the KY pool is #31, #51 and #82 — the Token-tagged KY card is never offered", () => {
    // The pool #57 Conjure KY generates from: the KY tag, minus tokens, minus the generator.
    expect(pool("57", { tags: ["KY"] }).map((card) => card.id)).toEqual([
      "core-031",
      "core-051",
      "core-082",
    ]);
    expect(query({ tags: ["KY"] }).map((card) => card.id)).not.toContain("core-051-1");
  });

  it("R60 it is reachable only by a query that names the token pool itself (§5.1)", () => {
    expect(query({ tags: ["Token"] }).map((card) => card.id)).toContain("core-051-1");
    expect(query({ defId: "core-051-1" }).map((card) => card.id)).toEqual(["core-051-1"]);
    // A cost or type filter that does not ask for tokens still cannot reach it.
    expect(query({ type: "Spell", cost: 1 }).map((card) => card.id)).not.toContain("core-051-1");
  });
});
