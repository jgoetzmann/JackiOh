// #79 Twinspell — SPEC §8.3, R30, §2.2, §6.2 Echo, §10.5 step 6.
//
// BUILD M4-T4: "Next spell echoes once (radiant twice); consumed to GY on use (R30); survives
// cleanup".
//
// The echo count is read through #78 /fullsend, whose "gain 4 mana" makes each resolution a number:
// one extra resolution is +8 instead of +4, two extra is +12. The "fresh prompts per repeat" half of
// §10.5 step 6 is read through #80 Zao Gao, the one Core card whose resolution opens a prompt
// (§10.6), which a declared play-time pick (#26) would not reopen.

import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const TWINSPELL = "core-079";
const FULLSEND = "core-078";
const ZAO_GAO = "core-080";

const LIBRARY = ["core-008", "core-008", "core-008", "core-008"] as const;
const DISCARDABLE = ["core-001", "core-002", "core-003", "core-004"] as const;

/** Harness gap (reported): no `mods()` accessor, so the test reads `state` — B1.7 covers `src` only. */
function echoRiders(s: Scenario): unknown[] {
  return s.state.players.p1.mods.filter((mod) => mod.kind === "echoNextSpell");
}

/** Mana 8, so Twinspell (2) and /fullsend (4) both fit on one turn. */
function withFullsend(radiant: boolean): Scenario {
  return scenario({
    p1: { hand: [{ def: TWINSPELL, radiant }, FULLSEND], mana: 8, library: [...LIBRARY] },
    p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
  });
}

/** Mana 4: Twinspell (2) and Zao Gao (2), with four cards left over to discard. */
function withZaoGao(radiant: boolean): Scenario {
  return scenario({
    p1: { hand: [{ def: TWINSPELL, radiant }, ZAO_GAO, ...DISCARDABLE], library: [...LIBRARY] },
    p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
  });
}

describe("#79 Twinspell — base", () => {
  it("R30 installs an until-used Echo +1 rider naming its own instance", () => {
    const s = withFullsend(false);
    const twin = s.card(TWINSPELL);

    s.play(TWINSPELL);

    // A Field Spell with a Cry is ordinary (#73): it enters the backrow and the Cry fires there.
    s.expectInZone(twin, "field");
    expect(echoRiders(s)).toHaveLength(1);
    expect(s.state.players.p1.mods.find((mod) => mod.kind === "echoNextSpell")).toMatchObject({
      kind: "echoNextSpell",
      amount: 1,
      // §2.2: not turn-scoped, so it waits for a spell rather than for cleanup.
      expiry: { until: "used" },
      // R30: the engine needs to know which card to bury when the rider is consumed.
      sourceId: twin.id,
    });
  });

  it("§2.2 the pending Echo survives end-of-turn cleanup", () => {
    const s = withFullsend(false);
    s.play(TWINSPELL);

    s.endTurn();

    // §2.2 says so in as many words: "Twinspell's pending Echo is not turn-scoped and survives
    // cleanup." BUILD M4-T2's acceptance row says the same of a "this turn" discount's opposite.
    expect(echoRiders(s)).toHaveLength(1);
    s.expectInZone(TWINSPELL, "field");
  });

  it("§10.5 step 6 the next spell resolves one extra time", () => {
    const s = withFullsend(false);
    s.play(TWINSPELL); // 8 − 2 = 6

    s.play(FULLSEND); // 6 − 4 = 2, then 4 mana per resolution

    // Two resolutions of "gain 4 mana": 2 + 8 = 10 rather than 2 + 4 = 6.
    s.expectMana("p1", 10);
  });

  it("R30 Twinspell is consumed to the graveyard when it applies, and the rider is gone", () => {
    const s = withFullsend(false);
    const twin = s.card(TWINSPELL);
    s.play(TWINSPELL);

    s.play(FULLSEND);

    s.expectInZone(twin, "graveyard");
    expect(echoRiders(s)).toHaveLength(0);
  });

  it("R30 only the NEXT spell echoes: a second spell resolves once", () => {
    const s = scenario({
      p1: { hand: [TWINSPELL, FULLSEND, FULLSEND], mana: 12, library: [...LIBRARY] },
      p2: { hand: ["core-005"], field: ["core-019"], library: [...LIBRARY] },
    });
    s.play(TWINSPELL); // 12 − 2 = 10
    s.play(FULLSEND); // 10 − 4 = 6, then +4 per resolution, twice: 14
    s.expectMana("p1", 14);

    // Those two resolutions each installed /fullsend's own rider — §8 row 78, "this turn your
    // cards cost 1 less" — so R65 charges the second copy 4 − 2 = 2, not 4. The number that
    // carries R30 is the GAIN: 4 for one resolution, where an echoed spell would have gained 8.
    expect(s.state.players.p1.mods.filter((mod) => mod.kind === "costDiscount")).toHaveLength(2);

    s.play(FULLSEND); // 14 − 2 = 12, +4 = 16

    s.expectMana("p1", 16);
    // The same fact without the arithmetic: the rider was spent on the first spell, so this one
    // carries no Echo and has exactly one resolution to show for itself (§10.5 step 6).
    expect(s.lastEvents.filter((event) => event.type === "cardResolved")).toHaveLength(1);
    expect(echoRiders(s)).toHaveLength(0);
  });

  it("§10.5 step 6 an echoed prompting spell reopens its prompt on the repeat", () => {
    const s = withZaoGao(false);
    s.play(TWINSPELL);

    s.play(ZAO_GAO);

    // First resolution's hand prompt (§10.6: Zao Gao's chosen discard).
    expect(s.state.pending?.kind).toBe("hand");
    s.answer([DISCARDABLE[0], DISCARDABLE[1]]);
    // The repeat asks again, with fresh options: a prompt, not a play-time declaration.
    expect(s.state.pending?.kind).toBe("hand");
    s.answer([DISCARDABLE[2], DISCARDABLE[3]]);

    expect(s.state.pending).toBeNull();
    // Two resolutions × two Rush Tokens.
    expect(s.state.players.p1.units.filter((pile) => pile !== null)).toHaveLength(4);
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).toContain(DISCARDABLE[3]);
  });
});

