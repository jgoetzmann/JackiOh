// #51 KY's Private Tutor — SPEC §8.3 row 51, §6.3 (Discover), §10.5 steps 5-6, §10.6, §10.8,
// §5.1; R4, R60, R65, R113.
//
// BUILD M4-T4 row 51: "Only types and brackets with a match offered; 3 random matches revealed; no
// match → Notebook; Field Trap counts as Trap; radiant runs twice".
//
// The card is a four-step machine whose middle three steps are prompts (§10.6), so almost every
// case below is a chain: play, then `answer` once per prompt. R113 is the rule that makes the chain
// a test subject in its own right — "a work item that cannot be resumed is a lost sequence … and
// must never be dropped in silence" — so the cases assert both halves of it: answering one prompt
// opens the next, and the card really finishes (no prompt left open, no work owed, the Spell in the
// graveyard). One case takes the paused game through `JSON.parse(JSON.stringify(...))` and resumes
// the revived state through `reduce`, because §9.3's "mid-action choices are state, not callbacks"
// is only true if the pause survives serialization.

import { describe, expect, it } from "vitest";
import { reduce, type GameState, type PendingChoice } from "@jackioh/engine";
import { base, def, radiant } from "../src/scripts/051-kys-private-tutor";
import { scenario, type Scenario } from "./_harness";

const TUTOR = "core-051";
const NOTEBOOK = "core-051-1";

/**
 * §2.5/R82 TURN ANCHOR. #10 Rapid Replenish is a 0-cost Spell and therefore always an affordable
 * play, so one in hand keeps p1's turn from auto-ending once the Tutor has left the hand — which
 * would clear `turnLog` and deal fatigue under the assertions. It is deliberately NOT one of the
 * library fixtures below, so no assertion about a library card is ambiguous about which copy it
 * means.
 */
const ANCHOR = "core-010";

// The library fixture, chosen so each of the four type options has a match and each type offers a
// different set of brackets. Costs are the printed ones; R65's out-of-play reading is its own case.
const SPELL_0A = "core-039"; // Recycling Initiative — Spell, 0
const SPELL_0B = "core-048"; // 5pek Controller      — Spell, 0
const SPELL_1A = "core-005"; // Stockpile            — Spell, 1
const SPELL_1B = "core-035"; // Lunar Eclipse        — Spell, 1
const SPELL_2 = "core-016"; //  Hit Job              — Spell, 2
const UNIT_1 = "core-008"; //   Mr. Vanilla          — Unit, 1
const UNIT_4 = "core-025"; //   4-mana 7/7           — Unit, 4
const FIELD_3 = "core-006"; //  Mana Well            — Field Spell, 3
const FIELD_TRAP_1 = "core-018"; // Bread and Butter — Field Trap, 1
const TRAP_1 = "core-041"; //   Sheepish             — Trap, 1

const LIBRARY = [
  SPELL_0A,
  SPELL_0B,
  SPELL_1A,
  SPELL_1B,
  SPELL_2,
  UNIT_1,
  UNIT_4,
  FIELD_3,
  FIELD_TRAP_1,
  TRAP_1,
] as const;

