// #17 Flood — SPEC §8.1 row 17, BUILD M4-T4 row 17.
//
// Must-pass (M4-T4): "Bounces both sides, tokens vanish, hand cap burns; radiant three modes each
// tested plus draw 1".
//
// Engine cell: "Tokens vanish on bounce; hand cap burns extras" — R11 and R4.
//
// R81 is why no test here calls `answer()`: the radiant "choose one" is a DECLARED mode, so it
// travels in the play action (`play(..., { modes })`) and never opens a `PendingChoice`. The strings
// are the same constants the script declares; a drift between the two would fail `refuseModes`
// (playChoices.ts) rather than silently pick the first option.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const BOUNCE_ALL = "bounce all units";
const BOUNCE_ENEMY = "bounce all enemy units";
const DESTROY_ENEMY = "destroy all enemy units";

/** HARNESS GAP: `SideSetup.hand` takes no `radiant` flag; see 016-hit-job.test.ts for the note. */
function makeRadiant(s: Scenario, ref: string): Scenario {
  s.card(ref).radiant = true;
  return s;
}

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`no unit in ${player} unit lane ${lane}`);
  return found;
}

/** Ten distinct cards, to sit a hand exactly on HAND_CAP once Flood has left it (R4). */
const TEN_CARDS = [
  "core-001",
  "core-002",
  "core-005",
  "core-006",
  "core-008",
  "core-010",
  "core-011",
  "core-012",
  "core-015",
  "core-020",
];

describe("#17 Flood (base)", () => {
  it("bounces every unit on both sides to its owner's hand (§6.3 Bounce, R12)", () => {
    const s = scenario({
      p1: { hand: ["core-017", "core-010"], field: ["core-012"], mana: 4 },
      p2: { field: ["core-019", "core-020"] },
    });
    const mine = unitAt(s, "p1", 1);
    const theirs1 = unitAt(s, "p2", 1);
    const theirs2 = unitAt(s, "p2", 2);

    s.play("core-017");

    s.expectInZone(mine, "hand");
    s.expectInZone(theirs1, "hand");
    s.expectInZone(theirs2, "hand");
    // Both unit rows are empty afterwards.
    for (const lane of [1, 2, 3, 4, 5]) {
      expect(s.unit("p1", lane)).toBeNull();
      expect(s.unit("p2", lane)).toBeNull();
    }
    // R12: off the field a card always goes to its OWNER's hand, never the caster's.
    expect(s.pile("p1", "hand").some((card) => card.id === mine.id)).toBe(true);
    expect(s.pile("p2", "hand").map((card) => card.id)).toContain(theirs1.id);
  });

  it("R11 a bounced unit token ceases to exist and reaches no hand", () => {
    const s = scenario({
      p1: { hand: ["core-017", "core-010"], field: ["core-t-rush"], mana: 4 },
      p2: { field: ["core-019"] },
    });
    const token = unitAt(s, "p1", 1);
    const real = unitAt(s, "p2", 1);

    s.play("core-017");

    s.expectInZone(token, "gone");
    expect(s.pile("p1", "hand").some((card) => card.id === token.id)).toBe(false);
    expect(s.pile("p1", "graveyard").some((card) => card.id === token.id)).toBe(false);
    // The real card beside it still bounces normally.
    s.expectInZone(real, "hand");
  });

  it("R4 a bounced unit is burned to the graveyard when its owner's hand is full", () => {
    const s = scenario({
      // Eleven cards: playing Flood leaves exactly HAND_CAP (10) behind, so the bounce has no room.
      p1: { hand: ["core-017", ...TEN_CARDS], field: ["core-012"], mana: 4 },
      p2: { field: ["core-019"] },
    });
    const mine = unitAt(s, "p1", 1);
    const theirs = unitAt(s, "p2", 1);

    s.play("core-017");

    expect(s.pile("p1", "hand")).toHaveLength(10);
    s.expectInZone(mine, "graveyard");
    s.expectEvents("burned", "enteredGraveyard");
    // The opponent's hand is empty, so their unit is not burned: the cap is per owner.
    s.expectInZone(theirs, "hand");
  });

  it("declares no mode: the base face bounces both sides unconditionally", () => {
    const s = scenario({ p1: { hand: ["core-017", "core-010"], mana: 4 }, p2: { field: ["core-019"] } });

    s.play("core-017");

    s.expectInZone("core-019", "hand");
    // No prompt was ever opened: R81's declared choices never pause resolution.
    expect(s.state.pending).toBeNull();
  });
});

