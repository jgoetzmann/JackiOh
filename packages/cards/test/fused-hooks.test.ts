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
//  - Round 7, lenses "card by card", "keywords and layers" and L2. R102: what each ingredient leaves
//    behind is its own — an answer comes back to the Mask that asked, each Cube remembers its own
//    meal, two Twinspells' grants and two Armors add up — and R43, R151: a Heroic Power's text #85
//    fuses onto a kept Mana Well rolls a power, as a card created later does.
//  - Round 8, lens "keywords and layers". R102, R124: two Going Longs' hero Armor adds up across a
//    Fuse, and each ingredient's text reads the price its own card was played for (a Suppressive
//    Aura paid 4 fused onto a Mana Well stays −5/−5). §8 #65.1: a radiant Spikey Pillow's aura, fused
//    into another card, still spares every Spikey Pillow.

import { describe, expect, it } from "vitest";
import type { Selection } from "@jackioh/shared";
import { createRng, defOf, heroArmorOf, legalActions, subsystems, type CardInstance, type EngineSink } from "@jackioh/engine";
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
    // The fused start-of-turn hook is [ask A's first, ask B's first], and R102 brings each answer back
    // to the Mask that asked, so an answered first pick is [A's pick, ask A's second] — never B's
    // pick as well. Answering the first question pauses that answered step on A's second question — a
    // pause during a resumption, which R113 owes "ahead of everything still owed", B's first question
    // and the rest of the start of turn included. Two Masks, two picks each: four questions.
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

    expect(asked).toEqual(["first", "second", "first", "second"]);
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

// ---------------------------------------------------------------------------
// Round 7 (lenses "card by card", "keywords and layers" and L2): what each ingredient's text leaves
// behind is its own (R102), and a text fused onto a kept card is had in full (R43, R151).
// ---------------------------------------------------------------------------

const MANA_WELL = "core-006";
const POINTMASTER = "core-020";
const SEVEN_SEVEN = "core-025"; // Unit, 4 — 7/7, Armor 7
const LAVA_GOLEM = "core-055"; // Unit, 3 — 10/5, Armor 3, Taunt (on the field; its Tribute is paid)
const TWINSPELL = "core-079";
const HEROIC_POWER = "core-098";
const RAPID = "core-010";

/** p2 plays its own 4-mana 7/7 into p1's armed #85, which fuses it onto p1's only Unit. */
function fuseSevenSevenOnto(target: string): { g: Scenario; kept: CardInstance } {
  const g = scenario({
    active: "p2",
    p1: {
      backrow: [{ def: EXPERIMENTATION, lane: 3 }],
      field: [{ def: target, lane: 1 }],
      hand: [MR_VANILLA],
      library: [...KEYWORD_LIBRARY],
    },
    p2: { hand: [SEVEN_SEVEN, MR_VANILLA], library: [...KEYWORD_LIBRARY] },
  });
  const kept = unitAt(g, "p1", 1);
  g.play(SEVEN_SEVEN, { zone: 1 });
  // The fusion happened: the target instance stands, carrying the summed stats (R77).
  expect(g.events.some((event) => event.type === "fused")).toBe(true);
  expect(g.unit("p2", 1)).toBeNull();
  return { g, kept };
}

