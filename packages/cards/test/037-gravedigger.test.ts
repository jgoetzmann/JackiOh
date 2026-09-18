// #37 Gravedigger (SPEC §8.2, BUILD M4-T4): "Random GY card to hand at start of turn before the
// draw; empty GY nothing; radiant Discover at −1."

import { describe, expect, it } from "vitest";
import { effectiveCost } from "@jackioh/engine";
import { base, def, radiant } from "../src/scripts/037-gravedigger";
import { scenario } from "./_harness";

const GRAVEDIGGER = "core-037";
/** Three distinct graveyard cards, so a random pick and a Discover are both readable by defId. */
const STOCKPILE = "core-005"; // cost 1
const HIT_JOB = "core-016"; // cost 2
const MANA_WELL = "core-006"; // cost 3
/** What the turn's draw puts in hand, so "before the draw" has something to be before. */
const DRAWN = "core-011";

const SEED = "gravedigger-37";
/** The card that seed picks out of the three-card graveyard; pinned per CLAUDE.md rule 4. */
const SEEDED_PICK = MANA_WELL;

const defIdsInHand = (s: ReturnType<typeof scenario>): string[] => s.hand("p1").map((card) => card.defId);

describe("#37 Gravedigger", () => {
  it("is §8.2's #37: a 2-cost Unit, 4/5 → 8/10", () => {
    expect(def.index).toBe("37");
    expect(def.type).toBe("Unit");
    expect(def.cost).toBe(2);
    expect([def.base.attack, def.base.health]).toEqual([4, 5]);
    expect([def.radiant.attack, def.radiant.health]).toEqual([8, 10]);
  });

  it("base hangs its clause on startOfTurn and radiant answers through a resume step (§10.6)", () => {
    expect(base.startOfTurn).toBeTypeOf("function");
    expect(base.resume).toBeUndefined();
    expect(radiant.startOfTurn).toBeTypeOf("function");
    // `prompts.ts`: `resumeSelf` files the continuation under `hook: "resume"`, `step: "picked"`.
    expect(radiant.resume?.picked).toBeTypeOf("function");
  });

  it("base adds a graveyard card to your hand at the start of your turn, BEFORE the draw", () => {
    const s = scenario({
      seed: SEED,
      p1: { field: [GRAVEDIGGER], graveyard: [STOCKPILE], library: [DRAWN] },
      p2: { hand: [STOCKPILE], library: [STOCKPILE] },
    });

    s.startTurn();

    // One card in the graveyard, so the seeded pick is forced: Stockpile moves GY → hand.
    expect(s.pile("p1", "graveyard")).toEqual([]);
    expect(defIdsInHand(s).sort()).toEqual([STOCKPILE, DRAWN].sort());
    // §2.2/R62: the start-of-turn hooks run before the draw, so the add is logged first.
    s.expectEvents("addedToHand", "drawn");
  });

  it("base picks with the seeded rng, so a fixed seed gives a fixed card", () => {
    const build = (): ReturnType<typeof scenario> =>
      scenario({
        seed: SEED,
        p1: { field: [GRAVEDIGGER], graveyard: [STOCKPILE, HIT_JOB, MANA_WELL], library: [DRAWN] },
        p2: { hand: [STOCKPILE], library: [STOCKPILE] },
      }).startTurn();

    const first = build();
    const second = build();

    const moved = (s: ReturnType<typeof scenario>): string[] =>
      defIdsInHand(s).filter((id) => id !== DRAWN);

    // The seed above picks Mana Well out of the three; the point of the assertion is that the
    // outcome is pinned, not which card it is.
    expect(moved(first)).toEqual([SEEDED_PICK]);
    expect(moved(second)).toEqual([SEEDED_PICK]);
    // It MOVED: one card left the graveyard rather than being copied out of it (R78, §6.3).
    expect(first.pile("p1", "graveyard")).toHaveLength(2);
    expect(first.pile("p1", "graveyard").map((card) => card.defId)).not.toContain(SEEDED_PICK);
  });

  it("base does nothing with an empty graveyard (§8.2 Engine)", () => {
    const s = scenario({
      seed: SEED,
      p1: { field: [GRAVEDIGGER], library: [DRAWN] },
      p2: { hand: [STOCKPILE], library: [STOCKPILE] },
    });

    s.startTurn();

    // Only the turn's draw reached the hand.
    expect(defIdsInHand(s)).toEqual([DRAWN]);
    expect(s.pile("p1", "graveyard")).toEqual([]);
  });

  it("radiant Discovers from the graveyard: the pick lands in hand at 1 less (R50, R65, R78)", () => {
    const s = scenario({
      seed: SEED,
      p1: {
        field: [{ def: GRAVEDIGGER, radiant: true }],
        graveyard: [STOCKPILE, HIT_JOB, MANA_WELL],
        library: [DRAWN],
      },
      p2: { hand: [STOCKPILE], library: [STOCKPILE] },
    });

    s.startTurn();

    // A genuine resolution prompt, not a play-time choice (R81): it opened a PendingChoice.
    const pending = s.state.pending;
    expect(pending, "the radiant face should have opened a Discover").not.toBeNull();
    expect(pending?.kind).toBe("discover");
    expect(pending?.playerId).toBe("p1");
    // R50: the options are the real graveyard instances, not a catalog pool.
    const offered = (pending?.options ?? []).map((option) => option.selection);
    expect(offered).toHaveLength(3);
    for (const selection of offered) expect(selection.pick).toBe("instance");

    s.answer(MANA_WELL);

    const picked = s.card(MANA_WELL);
    s.expectInZone(picked, "hand");
    // R65: "costs 1 less" is a −1 costMod, and R78 keeps it in every zone.
    expect(picked.costMod).toBe(-1);
    expect(effectiveCost(s.state, s.card(picked.id))).toBe(2);
    // The other two are still in the graveyard: Discover moves the pick alone.
    expect(s.pile("p1", "graveyard").map((card) => card.defId).sort()).toEqual([HIT_JOB, STOCKPILE].sort());
  });

  /**
   * KNOWN FAILING, and deliberately so — the assertion states R62's order, not the engine's.
   *
   * R62: "Refresh → start-of-turn delayed effects → start-of-turn triggers → draw". So a
   * start-of-turn trigger that opens a prompt must hold the draw until the prompt is answered and
   * the trigger has run to the end. The engine draws first: the log today is
   *     turnStarted, manaChanged, promptOpened, drawn, addedToHand, promptAnswered, …
   * with the turn's draw landing INSIDE the open prompt. That is the same bug class R62/R113 just
   * fixed at the end of a turn — the end of turn now parks its remainder in `state.work` and the
   * answer finishes it (R122) — still present at the start of one.
   *
   * THE FIX IS NOT IN THIS DIRECTORY: `packages/engine/src/turn.ts`'s `startTurn` runs
   * `queueHooksInTriggerOrder` + `settle` and then `draw` straight through, so a pause inside the
   * trigger queue leaves the draw to run under the prompt. It needs the end of turn's shape: a
   * start-of-turn work item that owes the draw, parked when the triggers pause and resumed by the
   * action that answers (R113, R117, R122). Everything else in this test passes — the resume does
   * happen, the draw does happen and the turn does land in `main`; only the ORDER is wrong.
   */
  it("R62 radiant resumes across the prompt: the draw comes AFTER the start-of-turn trigger", () => {
    const s = scenario({
      seed: SEED,
      p1: {
        field: [{ def: GRAVEDIGGER, radiant: true }],
        graveyard: [STOCKPILE, HIT_JOB, MANA_WELL],
        library: [DRAWN],
      },
      p2: { hand: [STOCKPILE], library: [STOCKPILE] },
    });

    s.startTurn().answer(MANA_WELL);

    expect(s.state.pending).toBeNull();
    expect(s.state.work).toEqual([]);
    // The draw that follows the start-of-turn hook happened, and the picked card is there too.
    expect(defIdsInHand(s).sort()).toEqual([DRAWN, MANA_WELL].sort());
    expect(s.state.phase).toBe("main");
    // R62's order, as a subsequence: the Discover opens, is answered and puts its pick in hand,
    // and only then does the turn draw. Red until `turn.ts` owes the draw to `state.work`.
    s.expectEvents("promptOpened", "promptAnswered", "addedToHand", "drawn", "addedToHand");
  });

  it("radiant does nothing with an empty graveyard: no prompt at all (§6.3)", () => {
    const s = scenario({
      seed: SEED,
      p1: { field: [{ def: GRAVEDIGGER, radiant: true }], library: [DRAWN] },
      p2: { hand: [STOCKPILE], library: [STOCKPILE] },
    });

    s.startTurn();

    expect(s.state.pending).toBeNull();
    expect(defIdsInHand(s)).toEqual([DRAWN]);
  });
});
