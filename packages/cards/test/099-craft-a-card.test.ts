// #99 Craft a Card — SPEC §8.5, §6.3 (Fuse, Discover), §10.5, §10.6, R4, R23, R60, R65, R77, R86,
// R102, R113.
//
// BUILD M4-T4 row 99: "Two Discovers, fused def in `transientDefs` with both forms fused, no
// on-field target and the ingredients' shared type (R77), cost 0 in hand, making it Radiant later
// switches to the fused radiant form; radiant three".
//
// R275 adds a draw to the radiant face: "…; Fuse them; the result costs 0 and goes to your hand;
// draw 1". The draw follows the fuse.
//
// R102's "the whole verb does nothing at all" guards are unreachable from a #99 play (it always
// brings two or three definitions and a destination hand), so they are asserted against
// `subsystems.fuse`, where that rule lives.

import { describe, expect, it } from "vitest";
import type { CardDef, GameEvent, Keyword } from "@jackioh/shared";
// `FUSE_COST_CAP` and `HAND_CAP` are R77's and R4's numbers and live in `config.ts`; the subsystem
// namespace does not re-export them, so reaching for `subsystems.FUSE_COST_CAP` yields `undefined`.
import {
  FUSE_COST_CAP,
  HAND_CAP,
  createRng,
  effectiveCost,
  printedCost,
  queryCost,
  subsystems,
} from "@jackioh/engine";
import type { CardInstance, EngineSink, GameState, PendingChoice } from "@jackioh/engine";
import { cardDef } from "../src/catalog-data";
import { query } from "../src/query";
import { base as craftBase, radiant as craftRadiant } from "../src/scripts/099-craft-a-card";
import { scenario, type Scenario, type SideSetup } from "./_harness";

