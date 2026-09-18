// #66 The Rock — SPEC §8.3, BUILD M4-T4: "Play refused without a tribute; Indestructible; radiant
// Immutable".
//
// The §8.3 row is "Tribute 1, Indestructible" → "Plus Immutable", with the Engine cell "Tribute
// validator; Indestructible per 6.1". So the cases below are: the validator refusing and accepting
// a Tribute (§6.3, §3.2's Sheep worth 2), Indestructible under damage (§4.4 step 4), under a destroy
// mark (R46) and at 0 max health (R69), and the radiant face keeping every base clause the cell does
// not restate (§8 Conventions) while adding Immutable (R23).

import { describe, expect, it } from "vitest";
import { scenario, type ScenarioOptions } from "./_harness";
import { base, def, radiant } from "../src/scripts/066-the-rock";

const ROCK = "core-066"; // Unit 10/10 → 20/20, cost 4, Human. Tribute 1, Indestructible.
const TIMMY = "core-011"; // Tempo Timmy, a plain 1-cost 3/3: a body to tribute or to attack with.
const SHEEP = "core-t-sheep"; // Sheep Token, 1/1, "worth 2 Tributes while on the field" (§3.2).
const RUSH = "core-t-rush"; // Rush Token, 3/3: a second body, so an action can run a state check.
const AURA = "core-046"; // Suppressive Aura, Field Spell, embiggen price 4 — R69's −10/−10.

type Board = ReturnType<typeof scenario>;

/**
 * R82: a turn whose only legal actions are ending it, conceding and offering a draw auto-ends by
 * itself, and `reduce` runs that check after EVERY action — so a play that empties the hand and
 * leaves no unit hands the turn over: the opponent draws (taking fatigue on an empty library),
 * start-of-turn triggers fire, and the numbers under test move underneath the assertion. Every
 * scenario below therefore keeps one free 0-cost Spell in p1's hand. It is never played; it only
 * keeps one legal action on the turn. (Reported as a harness gap: `scenario` could hold the turn
 * open by itself.)
 */
const ANCHOR = "core-010"; // Rapid Replenish, Spell, cost 0 — always an affordable play.

function board(opts: ScenarioOptions = {}): Board {
  const p1 = opts.p1 ?? {};
  return scenario({ ...opts, p1: { ...p1, hand: [...(p1.hand ?? []), ANCHOR] } });
}

/** The keyword set §10.4 computes for a unit, as the engine's own view reports it. */
function keywordsOf(s: Board, player: "p1" | "p2", lane: number): string[] {
  const side = player === "p1" ? s.view("p1").you : s.view("p1").opponent;
  return (side.units[lane - 1]?.keywords ?? []).map((keyword) => keyword.kind);
}