describe("R102: what a fused card's ingredients leave behind is each their own", () => {
  it("R102 a Fuse of two Armor 7 units prints Armor 14, as Armor 7 and Armor 3 print Armor 10 (§6.1 Armor stacks, R77)", () => {
    // Two different Armors already add up on the fused face.
    const golem = fuseSevenSevenOnto(LAVA_GOLEM);
    expect(golem.g.stats(golem.kept).attack).toBe(17);
    expect(golem.g.stats(golem.kept).armor).toBe(10);

    // Two equal ones add up the same way: each ingredient prints "Armor 7", and Armor stacks from
    // every source (§6.1, §10.4), while the stats beside it sum to 14/14 (R77).
    const twin = fuseSevenSevenOnto(SEVEN_SEVEN);
    expect(twin.g.stats(twin.kept).attack).toBe(14);
    expect(twin.g.stats(twin.kept).maxHealth).toBe(14);
    expect(twin.g.stats(twin.kept).armor).toBe(14);
  });

  it("R102 a Masochism Mask fused onto a Masochism Mask applies each start-of-turn pick once, not once per ingredient (§8 #65, R77)", () => {
    // p2 plays a Masochism Mask; p1's Unlicensed Experimentation fuses it onto p1's own Mask, the
    // only Field Spell p1 controls (R61, R77). The fused card carries both Masks' text: "Start of
    // turn: choose one …" twice, so p1 is asked twice and each answer is one pick.
    const s = scenario({
      seed: "r7-card-mask-mask",
      active: "p2",
      p1: {
        backrow: [MASOCHISM_MASK, EXPERIMENTATION],
        field: [MIDRANGE_MENACE],
        hand: [STOCKPILE],
        library: [...KEYWORD_LIBRARY],
      },
      p2: { hand: [MASOCHISM_MASK, STOCKPILE], field: [MIDRANGE_MENACE], library: [...KEYWORD_LIBRARY] },
    });
    s.play(MASOCHISM_MASK, { zone: 1 });
    expect(s.backrow("p1", 1)?.defId).toMatch(/^t-\d+:core-065\+core-065$/);

    s.endTurn();
    expect(s.state.pending?.playerId).toBe("p1");
    s.answer(["lose 3"]);
    // One Mask's pick: 3 health, not 3 for each ingredient that shares the step name.
    s.expectHealth("p1", 27);
    expect(s.state.pending?.playerId).toBe("p1");
    s.answer(["lose 3"]);
    s.expectHealth("p1", 24);
  });

  it("R102 a crafted Carnivorous Cube + Carnivorous Cube remembers both meals, so its Death copies each (§8 #22, R41, R77)", () => {
    const s = scenario({
      seed: "r7-cube-cube",
      p1: {
        mana: 10,
        hand: [CARNIVOROUS_CUBE, CARNIVOROUS_CUBE, HIT_JOB, RENO],
        field: [MIDRANGE_MENACE, POINTMASTER],
        backrow: [MANA_WELL],
        library: [...KEYWORD_LIBRARY],
      },
      p2: { hand: [STOCKPILE], field: [MIDRANGE_MENACE], library: [...KEYWORD_LIBRARY] },
    });
    // Craft a Card's result, built directly from the two Cubes in hand (R77).
    const cubes = s.hand("p1").filter((card) => card.defId === CARNIVOROUS_CUBE);
    expect(cubes).toHaveLength(2);
    const crafted = must(subsystems.fuse(sinkFor(s), { ingredients: cubes, toHand: "p1" }), "the crafted card");
    expect(crafted.defId).toMatch(/core-022\+core-022$/);

    // Each Cube's Cry tributes one of p1's other permanents and remembers it: Pointmaster (a unit)
    // for the first, Mana Well (a Field Spell) for the second (R81, R90: one pick per declaration).
    const pointmaster = unitAt(s, "p1", 2);
    const manaWell = must(s.backrow("p1", 1), "p1's Mana Well");
    s.play(crafted, {
      zone: 3,
      targets: [
        { pick: "instance", instanceId: pointmaster.id },
        { pick: "instance", instanceId: manaWell.id },
      ],
    });
    s.expectInZone(pointmaster, "graveyard").expectInZone(manaWell, "graveyard");

    // Hit Job destroys the crafted card: each Cube's Death summons 2 copies of ITS remembered card.
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: crafted.id }] });
    const units = [1, 2, 3, 4, 5].map((lane) => s.unit("p1", lane)?.defId);
    const backrow = [1, 2, 3, 4, 5].map((lane) => s.backrow("p1", lane)?.defId);
    expect(units.filter((id) => id === POINTMASTER)).toHaveLength(2);
    expect(backrow.filter((id) => id === MANA_WELL)).toHaveLength(2);
  });

  it("R102 a Twinspell fused onto a Twinspell gives the next Spell both Echo +1s (§8 #79, R77, R209)", () => {
    const library = Array.from({ length: 10 }, () => MR_VANILLA);
    // p2 plays a Twinspell; p1's Unlicensed Experimentation fuses it onto p1's own Twinspell (R61,
    // R77). The fused Field Spell prints "the next Spell you play gains Echo +1" twice.
    const s = scenario({
      seed: "r7-card-twin-twin",
      active: "p2",
      p1: { backrow: [TWINSPELL, EXPERIMENTATION], field: [MIDRANGE_MENACE], hand: [STOCKPILE, RAPID], library },
      p2: { hand: [TWINSPELL, STOCKPILE], field: [MIDRANGE_MENACE], library },
    });
    s.play(TWINSPELL, { zone: 1 });
    expect(s.backrow("p1", 1)?.defId).toMatch(/^t-\d+:core-079\+core-079$/);
    s.endTurn();

    // Two Twinspells standing apart make the next Spell resolve three times; the one card that
    // carries both texts does the same. Stockpile draws 2 per resolution.
    const from = s.events.length;
    s.play(STOCKPILE);
    const draws = s.events.slice(from).filter((event) => event.type === "drawn").length;
    expect(draws).toBe(6);
  });
});