const CRAFT = "core-099"; // Spell, 3, Mythic
/** #53 Reno, a 3-cost Unit: the spare card that keeps §2.5's auto-end off the assertions. */
const SPARE = "core-053";
/** #19 Midrange Menace: base 9/9 Taunt, radiant 18/18 Taunt + Immutable — R23's target. */
const MENACE = "core-019";
/** #11 Tempo Timmy, a 1-cost Unit, for a plain on-field ingredient. */
const TIMMY = "core-011";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function eventsOf<T extends GameEvent["type"]>(s: Scenario, type: T): Extract<GameEvent, { type: T }>[] {
  return s.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function open(s: Scenario): PendingChoice {
  return must(s.state.pending, "an open prompt");
}

/** A Discover's options are `mode` selections carrying catalog ids (§10.6). */
function optionIds(pending: PendingChoice): string[] {
  return pending.options.flatMap((option) =>
    option.selection.pick === "mode" ? [option.selection.option] : [],
  );
}

function craftScenario(opts: { radiantFace?: boolean; seed?: string; p1?: SideSetup } = {}): Scenario {
  return scenario({
    seed: opts.seed ?? "craft",
    p1: {
      mana: 8,
      ...(opts.p1 ?? {}),
      hand: [{ def: CRAFT, radiant: opts.radiantFace === true }, SPARE, ...(opts.p1?.hand ?? [])],
    },
  });
}

/** Play #99 and answer every Discover with its first option, collecting the picks in order. */
function craft(opts: { radiantFace?: boolean; seed?: string; p1?: SideSetup } = {}): {
  s: Scenario;
  picks: string[];
} {
  const s = craftScenario(opts);
  s.play(CRAFT);
  const picks: string[] = [];
  const expected = opts.radiantFace === true ? 3 : 2;
  for (let step = 0; step < expected; step += 1) {
    const pending = open(s);
    const pick = must(optionIds(pending)[0], `an option on Discover ${step + 1}`);
    picks.push(pick);
    s.answer(must(pending.options[0], "the first option").key);
  }
  return { s, picks };
}

/** The one transient definition a #99 resolution should have written (§10.1, R77). */
function fusedDefOf(state: GameState): CardDef {
  const defs = Object.values(state.transientDefs);
  expect(
    defs.length,
    "R77: Fuse writes one transient definition into `state.transientDefs`; #99's last step still " +
      "returns [] — the effects barrel now exports `fuseCards`, so the script needs the one line " +
      'its own comment writes out: return [fuseCards({ defIds: [...picks], toHand: "self" })]',
  ).toBe(1);
  return must(defs[0], "the fused definition");
}

function keywordKinds(keywords: readonly Keyword[]): string[] {
  return keywords.map((keyword) => keyword.kind);
}

/** A sink over the live state, threaded the way the harness's own direct engine calls are. */
function sinkFor(s: Scenario): EngineSink {
  return { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
}

// ---------------------------------------------------------------------------
// The card and the Discover chain (§8.5, §10.6, R113). This half passes today.
// ---------------------------------------------------------------------------

describe("#99 Craft a Card — the Discover chain", () => {
  it("§8.5 is a 3-cost Mythic Spell, uncastable on 2 mana", () => {
    const def = cardDef(CRAFT);
    expect(def.type).toBe("Spell");
    expect(def.cost).toBe(3);
    expect(def.rarity).toBe("Mythic");

    const s = scenario({ p1: { hand: [CRAFT], mana: 2 } });
    expect(() => s.play(CRAFT)).toThrow(/costs 3, more than your mana/);
  });

  it("§10.9 both faces are a Cry plus a resume table, and the radiant face has one more step", () => {
    expect(Object.keys(craftBase).sort()).toEqual(["cry", "resume"]);
    expect(Object.keys(craftRadiant).sort()).toEqual(["cry", "resume"]);
    // §8.5's radiant cell restates only how many Discovers there are (§8 Conventions).
    expect(Object.keys(craftBase.resume ?? {})).toHaveLength(2);
    expect(Object.keys(craftRadiant.resume ?? {})).toHaveLength(3);
  });

  it("§6.3 Discover: the first prompt offers 3 distinct non-token Units, to the caster only", () => {
    const s = craftScenario();
    s.play(CRAFT);

    const pending = open(s);
    expect(pending.kind).toBe("discover");
    expect(pending.playerId).toBe("p1");
    expect(pending.min).toBe(1);
    expect(pending.max).toBe(1);
    expect(pending.options).toHaveLength(3);

    const ids = optionIds(pending);
    expect(new Set(ids).size).toBe(3); // drawn without replacement (§6.3)
    const units = query({ type: "Unit" }).map((def) => def.id);
    for (const id of ids) {
      expect(units).toContain(id);
      expect(cardDef(id).type).toBe("Unit");
      // §5.1: a plain type filter asks for no tokens, so no Rush Token or Chaos Golem is craftable.
      expect(cardDef(id).token).toBe(false);
    }

    // §10.8: the opponent is told a prompt is open and nothing about its options.
    const asSeenByP2 = s.view("p2").pending;
    expect(asSeenByP2).toEqual({ forYou: false, pendingFor: "p1" });
  });

  it("R113 answering the first Discover opens the SECOND: the sequence resumes through state.work", () => {
    const s = craftScenario();
    s.play(CRAFT);

    const first = open(s);
    const firstPick = must(optionIds(first)[0], "an option on the first Discover");
    s.answer(must(first.options[0], "the first option").key);

    const second = open(s);
    expect(second.id).not.toBe(first.id);
    expect(second.kind).toBe("discover");
    expect(second.options).toHaveLength(3);
    expect(eventsOf(s, "promptOpened")).toHaveLength(2);

    // The second pool is an independent draw over the same query: nothing is narrowed by the first
    // pick, so the same Unit can be offered — and picked — twice (R60, and §8.5 forbids neither).
    const units = query({ type: "Unit" }).map((def) => def.id);
    for (const id of optionIds(second)) expect(units).toContain(id);

    s.answer(must(second.options[0], "the first option").key);
    expect(s.state.pending).toBeNull();
    // The spell only finishes after the whole chain: §10.5 steps 6-8 were owed while it paused.
    s.expectInZone(CRAFT, "graveyard");
    expect(firstPick).toBeTruthy();
  });

  it("R60 the second Discover can offer the card the first one gave, over the seeds", () => {
    // Proves the second pool is not narrowed: some seed offers the first pick again.
    let offeredAgain = false;
    for (let n = 0; n < 40 && !offeredAgain; n += 1) {
      const s = craftScenario({ seed: `craft-repeat-${n}` });
      s.play(CRAFT);
      const first = open(s);
      const picked = must(optionIds(first)[0], "an option");
      s.answer(must(first.options[0], "the first option").key);
      offeredAgain = optionIds(open(s)).includes(picked);
    }
    expect(offeredAgain).toBe(true);
  });

  it("§8.5 radiant opens THREE Discovers, each resuming into the next (R113)", () => {
    const s = craftScenario({ radiantFace: true });
    s.play(CRAFT);

    for (let step = 0; step < 3; step += 1) {
      const pending = open(s);
      expect(pending.kind).toBe("discover");
      expect(pending.options).toHaveLength(3);
      s.answer(must(pending.options[0], "the first option").key);
    }
    expect(s.state.pending).toBeNull();
    expect(eventsOf(s, "promptOpened")).toHaveLength(3);
    s.expectInZone(CRAFT, "graveyard");
  });

  it("§10.5 step 4 the spell counts as played before it asks anything", () => {
    const s = craftScenario();
    s.play(CRAFT);
    expect(s.state.counters.played).toBe(1);
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
    s.expectMana("p1", 5); // 8 − 3
  });
});

// ---------------------------------------------------------------------------
// The fused result (R77, R102).
// ---------------------------------------------------------------------------

describe("#99 Craft a Card — the fused result (R77, R102)", () => {
  it("R77 puts a fresh card in your hand with costOverride 0, and nothing on the field", () => {
    const { s } = craft();
    const fused = fusedDefOf(s.state);

    const crafted = s.hand("p1").filter((card) => card.defId === fused.id);
    expect(crafted).toHaveLength(1);
    const card = must(crafted[0], "the crafted card");
    expect(card.costOverride).toBe(subsystems.CRAFTED_CARD_COST);
    // "the result costs 0": the price the play validator reads, not merely a rider (R65).
    expect(effectiveCost(s.state, card)).toBe(0);
    // "a fresh, NON-Radiant hand card" (R77), and the fusion happened in a hand, not on a board.
    expect(card.radiant).toBe(false);
    expect(s.unit("p1", 1)).toBeNull();
    expect(eventsOf(s, "fused")).toHaveLength(1);
  });

  it("R102 sums the stats, unions the tags, dedupes the keywords, and fuses BOTH faces", () => {
    const { s, picks } = craft();
    const fused = fusedDefOf(s.state);
    const ingredients = picks.map((id) => cardDef(id));

    for (const [face, key] of [
      [fused.base, "base"],
      [fused.radiant, "radiant"],
    ] as const) {
      const faces = ingredients.map((def) => def[key]);
      expect(face.attack).toBe(faces.reduce((sum, one) => sum + (one.attack ?? 0), 0));
      expect(face.health).toBe(faces.reduce((sum, one) => sum + (one.health ?? 0), 0));
      // One entry per distinct keyword, so Armor 1 and Armor 2 both survive (§10.4).
      const kinds = keywordKinds(face.keywords);
      expect(new Set(kinds).size).toBe(kinds.length);
      for (const one of faces) for (const kind of keywordKinds(one.keywords)) expect(kinds).toContain(kind);
    }

    // Identity, member by member (R102).
    expect(fused.type).toBe("Unit"); // no target on the field, so the ingredients' shared type
    expect(fused.name).toBe(ingredients.map((def) => def.name).join(" + "));
    expect(fused.token).toBe(false);
    expect([...fused.tags].sort()).toEqual(
      [...new Set(ingredients.flatMap((def) => def.tags))].sort(),
    );
    // Cost is the capped sum of the printed costs read per R65 — not the crafted instance's 0.
    expect(fused.cost).toBe(
      Math.min(
        ingredients.reduce((sum, def) => sum + queryCost(def), 0),
        FUSE_COST_CAP,
      ),
    );
  });

  it("R77 both forms are fused, so making the hand card Radiant switches to the fused radiant form", () => {
    const { s, picks } = craft();
    const fused = fusedDefOf(s.state);
    const card = must(
      s.hand("p1").find((entry) => entry.defId === fused.id),
      "the crafted card in hand",
    );

    const sumOf = (key: "base" | "radiant"): { attack: number; health: number } =>
      picks
        .map((id) => cardDef(id)[key])
        .reduce(
          (total, face) => ({
            attack: total.attack + (face.attack ?? 0),
            health: total.health + (face.health ?? 0),
          }),
          { attack: 0, health: 0 },
        );

    s.expectStats(card, { attack: sumOf("base").attack, maxHealth: sumOf("base").health });
    // §5.2 is a flag on the instance, so the same card read as Radiant reads the fused radiant face.
    s.card(card).radiant = true;
    s.expectStats(card, { attack: sumOf("radiant").attack, maxHealth: sumOf("radiant").health });
  });

  it("R77 the crafted card is playable, and it is the fused card that lands", () => {
    const { s } = craft();
    const fused = fusedDefOf(s.state);
    const card = must(
      s.hand("p1").find((entry) => entry.defId === fused.id),
      "the crafted card in hand",
    );

    s.play(card);
    const landed = must(s.unit("p1", 1), "the crafted Unit on the field");
    expect(landed.defId).toBe(fused.id);
    // It cost 0, so the 5 left after #99 is untouched.
    s.expectMana("p1", 5);
  });

  it("R102 and R86 the ingredients cease to exist: no graveyard, no Death trigger, no destroyed", () => {
    const { s } = craft();
    fusedDefOf(s.state);
    // #99's ingredients are Discovered DEFINITIONS that were never cards on a board, so the only
    // thing to assert is that the fusion created no corpse and counted no destruction.
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).toEqual([CRAFT]);
    expect(s.state.counters.destroyed).toBe(0);
    expect(eventsOf(s, "destroyed")).toHaveLength(0);
    expect(eventsOf(s, "enteredGraveyard").map((event) => event.defId)).toEqual([CRAFT]);
  });

  it("§8.5 radiant fuses all three picks into one card", () => {
    const { s, picks } = craft({ radiantFace: true });
    expect(picks).toHaveLength(3);
    const fused = fusedDefOf(s.state);
    const ingredients = picks.map((id) => cardDef(id));

    expect(fused.name).toBe(ingredients.map((def) => def.name).join(" + "));
    expect(fused.base.attack).toBe(ingredients.reduce((sum, def) => sum + (def.base.attack ?? 0), 0));
    const crafted = s.hand("p1").filter((card) => card.defId === fused.id);
    expect(crafted).toHaveLength(1);
    expect(effectiveCost(s.state, must(crafted[0], "the crafted card"))).toBe(0);
  });

  it("R4 the crafted card goes through §2.4's pipeline and takes the slot #99 vacated", () => {
    // §2.4's cap is HAND_CAP. #99 leaves the hand at step 4 to resolve, so a hand that was full
    // has one slot free by the time the fusion lands: the crafted card fits and nothing burns.
    // The card can never burn itself out of its own play, which is why this is the reachable half
    // of R4 for #99 — a burn would need a card added between #99 leaving and the fusion landing.
    const filler = Array.from({ length: HAND_CAP - 2 }, () => SPARE);
    const { s } = craft({ p1: { hand: filler, mana: 8 } });
    const fused = fusedDefOf(s.state);
    expect(s.hand("p1")).toHaveLength(HAND_CAP);
    expect(s.hand("p1").filter((card) => card.defId === fused.id)).toHaveLength(1);
    expect(eventsOf(s, "burned")).toHaveLength(0);
  });

  it("the base face draws nothing after the fusion", () => {
    const { s } = craft({ p1: { library: [TIMMY, TIMMY], mana: 8 } });
    fusedDefOf(s.state);
    expect(eventsOf(s, "drawn")).toHaveLength(0);
    expect(s.pile("p1", "library")).toHaveLength(2);
  });
});

describe("#99 Craft a Card — radiant's draw (R275)", () => {
  it("R275 draws 1 once the fused card has gone to your hand", () => {
    const { s } = craft({ radiantFace: true, p1: { library: [TIMMY, MENACE], mana: 8 } });
    const fused = fusedDefOf(s.state);

    // The fuse, then the draw: the top of the library, and only that card.
    const types = s.events.map((event) => event.type);
    const fusedAt = types.indexOf("fused");
    const drawnAt = types.indexOf("drawn");
    expect(fusedAt).toBeGreaterThanOrEqual(0);
    expect(drawnAt).toBeGreaterThan(fusedAt);
    expect(eventsOf(s, "drawn")).toHaveLength(1);
    expect(s.hand("p1").map((card) => card.defId)).toEqual([SPARE, fused.id, TIMMY]);
    expect(s.pile("p1", "library").map((card) => card.defId)).toEqual([MENACE]);
  });

  it("R4 the draw comes after the fusion, so with the hand full it is the draw that burns", () => {
    // #99 leaves the hand to resolve, the crafted card takes that slot (above), and the hand is at
    // HAND_CAP when the draw lands: the drawn card burns and the crafted one stays.
    const filler = Array.from({ length: HAND_CAP - 2 }, () => SPARE);
    const { s } = craft({ radiantFace: true, p1: { hand: filler, library: [TIMMY], mana: 8 } });
    const fused = fusedDefOf(s.state);

    expect(s.hand("p1")).toHaveLength(HAND_CAP);
    expect(s.hand("p1").filter((card) => card.defId === fused.id)).toHaveLength(1);
    expect(eventsOf(s, "burned").map((event) => event.defId)).toEqual([TIMMY]);
  });

  it("§2.4 an empty library makes the radiant draw a fatigue hit", () => {
    const { s } = craft({ radiantFace: true, p1: { health: 20, mana: 8 } });
    fusedDefOf(s.state);
    s.expectHealth("p1", 19);
  });
});

// ---------------------------------------------------------------------------
// R102's "the whole verb does nothing at all". Unreachable from a #99 play — it always brings two
// or three definitions and a destination hand — so asserted where the rule lives.
// ---------------------------------------------------------------------------

describe("Fuse does nothing at all (R102, R23)", () => {
  function untouched(s: Scenario, ingredients: readonly CardInstance[]): void {
    expect(s.state.transientDefs).toEqual({});
    for (const card of ingredients) expect(s.card(card).defId).toBe(card.defId);
  }

  it("R102 with fewer than two ingredients: nothing is built and nothing changes", () => {
    const s = scenario({ p1: { field: [TIMMY], hand: [SPARE] } });
    const timmy = must(s.unit("p1", 1), "the #11 on the field");
    const sink = sinkFor(s);

    expect(subsystems.fuse(sink, { ingredients: [], toHand: "p1" })).toBeNull();
    expect(subsystems.fuse(sink, { ingredients: [timmy], toHand: "p1" })).toBeNull();
    expect(subsystems.FUSE_MIN_INGREDIENTS).toBe(2);
    expect(sink.events).toEqual([]);
    untouched(s, [timmy]);
  });

  it("R23 with an Immutable target: the fusion is refused and the target keeps its identity", () => {
    // A radiant #19 Midrange Menace is Taunt + Immutable (§8.2), and R23 blocks Fuse-onto.
    const s = scenario({ p1: { field: [{ def: MENACE, radiant: true }, TIMMY], hand: [SPARE] } });
    const immutable = must(s.unit("p1", 1), "the radiant #19");
    const timmy = must(s.unit("p1", 2), "the #11");
    expect(s.stats(immutable).keywords.map((keyword) => keyword.kind)).toContain("Immutable");
    const sink = sinkFor(s);

    expect(
      subsystems.fuse(sink, { ingredients: [timmy], target: immutable }),
    ).toBeNull();
    expect(sink.events).toEqual([]);
    untouched(s, [immutable, timmy]);
  });

  it("R102 with a target that is not on the field: refused", () => {
    const s = scenario({ p1: { field: [TIMMY], hand: [SPARE, MENACE] } });
    const timmy = must(s.unit("p1", 1), "the #11");
    const inHand = must(s.hand("p1").find((card) => card.defId === MENACE), "the #19 in hand");
    const sink = sinkFor(s);

    expect(subsystems.fuse(sink, { ingredients: [timmy], target: inHand })).toBeNull();
    expect(sink.events).toEqual([]);
    untouched(s, [timmy, inHand]);
  });

  it("R102 with neither a target nor a destination hand: refused", () => {
    const s = scenario({ p1: { field: [TIMMY, MENACE], hand: [SPARE] } });
    const timmy = must(s.unit("p1", 1), "the #11");
    const menace = must(s.unit("p1", 2), "the #19");
    const sink = sinkFor(s);

    expect(subsystems.fuse(sink, { ingredients: [timmy, menace] })).toBeNull();
    expect(sink.events).toEqual([]);
    untouched(s, [timmy, menace]);
  });

  it("R102 an ingredient's own `cost` hook is dropped, so R77's cap wins (#100's case)", () => {
    // #100 Ceaseless Void's printed cost is a hook (100 minus four game counters, R55). R102:
    // "Cost is the capped sum of the printed costs and any ingredient `cost` hook is dropped, so
    // R77's cap wins over a cost-rewriting hook."
    const s = scenario({ p1: { field: ["core-100", TIMMY], hand: [SPARE] } });
    const empty = must(s.unit("p1", 1), "the #100 on the field");
    const timmy = must(s.unit("p1", 2), "the #11");
    expect(printedCost(s.state, empty)).toBeGreaterThan(FUSE_COST_CAP);

    const result = must(
      subsystems.fuse(sinkFor(s), { ingredients: [empty], target: timmy }),
      "the fused card",
    );
    const fused = fusedDefOf(s.state);
    expect(fused.cost).toBe(FUSE_COST_CAP);
    // The kept instance now reads the fused def's flat cost, not #100's hook.
    expect(printedCost(s.state, s.card(result))).toBe(FUSE_COST_CAP);
  });
});
