// #82 KY's Trial (SPEC §8.4 row 82; R54, R60, R65, R247).
//
// BUILD M4-T4's must-pass row: "Three distinct numbers 1–100 never 82 or a token index (R54);
// chosen card is radiant; radiant costs 0".
//
// The three offered options are the whole of R54, and they can be read straight off
// `state.pending.options` without answering anything, so those cases are exact. R247 makes each
// option the number itself — the card's §5 index — so every case reads the options as indices and
// looks the card up in the catalog, as a player looks it up in the collection.

import { describe, expect, it } from "vitest";
import { legalActions, viewFor } from "@jackioh/engine";
import type { ActionBody } from "@jackioh/shared";
import { scenario } from "./_harness";
import { CATALOG } from "../src/catalog-data";

const TRIAL = "core-082";

/** The ten token indices are the ten non-integer ones; R54 forbids every one of them. */
function isNumberedOneToHundred(index: string): boolean {
  return /^\d+$/.test(index) && Number(index) >= 1 && Number(index) <= 100;
}

/** The catalog card a number names (§5: its index), as the collection shows it. */
function cardNumbered(index: string): string | undefined {
  return Object.values(CATALOG).find((def) => def.index === index)?.id;
}

/** The numbers a Discover offered, read out of the prompt the play opened (§10.6, R247). */
function numbers(s: ReturnType<typeof scenario>): string[] {
  const pending = s.state.pending;
  expect(pending).not.toBeNull();
  expect(pending?.kind).toBe("discover");
  return (pending?.options ?? []).map((option) =>
    option.selection.pick === "mode" ? option.selection.option : `not-a-mode:${option.key}`,
  );
}

/** The catalog ids those numbers name. */
function offered(s: ReturnType<typeof scenario>): string[] {
  return numbers(s).map((index) => cardNumbered(index) ?? `no card numbered ${index}`);
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
    const s = trialScenario();

    expect(offered(s)).not.toContain(TRIAL);
    expect(numbers(s)).not.toContain("82");
  });

  it("R74 the chosen card arrives in your hand Radiant", () => {
    const s = trialScenario();
    const pending = s.state.pending;
    const first = pending?.options[0];
    const chosen = cardNumbered(first?.selection.pick === "mode" ? first.selection.option : "") ?? "";

    s.answer(first?.key ?? "");

    const added = s.hand("p1").find((card) => card.defId === chosen);
    expect(added, `no ${chosen} in hand`).toBeDefined();
    expect(added?.radiant).toBe(true);
    s.expectEvents("promptOpened", "promptAnswered", "addedToHand");
  });

  it("base: the card arrives at its printed cost — only the radiant face makes it free (R65)", () => {
    const s = trialScenario();
    const first = s.state.pending?.options[0];
    const chosen = cardNumbered(first?.selection.pick === "mode" ? first.selection.option : "") ?? "";

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
    const chosen = cardNumbered(first?.selection.pick === "mode" ? first.selection.option : "") ?? "";

    s.answer(first?.key ?? "");

    const added = s.hand("p1").find((card) => card.defId === chosen);
    expect(added?.radiant).toBe(true);
    // R65 starts the calculation from `costOverride`, so 0 here is a card that costs 0 in hand and
    // keeps costing 0 in every zone (R78).
    expect(added?.costOverride).toBe(0);
  });
});

describe("#82 KY's Trial — R247, the options are the numbers", () => {
  it("R247 offers three numbers: each option is a card's index, labelled with it and keyed by it", () => {
    const s = trialScenario();
    const options = s.state.pending?.options ?? [];

    expect(options).toHaveLength(3);
    for (const option of options) {
      const index = option.selection.pick === "mode" ? option.selection.option : "";
      expect(isNumberedOneToHundred(index), `${index} is a number from 1 to 100`).toBe(true);
      expect(option.label).toBe(index);
      expect(option.key).toBe(`mode:${index}`);
      // Nothing in the option names a card: neither its key, its label nor its selection.
      expect(JSON.stringify(option)).not.toMatch(/core-/);
    }
  });

  it("R247 the chooser's view shows the numbers and names no card; the other seat sees only that a prompt is open", () => {
    const s = trialScenario();
    const chooser = s.view("p1").pending;
    const watcher = s.view("p2").pending;

    expect(chooser?.forYou).toBe(true);
    if (chooser?.forYou !== true) throw new Error("the chooser has no prompt");
    expect(chooser.kind).toBe("discover");
    expect(chooser.options.map((option) => option.label)).toEqual(numbers(s));
    for (const option of chooser.options) {
      expect(option.defId, `option ${option.key} names no definition`).toBeUndefined();
      expect(option.instanceId).toBeUndefined();
    }
    // §10.6: the other seat learns that a choice is open, and whose.
    expect(watcher).toEqual({ forYou: false, pendingFor: "p1" });
  });

  it("R247 legalActions offers one answer per number, and the answer adds the Radiant card with that index", () => {
    const s = trialScenario(true);
    const choiceId = s.state.pending?.id ?? "";
    const answers = legalActions(s.state, "p1").filter(
      (body): body is Extract<ActionBody, { type: "answer" }> => body.type === "answer" && body.choiceId === choiceId,
    );

    expect(answers.map((body) => body.selection)).toEqual(numbers(s).map((index) => [{ pick: "mode", option: index }]));

    const picked = numbers(s)[2] ?? "";
    s.answer([{ pick: "mode", option: picked }]);

    const added = s.hand("p1").find((card) => card.defId === cardNumbered(picked));
    expect(added, `no card numbered ${picked} in hand`).toBeDefined();
    expect(added?.radiant).toBe(true);
    expect(added?.costOverride).toBe(0);
    expect(viewFor(s.state, "p1").pending).toBeNull();
  });
});