describe("#66 The Rock", () => {
  // -------------------------------------------------------------------------------------------
  // The script itself
  // -------------------------------------------------------------------------------------------

  it("§8.3 the script carries only the Tribute cost; both keywords are catalog data (§10.4 layer 1)", () => {
    // Granting Indestructible or Immutable here would be a second source of truth (see #25).
    expect(base.staticFlags).toEqual({ tribute: 1 });
    expect(def.base.keywords.map((keyword) => keyword.kind)).toEqual(["Indestructible"]);
    expect(def.radiant.keywords.map((keyword) => keyword.kind)).toEqual(["Indestructible", "Immutable"]);
    expect(base.cry).toBeUndefined();
    expect(base.aura).toBeUndefined();
  });

  it("R81/R90 the Tribute travels in the play action's own list, so the card declares no targets", () => {
    expect(base.targets).toBeUndefined();
    expect(base.modes).toBeUndefined();
  });

  it("§8 Conventions the radiant cell adds a keyword only, so the radiant script keeps Tribute 1", () => {
    expect(radiant).toBe(base);
    expect(radiant.staticFlags).toEqual({ tribute: 1 });
  });

  // -------------------------------------------------------------------------------------------
  // Base: the Tribute cost (§6.3, §3.2)
  // -------------------------------------------------------------------------------------------

  it("BUILD row 66 refuses the play with no unit on the board to tribute (§6.3)", () => {
    const s = board({ p1: { hand: [ROCK] } });
    expect(() => s.play(ROCK)).toThrow(/[Tt]ribute/);
    s.expectInZone(ROCK, "hand").expectMana("p1", 4);
  });

  it("BUILD row 66 refuses the play when a unit is available but the play names none", () => {
    const s = board({ p1: { hand: [ROCK], field: [TIMMY] } });
    expect(() => s.play(ROCK)).toThrow(/[Tt]ribute/);
    s.expectInZone(TIMMY, "field");
  });

  it("§6.3 plays for the printed 4 once a unit pays the Tribute, and that unit dies", () => {
    const s = board({ p1: { hand: [ROCK], field: [TIMMY] } });
    s.play(ROCK, { tributes: [TIMMY] });
    s.expectInZone(ROCK, "field")
      .expectStats(ROCK, { attack: 10, health: 10, maxHealth: 10 })
      .expectInZone(TIMMY, "graveyard")
      .expectMana("p1", 0)
      .expectEvents("destroyed", "cardPlayed");
  });

  it("§3.2 one Sheep Token pays Tribute 1 on its own, because it is worth 2", () => {
    const s = board({ p1: { hand: [ROCK], field: [SHEEP] } });
    const sheep = s.card(SHEEP);
    s.play(ROCK, { tributes: [SHEEP] });
    s.expectInZone(ROCK, "field").expectMana("p1", 0);
    // R11: a unit token that leaves the field ceases to exist rather than entering a graveyard.
    s.expectInZone(sheep, "gone");
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).not.toContain(SHEEP);
  });

  it("§6.1 a Tribute sacrifices an Indestructible unit: Sacrifice bypasses it", () => {
    // Two copies: the string form resolves the hand one for `play` and the field one for `tributes`,
    // because each search is narrowed to its own place.
    const s = board({ p1: { hand: [ROCK], field: [ROCK] } });
    const onField = s.unit("p1", 1);
    s.play(ROCK, { tributes: [ROCK] });
    expect(onField).not.toBeNull();
    s.expectInZone(onField as NonNullable<typeof onField>, "graveyard");
  });

  // -------------------------------------------------------------------------------------------
  // Base: Indestructible (§4.4 step 4, R46, R69)
  // -------------------------------------------------------------------------------------------

  it("§4.4 step 4 Indestructible takes no damage at all, and the attacker takes the full 10 back", () => {
    const s = board({ p1: { field: [TIMMY] }, p2: { field: [ROCK] } });
    s.attack(TIMMY, ROCK);
    s.expectStats(ROCK, { health: 10, maxHealth: 10 }).expectInZone(TIMMY, "graveyard");
  });

  it("R46 an Indestructible unit ignores a destroy mark, switching to Attack Position for the turn", () => {
    const s = board({ p1: { field: [{ def: ROCK, position: "DEF", lane: 1 }, { def: RUSH, lane: 2 }] } });
    // §6.3 Destroy "only marks the card"; `effects/destroy.ts` sets exactly this flag and stops, and
    // §4.5 step 1 collects the mark at the next state check. No harness step and no card whose
    // script is green applies a destroy to a chosen unit today (#16 Hit Job is blocked on its own
    // `destroyAdjacentTo`), so the mark is set here directly — reported as a harness gap
    // (`s.destroy(card)`); reaching into `s.state` is a test-only liberty.
    s.card(ROCK).markedDestroyed = true;
    s.switchPosition(RUSH); // Any action runs the state check (R59).

    s.expectInZone(ROCK, "field").expectEvents("positionSwitched");
    expect(s.card(ROCK).markedDestroyed).not.toBe(true);
    expect(s.card(ROCK).position).toBe("ATK");
    // R46's other half: Taunt is suppressed for this turn. The Rock prints no Taunt, so the stamp is
    // what there is to see; #19 Midrange Menace and #55 Lava Golem are where it bites.
    expect(s.card(ROCK).tauntSuppressedTurn).toBe(s.state.turn);
  });

  it("R69 an Indestructible unit whose max health falls to 0 dies anyway (#46 paid 4 → −10/−10)", () => {
    const s = board({ p1: { hand: [{ def: AURA, radiant: true }] }, p2: { field: [ROCK] } });
    s.play(AURA, { embiggen: true });
    // No destroy effect is involved, so Indestructible has nothing to ignore: it is collected like
    // any other unit and fires Death (R69, Hearthstone).
    s.expectInZone(ROCK, "graveyard").expectEvents("destroyed");
  });

  // -------------------------------------------------------------------------------------------
  // Radiant: "Plus Immutable" (§8 Conventions, R23)
  // -------------------------------------------------------------------------------------------

  it("§5.2 the radiant face is 20/20", () => {
    const s = board({ p2: { field: [{ def: ROCK, radiant: true }] } });
    s.expectStats(ROCK, { attack: 20, health: 20, maxHealth: 20 });
  });

  it("R23 the radiant face computes as Indestructible plus Immutable (§8 Conventions' 'Plus')", () => {
    const s = board({ p1: { field: [{ def: ROCK, radiant: true }] } });
    expect(keywordsOf(s, "p1", 1)).toEqual(expect.arrayContaining(["Indestructible", "Immutable"]));
    // R23's blocking itself lives in `effects/transform.ts` (`transform` and `vanilla` both return
    // early on an Immutable card) and in `traps.ts` for #41 Sheepish. No verb a card test can reach
    // applies Vanilla or Transform to a chosen unit yet — #83 Transmogulate is Wave 3 and #61's
    // Postdoc copy is R23's *allowed* case — so the cross-card cases live in #41, #61, #83 and #85.
  });

  it("§8 Conventions the radiant face still costs Tribute 1, a clause the cell does not restate", () => {
    const s = board({ p1: { hand: [{ def: ROCK, radiant: true }] } });
    expect(() => s.play(ROCK)).toThrow(/[Tt]ribute/);
  });

  it("§4.4 step 4 the radiant face is still Indestructible under damage", () => {
    const s = board({ p1: { field: [TIMMY] }, p2: { field: [{ def: ROCK, radiant: true }] } });
    s.attack(TIMMY, ROCK);
    s.expectStats(ROCK, { health: 20, maxHealth: 20 }).expectInZone(TIMMY, "graveyard");
  });
});