describe("R43, R151, R77: a Heroic Power's text fused onto another permanent has a power", () => {
  it("R151 Unlicensed Experimentation fusing a played Heroic Power onto a Mana Well leaves a card whose power can be activated (R43, R77)", () => {
    const g = scenario({
      p1: { hand: [HEROIC_POWER, STOCKPILE] },
      p2: {
        hand: [STOCKPILE],
        backrow: [
          { def: EXPERIMENTATION, lane: 1 },
          { def: MANA_WELL, lane: 2 },
        ],
      },
    });
    // The power the Heroic Power rolled in hand (R43): "deal 2 damage to each opposing hero", which
    // asks nothing.
    const power = must(
      g.state.players.p1.hand.find((card) => card.defId === HEROIC_POWER),
      "the live Heroic Power",
    );
    power.memory[subsystems.POWER_KEY] = "burn";
    const well = must(g.backrow("p2", 2), "p2's Mana Well");

    // p1 plays it (it activates once, R43), and after it resolves p2's #85 fuses it onto the Mana Well
    // (R61, R77): the Mana Well's instance is kept and now carries the Heroic Power's text.
    g.play(power, { zone: 1 });
    const fused: CardInstance = g.card(well);
    expect(fused.defId.startsWith("t-")).toBe(true);
    g.expectInZone(power, "gone");

    // R43: "Once per turn, spend X" is the card's text, and "one created later rolls when it is
    // created"; R151 has a Heroic Power roll as it arrives anywhere a card can be looked at, so no
    // copy of the text is left "carrying no power … for ever". The fused card has a power, and p2
    // may use it on their own turn.
    expect(subsystems.powerOf(fused)).not.toBeNull();
    g.endTurn();
    expect(g.state.active).toBe("p2");
    expect(subsystems.whyCannotActivate(g.state, "p2", fused.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Round 8: a fused card's layers are each ingredient's
// ---------------------------------------------------------------------------------------------

const SUPPRESSIVE_AURA = "core-046"; // Field Spell, 2 embiggen 4
const GOING_LONG = "core-084"; // Field Spell, 2 embiggen 4, Quickdraw — hero Armor 2 (paid 4: 5)
const BIG_FELINOR = "core-043"; // Unit, 3 — 3/10
const PILLOW = "core-065-1"; // Unit token — 0/2 → 0/4, the −2 attack aura
const WEAPONS = "core-014"; // Field Spell, 4 — your units +4 attack, Rush, First Strike
const LAYER_LIBRARY = [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA];

function backrowAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.backrow(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a backrow card in lane ${lane}`);
  return card;
}

describe("R102: a fused card's layers are each ingredient's", () => {
  it("R102 a Going Long fused onto a Going Long gives its hero Armor 4, as two Going Longs standing apart do (R124)", () => {
    // p2 plays Going Long for 2; p1's Unlicensed Experimentation fuses it onto p1's own Going Long,
    // the only Field Spell p1 controls (R61, R77). The fused card carries both texts, "Your hero has
    // Armor 2" twice: hero Armor from several sources adds up (R124), and a static flag that is an
    // amount of what the text does adds up across a Fuse, as a Twinspell's Echo grant does.
    const g = scenario({
      active: "p2",
      p1: {
        backrow: [{ def: GOING_LONG, lane: 1 }, { def: EXPERIMENTATION, lane: 3 }],
        hand: [STOCKPILE],
        library: [...LAYER_LIBRARY],
      },
      p2: { hand: [GOING_LONG, STOCKPILE], library: [...LAYER_LIBRARY] },
    });
    expect(heroArmorOf(g.state, "p1")).toBe(2);

    g.play(GOING_LONG, { zone: 1, embiggen: false });
    expect(g.events.some((event) => event.type === "fused")).toBe(true);
    expect(g.backrow("p2", 1)).toBeNull();
    expect(backrowAt(g, "p1", 1).defId).toMatch(/^t-\d+:core-084\+core-084$/);

    expect(heroArmorOf(g.state, "p1")).toBe(4);
  });

  it("R102 a Going Long paid 4 fused onto a Going Long paid 2 gives Armor 5 and 2, each at its own card's price (§6.3 Embiggen, R124)", () => {
    const g = scenario({
      active: "p2",
      p1: {
        backrow: [{ def: GOING_LONG, lane: 1 }, { def: EXPERIMENTATION, lane: 3 }],
        hand: [STOCKPILE],
        library: [...LAYER_LIBRARY],
      },
      p2: { hand: [GOING_LONG, STOCKPILE], library: [...LAYER_LIBRARY], mana: 4 },
    });
    g.play(GOING_LONG, { zone: 1, embiggen: true });
    expect(backrowAt(g, "p1", 1).defId).toMatch(/^t-\d+:core-084\+core-084$/);
    expect(heroArmorOf(g.state, "p1")).toBe(7);
  });

  it("R102 a Suppressive Aura paid 4 fused onto a Mana Well keeps its −5/−5 (§6.3 Embiggen, R65)", () => {
    // p2 plays Suppressive Aura at its embiggen price, 4: "all units −5/−5". p1's Unlicensed
    // Experimentation fuses it onto p1's Mana Well. The fused cost already reads that ingredient at
    // the price it was played for (R77: the sum of the printed costs per R65), and its text is the
    // same ingredient's, which §6.3 Embiggen has read the stored choice, so the aura stays −5/−5.
    const g = scenario({
      active: "p2",
      p1: {
        backrow: [{ def: MANA_WELL, lane: 1 }, { def: EXPERIMENTATION, lane: 3 }],
        field: [{ def: BIG_FELINOR, lane: 1 }],
        hand: [STOCKPILE],
        library: [...LAYER_LIBRARY],
      },
      p2: { hand: [SUPPRESSIVE_AURA, STOCKPILE], library: [...LAYER_LIBRARY] },
    });
    const felinor = unitAt(g, "p1", 1);

    g.play(SUPPRESSIVE_AURA, { zone: 1, embiggen: true });
    expect(g.events.some((event) => event.type === "fused")).toBe(true);
    expect(backrowAt(g, "p1", 1).defId).toMatch(/^t-\d+:core-046\+core-006$/);

    // Big Felinor is 3/10: under −5/−5 it is 0/5, under the base price's −2/−2 it would be 1/8.
    g.expectStats(felinor, { attack: 0, maxHealth: 5 });
  });

  it("R102 a radiant Spikey Pillow fused with another card still spares every Spikey Pillow its aura names (§7, §8 #65.1)", () => {
    // p1's radiant Spikey Pillow prints "Aura: your non-Spikey-Pillow units have −2 attack". p2
    // plays Tempo Timmy, and p1's Unlicensed Experimentation fuses it onto the Pillow, p1's only
    // Unit (R61, R77). The fused card carries the Pillow's text in full. On p1's turn its Masochism
    // Mask summons a second, real Spikey Pillow: a Spikey Pillow, so the fused card's aura does not
    // reach it. Jlockeed's Weapons gives it +4 attack and its own base aura −2.
    const g = scenario({
      active: "p2",
      p1: {
        field: [{ def: PILLOW, radiant: true, lane: 1 }],
        backrow: [
          { def: MASOCHISM_MASK, lane: 1 },
          { def: WEAPONS, lane: 2 },
          { def: EXPERIMENTATION, lane: 3 },
        ],
        hand: [STOCKPILE],
        library: [...LAYER_LIBRARY],
      },
      p2: { hand: [TEMPO_TIMMY, STOCKPILE], library: [...LAYER_LIBRARY] },
    });
    const kept = unitAt(g, "p1", 1);
    g.play(TEMPO_TIMMY, { zone: 1 });
    expect(g.card(kept).defId).toMatch(/^t-\d+:core-011\+core-065-1$|^t-\d+:core-065-1\+core-011$/);

    g.endTurn();
    expect(g.state.pending?.playerId).toBe("p1");
    g.answer(["summon Spikey Pillow"]);
    const pillow = unitAt(g, "p1", 2);
    expect(pillow.defId).toBe(PILLOW);

    // 0 printed + 4 (Weapons) − 2 (its own base aura), and nothing from the fused radiant aura.
    g.expectStats(pillow, { attack: 2 });
  });
});