describe("#17 Flood (radiant)", () => {
  it(`R81 mode "${BOUNCE_ALL}" bounces both sides, then draws 1`, () => {
    const s = scenario({
      p1: { hand: ["core-017"], field: ["core-012"], library: ["core-010"], mana: 4 },
      p2: { field: ["core-019", "core-020"] },
    });
    makeRadiant(s, "core-017");
    const mine = unitAt(s, "p1", 1);
    const theirs = unitAt(s, "p2", 1);

    s.play("core-017", { modes: [BOUNCE_ALL] });

    s.expectInZone(mine, "hand");
    s.expectInZone(theirs, "hand");
    s.expectInZone("core-010", "hand");
    expect(s.pile("p1", "library")).toHaveLength(0);
    expect(s.state.pending).toBeNull();
  });

  it(`R81 mode "${BOUNCE_ENEMY}" spares your own units, then draws 1`, () => {
    const s = scenario({
      p1: { hand: ["core-017"], field: ["core-012", "core-025"], library: ["core-010"], mana: 4 },
      p2: { field: ["core-019", "core-020"] },
    });
    makeRadiant(s, "core-017");
    const mine1 = unitAt(s, "p1", 1);
    const mine2 = unitAt(s, "p1", 2);
    const theirs1 = unitAt(s, "p2", 1);
    const theirs2 = unitAt(s, "p2", 2);

    s.play("core-017", { modes: [BOUNCE_ENEMY] });

    s.expectInZone(mine1, "field");
    s.expectInZone(mine2, "field");
    s.expectInZone(theirs1, "hand");
    s.expectInZone(theirs2, "hand");
    s.expectInZone("core-010", "hand");
  });

  it(`R81 mode "${DESTROY_ENEMY}" destroys them instead of bouncing them, then draws 1`, () => {
    const s = scenario({
      p1: { hand: ["core-017"], field: ["core-012"], library: ["core-010"], mana: 4 },
      p2: { field: ["core-019", "core-020"] },
    });
    makeRadiant(s, "core-017");
    const mine = unitAt(s, "p1", 1);
    const theirs1 = unitAt(s, "p2", 1);
    const theirs2 = unitAt(s, "p2", 2);

    s.play("core-017", { modes: [DESTROY_ENEMY] });

    s.expectInZone(theirs1, "graveyard");
    s.expectInZone(theirs2, "graveyard");
    s.expectInZone(mine, "field");
    s.expectInZone("core-010", "hand");
    // R59: one effect marks both, so both deaths land in the same state check.
    s.expectEvents("destroyed", "destroyed");
  });

  it("R46 the destroy mode leaves an Indestructible enemy standing, and still draws 1", () => {
    const s = scenario({
      p1: { hand: ["core-017"], library: ["core-010"], mana: 4 },
      p2: { field: [{ def: "core-025", radiant: true }, "core-019"] },
    });
    makeRadiant(s, "core-017");
    const indestructible = unitAt(s, "p2", 1);
    const mortal = unitAt(s, "p2", 2);

    s.play("core-017", { modes: [DESTROY_ENEMY] });

    s.expectInZone(indestructible, "field");
    s.expectInZone(mortal, "graveyard");
    s.expectInZone("core-010", "hand");
  });

  it("R11 the bounce modes still make a unit token cease to exist", () => {
    const s = scenario({
      p1: { hand: ["core-017"], library: ["core-010"], mana: 4 },
      p2: { field: ["core-t-rush"] },
    });
    makeRadiant(s, "core-017");
    const token = unitAt(s, "p2", 1);

    s.play("core-017", { modes: [BOUNCE_ENEMY] });

    s.expectInZone(token, "gone");
  });
});
