// `GAME_EVENT_TYPES` is the list BUILD M5-T4's animation table is checked against, so the list
// itself has to be provably complete. Two things could make it lie, and this file closes both:
//
//   1. a MISSING member. `as const satisfies readonly GameEventType[]` in src/events.ts is a
//      subset check — it rejects a string that is not an event type and is silent about an event
//      type that is not in the array. `GameEventTypesAreExhaustive` (same file) makes that a
//      compile error, but `vitest run` does not typecheck, so the test below re-derives the union
//      from the SOURCE of `events.ts` and compares. Add a member to `GameEvent` without touching
//      the array and this file goes red, in `pnpm test` as well as in `pnpm typecheck`.
//   2. a DUPLICATE. Neither `satisfies` nor `Exclude` notices one, and a duplicate would inflate
//      the count `apps/web/src/game/animations.test.ts` asserts.
//
// Reading source text in a test is deliberate. The union is types only: it has no runtime value to
// enumerate, so the only independent witness of its members is the file it is written in.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { GAME_EVENT_TYPES } from "../src/events";

const SOURCE = readFileSync(fileURLToPath(new URL("../src/events.ts", import.meta.url)), "utf8");

/**
 * The `GameEvent` union's own text: everything between its declaration and the semicolon that
 * ends it. Block comments are stripped first, so prose inside the union cannot be mistaken for a
 * member.
 */
function unionBody(): string {
  const start = SOURCE.indexOf("export type GameEvent =");
  expect(start, "events.ts no longer declares `export type GameEvent =`").toBeGreaterThanOrEqual(0);
  const end = SOURCE.indexOf("export type GameEventType", start);
  expect(end, "events.ts no longer declares `export type GameEventType`").toBeGreaterThan(start);
  return SOURCE.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

/** Every `type: "…"` discriminant in the union, in source order. */
function declaredTypes(): string[] {
  return [...unionBody().matchAll(/\btype:\s*"([^"]+)"/g)].map((match) => match[1] as string);
}

describe("GAME_EVENT_TYPES", () => {
  it("lists every member of the GameEvent union — no member may be missing", () => {
    const declared = declaredTypes();
    // A parse that found nothing must fail loudly rather than agree with an empty expectation.
    expect(declared.length, "no discriminants parsed out of the GameEvent union").toBeGreaterThan(0);

    const listed = new Set<string>(GAME_EVENT_TYPES);
    const missing = declared.filter((type) => !listed.has(type));
    expect(
      missing,
      `packages/shared/src/events.ts declares these GameEvent types but GAME_EVENT_TYPES does not ` +
        `list them: ${missing.join(", ")}. Add them there and give each a row in ` +
        `apps/web/src/game/animations.ts (BUILD M5-T4).`,
    ).toEqual([]);
  });

  it("lists nothing the union does not declare, and lists nothing twice", () => {
    const declared = new Set(declaredTypes());
    const extra = [...GAME_EVENT_TYPES].filter((type) => !declared.has(type));
    expect(extra, `GAME_EVENT_TYPES names types the union does not declare: ${extra.join(", ")}`).toEqual([]);

    const seen = new Set<string>();
    const duplicates = [...GAME_EVENT_TYPES].filter((type) => (seen.has(type) ? true : (seen.add(type), false)));
    expect(duplicates, `GAME_EVENT_TYPES repeats: ${duplicates.join(", ")}`).toEqual([]);
    expect(GAME_EVENT_TYPES).toHaveLength(seen.size);
  });

  it("agrees with SPEC §10.3's count, which BUILD M5-T4's table has one row for each of", () => {
    // 43 is the number of rows in BUILD M5-T4's table (41, and R315's `fatigue` and R316's
    // `libraryOverflow`); the two tests above make this a count of the union itself rather than a
    // count of the array copied from it.
    expect(declaredTypes()).toHaveLength(43);
    expect(GAME_EVENT_TYPES).toHaveLength(43);
  });
});
