// #72 Reminisce — SPEC §8.3, BUILD M4-T4: "Discover from the GY including spell tokens (R50);
// chosen card −1 (radiant 0); exiled; empty GY → nothing".
//
// The card under test is a two-step script (§10.6): the Cry opens the Discover and parks "exile
// this" as a work item, and the answer runs the `chosen` resume step and then drains the parked
// tail. So every test here asserts BOTH halves — where the picked card went and what its cost is,
// and that Reminisce itself ended in exile — and one test covers each of the two paths through the
// Cry's single effect list: the prompt opened (tail parked), and the graveyard was empty (tail ran
// straight through, resume step never reached).
//
// core-013 Jlockeed Shredder-10 (printed cost 3) is the Discover subject in the cost tests on both
// faces, so the base "-1" (cost 2) and the radiant "costs 0" are the same card read two ways.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

function costsChanged(s: Scenario): { instanceId: string; cost: number }[] {
  return s.events.flatMap((event) => (event.type === "costChanged" ? [event] : []));
}

describe("#72 Reminisce (base)", () => {
  it("R50 Discovers from the ACTUAL graveyard, so a spell token there is an eligible option", () => {
    const s = scenario({
      seed: "core-072-r50",
      p1: {
        hand: ["core-072"],
        // core-051-1 is KY's Empty Notebook, a spell token (§7). A pool-based Discover would
        // exclude it; R50 says this one does not, because it discovers "a card in your GY".
        graveyard: ["core-051-1", "core-005", "core-023"],
        library: ["core-035"],
      },
      p2: { hand: ["core-005"] },
    });
    const graveyard = s.pile("p1", "graveyard");
    const token = graveyard[0];
    expect(token?.defId).toBe("core-051-1");

    s.play("core-072");

    const pending = s.state.pending;
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("discover");
    expect(pending?.playerId).toBe("p1");
    // Drawn without replacement from a graveyard of exactly three: all three, each once.
    expect(pending?.options).toHaveLength(3);
    const offered = pending?.options.map((option) =>
      option.selection.pick === "instance" ? option.selection.instanceId : null,
    );
    expect(offered).toContain(token?.id);
    expect(new Set(offered).size).toBe(3);

    s.answer(token!.id);

    s.expectInZone(token!, "hand");
    expect(s.hand("p1").map((card) => card.defId)).toContain("core-051-1");
  });

  it("the chosen card moves GY → hand and costs 1 less, and Reminisce is exiled", () => {
    const s = scenario({
      seed: "core-072-base-cost",
      p1: { hand: ["core-072"], graveyard: ["core-013"], library: ["core-035"] },
      p2: { hand: ["core-005"] },
    });
    const spell = s.hand("p1")[0];
    const picked = s.pile("p1", "graveyard")[0];
    expect(spell?.defId).toBe("core-072");
    expect(picked?.defId).toBe("core-013");

    s.play("core-072").answer(picked!.id);

    // GY → hand (§8.3 Engine cell).
    s.expectInZone(picked!, "hand");
    // R65: printed 3 plus a costMod of −1 is 2, and the mod travels with the card (R78).
    expect(s.card(picked!).costMod).toBe(-1);
    expect(s.card(picked!).costOverride).toBeUndefined();
    expect(costsChanged(s).at(-1)).toEqual({ type: "costChanged", instanceId: picked!.id, cost: 2 });
    // "Exile this" — not the graveyard every other Spell goes to (§10.5 step 7).
    s.expectInZone(spell!, "exile");
  });

  it("§10.6: the sequence spanning the prompt resumes in order — pick to hand, cost changed, then the parked exile", () => {
    const s = scenario({
      seed: "core-072-resume-order",
      p1: { hand: ["core-072"], graveyard: ["core-013"], library: ["core-035"] },
      p2: { hand: ["core-005"] },
    });
    const picked = s.pile("p1", "graveyard")[0];

    s.play("core-072");
    // The prompt paused the Cry's list: "exile this" has NOT happened yet. (A Spell mid-resolution
    // sits in the `resolving` zone, which `ZoneName` does not name, so this reads the exile pile.)
    expect(s.state.pending).not.toBeNull();
    expect(s.pile("p1", "exile")).toHaveLength(0);

    s.answer(picked!.id);

    s.expectEvents("cardPlayed", "promptOpened", "promptAnswered", "addedToHand", "costChanged", "exiled");
  });

  it("an empty graveyard opens no prompt and does nothing, and the spell is still exiled", () => {
    const s = scenario({
      seed: "core-072-empty-gy",
      p1: { hand: ["core-072", "core-005"], graveyard: [], library: ["core-035"] },
      p2: { hand: ["core-005"] },
    });
    const spell = s.hand("p1")[0];

    s.play("core-072");

    // §6.3: an effect with nothing to offer fizzles and the card still resolves.
    expect(s.state.pending).toBeNull();
    // The resume step never ran, so nothing reached the hand; only core-005 is left there.
    expect(s.hand("p1").map((card) => card.defId)).toEqual(["core-005"]);
    // The parked tail was never parked: it ran straight through in the same pass.
    s.expectInZone(spell!, "exile");
    s.expectEvents("cardPlayed", "exiled");
  });

  it("R4: a card the Discover picks into a full hand is burned to the graveyard", () => {
    // Eleven cards in hand, so playing Reminisce leaves exactly HAND_CAP (10) behind it.
    const s = scenario({
      seed: "core-072-hand-cap",
      p1: {
        hand: [
          "core-072",
          "core-005",
          "core-023",
          "core-031",
          "core-035",
          "core-036",
          "core-013",
          "core-019",
          "core-043",
          "core-054",
          "core-066",
        ],
        graveyard: ["core-002"],
        library: ["core-088"],
      },
      p2: { hand: ["core-005"] },
    });
    const picked = s.pile("p1", "graveyard")[0];
    expect(s.hand("p1")).toHaveLength(11);

    s.play("core-072").answer(picked!.id);

    expect(s.hand("p1")).toHaveLength(10);
    s.expectEvents("burned");
    // Burned means back to the graveyard it came from, not the hand.
    s.expectInZone(picked!, "graveyard");
  });
});

