// A fused card's hooks: how each ingredient's list is handed its choices, resumed after a pause and
// ordered against what is already owed (SPEC §10.5, §10.6, R77, R90, R102, R113, R122). Found by the
// polish-4 edge-case hunt, round 4 (docs/polish/4-edge-cases.md, lens L7); every case here failed
// before its fix.
//
// Fused cards are the one place in Core where a Cry can pause with more of its list still to run,
// and where one answered step can itself pause with a tail, so they carry most of what lens L7
// found. Craft a Card's and #85's fusions are built directly with `subsystems.fuse`, as
// `099-craft-a-card.test.ts` does, so the ingredients are fixed rather than a seed's Discovers.
//
//  - R113: a paused fused Cry resumes ingredient by ingredient. It used to rebuild every ingredient's
//    list against the board as it now stood and skip as many effects as had run, and #22 Carnivorous
//    Cube's half is two effects shorter once its meal has gone, so the skip swallowed the next
//    ingredient's damage without a word.
//  - R90, R102: each ingredient resolves the slice of the play's choices that §10.5 step 1 read, not
//    a slice measured against the board at step 5, where the crafted card itself stands.
//  - R113, R122: answering a prompt takes the paused step up again, so the cursor resets and a pause
//    inside the answered step is owed ahead of everything older.
//  - Round 6, lenses L2 and "keywords and layers". R102, R41, §8 #68: each ingredient's list is built
//    when the combined list reaches it, so it reads the board the ingredients before it left — a
//    Cube crafted behind a Ceaseless Void eats nothing the Void exiled, and a Sorcerer crafted
//    behind a Reno reads the hero Reno healed. §5.2: a Fuse that adds a printed Divine Shield or
//    Reborn gives back a shield or a Reborn the kept card had spent.

import { describe, expect, it } from "vitest";
import type { Selection } from "@jackioh/shared";
import { createRng, defOf, legalActions, subsystems, type CardInstance, type EngineSink } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";

