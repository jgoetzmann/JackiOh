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

import { describe, expect, it } from "vitest";
import type { Selection } from "@jackioh/shared";
import { createRng, legalActions, subsystems, type CardInstance, type EngineSink } from "@jackioh/engine";
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