describe("#72 Reminisce (radiant)", () => {
  it("radiant: the chosen card costs 0, not one less", () => {
    const s = scenario({
      seed: "core-072-radiant-cost",
      p1: {
        hand: [{ def: "core-072", radiant: true }],
        graveyard: ["core-013"],
        library: ["core-035"],
      },
      p2: { hand: ["core-005"] },
    });
    const spell = s.hand("p1")[0];
    const picked = s.pile("p1", "graveyard")[0];
    expect(spell?.radiant).toBe(true);

    s.play("core-072").answer(picked!.id);

    s.expectInZone(picked!, "hand");
    // R65/R77: "it costs 0" is a costOverride, the same reading Craft a Card's 0-cost card gets.
    expect(s.card(picked!).costOverride).toBe(0);
    expect(s.card(picked!).costMod).toBe(0);
    expect(costsChanged(s).at(-1)).toEqual({ type: "costChanged", instanceId: picked!.id, cost: 0 });
    s.expectInZone(spell!, "exile");
  });

  it("radiant keeps the Discover, R50's token eligibility and the self-exile (§8 Conventions)", () => {
    const s = scenario({
      seed: "core-072-radiant-r50",
      p1: {
        hand: [{ def: "core-072", radiant: true }],
        graveyard: ["core-051-1"],
        library: ["core-035"],
      },
      p2: { hand: ["core-005"] },
    });
    const spell = s.hand("p1")[0];
    const token = s.pile("p1", "graveyard")[0];

    s.play("core-072");
    expect(s.state.pending?.kind).toBe("discover");
    expect(s.state.pending?.options).toHaveLength(1);

    s.answer(token!.id);

    s.expectInZone(token!, "hand");
    expect(s.card(token!).costOverride).toBe(0);
    s.expectInZone(spell!, "exile");
  });

  it("radiant on an empty graveyard also does nothing but still exiles the spell", () => {
    const s = scenario({
      seed: "core-072-radiant-empty",
      p1: { hand: [{ def: "core-072", radiant: true }, "core-005"], graveyard: [], library: ["core-035"] },
      p2: { hand: ["core-005"] },
    });
    const spell = s.hand("p1")[0];

    s.play("core-072");

    expect(s.state.pending).toBeNull();
    s.expectInZone(spell!, "exile");
    expect(s.hand("p1").map((card) => card.defId)).toEqual(["core-005"]);
  });
});