const JEWELOSCO_SCARAB = "core-007";
const MR_VANILLA = "core-008";
const TEMPO_TIMMY = "core-011";
const MIDRANGE_MENACE = "core-019";
const CARNIVOROUS_CUBE = "core-022";
const RENO = "core-053";
const PREJUDICED_POSTDOC = "core-061";
const MASOCHISM_MASK = "core-065";
const TWISTED_SORCERER = "core-068";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function sinkFor(s: Scenario): EngineSink {
  return { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
}

/** Craft a Card's result, built directly: the ingredients in hand fused into one hand card (R77). */
function craft(s: Scenario, defIds: readonly string[]): CardInstance {
  const ingredients = defIds.map((defId) =>
    must(s.hand("p1").find((card) => card.defId === defId), `${defId} in p1's hand`),
  );
  return must(subsystems.fuse(sinkFor(s), { ingredients, toHand: "p1" }), "the crafted card");
}

describe("R113: a fused Cry that pauses resumes the rest of every ingredient's list", () => {
  it("R113 a crafted Cube + Scarab + Sorcerer still deals the Sorcerer's damage after the Scarab's Discover (R77, R102)", () => {
    // The fused Cry is [Cube: remember, sacrifice] + [Scarab: Discover] + [Sorcerer: 4 damage]. The
    // Discover pauses it at its third effect and the fourth is owed. Rebuilt on the answer, the
    // Cube's half is empty — its meal has left the field — so the resume must go by ingredient.
    // A second permanent stays on the field, so the Cube's declaration still takes its one pick.
    const s = scenario({
      p1: {
        hand: [CARNIVOROUS_CUBE, JEWELOSCO_SCARAB, TWISTED_SORCERER, RENO],
        field: [MR_VANILLA, MIDRANGE_MENACE],
        mana: 4,
      },
      p2: { hand: [RENO] },
    });
    const crafted = craft(s, [CARNIVOROUS_CUBE, JEWELOSCO_SCARAB, TWISTED_SORCERER]);
    const meal = must(s.unit("p1", 1), "p1's Mr. Vanilla, the Cube's meal");

    const targets: Selection[] = [
      { pick: "instance", instanceId: meal.id },
      { pick: "hero", player: "p2" },
    ];
    s.play(crafted, { zone: 3, targets });
    // The Cube's half has eaten the meal, and the Scarab's Discover is asking.
    expect(s.card(meal).zone.z).toBe("graveyard");
    const pending = must(s.state.pending, "the Scarab's Discover");
    s.answer(must(pending.options[0], "a Discover option").key);

    // R77: "both Cry and Death lists run" — the Sorcerer's 4 lands on the target it was given.
    expect(s.state.players.p2.hero.health).toBe(26);
  });
});

describe("R90, R102: a fused card's choices are split as the play declared them", () => {
  it("R90 a crafted Postdoc + Sorcerer played with no Human on the field deals the Sorcerer's 4 to its target (R102)", () => {
    // Step 1 validates the play against the board with the crafted card in hand: no Human unit is on
    // the field, so the Postdoc's declaration takes nothing (R90) and the one target is the
    // Sorcerer's. The crafted card is a Human (R102 unions the tags), and by step 5 it stands on the
    // field itself — but the play's choices were already read declaration by declaration.
    const s = scenario({
      p1: { hand: [PREJUDICED_POSTDOC, TWISTED_SORCERER, RENO], mana: 4 },
      p2: { hand: [RENO], field: [MIDRANGE_MENACE] },
    });
    const crafted = craft(s, [PREJUDICED_POSTDOC, TWISTED_SORCERER]);
    expect(s.state.transientDefs[crafted.defId]?.tags).toContain("Human");
    const heroOnly: Selection[] = [{ pick: "hero", player: "p2" }];
    const offered = legalActions(s.state, "p1").some(
      (action) =>
        action.type === "play" &&
        action.instanceId === crafted.id &&
        JSON.stringify(action.targets) === JSON.stringify(heroOnly),
    );
    expect(offered).toBe(true);

    s.play(crafted, { zone: 1, targets: heroOnly });

    expect(s.state.players.p2.hero.health).toBe(26);
  });
});

describe("R113, R122: a pause inside an answered step is owed ahead of what was already owed", () => {
  it("R113 a fused radiant Mask + Mask finishes the answered first pick's second question before the other Mask's first (R122, R102)", () => {
    // #85 Unlicensed Experimentation fuses the Mask p2 plays onto p1's own (R77): built directly here.
    // The fused start-of-turn hook is [ask A's first, ask B's first]; R102 merges the two
    // `firstPick` steps, so an answered first pick is [A's pick, ask A's second, B's pick, ask B's
    // second]. Answering the first question pauses that answered step on A's second question with
    // B's second still owed — a pause during a resumption, which R113 owes "ahead of everything still
    // owed", B's first question and the rest of the start of turn included.
    const s = scenario({
      p1: {
        backrow: [{ def: MASOCHISM_MASK, radiant: true }],
        hand: [MASOCHISM_MASK, RENO],
        library: [TEMPO_TIMMY, RENO],
      },
      p2: { hand: [RENO], field: [MIDRANGE_MENACE] },
    });
    const kept = must(s.backrow("p1", 1), "p1's radiant Mask");
    const ingredient = must(s.hand("p1").find((card) => card.defId === MASOCHISM_MASK), "the Mask in hand");
    must(subsystems.fuse(sinkFor(s), { ingredients: [ingredient], target: kept }), "the fused Mask");

    s.startTurn();
    const asked: string[] = [];
    for (let guard = 0; guard < 20; guard += 1) {
      const pending = s.state.pending;
      if (pending === null) break;
      asked.push(pending.prompt.includes("(1 of 2)") ? "first" : "second");
      s.answer("nothing");
    }

    expect(asked).toEqual(["first", "second", "second", "first", "second", "second"]);
  });
});

const GARY = "core-004";
const STOCKPILE = "core-005";
const HIT_JOB = "core-016";
const CEASELESS_VOID = "core-100";
const CRAFT_A_CARD = "core-099";
const KPOP = "core-050";
const JILLIAX = "core-056";
const SAINTESS = "core-081";
const EXPERIMENTATION = "core-085";
const KEYWORD_LIBRARY = [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function kinds(g: Scenario, card: CardInstance): string[] {
  return g.stats(card).keywords.map((keyword) => keyword.kind);
}

describe("R41, R77: a fused Cry's later part reads the board its earlier parts left", () => {
  it("R41 a crafted Ceaseless Void + Carnivorous Cube whose Void exiled the meal has eaten nothing, so its Death summons nothing (R102, R174)", () => {
    const g = scenario({
      seed: "r6cube-17", // Craft a Card's Discovers offer Ceaseless Void, then Carnivorous Cube
      p1: { hand: [CRAFT_A_CARD, HIT_JOB, STOCKPILE], mana: 10, field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [STOCKPILE], field: [{ def: RENO, lane: 1 }] },
    });
    g.play(CRAFT_A_CARD);
    g.answer(CEASELESS_VOID);
    g.answer(CARNIVOROUS_CUBE);
    const card = must(g.hand("p1").find((held) => held.defId.startsWith("t-")), "the crafted card");
    const gary = must(g.unit("p1", 1), "Gary");

    // The Void's part exiles every other permanent, Gary included (§8 #100), so the Cube's part has
    // nothing to tribute: the sacrifice fizzles (R174) and nothing is eaten (R41).
    g.play(card, { zone: 3, targets: [{ pick: "instance", instanceId: gary.id }] });
    g.expectInZone(gary, "exile");
    const crafted = must(g.unit("p1", 3), "the crafted unit");
    const before = g.events.length;

    // R41: "nothing eaten → Death does nothing". The crafted card dies, and no Gary comes back.
    g.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: crafted.id }] });
    g.expectInZone(crafted, "graveyard");
    const copies = g.events.slice(before).filter((event) => event.type === "summoned" && event.defId === GARY);
    expect({ copies: copies.length, units: g.state.players.p1.units.filter((pile) => pile !== null).length }).toEqual({
      copies: 0,
      units: 0,
    });
  });
});

