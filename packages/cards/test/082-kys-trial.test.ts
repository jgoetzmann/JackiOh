// #82 KY's Trial (SPEC §8.4 row 82; R54, R60, R65).
//
// BUILD M4-T4's must-pass row: "Three distinct numbers 1–100 never 82 or a token index (R54);
// chosen card is radiant; radiant costs 0".
//
// The three offered options are the whole of R54, and they can be read straight off
// `state.pending.options` without answering anything, so those cases are exact.
//
// RED UNTIL `reduce` WIRES PROMPTS (not a card gap): `reduce.ts`'s `answer` case still returns
// "prompts arrive with M3" even though `prompts.ts`'s `answerPrompt` is written, so every case below
// that calls `answer()` throws today. They are written as real tests rather than `it.todo` because
// the card's `resume` step is what they cover and nothing in this card has to change for them to go
// green — see the agent report.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { CATALOG } from "../src/catalog-data";

const TRIAL = "core-082";

/** The ten token indices are the ten non-integer ones; R54 forbids every one of them. */
function isNumberedOneToHundred(index: string): boolean {
  return /^\d+$/.test(index) && Number(index) >= 1 && Number(index) <= 100;
}

/** The catalog ids a Discover offered, read out of the prompt the play opened (§10.6). */
function offered(s: ReturnType<typeof scenario>): string[] {
  const pending = s.state.pending;
  expect(pending).not.toBeNull();
  expect(pending?.kind).toBe("discover");
  return (pending?.options ?? []).map((option) =>
    option.selection.pick === "mode" ? option.selection.option : `not-a-mode:${option.key}`,
  );
}

function trialScenario(radiantFace = false) {
  const s = scenario({ seed: "kys-trial", p1: { hand: [TRIAL] } });
  // Stands in for a missing `{ def, radiant }` form on SideSetup.hand (harness request).
  if (radiantFace) s.card(TRIAL).radiant = true;
  return s.play(TRIAL);
}

describe("#82 KY's Trial — base", () => {
  it("R54 Discovers among 3 numbers 1–100: three distinct Core cards, no token index", () => {
    const ids = offered(trialScenario());

    expect(ids).toHaveLength(3);
    // R60: "Discover options are always different".
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      const def = CATALOG[id];
      expect(def, `${id} is not a catalog card`).toBeDefined();
      expect(def?.set).toBe("Core");
      // R54 "never a token index", which §5.1 gives for free: no Token def, tag or rarity.
      expect(def?.token).toBe(false);
      expect(def?.tags).not.toContain("Token");
      expect(def?.rarity).not.toBe("Token");
      // R54 "rolls 1–100 only".
      expect(isNumberedOneToHundred(def?.index ?? "")).toBe(true);
    }
  });

  it("R54 rerolls its own index: #82 is never one of the three", () => {
    const ids = offered(trialScenario());

    expect(ids).not.toContain(TRIAL);
    expect(ids.map((id) => CATALOG[id]?.index)).not.toContain("82");
  });

  it("R74 the chosen card arrives in your hand Radiant", () => {
    const s = trialScenario();
    const pending = s.state.pending;
    const first = pending?.options[0];
    const chosen = first?.selection.pick === "mode" ? first.selection.option : "";

    s.answer(first?.key ?? "");

    const added = s.hand("p1").find((card) => card.defId === chosen);
    expect(added, `no ${chosen} in hand`).toBeDefined();
    expect(added?.radiant).toBe(true);
    s.expectEvents("promptOpened", "promptAnswered", "addedToHand");
  });

  it("base: the card arrives at its printed cost — only the radiant face makes it free (R65)", () => {
    const s = trialScenario();
    const first = s.state.pending?.options[0];
    const chosen = first?.selection.pick === "mode" ? first.selection.option : "";

    s.answer(first?.key ?? "");

    expect(s.hand("p1").find((card) => card.defId === chosen)?.costOverride).toBeUndefined();
  });
});

describe("#82 KY's Trial — radiant", () => {
  it("R54 the radiant face Discovers from the same pool: 3 distinct, never #82, never a token", () => {
    const ids = offered(trialScenario(true));

    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(ids).not.toContain(TRIAL);
    for (const id of ids) expect(isNumberedOneToHundred(CATALOG[id]?.index ?? "")).toBe(true);
  });

  it("'It costs 0' (R65): the card the Discover adds is Radiant and carries a 0 cost override", () => {
    const s = trialScenario(true);
    const first = s.state.pending?.options[0];
    const chosen = first?.selection.pick === "mode" ? first.selection.option : "";

    s.answer(first?.key ?? "");

    const added = s.hand("p1").find((card) => card.defId === chosen);
    expect(added?.radiant).toBe(true);
    // R65 starts the calculation from `costOverride`, so 0 here is a card that costs 0 in hand and
    // keeps costing 0 in every zone (R78).
    expect(added?.costOverride).toBe(0);
  });
});