describe("#79 Twinspell — radiant", () => {
  it("R30 radiant installs Echo +2", () => {
    const s = withFullsend(true);
    const twin = s.card(TWINSPELL);

    s.play(TWINSPELL);

    expect(s.state.players.p1.mods.find((mod) => mod.kind === "echoNextSpell")).toMatchObject({
      kind: "echoNextSpell",
      amount: 2,
      expiry: { until: "used" },
      sourceId: twin.id,
    });
  });

  it("§10.5 step 6 radiant makes the next spell resolve twice more", () => {
    const s = withFullsend(true);
    s.play(TWINSPELL); // 8 − 2 = 6

    s.play(FULLSEND); // 6 − 4 = 2, three resolutions of +4

    s.expectMana("p1", 14);
  });

  it("R30 radiant is consumed to the graveyard on use and survives cleanup until then", () => {
    const s = withFullsend(true);
    const twin = s.card(TWINSPELL);
    s.play(TWINSPELL);

    s.endTurn();
    expect(echoRiders(s)).toHaveLength(1);
    s.expectInZone(twin, "field");

    // Back around to p1's turn, where the waiting rider is spent.
    s.endTurn();
    s.play(FULLSEND);

    s.expectInZone(twin, "graveyard");
    expect(echoRiders(s)).toHaveLength(0);
  });

  it("§10.5 step 6 radiant reopens a prompting spell's prompt on both repeats", () => {
    const s = scenario({
      p1: {
        hand: [
          { def: TWINSPELL, radiant: true },
          ZAO_GAO,
          ...DISCARDABLE,
          "core-005",
          "core-006",
        ],
        library: [...LIBRARY],
      },
      p2: { hand: ["core-007"], field: ["core-019"], library: [...LIBRARY] },
    });
    s.play(TWINSPELL);

    s.play(ZAO_GAO);

    expect(s.state.pending?.kind).toBe("hand");
    s.answer([DISCARDABLE[0], DISCARDABLE[1]]);
    expect(s.state.pending?.kind).toBe("hand");
    s.answer([DISCARDABLE[2], DISCARDABLE[3]]);
    expect(s.state.pending?.kind).toBe("hand");
    s.answer(["core-005", "core-006"]);

    expect(s.state.pending).toBeNull();
    // R64: three resolutions want six tokens and the unit row holds five.
    expect(s.state.players.p1.units.filter((pile) => pile !== null)).toHaveLength(5);
  });
});