describe("§8 #68, R77: a fused Cry's later part reads the board its earlier parts left", () => {
  it("§8 #68 a crafted Reno + Twisted Sorcerer reads the hero Reno has just set to 30, so it deals 4, not 8 (R102)", () => {
    const g = scenario({
      seed: "r6reno-115", // Craft a Card's Discovers offer Reno, then Twisted Sorcerer
      p1: { hand: [CRAFT_A_CARD, STOCKPILE], mana: 10, health: 5 },
      p2: { hand: [STOCKPILE], field: [{ def: RENO, lane: 1 }] },
    });
    g.play(CRAFT_A_CARD);
    g.answer(RENO);
    g.answer(TWISTED_SORCERER);
    const card = must(g.hand("p1").find((held) => held.defId.startsWith("t-")), "the crafted card");
    const before = g.events.length;

    // Reno's part sets the hero to 30 (§8 #53), and then the Sorcerer's part resolves: "8 if your
    // hero is below 10", with the threshold "read at resolution" (§8 #68's Engine cell). The hero is
    // at 30 by then, so the enemy hero takes 4.
    g.play(card, { zone: 1, targets: [{ pick: "hero", player: "p2" }] });
    g.expectHealth("p1", 30);
    const hits = g.events.slice(before).filter((event) => event.type === "damage" && event.targetId === "hero-p2");
    expect(hits.map((event) => (event.type === "damage" ? event.amount : -1))).toEqual([4]);
    g.expectHealth("p2", 26);
  });
});

describe("§5.2, R77: a keyword a Fuse newly prints applies at once", () => {
  it("R77 a Fuse that adds a printed Divine Shield gives a unit whose granted shield was spent a shield again (§5.2, §10.1)", () => {
    const g = scenario({
      active: "p2",
      turn: 10,
      p1: {
        field: [{ def: KPOP, lane: 1 }],
        backrow: [{ def: EXPERIMENTATION, lane: 3 }],
        hand: [STOCKPILE],
        library: [...KEYWORD_LIBRARY],
      },
      p2: { hand: [JILLIAX, STOCKPILE], library: [...KEYWORD_LIBRARY] },
    });
    const kpop = unitAt(g, "p1", 1);
    // A granted Divine Shield (#63's or #80's pool, R21) that a hit has already spent (§4.4 step 1).
    g.card(kpop).grantedKeywords = [{ kind: "Divine Shield" }];
    g.card(kpop).divineShieldSpent = true;
    expect(kinds(g, kpop)).not.toContain("Divine Shield");

    // p2 plays Jilliax (Rush, Taunt, Lifesteal, Divine Shield); #85 fuses it onto the Kpop.
    g.play(JILLIAX, { zone: 1 });

    const fused = g.card(kpop);
    expect(fused.defId).not.toBe(KPOP);
    expect(g.unit("p2", 1)).toBeNull();
    expect(defOf(g.state, fused.defId).base.keywords.map((keyword) => keyword.kind)).toContain("Divine Shield");
    // The fused definition prints Jilliax's Divine Shield, which Kpop Fanatic's base face never
    // printed: a keyword the card newly gains applies at once (§5.2), exactly as radiant #50's
    // printed shield does after a granted one was spent (`radiant.gainPrintedShield`).
    expect(kinds(g, kpop)).toContain("Divine Shield");
  });

  it("R77 a Reborn body fused with a card that prints Reborn has Reborn again (§5.2, §10.1, R83)", () => {
    const g = scenario({
      active: "p2",
      turn: 10,
      p1: {
        field: [{ def: KPOP, lane: 1 }],
        backrow: [{ def: EXPERIMENTATION, lane: 3 }],
        hand: [STOCKPILE],
        library: [...KEYWORD_LIBRARY],
      },
      p2: { hand: [SAINTESS, STOCKPILE], library: [...KEYWORD_LIBRARY] },
    });
    const kpop = unitAt(g, "p1", 1);
    // A Kpop that came back through a granted Reborn: the body has used its Reborn (§4.5 step 4).
    g.card(kpop).rebornSpent = true;

    // p2 plays Radiant Saintess (Reborn printed); #85 fuses it onto the Kpop's Reborn body.
    g.play(SAINTESS, { zone: 1 });

    const fused = g.card(kpop);
    expect(fused.defId).not.toBe(KPOP);
    expect(defOf(g.state, fused.defId).base.keywords.map((keyword) => keyword.kind)).toContain("Reborn");
    // The Saintess's printed Reborn is the fused card's text, which the Kpop never printed.
    expect(kinds(g, kpop)).toContain("Reborn");
  });
});
