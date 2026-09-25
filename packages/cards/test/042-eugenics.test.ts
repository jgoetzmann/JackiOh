// #42 Eugenics (SPEC §8.2, §5.2, §6.1 Lucky, §10.7; R60, R80).
//
// The must-pass row (BUILD M4-T4 #42): "8 random exiled (all if fewer); 30% per remaining card;
// radiant two rolls at 40%."
//
// Exact per-seed outcomes are not asserted here, and deliberately so: the two verbs this card needs
// (`exileRandomFromLibrary`, `radiantChance`) are not in the effects library yet, so there is no
// implementation whose draw order an expected number could be read off — a hard-coded count would
// be a guess that locks the engine into whatever the guess was. What IS pinned down instead:
//   * the counts the §8 row states (8, or the whole library when smaller);
//   * that the roll is PER CARD and independent, proved with a 58-card library where "one roll for
//     the zone" or "all or nothing" would land on 0 or 50 and an independent 30% cannot;
//   * that the exiled cards are never rolled;
//   * determinism: the same seed and the same steps give the same pattern of flags (§9.3);
//   * that the radiant face rolls exactly one extra time per remaining card, which is what Lucky 1
//     means (§6.1) and is a count, not a probability.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base as eugenicsBase, radiant as eugenicsRadiant } from "../src/scripts/042-eugenics";

/**
 * A library of `n` identical non-Radiant, non-token cards. Identity is irrelevant to every clause
 * of this card — only the counts and the flags are — and #25 4-mana 7/7 has no script at all, so
 * nothing in the library can react to being exiled. R80 caps a library at 60.
 */
function library(n: number): string[] {
  return Array.from({ length: n }, () => "core-025");
}

/** p1 casts Eugenics; #21 Hinder rides along so the turn does not auto-end after it (R82). */
function cast(librarySize: number, seed = "eugenics"): ReturnType<typeof scenario> {
  return scenario({
    seed,
    p1: { hand: ["core-042", "core-021"], library: library(librarySize) },
  }).play("core-042");
}

/** The radiant face has to be flagged in hand: the builder only takes `radiant` on the board. */
function castRadiant(librarySize: number, seed = "eugenics"): ReturnType<typeof scenario> {
  const s = scenario({
    seed,
    p1: { hand: ["core-042", "core-021"], library: library(librarySize) },
  });
  s.card("core-042").radiant = true;
  return s.play("core-042");
}

/** The effects a face returns, by `kind`. Neither hook reads its context, so a stub is enough. */
function effectKinds(hook: typeof eugenicsBase.cry): string[] {
  if (hook === undefined) return [];
  const stub = undefined as unknown as Parameters<typeof hook>[0];
  return hook(stub).map((effect) => effect.kind);
}

function radiantFlags(s: ReturnType<typeof scenario>): boolean[] {
  return s.pile("p1", "library").map((card) => card.radiant);
}

describe("#42 Eugenics — base", () => {
  it("exiles 8 random cards from your library", () => {
    const s = cast(12);

    expect(s.pile("p1", "exile")).toHaveLength(8);
    expect(s.pile("p1", "library")).toHaveLength(4);
  });

  it("R60 exiles the whole library when it holds fewer than 8 (§8.2 Engine: 'fewer than 8 → exile all')", () => {
    const s = cast(5);

    expect(s.pile("p1", "exile")).toHaveLength(5);
    expect(s.pile("p1", "library")).toHaveLength(0);
  });

  it("an empty library exiles nothing and the spell still counts as played (§8 Conventions)", () => {
    const s = cast(0);

    expect(s.pile("p1", "exile")).toHaveLength(0);
    s.expectEvents("cardPlayed");
    s.expectInZone("core-042", "graveyard");
  });

  it("rolls 'each remaining library card' independently at 30%, so neither 0 nor all 50 come up", () => {
    const s = cast(58);
    const remaining = s.pile("p1", "library");

    expect(remaining).toHaveLength(50);
    const converted = remaining.filter((card) => card.radiant).length;
    // One roll for the whole zone would give 0 or 50; 50 independent 30% rolls give neither.
    expect(converted).toBeGreaterThan(0);
    expect(converted).toBeLessThan(50);
  });

  it("R60 the exiled cards are never rolled: the exile happens first, the chance rolls over what is left", () => {
    const s = cast(58);

    expect(s.pile("p1", "exile")).toHaveLength(8);
    expect(s.pile("p1", "exile").every((card) => !card.radiant)).toBe(true);
  });

  it("§9.3 is deterministic: the same seed and steps give the same flags", () => {
    expect(radiantFlags(cast(58, "eugenics-determinism"))).toEqual(
      radiantFlags(cast(58, "eugenics-determinism")),
    );
  });

  it("§10.9 the base face is one exile effect followed by one chance effect, in that order", () => {
    expect(effectKinds(eugenicsBase.cry)).toEqual(["exileRandomFromLibrary", "radiantChance"]);
  });
});

describe("#42 Eugenics — radiant", () => {
  it("§8 Conventions: the unrestated clause is kept, so it still exiles 8", () => {
    const s = castRadiant(12);

    expect(s.pile("p1", "exile")).toHaveLength(8);
    expect(s.pile("p1", "library")).toHaveLength(4);
  });

  it("R60 the exiled cards are still never rolled", () => {
    const s = castRadiant(58);

    expect(s.pile("p1", "exile")).toHaveLength(8);
    expect(s.pile("p1", "exile").every((card) => !card.radiant)).toBe(true);
  });

  it("rolls per remaining card at 40% with Lucky 1, so neither 0 nor all 50 come up", () => {
    const s = castRadiant(58);
    const remaining = s.pile("p1", "library");

    expect(remaining).toHaveLength(50);
    const converted = remaining.filter((card) => card.radiant).length;
    expect(converted).toBeGreaterThan(0);
    expect(converted).toBeLessThan(50);
  });

  it("§6.1 Lucky 1 is exactly one extra roll per remaining card: 50 more draws than the base face", () => {
    // Same seed and same library, so the exile step consumes the same draws in both runs and the
    // whole difference in `rngCursor` is the second roll Lucky 1 takes for each remaining card.
    const plain = cast(58, "eugenics-lucky");
    const lucky = castRadiant(58, "eugenics-lucky");

    expect(lucky.state.rngCursor - plain.state.rngCursor).toBe(50);
  });

  it("§9.3 is deterministic: the same seed and steps give the same flags", () => {
    expect(radiantFlags(castRadiant(58, "eugenics-r-determinism"))).toEqual(
      radiantFlags(castRadiant(58, "eugenics-r-determinism")),
    );
  });

  it("§10.9 the radiant face is the same pair of effects, so only the numbers changed", () => {
    expect(effectKinds(eugenicsRadiant.cry)).toEqual(["exileRandomFromLibrary", "radiantChance"]);
  });
});

describe("#42 Eugenics — R311 the owner's library list", () => {
  it("R311 a card rolled Radiant inside the library is still listed with the face it went in with", () => {
    const s = cast(58);
    const remaining = s.pile("p1", "library");
    expect(remaining.some((card) => card.radiant)).toBe(true);

    // The rolls happened where nobody reads them (R177), so the list shows none of them.
    expect(s.view("p1").you.library).toEqual({
      cards: [{ defId: "core-025", radiant: false, count: remaining.length }],
      unknown: 0,
    });
  });
});