const SEED = "ky-tutor";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the scenario has no ${what}`);
  return value;
}

function open(s: Scenario): PendingChoice {
  return must(s.state.pending, "an open prompt");
}

/** A `mode` prompt's options as the plain option strings the card declared (§10.6). */
function modeOptions(pending: PendingChoice): string[] {
  return pending.options.flatMap((option) =>
    option.selection.pick === "mode" ? [option.selection.option] : [],
  );
}

/** A Discover-from-library prompt's options are LIBRARY INSTANCES, so read their def ids. */
function revealedDefIds(s: Scenario, pending: PendingChoice): string[] {
  return pending.options.flatMap((option) =>
    option.selection.pick === "instance" ? [s.card(option.selection.instanceId).defId] : [],
  );
}

function revealedInstanceIds(pending: PendingChoice): string[] {
  return pending.options.flatMap((option) =>
    option.selection.pick === "instance" ? [option.selection.instanceId] : [],
  );
}

function handDefIds(s: Scenario): string[] {
  return s.hand("p1").map((card) => card.defId);
}

function tutor(opts: { radiant?: boolean; library?: readonly string[] } = {}): Scenario {
  const card = opts.radiant === true ? { def: TUTOR, radiant: true } : TUTOR;
  return scenario({
    seed: SEED,
    p1: { hand: [card, ANCHOR], library: [...(opts.library ?? LIBRARY)] },
    p2: { hand: [ANCHOR], library: [...LIBRARY] },
  });
}

/** The chain finished cleanly: no prompt open, nothing owed, the Spell in the graveyard (R113). */
function expectChainFinished(s: Scenario): void {
  expect(s.state.pending).toBeNull();
  expect(s.state.work).toEqual([]);
  s.expectInZone(TUTOR, "graveyard");
}

// ---------------------------------------------------------------------------
// The card's shape (§8.3, §10.9)
// ---------------------------------------------------------------------------

describe("#51 KY's Private Tutor — the card", () => {
  it("§8.3 is a 1-cost Epic Spell tagged KY", () => {
    expect(def.id).toBe(TUTOR);
    expect(def.type).toBe("Spell");
    expect(def.cost).toBe(1);
    expect(def.rarity).toBe("Epic");
    expect(def.tags).toContain("KY");
  });

  it("§10.9 both faces are a Cry plus the same three named continuations (§10.6)", () => {
    expect(Object.keys(base).sort()).toEqual(["cry", "resume"]);
    expect(Object.keys(base.resume ?? {}).sort()).toEqual(["bracket", "reveal", "take"]);
    expect(Object.keys(radiant.resume ?? {}).sort()).toEqual(["bracket", "reveal", "take"]);
    // R81: nothing about this card travels in the `play` action — every choice is a prompt.
    expect(base.targets).toBeUndefined();
    expect(base.modes).toBeUndefined();
  });

  it("§8.3 the radiant cell is Echo, so the radiant face is the same steps plus one repeat", () => {
    expect(radiant.staticFlags).toEqual({ echo: 1 });
    expect(base.staticFlags).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The chain (§10.6, R113)
// ---------------------------------------------------------------------------

describe("#51 KY's Private Tutor — base", () => {
  it("R113 three chained prompts: type, then bracket, then the reveal — and the card finishes", () => {
    const s = tutor();
    s.play(TUTOR);

    // Prompt 1 — the type, to the caster.
    const types = open(s);
    expect(types.kind).toBe("mode");
    expect(types.playerId).toBe("p1");
    expect(modeOptions(types)).toEqual(["Spell", "Unit", "Field Spell", "Trap"]);

    // Answering it opens the NEXT one rather than ending the sequence (R113).
    s.answer("Spell");
    const brackets = open(s);
    expect(brackets.kind).toBe("mode");
    expect(brackets.id).not.toBe(types.id);

    s.answer("0-1");
    const reveal = open(s);
    expect(reveal.kind).toBe("discover");
    expect(reveal.id).not.toBe(brackets.id);
    const picked = must(revealedInstanceIds(reveal)[0], "a revealed card");

    s.answer(picked);

    // The fourth step is not a prompt: it moves the pick and the sequence ends.
    expectChainFinished(s);
    expect(s.hand("p1").map((card) => card.id)).toContain(picked);
    s.expectEvents("cardPlayed", "promptOpened", "promptAnswered", "addedToHand", "cardResolved");
  });

  it("R113 the paused game survives a JSON round trip and resumes from the revived state", () => {
    const s = tutor();
    s.play(TUTOR);
    s.answer("Spell");
    s.answer("0-1");

    const paused = s.state;
    expect(paused.pending?.kind).toBe("discover");

    // §9.3: a mid-action choice is state, not a callback. Nothing in the pause is a closure, so a
    // round trip through JSON is the same game — the prompt, its options and its `resume` included.
    const revived = JSON.parse(JSON.stringify(paused)) as GameState;
    expect(revived).toEqual(paused);
    expect(revived.pending?.resume).toEqual(paused.pending?.resume);

    // And it really resumes: the revived state answers through the ordinary reducer and the card
    // finishes there, with no prompt left open and nothing owed on `state.work` (R113).
    const choiceId = must(revived.pending, "a revived prompt").id;
    const instanceId = must(revealedInstanceIds(must(revived.pending, "a revived prompt"))[0], "an option");
    const result = reduce(revived, {
      type: "answer",
      playerId: "p1",
      choiceId,
      selection: [{ pick: "instance", instanceId }],
      nonce: "round-trip-1",
    });

    expect(result.error).toBeUndefined();
    expect(result.state.pending).toBeNull();
    expect(result.state.work).toEqual([]);
    expect(result.state.players.p1.hand.map((card) => card.id)).toContain(instanceId);
  });

  it("§8.3 only types with a match in the library are offered", () => {
    // A library of nothing but Units: three of the four options have no match and are not offered.
    const s = tutor({ library: [UNIT_1, UNIT_4] });
    s.play(TUTOR);

    expect(modeOptions(open(s))).toEqual(["Unit"]);
  });

  it("§8.3 only brackets with a match FOR THE CHOSEN TYPE are offered", () => {
    const s = tutor();
    s.play(TUTOR);

    // Spells in the fixture cost 0, 0, 1, 1 and 2 — so "0-1" and "2", never "3" or "4+".
    s.answer("Spell");
    expect(modeOptions(open(s))).toEqual(["0-1", "2"]);
  });

  it("§8.3 the brackets are recomputed per type, not fixed", () => {
    const units = tutor();
    units.play(TUTOR).answer("Unit");
    // Mr. Vanilla at 1 and the 4-mana 7/7 at 4: the two ends and nothing between them.
    expect(modeOptions(open(units))).toEqual(["0-1", "4+"]);

    const fields = tutor();
    fields.play(TUTOR).answer("Field Spell");
    // Mana Well is the only Field Spell in the fixture, at 3.
    expect(modeOptions(open(fields))).toEqual(["3"]);
  });

  it("§8.3 reveals 3 random matching library cards, all of them matching the two answers", () => {
    const s = tutor();
    s.play(TUTOR).answer("Spell").answer("0-1");

    const reveal = open(s);
    // Four Spells in the fixture cost 0 or 1, so the Discover offers three of them.
    expect(reveal.options).toHaveLength(3);
    expect(new Set(revealedInstanceIds(reveal)).size).toBe(3);
    for (const defId of revealedDefIds(s, reveal)) {
      expect([SPELL_0A, SPELL_0B, SPELL_1A, SPELL_1B]).toContain(defId);
    }
  });

  it("§6.3 fewer than three matches reveal what exists", () => {
    const s = tutor({ library: [SPELL_2, UNIT_1] });
    s.play(TUTOR).answer("Spell");
    // Hit Job is the only Spell, so "2" is the only bracket and it is the only reveal.
    expect(modeOptions(open(s))).toEqual(["2"]);

    s.answer("2");
    const reveal = open(s);
    expect(revealedDefIds(s, reveal)).toEqual([SPELL_2]);
  });

  it("R60 the three revealed cards are the seed's, so a replay reveals the same three", () => {
    const first = tutor();
    first.play(TUTOR).answer("Spell").answer("0-1");
    const second = tutor();
    second.play(TUTOR).answer("Spell").answer("0-1");

    expect(revealedDefIds(second, open(second))).toEqual(revealedDefIds(first, open(first)));
  });

  it("§6.3 the chosen card MOVES library → hand; it is not copied", () => {
    const s = tutor();
    const libraryBefore = s.pile("p1", "library").length;
    s.play(TUTOR).answer("Spell").answer("0-1");
    const picked = must(revealedInstanceIds(open(s))[0], "a revealed card");

    s.answer(picked);

    s.expectInZone(picked, "hand");
    expect(s.pile("p1", "library")).toHaveLength(libraryBefore - 1);
    expect(s.pile("p1", "library").map((card) => card.id)).not.toContain(picked);
    // The same instance, not a fresh one made from its def.
    expect(s.hand("p1").filter((card) => card.id === picked)).toHaveLength(1);
  });

  it("the Engine cell's 'Field Trap counts as Trap': the Trap option reaches a Field Trap", () => {
    const s = tutor({ library: [FIELD_TRAP_1] });
    s.play(TUTOR);

    // A `type` filter matches the field exactly, so "Trap" has to name both or #18 Bread and Butter
    // and #71 Intern Stimmy would silently vanish from this card (the same reading as R35 and R61).
    expect(modeOptions(open(s))).toEqual(["Trap"]);

    s.answer("Trap");
    expect(modeOptions(open(s))).toEqual(["0-1"]);

    s.answer("0-1");
    expect(revealedDefIds(s, open(s))).toEqual([FIELD_TRAP_1]);
  });

  it("the Engine cell's 'Trap' also still reaches an ordinary Trap, and both together", () => {
    const s = tutor({ library: [TRAP_1, FIELD_TRAP_1] });
    s.play(TUTOR).answer("Trap").answer("0-1");

    expect(revealedDefIds(s, open(s)).sort()).toEqual([FIELD_TRAP_1, TRAP_1].sort());
  });

  it("R65 the brackets read costs OUT OF PLAY: an X-cost card is 0 and an embiggen card its base", () => {
    // #74 Adaptive UI is a Spell printed "X"; R65 reads it as 0 in a library, so it is in "0-1".
    const xCost = tutor({ library: ["core-074"] });
    xCost.play(TUTOR).answer("Spell");
    expect(modeOptions(open(xCost))).toEqual(["0-1"]);

    // #59 Unbiased Immigration is a Field Spell printed "2 embiggen 4"; out of play it reads 2.
    const embiggen = tutor({ library: ["core-059"] });
    embiggen.play(TUTOR).answer("Field Spell");
    expect(modeOptions(open(embiggen))).toEqual(["2"]);
  });

  it("§8.3 no match at all: an empty library adds a KY's Empty Notebook and opens no prompt", () => {
    const s = tutor({ library: [] });

    s.play(TUTOR);

    // No type has a match exactly when the library is empty, since every card in it has one of the
    // five types and all five map onto the four options.
    expect(s.state.pending).toBeNull();
    expect(handDefIds(s)).toContain(NOTEBOOK);
    expectChainFinished(s);
    s.expectEvents("cardPlayed", "addedToHand", "cardResolved");
  });

  it("§5.1 the Notebook is created here and nowhere else: it is not taken out of the library", () => {
    const s = tutor({ library: [] });
    s.play(TUTOR);

    // §7/R11: a fresh token instance, owned by the caster.
    const notebook = must(
      s.hand("p1").find((card) => card.defId === NOTEBOOK),
      "a Notebook in hand",
    );
    expect(notebook.owner).toBe("p1");
    expect(s.pile("p1", "library")).toHaveLength(0);
  });

  it("§10.8 the reveal is shown to the caster only", () => {
    const s = tutor();
    s.play(TUTOR).answer("Spell").answer("0-1");

    const mine = must(s.view("p1").pending, "p1's own prompt view");
    expect(mine.forYou).toBe(true);

    // The opponent learns that p1 is choosing and nothing else: no options, so no card that was
    // revealed out of p1's library reaches p2's view.
    const theirs = must(s.view("p2").pending, "p2's view of the prompt");
    expect(theirs.forYou).toBe(false);
    for (const defId of revealedDefIds(s, open(s))) {
      expect(JSON.stringify(theirs)).not.toContain(defId);
    }
  });
});

// ---------------------------------------------------------------------------
// The radiant face: Echo (§6.2, §10.5 step 6)
// ---------------------------------------------------------------------------

describe("#51 KY's Private Tutor — radiant", () => {
  it("§8.3 Echo: the whole four-step sequence runs a second time", () => {
    const s = tutor({ radiant: true });
    const libraryBefore = s.pile("p1", "library").length;

    s.play(TUTOR);

    // First resolution: the same three prompts as the base face.
    expect(modeOptions(open(s))).toEqual(["Spell", "Unit", "Field Spell", "Trap"]);
    s.answer("Spell").answer("0-1");
    const firstPick = must(revealedInstanceIds(open(s))[0], "a first reveal");
    s.answer(firstPick);

    // §10.5 step 6: the repeat opens its OWN fresh prompts rather than finishing the card.
    const secondTypes = open(s);
    expect(secondTypes.kind).toBe("mode");
    s.answer("Unit").answer("0-1");
    const secondReveal = open(s);
    expect(secondReveal.kind).toBe("discover");
    const secondPick = must(revealedInstanceIds(secondReveal)[0], "a second reveal");

    s.answer(secondPick);

    expectChainFinished(s);
    expect(s.hand("p1").map((card) => card.id)).toEqual(
      expect.arrayContaining([firstPick, secondPick]),
    );
    expect(s.pile("p1", "library")).toHaveLength(libraryBefore - 2);
  });

  it("§8.3 the repeat reads the library as it is NOW: the first pick is not offered again", () => {
    // Two Spells at 0-1, so the first resolution takes one and the second can only be the other.
    const s = tutor({ radiant: true, library: [SPELL_0A, SPELL_1A, UNIT_1] });
    s.play(TUTOR).answer("Spell").answer("0-1");
    const firstReveal = open(s);
    expect(revealedDefIds(s, firstReveal).sort()).toEqual([SPELL_0A, SPELL_1A].sort());
    const firstPick = must(revealedInstanceIds(firstReveal)[0], "a first reveal");
    s.answer(firstPick);

    s.answer("Spell").answer("0-1");
    const secondReveal = open(s);

    expect(revealedInstanceIds(secondReveal)).not.toContain(firstPick);
    expect(revealedInstanceIds(secondReveal)).toHaveLength(1);
  });

  it("§8.3 the radiant face still falls back to the Notebook, twice, on an empty library", () => {
    const s = tutor({ radiant: true, library: [] });

    s.play(TUTOR);

    // Neither resolution finds a match, and neither opens a prompt.
    expect(s.state.pending).toBeNull();
    expect(handDefIds(s).filter((defId) => defId === NOTEBOOK)).toHaveLength(2);
    expectChainFinished(s);
  });

  it("§8 Conventions: the radiant cell restates none of the base clause, so every step is kept", () => {
    const s = tutor({ radiant: true, library: [FIELD_TRAP_1, UNIT_1] });
    s.play(TUTOR);

    // The type filter, the bracket filter and "Field Trap counts as Trap" all still apply.
    expect(modeOptions(open(s))).toEqual(["Unit", "Trap"]);
    s.answer("Trap").answer("0-1");
    expect(revealedDefIds(s, open(s))).toEqual([FIELD_TRAP_1]);
  });
});
