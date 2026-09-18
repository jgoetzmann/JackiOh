// SPEC §11, every row: the single index BUILD's M3 gate asks for and REVIEW's B4 check greps by
// name. One `it("R<n> …")` per §11 row, R1 to R155, in order.
//
// Two kinds of test live here. A row whose ruling is a number asserts that number against
// `config.ts` — the seven "decide" rows (R1, R2, R4, R5, R14, R26, R39) among them, which B4
// requires to be named constants there. Every other row delegates: the comment above it names the
// file and the test that does the work with fixtures, and the body asserts that the named file
// still carries a test for the row, so the index goes red if a proof is renamed away or deleted.
// Rows whose subject is a card M4 has yet to build say so in the comment: the engine test proves
// the machinery, the card test will prove the card (BUILD M3 gate, M4-T4).
//
// R104 to R112 are server rulings, and B4 greps only this file and `packages/cards/test`, so their
// index rows stay here: they delegate to `apps/server`'s own evidence where there is some and
// assert the constant §11 fixes where there is not (R107, R108, R109 are `config.ts` values with no
// database behaviour, proved at the server level by BUILD M6-T1, M7-T1 and M7-T3).
//
// The index imports `config.ts` and nothing else from the engine on purpose: it must stay green
// while the modules it points at are edited, so a red test here always means a missing proof.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as config from "../src/config";

const titleCache = new Map<string, readonly string[]>();
const sourceCache = new Map<string, string>();

/**
 * One proof file's text. The path is resolved against this directory, so a sibling test file is a
 * bare name and a proof outside `packages/engine/test` is a relative path — `apps/server`'s SQL
 * evidence scripts and vitest files included. Nothing is imported: the index must not make
 * `packages/engine` depend on `apps/server`.
 */
function sourceOf(file: string): string {
  const cached = sourceCache.get(file);
  if (cached !== undefined) return cached;
  let source: string;
  try {
    source = readFileSync(new URL(file, import.meta.url), "utf8");
  } catch {
    source = ""; // A missing file reads as no proofs, so `provenIn` names the row it cannot find.
  }
  sourceCache.set(file, source);
  return source;
}

/** Every `R<n> …` test title in a sibling test file, read once. A title may name two rows. */
function rulingTitles(file: string): readonly string[] {
  const cached = titleCache.get(file);
  if (cached !== undefined) return cached;
  const titles = [...sourceOf(file).matchAll(/\bit\(\s*"(R\d+[^"]*)"/g)].map((match) => match[1] ?? "");
  titleCache.set(file, titles);
  return titles;
}

/**
 * Every *heading* an SQL evidence script announces a check with: `\echo '### … ###'` or
 * `\echo '=== … ==='`, as the text between the delimiters.
 *
 * Only a heading counts. `apps/server/test/sql/03_match_lifecycle.sql`'s own header states the
 * contract ("that heading form is the signal; a bare mention in prose is not"), and it exists
 * because that file *names* R107, R108 and R109 in a comment in order to record that it
 * deliberately does **not** prove them — they are `config.ts` values with no database behaviour.
 * A substring search over the file would therefore credit exactly the three rows it disclaims, so
 * neither comments nor the `-- …` prose `\echo`s between checks are read. `sqlHeadingsCredit`
 * below is the test that keeps this honest.
 */
function sqlHeadings(file: string): readonly string[] {
  return [...sourceOf(file).matchAll(/\\echo\s*'\s*(?:###|===)\s*([^']*?)\s*(?:###|===)?\s*'/g)].map(
    (match) => match[1] ?? "",
  );
}

/**
 * The headings of one SQL file that name this row. A heading names a row by writing the id where a
 * name goes — `### R104: …` or `=== CHECK 15 (R105): …` — so the id is followed by `:` or `)`.
 */
function sqlProofs(file: string, row: number): readonly string[] {
  const names = new RegExp(`\\bR${row}(?![0-9])\\s*[:)]`);
  return sqlHeadings(file).filter((heading) => names.test(heading));
}

/**
 * Every proof of this row in one file, in that file's own idiom for a test name:
 *   * a sibling engine test leads with the row (`it("R<n> …")`), which is this file's convention;
 *   * a vitest file elsewhere may also put it mid-title or at the end (`it("… (R112)")`), or name
 *     it on the `describe` that heads the group of tests proving it (`describe("R143 — …")`) — the
 *     same heading idea as the SQL scripts, one level up from the individual case;
 *   * an SQL evidence script announces it as a heading, per `sqlHeadings`.
 */
function proofsFor(file: string, row: number): readonly string[] {
  if (file.endsWith(".sql")) return sqlProofs(file, row);

  const leads = new RegExp(`^R${row}(?![0-9])`);
  const strict = rulingTitles(file).filter((title) => leads.test(title));
  if (strict.length > 0 || !file.includes("/")) return strict;

  const names = new RegExp(`\\bR${row}(?![0-9])`);
  return [...sourceOf(file).matchAll(/\b(?:it|describe)\(\s*"([^"]*)"/g)]
    .map((match) => match[1] ?? "")
    .filter((title) => names.test(title));
}

/** The row is proved by a test named after it in each file listed. */
function provenIn(row: number, ...files: readonly string[]): void {
  for (const file of files) {
    expect(proofsFor(file, row), `${file} carries no test named after R${row}`).not.toEqual([]);
  }
}

/** `apps/server/src/config.ts`, whose constants R104 to R109 fix. */
const SERVER_CONFIG = "../../../apps/server/src/config.ts";
/** `apps/server`'s SQL evidence for the rulings its schema implements (BUILD M6-T1). */
const SERVER_SQL = "../../../apps/server/test/sql/03_match_lifecycle.sql";
/** The schema-invariant checks, which prove R105 a second way (BUILD M6-T1). */
const SERVER_SCHEMA_SQL = "../../../apps/server/test/sql/01_schema_invariants.sql";
/** The server modules R137 and R145 to R149 fix a number or a shape in (BUILD M7). */
const SERVER_ACTOR = "../../../apps/server/src/match/actor.ts";
const SERVER_CLOCK = "../../../apps/server/src/match/clock.ts";
const SERVER_WS = "../../../apps/server/src/match/wsServer.ts";
const SERVER_ROOMS = "../../../apps/server/src/match/rooms.ts";
const SERVER_CODES = "../../../apps/server/src/api/codes.ts";
const SERVER_RESULTS = "../../../apps/server/src/api/results.ts";
/** The end-to-end-mode server tests, which name R143 and R144 on their `describe`s. */
const SERVER_E2E_TEST = "../../../apps/server/test/api/e2e.test.ts";
/** The migrations R105, R110, R111 and R112 live in (BUILD M6-T2, M7-T2). */
const SERVER_INVITES_SQL = "../../../apps/server/src/db/migrations/0001_profiles_and_invites.sql";
const SERVER_COLLECTION_SQL = "../../../apps/server/src/db/migrations/0002_collection.sql";
const SERVER_MATCHES_SQL = "../../../apps/server/src/db/migrations/0004_matches.sql";
const SERVER_LOADOUTS_SQL = "../../../apps/server/src/db/migrations/0003_loadouts.sql";

/**
 * The literal an `export const NAME = …` declares in a server source file, as written. Read rather
 * than imported for the reason `sourceOf` gives; `null` when the file has no such constant, so a
 * renamed constant reads as a missing value instead of a silent pass.
 */
function serverConstant(file: string, name: string): string | null {
  const found = new RegExp(`^export const ${name} = ([^;]+);`, "m").exec(sourceOf(file));
  return found?.[1]?.trim() ?? null;
}

describe("SPEC §11 rulings R1–R155 (BUILD M3 gate, REVIEW B4)", () => {
  // Proved by rulings-a.test.ts "R1 fires Cry only on a play from hand or a cast, never on a summon, Recruit
  // or Transform"; effects-summon.test.ts "R1 fires no Cry".
  it("R1 fires Cry only on a play from hand or a cast", () => {
    expect(config.CRY_ON_PLAY_ONLY).toBe(true);
    provenIn(1, "rulings-a.test.ts", "effects-summon.test.ts");
  });

  // Proved by rulings-a.test.ts "R2 counts the cap in player-turns: 30 turns, 15 each, then the game is a
  // draw".
  it("R2 counts the turn cap in player-turns: 30, so 15 each", () => {
    expect(config.TURN_CAP_PLAYER_TURNS).toBe(30);
    expect(config.TURN_CAP_PLAYER_TURNS / 2).toBe(15);
    provenIn(2, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R3 makes the Nth draw from an empty library deal N damage to that hero";
  // config.test.ts "R3 fatigue deals N on the Nth empty draw".
  it("R3 deals N damage on the Nth draw from an empty library", () => {
    expect([1, 2, 3, 4].map(config.FATIGUE_DAMAGE)).toEqual([1, 2, 3, 4]);
    provenIn(3, "rulings-a.test.ts", "config.test.ts");
  });

  // Proved by rulings-a.test.ts "R4 caps the hand at 10 and burns an extra draw to the graveyard";
  // callToChaos.test.ts "R4 a full hand burns what the draw and the added cards cannot fit".
  it("R4 caps the hand at 10 and burns the overflow to the graveyard", () => {
    expect(config.HAND_CAP).toBe(10);
    provenIn(4, "rulings-a.test.ts", "callToChaos.test.ts");
  });

  // Proved by rulings-a.test.ts "R5 does not restrict attacks by lane: any unit may attack any enemy unit or
  // the hero"; combat-validation.test.ts "R5 lets a lane-1 unit attack an enemy in lane 5, since attacks
  // are not lane-restricted".
  it("R5 does not restrict attacks by lane", () => {
    expect(config.LANE_RESTRICTED_ATTACKS).toBe(false);
    provenIn(5, "rulings-a.test.ts", "combat-validation.test.ts");
  });

  // Proved by rulings-a.test.ts "R6 refuses an attack from Defense Position, and switching to Attack spends
  // the exertion"; combat-positions.test.ts "R6 a unit that switched position cannot attack that turn".
  it("R6 refuses an attack from Defense Position, and a switch spends the turn's exertion", () => {
    provenIn(6, "rulings-a.test.ts", "combat-positions.test.ts");
  });

  // Proved by rulings-a.test.ts "R7 refuses an attack declared by a 0-attack unit"; combat-validation.test.ts
  // "R7 refuses a unit with 0 attack", "R7 never lets Big D-fender (0 attack) be an attacker".
  it("R7 refuses an attack declared by a 0-attack unit", () => {
    provenIn(7, "rulings-a.test.ts", "combat-validation.test.ts");
  });

  // Proved by rulings-a.test.ts "R8 fires Death on both deaths of a Reborn unit"; statecheck.test.ts "R8,
  // R64: a Reborn unit reserves its zone, a Death-trigger summon lands elsewhere, and Death fires on both
  // deaths".
  it("R8 fires Death on both deaths of a Reborn unit", () => {
    provenIn(8, "rulings-a.test.ts", "statecheck.test.ts");
  });

  // Proved by rulings-a.test.ts "R9 draws the mulligan replacements before the returned cards are shuffled
  // back in"; setup.test.ts "R9: replacements are drawn before the returned cards are shuffled back".
  it("R9 draws the mulligan replacements before shuffling the returned cards back in", () => {
    expect(config.MULLIGAN_ORDER).toBe("draw-then-shuffle");
    provenIn(9, "rulings-a.test.ts", "setup.test.ts");
  });

  // Proved by rulings-a.test.ts "R10 gives the first player their turn-1 draw".
  it("R10 gives the first player their turn-1 draw", () => {
    provenIn(10, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R11 vanishes a unit token off the field while a spell token reaches the
  // graveyard"; effects-destroy.test.ts "R11 a destroyed unit token vanishes and reaches no graveyard",
  // "R11 a sacrificed unit token vanishes and enters no graveyard"; effects-move.test.ts "R11 an exiled
  // unit token vanishes and never enters the exile pile", "R11 a bounced unit token vanishes instead of
  // reaching a hand", and 2 more.
  it("R11 vanishes a unit token that leaves the field, while a spell token reaches the graveyard", () => {
    provenIn(11, "rulings-a.test.ts", "effects-destroy.test.ts", "effects-move.test.ts");
  });

  // Proved by rulings-a.test.ts "R12 keeps ownership off the field: a stolen unit dies to its owner's
  // graveyard"; effects-steal.test.ts "R12 keeps the owner, so a stolen unit that dies goes to its owner's
  // graveyard"; effects-move.test.ts "R12 a stolen unit is exiled to its owner's pile", "R12 a stolen unit
  // bounces to its owner's hand, not the controller's", and 1 more.
  it("R12 keeps hand, library, graveyard and exile with the owner, control only on the field", () => {
    provenIn(12, "rulings-a.test.ts", "effects-steal.test.ts", "effects-move.test.ts");
  });

  // Proved by rulings-a.test.ts "R13 keeps a card under a Stack off the field: it neither acts nor can be
  // targeted"; combat-validation.test.ts "R13 refuses an attack by a card dormant under a Stack (§3.2)",
  // "R13 refuses a dormant card under a Stack as a target too (§3.2)"; effects-radiant.test.ts "R13 offers
  // only the top of a Stack pile, never the dormant card beneath".
  it("R13 keeps a card dormant under a Stack off the field", () => {
    provenIn(13, "rulings-a.test.ts", "combat-validation.test.ts", "effects-radiant.test.ts");
  });

  // M4 owns #52 Silly Silas itself; the rotation subsystem is the machinery its script calls.
  // Proved by rulings-a.test.ts "R14 rotates two independent rings, bounces a Locked destination and carries
  // damage and buffs"; rotation.test.ts "R14 rotates the unit ring one step right, so your lane 5 crosses
  // to the opponent's lane 5", "R14 rotates left as the mirror of right, so your lane 1 crosses to the
  // opponent's lane 1", and 5 more.
  it("R14 rotates two independent rings, bounces a Locked destination, and carries damage and buffs", () => {
    expect(config.ROTATION_RING).toBe("two-rings");
    provenIn(14, "rulings-a.test.ts", "rotation.test.ts");
  });

  // Proved by rulings-a.test.ts "R15 steals into the same lane when it is free, else the first free zone,
  // leaving the excess"; effects-steal.test.ts "R15 takes the same lane when it is free, and moves control
  // only", "R15 falls back to the first free zone when the same lane is taken or Locked", and 2 more.
  it("R15 steals into the same lane when it is free, else the first free zone, and leaves the excess", () => {
    provenIn(15, "rulings-a.test.ts", "effects-steal.test.ts");
  });

  // Proved by rulings-a.test.ts "R16 makes a discard the player's choice unless the card says random";
  // effects-move.test.ts "R16 a named card goes from the hand to the graveyard", "R16 the random form draws
  // its pick from the match rng", and 2 more.
  it("R16 makes a discard the player's choice unless the card says random", () => {
    provenIn(16, "rulings-a.test.ts", "effects-move.test.ts");
  });

  // M4 owns #41 Sheepish, #60, #33 and #85: their card tests prove the timing on the real scripts.
  // Proved by rulings-a.test.ts "R17 fires a trap on the play before the Cry, and an Immutable target still
  // consumes it".
  it("R17 fires Sheepish before the Cry and the other traps after the card resolves", () => {
    provenIn(17, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R18 makes a health loss skip Armor, the hero cap and the damage pipeline";
  // damage.test.ts "R18: lose health bypasses Armor, the hero cap and the damage event".
  it("R18 makes a health loss skip Armor, the hero cap and the damage pipeline", () => {
    provenIn(18, "rulings-a.test.ts", "damage.test.ts");
  });

  // Proved by rulings-a.test.ts "R19 lets a heal name any unit or hero on either side"; effects-heal.test.ts
  // "R19: heal X takes damage off a unit and never past its max health", "R19: heal X gives a hero health
  // with no cap, on either side (#5, #47)".
  it("R19 lets a heal name any unit or hero on either side", () => {
    provenIn(19, "rulings-a.test.ts", "effects-heal.test.ts");
  });

  // Proved by rulings-a.test.ts "R20 spends no exertion when an effect switches a position";
  // combat-positions.test.ts "R20 a unit switched by a spell keeps its exertion".
  it("R20 spends no exertion when an effect switches a position", () => {
    provenIn(20, "rulings-a.test.ts", "combat-positions.test.ts");
  });

  // Proved by rulings-a.test.ts "R21 draws random keywords from the eleven-entry pool and never repeats one
  // on a unit"; effects-buff.test.ts "R21 draws from the pool, never repeats within one grant, and is
  // seeded", "R21 never grants a keyword the unit already has, from any source", and 1 more.
  it("R21 draws random keywords from the eleven-entry pool and never repeats one on a unit", () => {
    expect(config.RANDOM_KEYWORD_POOL).toEqual([
      "Taunt",
      "Armor 1",
      "Rush",
      "Charge",
      "First Strike",
      "Poisonous",
      "Lifesteal",
      "Reborn",
      "Divine Shield",
      "Trample",
      "Cleave",
    ]);
    expect(new Set(config.RANDOM_KEYWORD_POOL).size).toBe(11);
    provenIn(21, "rulings-a.test.ts", "effects-buff.test.ts");
  });

  // Proved by rulings-a.test.ts "R22 swaps the base layer on the field, keeps damage and buffs, and re-fires
  // no Cry"; effects-radiant.test.ts "R22 swaps the base-stat layer at once, keeps damage and buffs, and
  // re-fires no Cry", "R22 applies a keyword the radiant face adds at once", and 1 more.
  it("R22 swaps the base layer on the field, keeps damage and buffs, and re-fires no Cry", () => {
    provenIn(22, "rulings-a.test.ts", "effects-radiant.test.ts");
  });

  // Proved by rulings-a.test.ts "R23 blocks Vanilla, Transform and Fuse-onto on an Immutable card while
  // Radiant still works"; effects-transform.test.ts "R23 refuses a Transform on an Immutable card, printed
  // or granted", "R23 refuses a Vanilla on an Immutable card, printed or granted".
  it("R23 blocks Vanilla, Transform and Fuse-onto on an Immutable card while Radiant still works", () => {
    provenIn(23, "rulings-a.test.ts", "effects-transform.test.ts");
  });

  // M4 owns #30 Archivist: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R24 reads costs per R65 for highest and lowest, and ties go to the card
  // nearest the top".
  it("R24 reads costs per R65 for highest and lowest, and breaks ties nearest the top", () => {
    provenIn(24, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R25 clamps the Fib index at Fib(11) = 89"; config.test.ts "R25 Fib index
  // clamps at 11 (89)".
  it("R25 clamps the Fib index at Fib(11) = 89", () => {
    expect(config.FIB).toHaveLength(12);
    expect([11, 12, 99].map(config.fib)).toEqual([89, 89, 89]);
    expect([0, 1, 2, 7].map(config.fib)).toEqual([0, 1, 1, 13]);
    provenIn(25, "rulings-a.test.ts", "config.test.ts");
  });

  // M4 owns #94 Genn's Greed: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R26 reads Genn's Greed as 'exile all odd-cost cards'".
  it("R26 reads Genn's Greed as “exile all odd-cost cards”", () => {
    expect(config.GENN_GREED_EXILES).toBe("odd");
    provenIn(26, "rulings-a.test.ts");
  });

  // M4 owns #93 Combo-Index; the subsystem test is the machinery its script calls.
  // Proved by comboIndex.test.ts "R27 runs every step from E up to the new grade, in order", "R27 the E→S
  // cascade runs each step in order once it reaches S", and 2 more.
  it("R27 runs Combo-Index E to the new grade in order, and makes grade S terminal", () => {
    provenIn(27, "comboIndex.test.ts");
  });

  // M4 owns #95 Call to Chaos; the subsystem test is the machinery its script calls.
  // Proved by callToChaos.test.ts "R28 the base form rolls exactly one of the ten effects, and all ten are
  // reachable", "R28 the radiant form rolls two effects: the recursion plus one of the other nine", and 4
  // more.
  it("R28 caps the Call to Chaos chain at 20 and pairs the recursion with one of the other nine", () => {
    expect(config.CALL_TO_CHAOS_CHAIN_CAP).toBe(20);
    provenIn(28, "callToChaos.test.ts");
  });

  // M4 owns #97 Zephyrs; the scorer subsystem is the machinery its script calls.
  // Proved by rulings-a.test.ts "R29 ranks every non-token Core card except #97 and offers the top three";
  // scorer.test.ts "R29 ranks every non-token Core definition except #97 itself", "R29 is deterministic:
  // the same state always produces the same order", and 6 more.
  it("R29 ranks every non-token Core card except #97 and offers the top three", () => {
    provenIn(29, "rulings-a.test.ts", "scorer.test.ts");
  });

  // M4 owns #79 Twinspell: its card test proves the lifetime on the real script.
  // Proved by rulings-a.test.ts "R30 keeps a Twinspell Echo until a Spell is played, then sends Twinspell to
  // the graveyard".
  it("R30 keeps a Twinspell Echo until a Spell is played, then sends Twinspell to the graveyard", () => {
    provenIn(30, "rulings-a.test.ts");
  });

  // M4 owns #76 Field of Dreams: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R31 sends a replaced hand to the graveyard, where Reminisce can still find
  // it".
  it("R31 sends a hand replaced by Field of Dreams to the graveyard", () => {
    provenIn(31, "rulings-a.test.ts");
  });

  // M4 owns #4 Lucky: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R32 leaves a coin-stat effect alone: Lucky has no defined best, so it
  // changes nothing".
  it("R32 leaves a coin-stat effect alone, since Lucky has no defined best", () => {
    provenIn(32, "rulings-a.test.ts");
  });

  // Proved by rulings-a.test.ts "R33 shows a face-down trap to its current controller only, and a fired Field
  // Trap to both"; effects-swap.test.ts "R33 a swapped face-down trap stays face-down and is readable by
  // its new controller only"; rotation.test.ts "R33 a face-down trap that crosses answers to its new
  // controller and stays face down".
  it("R33 shows a face-down trap to its current controller only, and a fired Field Trap to both", () => {
    provenIn(33, "rulings-a.test.ts", "effects-swap.test.ts", "rotation.test.ts");
  });

  // M4 owns #33 Unstable Clone Machine: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R34 copies token cards too: a unit-token card and a spell token both reach
  // the library".
  it("R34 copies token cards too, spell tokens and unit-token cards alike", () => {
    provenIn(34, "rulings-a.test.ts");
  });

  // M4 owns #83 Transmogulate and its pool: its card test proves the ruling on the real script.
  // Proved by rulings-a.test.ts "R35 replaces a board card in place with its own type, and the replaced card
  // ceases to exist"; effects-transform.test.ts "R35 the replaced card ceases to exist: no graveyard, no
  // exile and no Death", "R35 replaces a hand card and keeps a library card at its index".
  it("R35 replaces a board card in place with its own type, and the replaced card ceases to exist", () => {
    provenIn(35, "rulings-a.test.ts", "effects-transform.test.ts");
  });

  // Proved by rulings-a.test.ts "R36 lets only the active player offer a draw, once a turn, and a decline
  // blocks 3 of their turns".
  it("R36 lets only the active player offer a draw, once a turn, and blocks a decliner for three turns", () => {
    expect(config.DRAW_OFFERS_PER_TURN).toBe(1);
    expect(config.DRAW_OFFER_BLOCK_TURNS).toBe(3);
    provenIn(36, "rulings-a.test.ts");
  });

  // M4 owns #18 and the token catalog row: the card test proves the name and cost.
  // Proved by rulings-a.test.ts "R37 gives the unnamed X/X token its stats through statsOverride, at cost 0".
  it("R37 names the unnamed X/X token Bread Token, cost 0, with no text", () => {
    provenIn(37, "rulings-a.test.ts");
  });

  // M4 owns #89 Corpse Eater: its card test proves the stat source on the real script.
  // Proved by rulings-a.test.ts "R38 feeds a hand trigger from a unit reaching a graveyard, and never from a
  // token".
  it("R38 feeds Corpse Eater the dying unit's current attack and max health", () => {
    provenIn(38, "rulings-a.test.ts");
  });

  // M4 owns #92 Felinor Fiender: its card test proves the stat mode on the real script.
  // Proved by rulings-a.test.ts "R39 gives Felinor Fiender printed plus the sum of your Felinors, never below
  // printed".
  it("R39 gives Felinor Fiender printed stats plus the sum of your Felinors, never below printed", () => {
    expect(config.FIENDER_STATS_MODE).toBe("printed-plus-sum");
    provenIn(39, "rulings-a.test.ts");
  });

  // M4 owns #21, #27 and #90.1: their card tests prove Combo counting on the real scripts.
  // Proved by rulings-a.test.ts "R40 counts a cast-on-draw cast as a card played this turn, at cost 0".
  it("R40 counts a cast-on-draw cast as a card played this turn, at cost 0", () => {
    provenIn(40, "rulings-a.test.ts");
  });

  // M4 owns #22 Carnivorous Cube: its card test proves the meal on the real script.
  // Proved by rulings-a.test.ts "R41 gives Carnivorous Cube a meal it never takes from itself, and a Death
  // that can do nothing".
  it("R41 never lets Carnivorous Cube eat itself, and makes it eat if able", () => {
    provenIn(41, "rulings-a.test.ts");
  });

  // M4 owns #32: its card test proves the trigger on the real script.
  // Proved by rulings-a.test.ts "R42 records the unit whose damage instance was lethal, Cleave hits
  // included".
  it("R42 reads “destroys a unit” as a death whose lethal damage instance came from this unit", () => {
    provenIn(42, "rulings-a.test.ts");
  });

  // M4 owns #98 Heroic Power: its card test proves the power list and the once-a-turn use.
  // Proved by rulings-b.test.ts "R43 stores Heroic Power's power on the instance, costs its X, uses it once a
  // turn and recruits a permanent"; setup.test.ts "R43: Heroic Power rolls its power during setup,
  // deterministically from the seed", "R43 rolls a power for a Heroic Power the mulligan returned to the
  // library"; mana.test.ts "R43 gives Heroic Power the cost of its power".
  it("R43 stores Heroic Power's rolled power on the instance and costs its X", () => {
    provenIn(43, "rulings-b.test.ts", "setup.test.ts", "mana.test.ts");
  });

  // M4 owns #96 My Pawn: its card test proves the cancel on the real trap script.
  // Proved by rulings-b.test.ts "R44 projects lethal after Armor, the cap and Trample excess, and the policy
  // draws from legalActions"; lethal.test.ts "R44 projects a plain hit on the hero as the attacker's
  // attack", "R44 subtracts the defending hero's Armor before the comparison (§4.4 step 2)", and 5 more;
  // aiPolicy.test.ts "R44 returns the same action sequence for the same state and seed", "R44 ends the turn
  // when nothing else is on offer, and takes no rng draw to decide it", and 5 more.
  it("R44 projects lethal after Armor, the Anti-oneshot cap and Trample excess, then cancels the attack", () => {
    expect(config.ANTI_ONESHOT_CAP).toEqual({ base: 5, radiant: 3 });
    provenIn(44, "rulings-b.test.ts", "lethal.test.ts", "aiPolicy.test.ts");
  });

  // Proved by rulings-b.test.ts "R45 keeps players as a map, so the seats and 'each opposing hero' are read
  // from it, not hard-coded".
  it("R45 keeps players as a map, so the seats and “each opposing hero” are read from it", () => {
    provenIn(45, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R46 turns a would-destroy Indestructible unit to Attack Position without
  // Taunt, and leaves a Field Spell alone"; statecheck.test.ts "R46: an Indestructible unit destroyed by an
  // effect is in Attack Position with no Taunt until end of turn", "R46 leaves an Indestructible Field
  // Spell where it is and drops the mark"; effects-destroy.test.ts "R46 an Indestructible unit ignores a
  // destroy mark and stays on the field".
  it("R46 turns a would-destroy Indestructible unit to Attack Position without Taunt", () => {
    provenIn(46, "rulings-b.test.ts", "statecheck.test.ts", "effects-destroy.test.ts");
  });

  // Proved by rulings-b.test.ts "R47 fizzles a lane-targeted summon into an occupied or Locked zone, and
  // holds a Reborn unit's zone"; statecheck.test.ts "R47: Reborn into a zone that was Locked meanwhile
  // fails silently", "R47 says so in the event stream when a Reborn return fizzles into a Locked zone";
  // effects-summon.test.ts "R47 a lane-named summon fizzles on an occupied or a Locked zone".
  it("R47 fizzles a lane-targeted summon into an occupied or Locked zone", () => {
    provenIn(47, "rulings-b.test.ts", "statecheck.test.ts", "effects-summon.test.ts");
  });

  // M4 owns #77 Professor Curvature: its card test proves the discount on the real script.
  // Proved by rulings-b.test.ts "R48 applies Professor Curvature to a card whose cost is 4 once the other
  // modifiers have landed"; mana.test.ts "R48 a next-turn discount does nothing on the turn it was
  // created"; turn.test.ts "R48 keeps a next-turn modifier through its own turn and drops it after the next
  // one".
  it("R48 applies Professor Curvature to a card whose current cost is 4 at play time", () => {
    provenIn(48, "rulings-b.test.ts", "mana.test.ts", "turn.test.ts");
  });

  // M4 owns #45 Deft Duelist: its card test proves the second exertion on the real script.
  // Proved by rulings-b.test.ts "R49 gives Deft Duelist two exertions, one attack and one switch, where a
  // plain unit has one"; combat-positions.test.ts "R49 Deft Duelist attacks and switches in one turn".
  it("R49 gives Deft Duelist two exertions: one attack and one switch a turn", () => {
    provenIn(49, "rulings-b.test.ts", "combat-positions.test.ts");
  });

  // M4 owns #72 Reminisce: its card test proves the Discover on the real script.
  // Proved by rulings-b.test.ts "R50 discovers from the actual graveyard, so a spell token sitting there is
  // eligible"; effects-choose.test.ts "R50 Discover from the graveyard offers the cards actually in your
  // own graveyard".
  it("R50 discovers from the actual graveyard, so a spell token sitting there is eligible", () => {
    provenIn(50, "rulings-b.test.ts", "effects-choose.test.ts");
  });

  // M4 owns #13: its card test proves the spread on the real script.
  // Proved by rulings-b.test.ts "R51 gives 'all enemies' one damage instance to every enemy unit and one to
  // the enemy hero".
  it("R51 gives “all enemies” one damage instance each, the enemy hero included", () => {
    provenIn(51, "rulings-b.test.ts");
  });

  // M4 owns #18 Bread and Butter: its card test proves the beneficiary on the real script.
  // Proved by rulings-b.test.ts "R52 gives the end-of-turn token to the trap's controller, whoever ended the
  // turn with mana".
  it("R52 gives the end-of-turn token to the trap's controller", () => {
    provenIn(52, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R53 forces an attack past the validator, spends no exertion, and stops once
  // the target is gone"; combat-resolution.test.ts "R53 Moths pulls a summoning-sick enemy into an attack
  // without spending its exertion", "R53 a forced attack ignores position, sickness and the Taunt rule",
  // and 3 more.
  it("R53 runs a forced attack past the validator, with no exertion and its own state check", () => {
    provenIn(53, "rulings-b.test.ts", "combat-resolution.test.ts");
  });

  // M4 owns #82 KY's Trial: its card test proves the roll on the real script.
  // Proved by rulings-b.test.ts "R54 never offers a token index or the generating card's own index in a
  // random pool".
  it("R54 rolls only 1–100, rerolls its own index and never a token index", () => {
    provenIn(54, "rulings-b.test.ts");
  });

  // M4 owns #100 Ceaseless Void: its card test proves the counters on the real script.
  // Proved by rulings-b.test.ts "R55 counts both players' draws, plays, destructions and exiles from the
  // start of the game".
  it("R55 counts both players' draws, plays, destructions and exiles from the start of the game", () => {
    provenIn(55, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R56 reports the cost actually paid after modifiers, which is what a cost
  // threshold reads".
  it("R56 reads a cost threshold off the cost actually paid after modifiers", () => {
    provenIn(56, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R57 makes a shuffled-in copy a fresh instance carrying the radiant flag, and
  // a field copy keep statsOverride".
  it("R57 keeps a field copy's flag, buffs and statsOverride, and makes a shuffled-in copy fresh", () => {
    provenIn(57, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R58 casts at most CAST_ON_DRAW_CHAIN_CAP cards in one draw, casts on a full
  // hand, and draws N times for 'draw N'"; draw.test.ts "R58 casts a cast-on-draw card even when the hand
  // is full"; callToChaos.test.ts "R58 draws the library it had when the effect started and gains 4 mana".
  it("R58 casts at most CAST_ON_DRAW_CHAIN_CAP cards per draw, even on a full hand", () => {
    expect(config.CAST_ON_DRAW_CHAIN_CAP).toBe(20);
    provenIn(58, "rulings-b.test.ts", "draw.test.ts", "callToChaos.test.ts");
  });

  // Proved by rulings-b.test.ts "R59 runs the state check after a whole effect, never between its hits, and
  // calls two dead heroes a draw"; statecheck.test.ts "R59: the check runs after a whole effect, not
  // between its hits", "R59: both heroes at 0 in one check is a draw, one hero at 0 is a loss";
  // endgame.test.ts "R59: one effect that leaves both heroes at 0 is a draw".
  it("R59 runs the state check after each whole effect, never between its hits, and calls two dead heroes a draw", () => {
    provenIn(59, "rulings-b.test.ts", "statecheck.test.ts", "endgame.test.ts");
  });

  // Proved by rulings-b.test.ts "R60 picks different cards among the non-Radiant ones, all of them when fewer
  // exist, and none when none are left"; effects-radiant.test.ts "R60 chooses only among non-Radiant
  // cards", "R60 does nothing when no non-Radiant card is left", and 1 more; comboIndex.test.ts "R60 grade
  // D makes 2 different random hand cards cost 1 less", "R60 grade B picks only among non-Radiant hand
  // cards, and does nothing when none are left".
  it("R60 picks different cards, all of them when fewer exist, and nothing when none are left", () => {
    provenIn(60, "rulings-b.test.ts", "effects-radiant.test.ts", "comboIndex.test.ts");
  });

  // M4 owns #85 Unlicensed Experimentation: its card test proves the trigger on the real script.
  // Proved by rulings-b.test.ts "R61 emits cardPlayed only for a play or a cast, refuses an Immutable Fuse
  // target, and consumes a trap that does nothing".
  it("R61 fires Unlicensed Experimentation only on the opponent's played permanent, after its Cry", () => {
    provenIn(61, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R62 ends a turn as triggers, then the trap window on both sides, then
  // delayed effects, then cleanup"; turn.test.ts "R62 runs a turn in order: refresh, start triggers, draw,
  // then end of turn"; comboIndex.test.ts "R62 the rise is an ordinary end-of-turn trigger, so ending the
  // turn runs the cascade".
  it("R62 runs the turn in §11 order: triggers, then the end-of-turn trap window, then delayed effects, then cleanup", () => {
    provenIn(62, "rulings-b.test.ts", "turn.test.ts", "comboIndex.test.ts");
  });

  // Proved by rulings-b.test.ts "R63 tramples only the excess, cleaves past a stopped hit, ignores zero hits
  // and lifesteals the total once"; damage.test.ts "R63 gives Fed Fauci one Plague Token per damage
  // instance, and none for an instance Armor zeroed"; effects-damage.test.ts "R63 an amount of 0 or less is
  // not a damage instance at all".
  it("R63 tramples only the excess, cleaves past a stopped hit, and makes a zero hit no damage instance", () => {
    provenIn(63, "rulings-b.test.ts", "damage.test.ts", "effects-damage.test.ts");
  });

  // Proved by rulings-b.test.ts "R64 summons into the leftmost open zone, fills the board left to right, and
  // reserves a Reborn unit's zone"; effects-summon.test.ts "R64 takes the leftmost empty unlocked zone of
  // its row with no zone named", "R64 skips a Locked zone and one reserved for a Reborn unit", and 2 more.
  it("R64 summons into the leftmost open zone, fills left to right, and reserves a dying Reborn unit's zone", () => {
    provenIn(64, "rulings-b.test.ts", "effects-summon.test.ts");
  });

  // Proved by rulings-b.test.ts "R65 reads costOverride, then costMod, then the player's discounts, then
  // Curvature, floored at 0"; mana.test.ts "R65 prefers costOverride over the printed cost, then applies
  // costMod", "R65 applies a player discount, and only to the types it names", and 4 more;
  // effects-cost.test.ts "R65 adds to the instance's costMod and reports the new effective cost", "R65: the
  // cost the event reports is the effective one, with the player's discount included", and 4 more.
  it("R65 computes a cost as override, then costMod, then discounts, then Curvature, floored at 0", () => {
    provenIn(65, "rulings-b.test.ts", "mana.test.ts", "effects-cost.test.ts");
  });

  // M4 owns #94 Genn's Greed: its card test proves both halves on the real script.
  // Proved by rulings-b.test.ts "R66 reads Genn's Greed costs per R65 at resolution and exempts X-cost cards
  // from both halves".
  it("R66 reads Genn's Greed costs per R65 at resolution and exempts X-cost cards from both halves", () => {
    provenIn(66, "rulings-b.test.ts");
  });

  // M4 owns #31 KY's Math Equation: its card test proves the index on the real script.
  // Proved by rulings-b.test.ts "R67 takes KY's Math Equation's Fib index from printed cost plus costMod plus
  // 1, ignoring discounts".
  it("R67 takes KY's Math Equation's Fib index from printed cost plus costMod plus 1", () => {
    provenIn(67, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R68 orders triggers active side first, units by lane, then backrow, hand and
  // graveyard, delayed by creation"; turn.test.ts "R68 resolves two end-of-turn triggers on one side in
  // lane order"; statecheck.test.ts "R68: one effect kills six units in one check and fires six Death
  // triggers, active side first, then lane order".
  it("R68 orders triggers by side, then lane, then hand and graveyard, and delayed effects by creation", () => {
    provenIn(68, "rulings-b.test.ts", "turn.test.ts", "statecheck.test.ts");
  });

  // Proved by rulings-b.test.ts "R69 collects an Indestructible unit whose max health falls to 0, and leaves
  // one merely at 0 health"; statecheck.test.ts "R69: an Indestructible unit at 0 max health dies and
  // counts as destroyed, one at 0 health with max health above 0 stays".
  it("R69 collects an Indestructible unit whose max health falls to 0, and leaves one merely at 0 health", () => {
    provenIn(69, "rulings-b.test.ts", "statecheck.test.ts");
  });

  // Proved by rulings-b.test.ts "R70 makes a cast free, counts it as a play, fires the card's Cry and sends a
  // Spell to the graveyard"; turn.test.ts "R70 a cast counts as a play and pays nothing";
  // callToChaos.test.ts "R70 casts a random Call to Chaos: free, counted as a play, and its script
  // resolves".
  it("R70 makes a cast free, counts it as a play and fires the card's Cry", () => {
    provenIn(70, "rulings-b.test.ts", "turn.test.ts", "callToChaos.test.ts");
  });

  // M4 owns #39 Recycling Initiative: its card test proves the copy set on the real script.
  // Proved by rulings-b.test.ts "R71 copies every other card played this turn at end of turn, including the
  // ones played after it".
  it("R71 copies every other card played this turn at end of turn, the later ones included", () => {
    provenIn(71, "rulings-b.test.ts");
  });

  // M4 owns #40 and #70: their card tests prove the counts on the real scripts.
  // Proved by rulings-b.test.ts "R72 keeps exile piles with their owners and lets a hero climb above the 30
  // that missing health counts from".
  it("R72 reads “cards in exile” as your own pile and counts missing health from 30", () => {
    expect(config.HERO_HEALTH).toBe(30);
    provenIn(72, "rulings-b.test.ts");
  });

  // M4 owns #87 Pocket Chaos: its card test proves the three swaps on the real script.
  // Proved by rulings-b.test.ts "R73 gives Pocket Chaos its three swaps: armor apart from health, locks with
  // the zone, a trap read by its controller, and owner-routed libraries"; effects-swap.test.ts "R73 swaps
  // hero health and leaves each hero's armor where it was", "R73 swaps board contents lane by lane in both
  // rows, with control moving and nothing resetting", and 3 more.
  it("R73 gives Pocket Chaos its three swaps: health apart from armor, board with locks, libraries with owners", () => {
    provenIn(73, "rulings-b.test.ts", "effects-swap.test.ts");
  });

  // Proved by rulings-b.test.ts "R74 models Radiant as a flag that never unsets, swaps the layer in place,
  // and rides copies and formless cards"; effects-radiant.test.ts "R74 sets the flag on a card whose
  // radiant form is the same as its base".
  it("R74 models Radiant as a flag that never unsets, with an in-place layer swap and no Cry", () => {
    provenIn(74, "rulings-b.test.ts", "effects-radiant.test.ts");
  });

  // M4's catalog.test.ts diffs the whole catalog against the §8 fixture.
  // Proved by rulings-b.test.ts "R75 keeps the §5.3 corrections in the catalog shape: a set and type on every
  // def, the Felinor tag, N.1 indexes and cost 6".
  it("R75 keeps the §5.3 catalog corrections in the catalog shape", () => {
    provenIn(75, "rulings-b.test.ts");
  });

  // M4 owns #50 Kpop Fanatic: its card test proves the delay on the real script.
  // Proved by rulings-b.test.ts "R76 fires the delayed steal at your next start of turn even though the unit
  // died, and fizzles on a card already yours".
  it("R76 fires the delayed steal at your next start of turn even after the unit died", () => {
    provenIn(76, "rulings-b.test.ts");
  });

  // M4 owns #85 and #99; the fuse subsystem is the machinery their scripts call.
  // Proved by rulings-b.test.ts "R77 fuses the base forms, keeps the target's instance, sums buffs, and
  // crafts a free non-Radiant hand card".
  it("R77 fuses into a transient definition whose cost is capped at FUSE_COST_CAP", () => {
    expect(config.FUSE_COST_CAP).toBe(4);
    provenIn(77, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R78 resets an instance as it leaves the field while costMod, costOverride
  // and radiant persist"; statecheck.test.ts "R78: a Reborn unit returns reset, at 1 health without Reborn,
  // and its Cry does not fire", "R78 a Death trigger reads what the unit remembered before it left the
  // field"; effects-move.test.ts "R78 exile resets the instance but keeps costMod and radiant", "R78
  // returns a unit to its owner's hand and drops its damage, buffs and position".
  it("R78 resets an instance as it leaves the field, while costMod, costOverride and radiant persist", () => {
    provenIn(78, "rulings-b.test.ts", "statecheck.test.ts", "effects-move.test.ts");
  });

  // M7 owns apps/server/src/config.ts: the server test proves the clocks, the Elo and the room codes.
  // Proved by rulings-b.test.ts "R79 answers only the timed-out player's prompt, loses on a disconnect, draws
  // at the ceiling, and leaves the clocks to the server".
  it("R79 leaves the match-lifecycle defaults to the server config", () => {
    provenIn(79, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R80 caps a library at LIBRARY_CAP: a new card is never created and an
  // existing one lands in the graveyard"; callToChaos.test.ts "R80 no chaos effect creates a library card,
  // so a full library only ever shrinks".
  it("R80 caps a library at LIBRARY_CAP, creating no new card and routing an existing one", () => {
    expect(config.LIBRARY_CAP).toBe(60);
    provenIn(80, "rulings-b.test.ts", "callToChaos.test.ts");
  });

  // Proved by rulings-b.test.ts "R81 carries zone, X, targets and modes in the play action, and opens a
  // PendingChoice only during resolution"; playChoices-filters.test.ts "R81 filters a hand declaration by
  // the card type it names (§10.6)", "R81 offers a backrow declaration both backrows, filtered by the list
  // of types it names", and 6 more; effects-choose.test.ts "R81 reads a prompt's mode pick out of
  // ctx.targets and a play's modes out of ctx.modes".
  it("R81 carries a play's zone, X, targets and modes in the action, and prompts only during resolution", () => {
    provenIn(81, "rulings-b.test.ts", "playChoices-filters.test.ts", "effects-choose.test.ts");
  });

  // Proved by rulings-b.test.ts "R82 ends the turn by itself when only ending, conceding and offering a draw
  // are left".
  it("R82 ends a turn by itself when only ending, conceding and offering a draw are left", () => {
    provenIn(82, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R83 brings a Reborn unit back summoning sick, so it cannot attack twice, but
  // it may still switch".
  it("R83 brings a Reborn unit back summoning sick, so it cannot attack again, but it may still switch", () => {
    provenIn(83, "rulings-b.test.ts");
  });

  // Proved by rulings-b.test.ts "R84 keeps concede, offerDraw and answerDraw out of the policy, so a random
  // game ends by death or the cap"; aiPolicy.test.ts "R84 only ever returns an action legalActions offered,
  // and never a concede or a draw offer".
  it("R84 keeps concede, offerDraw and answerDraw out of the AI policy", () => {
    expect(config.AI_END_TURN_PROBABILITY).toBe(0.1);
    provenIn(84, "rulings-b.test.ts", "aiPolicy.test.ts");
  });

  // Proved by damage.test.ts "R85 an effect may state its damage has Lifesteal, without the source carrying
  // the keyword"; effects-damage.test.ts "R85 heals the source's controller when the effect's own text has
  // Lifesteal", "R85 heals the amount actually dealt, and heals nobody when the effect has no source".
  it("R85 heals for an effect whose own text says its damage has Lifesteal, without granting the keyword", () => {
    provenIn(85, "damage.test.ts", "effects-damage.test.ts");
  });

  // Proved by comboIndex.test.ts "R86 skips a played card that no longer exists and keeps one that only
  // changed zone".
  it("R86 skips a played card that no longer exists and keeps one that only changed zone", () => {
    provenIn(86, "comboIndex.test.ts");
  });

  // M4 owns #95 Call to Chaos; the subsystem test is the machinery its script calls.
  // Proved by callToChaos.test.ts "R87 resolves the radiant pair in written order, leaves a cast card in the
  // graveyard, and rolls no substitute at the cap".
  it("R87 resolves the Call to Chaos radiant pair in written order and rolls no substitute at the cap", () => {
    provenIn(87, "callToChaos.test.ts");
  });

  // The rotation half of the same rule is rotation.test.ts "R14 bounces a card whose destination is Locked to
  // its owner's hand".
  // Proved by effects-swap.test.ts "R88 a card whose destination is Locked bounces to its owner's hand, as
  // R14 does for a rotation".
  it("R88 bounces a whole-board move into a closed zone to the card's owner's hand", () => {
    provenIn(88, "effects-swap.test.ts");
  });

  // Proved by statecheck.test.ts "R89 reports the dying card's owner, its last stats and the unit that killed
  // it", "R89 reports no killer when nothing dealt the lethal damage".
  it("R89 carries the dying card's owner, its last stats and its killer on the destroyed event", () => {
    provenIn(89, "statecheck.test.ts");
  });

  // Proved by playChoices-filters.test.ts "R90 reads two declarations off the flat targets list in order, and
  // refuses the swapped order", "R90 enumerates a declaration pair as a cross product, and both may name
  // the same card", and 3 more.
  it("R90 validates a play's choices against what the card declared and what the board allows", () => {
    provenIn(90, "playChoices-filters.test.ts");
  });

  // M4 owns #48 5pek Controller and #65.1 Spikey Pillow; `combat.switchPosition` is the machinery
  // their scripts call.
  // Proved by rulings-c.test.ts "R91 does nothing when a unit is switched to the position it already
  // holds", "R91 is not an error even for a unit that has already acted this turn".
  it("R91 does nothing when a unit is switched to the position it already holds", () => {
    provenIn(91, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R92 gives a position only to a card on the field, so a dormant or
  // absent card cannot be switched".
  it("R92 gives a position only to a card on the field, so a dormant or absent card cannot be switched", () => {
    provenIn(92, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R93 has a First Strike unit strike once: step 1 is when its strike
  // happens, not an extra one".
  it("R93 has a First Strike unit strike once, so two First Strikers trade in step 1", () => {
    provenIn(93, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R94 reads the attacker's attack once per combat, before a First
  // Strike defender's hit lands", "R94 reads the defender's attack once per combat, so a First
  // Strike survivor is struck back with the attack it had before the hit".
  it("R94 reads both units' attack once per combat, at the start of it", () => {
    provenIn(94, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R95 lands Cleave on the attacker's own hit, never on the
  // strike-back and never on a hero target".
  it("R95 lands Cleave on the attacker's own hit, never the strike-back, and never on a hero target", () => {
    provenIn(95, "rulings-c.test.ts");
  });

  // The R53 half of the same rule is combat-resolution.test.ts "R53 a sequence of forced attackers
  // stops once the target is gone".
  // Proved by rulings-c.test.ts "R96 skips a forced attacker that is already gone in silence, and
  // stops once the game has a result".
  it("R96 skips a forced attacker that is already gone, and stops once the game has a result", () => {
    provenIn(96, "rulings-c.test.ts");
  });

  // Proved by viewFor.test.ts "R97 redacts an event that names a card the viewer may not read,
  // rather than dropping it", "R97 never reads a card in a library, and blanks a shuffled-in card's
  // slot for both players".
  it("R97 redacts an event that names an unreadable card rather than dropping it", () => {
    provenIn(97, "viewFor.test.ts");
  });

  // Proved by prompts.test.ts "R98 a card that asks a question while it resolves is still itself",
  // "R98 a card that has left the resolving zone resumes with no self, from its captured data".
  it("R98 keeps a card that asks a question while it resolves as its own ctx.self", () => {
    provenIn(98, "prompts.test.ts");
  });

  // M4 owns #52, #56, #67 and #85; `traps.ts` is the machinery their scripts call.
  // Proved by rulings-c.test.ts "R99 fires a trap only when its `when` admits the event, spends it
  // on an empty effect list, and answers either side without a predicate".
  it("R99 fires a trap only when its `when` admits the event, and spends it on an empty effect list", () => {
    provenIn(99, "rulings-c.test.ts");
  });

  // R62's whole end-of-turn order is rulings-b.test.ts "R62 orders the end of a turn: end-of-turn
  // triggers, the trap window on both sides, delayed effects, then cleanup".
  // Proved by rulings-c.test.ts "R100 gives the end-of-turn window its own events, so a `turnEnded`
  // trap fires once per turn end"; trap-window-pause.test.ts "R100 re-offers the event to nobody who
  // has already seen it, so one turn end is one firing".
  it("R100 gives the end-of-turn trap window its own events, so a turnEnded trap fires once", () => {
    provenIn(100, "rulings-c.test.ts", "trap-window-pause.test.ts");
  });

  // Proved by rulings-c.test.ts "R101 pays a Tribute with a minimal set, counts a Sheep Token 2, and
  // refuses the play when the board cannot pay", "R101 lets only a card that says so tribute the
  // opponent's units"; 055-lava-golem.test.ts "R101 an enemy unit is legal fodder, and it is
  // SACRIFICED, not destroyed", "R101 three enemy units alone can pay the whole cost", "R101 an
  // enemy Sheep Token also counts 2 (§3.2 does not name a side)".
  it("R101 pays a Tribute with a minimal set, and makes an unpayable Tribute an illegal play", () => {
    provenIn(101, "rulings-c.test.ts", "../../cards/test/055-lava-golem.test.ts");
  });

  // M4 owns #85 Unlicensed Experimentation and #99 Craft a Card; R77's own clauses are fuse.test.ts.
  // Proved by rulings-c.test.ts "R102 caps the fused cost and drops every ingredient's `cost` hook,
  // so the cap wins over a cost-rewriting hook", "R102 takes the max of the ingredients'
  // `staticFlags.tribute` rather than the sum", "R102 namespaces trigger ids by ingredient, so two
  // ingredients that share an id stay two conditions", "R102 makes every consumed ingredient cease
  // to exist: no graveyard, no Death trigger, no destroyed counter", "R102 resolves a multi-target
  // Fuse's ingredients once and reuses them, since a consumed one cannot be re-found".
  it("R102 composes a Fuse member by member: capped cost, max tribute, namespaced triggers, consumed ingredients", () => {
    expect(config.FUSE_COST_CAP).toBe(4);
    provenIn(102, "rulings-c.test.ts");
  });

  // M4 owns #98 Heroic Power; R43's own clauses are heroPower.test.ts.
  // Proved by rulings-c.test.ts "R103 stores the seven power names and costs 0 for a power that has
  // not rolled", "R103 checks once-per-turn before mana, turn and phase", "R103 marks the use before
  // the effects run, and fizzles a token power in silence when the token is absent".
  it("R103 fixes the Heroic Power surface: seven names, cost 0 unrolled, once-per-turn checked first", () => {
    provenIn(103, "rulings-c.test.ts");
  });

  // M7 owns apps/server/src/config.ts; the SQL evidence is BUILD M6-T1's lifecycle script.
  // Proved by 03_match_lifecycle.sql "### R104: the room-code alphabet excludes 0, 1, I and O ###".
  it("R104 writes the code alphabet out: 32 upper-case symbols without 0, 1, I or O", () => {
    // §11 R104 spells the alphabet; the server must carry exactly it, and the schema's room-code
    // check constraint must derive from the same 32 symbols.
    const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    expect(alphabet).toHaveLength(32);
    expect([..."01IO"].some((symbol) => alphabet.includes(symbol))).toBe(false);
    expect(serverConstant(SERVER_CONFIG, "CODE_ALPHABET")).toBe(`"${alphabet}"`);
    // 16 symbols over 32 is 80 bits, and a 6-character room code 30 (§9.4, §9.5).
    expect(serverConstant(SERVER_CONFIG, "INVITE_CODE_LENGTH")).toBe("16");
    expect(serverConstant(SERVER_CONFIG, "ROOM_CODE_LENGTH")).toBe("6");
    expect(sourceOf(SERVER_MATCHES_SQL)).toContain(`^[${alphabet}]{6}$`);
    provenIn(104, SERVER_SQL);
  });

  // R105 is proved twice by different paths, so both are named: 03_match_lifecycle.sql
  // "### R105: a stale catalog version is refused at save and queue ###" is the gate as
  // `save_loadout` invokes it, and 01_schema_invariants.sql "=== CHECK 15 (R105): stale catalog
  // version says "update required" ===" is the raw `app.assert_catalog_version`.
  it("R105 makes the catalog version a short opaque string, compared for equality only", () => {
    // "Stamped on every `cards` row and mirrored in the server's settings; the Core set is core-1."
    expect(sourceOf(SERVER_COLLECTION_SQL)).toMatch(/catalog_version text not null/);
    expect(sourceOf(SERVER_INVITES_SQL)).toMatch(/\('catalog_version', '"core-1"'\)/);
    // "Nothing may parse or order it": the gate is an equality test and nothing else.
    expect(sourceOf(SERVER_COLLECTION_SQL)).toContain(
      "if p_version is distinct from app.catalog_version() then",
    );
    expect(sourceOf(SERVER_COLLECTION_SQL)).not.toMatch(/catalog_version\(\)\s*[<>]/);
    provenIn(105, SERVER_SQL, SERVER_SCHEMA_SQL);
  });

  // Proved by 03_match_lifecycle.sql "### R106: the circuit breaker refuses redemption while it is
  // open ###".
  it("R106 opens the circuit breaker at 100 failures in a 600-second window", () => {
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_CIRCUIT_FAILURE_THRESHOLD")).toBe("100");
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_CIRCUIT_WINDOW_SECONDS")).toBe("600");
    // The same two numbers are the seeded settings the breaker actually reads, so tuning them needs
    // no migration and the constant above is not a second source of truth.
    expect(sourceOf(SERVER_INVITES_SQL)).toMatch(/\('redemption_failure_threshold', '100'\)/);
    expect(sourceOf(SERVER_INVITES_SQL)).toMatch(/\('redemption_failure_window_seconds', '600'\)/);
    provenIn(106, SERVER_SQL);
  });

  // A server responsibility with no database behaviour: SQL cannot deliver a timing floor. BUILD
  // M6-T1's 5 ms timing test proves it at the server level.
  it("R107 pads every redemption response to a 250 ms constant-time floor", () => {
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_RESPONSE_FLOOR_MS")).toBe("250");
    // §9.4's "identical time" also needs one message for every rejection, or the floor proves
    // nothing about which rejection it was.
    expect(serverConstant(SERVER_CONFIG, "REDEMPTION_IDENTICAL_ERROR")).not.toBeNull();
  });

  // A config value with no database behaviour; BUILD M7-T1 proves the cadences at the server level.
  it("R108 runs the sweeper every 3 seconds and the reaper every 30", () => {
    expect(serverConstant(SERVER_CONFIG, "MATCHMAKER_SWEEP_INTERVAL_SECONDS")).toBe("3");
    expect(serverConstant(SERVER_CONFIG, "MATCH_REAPER_INTERVAL_SECONDS")).toBe("30");
    // The reaper is the coarser clock of the two, and both sit well inside the 60-minute ceiling.
    expect(serverConstant(SERVER_CONFIG, "MATCH_CEILING_MINUTES")).toBe("60");
  });

  // A config value with no database behaviour; BUILD M7-T3 proves the limits at the server level.
  it("R109 limits a match to 5 actions a second and an account to 300 requests a minute", () => {
    expect(serverConstant(SERVER_CONFIG, "MATCH_ACTIONS_PER_SECOND")).toBe("5");
    expect(serverConstant(SERVER_CONFIG, "API_REQUESTS_PER_MINUTE")).toBe("300");
  });

  // Proved by 03_match_lifecycle.sql "### R110: a room code is reusable once its match is over ###".
  it("R110 makes a room code unique only among matches that are not yet over", () => {
    const source = sourceOf(SERVER_MATCHES_SQL);
    // The uniqueness is a *partial* index, which is the whole ruling: a finished match releases its
    // code back into the pool rather than burning it for ever.
    expect(source).toMatch(
      /create unique index if not exists matches_room_code_open_key\s+on public\.matches \(room_code\)\s+where room_code is not null and status <> 'over';/,
    );
    // And there is no unconditional unique index or unique constraint that would defeat it.
    expect(source).not.toMatch(/unique\s*\(\s*room_code\s*\)/);
    provenIn(110, SERVER_SQL);
  });

  // Proved by 03_match_lifecycle.sql "### R111: the launch grant is idempotent ###".
  it("R111 grants one copy of every non-token card when a profile becomes active, idempotently", () => {
    provenIn(111, SERVER_SQL);
  });

  // Proved by 03_match_lifecycle.sql "### R112: a reaper-resolved ceiling draw records turns 0 and
  // moves no rating ###"; results.test.ts "resolves a match past its ceiling as a draw and leaves
  // both ratings unchanged (R112)", "match-ceiling: an actor-resolved ceiling is a draw with the
  // ordinary Elo move (R112)".
  it("R112 has the reaper resolve a stuck match itself, recording turns 0 and no rating move", () => {
    provenIn(112, SERVER_SQL, "../../../apps/server/test/api/results.test.ts");
  });

  // Proved by rulings-c.test.ts "R113 parks one cascade's sequences innermost-first, and a pause
  // during a resumption ahead of everything owed", "R113 raises rather than drop a work item nothing
  // knows how to resume"; prompts.test.ts "R113 registers the card-continuation work handler, so a
  // parked tail always has an owner"; trap-window-pause.test.ts "R113 owes the rest of the window
  // when a trap prompts, and the answer fires the traps it had not reached", "R113 owes the whole
  // window when a prompt is already open at its scheduled point". The sequences that ride the cursor
  // are pauses.test.ts "§10.6 chains a second prompt inside the answer and finishes both tails,
  // innermost first" and "§9.3 finishes a pause nested inside an owed sequence before the sequence's
  // own tail".
  it("R113 resumes paused sequences in workCursor order, and raises rather than lose one", () => {
    provenIn(113, "rulings-c.test.ts", "prompts.test.ts", "trap-window-pause.test.ts");
  });

  // M4 owns #21 Trample Tram and #32 Cleaver; `damage.ts` is the pipeline their scripts ride.
  // Proved by rulings-c.test.ts "R114 deals nothing to a unit already at 0 health and sends the
  // whole Trample amount to its hero". The M2 gate's 1,000 random combats cover the same rule
  // across seeds (combat.property.test.ts).
  it("R114 deals nothing to a unit already at 0 health, sending the whole Trample amount to its hero", () => {
    provenIn(114, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R115 stops a Vanilla'd permanent projecting its aura and setting
  // its own stats, while it still receives other cards' auras"; layers.test.ts "§6.3 a Vanilla
  // unit's own aura stops applying, because Vanilla clears its scripts".
  it("R115 stops a Vanilla'd permanent projecting an aura or setting its own stats, while it still receives", () => {
    provenIn(115, "rulings-c.test.ts");
  });

  // M4 owns #92 Felinor Fiender; R39's own clause is layers.test.ts "R39 layer 2 adds the sum of
  // your Felinors' layer-4 stats, and R13 counts the ones under a Stack".
  // Proved by rulings-c.test.ts "R116 adds a set-stat hook's return to the printed face as a delta,
  // floored at 0, and never lets two of them read each other".
  it("R116 makes a set-stat hook return a delta, added to the printed face and floored at 0", () => {
    provenIn(116, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R117 owes a play's remaining steps only at the moment it pauses,
  // never in advance".
  it("R117 owes a paused sequence's remaining steps only at the pause, never in advance", () => {
    provenIn(117, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R118 lets a trap's prompt interrupt a play without eating its Cry,
  // which still fires exactly once"; triggers.test.ts's "§10.3 pauses the opponent's action until
  // the trap's prompt is answered" covers the same order through the reducer.
  it("R118 lets a trap's prompt interrupt a play without eating its Cry", () => {
    expect(config.CRY_ON_PLAY_ONLY).toBe(true);
    provenIn(118, "rulings-c.test.ts");
  });

  // Proved by 033-unstable-clone-machine.test.ts "R119 a permanent does not answer its own arrival:
  // it starts counting from the next play".
  it("R119 keeps a permanent from answering the play that put it on the field", () => {
    provenIn(119, "../../cards/test/033-unstable-clone-machine.test.ts");
  });

  // Proved by 041-sheepish.test.ts "R120 an Also clause stands on its own: an Immutable target
  // refuses the Transform and the rest of the text still resolves".
  it("R120 resolves an Also clause even when the clause before it did not", () => {
    provenIn(120, "../../cards/test/041-sheepish.test.ts");
  });

  // The R53 half is combat-resolution.test.ts "R53 an ordinary attack spends the attacker's exertion
  // and a forced one does not".
  // Proved by 096-my-pawn.test.ts "R121 a forced attack is declared by the effect, not the player,
  // so a trigger keyed to an opponent's declaration does not arm".
  it("R121 has a forced attack declared by the effect, not the player", () => {
    provenIn(121, "../../cards/test/096-my-pawn.test.ts");
  });

  // Proved by rulings-c.test.ts "R122 has the answering action finish what the prompt interrupted,
  // even driven without the reducer".
  it("R122 has the action that answers a prompt finish what the prompt interrupted", () => {
    provenIn(122, "rulings-c.test.ts");
  });

  // M4 owns #22 Carnivorous Cube, #55 Lava Golem and #66 The Rock; the R101 half is the Tribute cost.
  // Proved by rulings-c.test.ts "R123 carries a declared Tribute's picks in targets and its amount
  // as the play's Tribute cost".
  it("R123 carries a declared Tribute's picks in targets and its amount in the play's tributes", () => {
    provenIn(123, "rulings-c.test.ts");
  });

  // M4 owns #84 Going Long and #73; `damage.ts` steps 2 and 3 are what their scripts feed.
  // Proved by rulings-c.test.ts "R124 adds hero Armor up across its sources, where the Anti-oneshot
  // cap instead takes the smallest"; damage.test.ts "step 2: Armor 7 turns a 7 into 0, Defense adds
  // 1, Big D-fender adds 2 more, True Strike ignores it" is the unit-side half of the same layer.
  it("R124 adds hero Armor up across its sources, where the Anti-oneshot cap takes the smallest", () => {
    expect(config.ANTI_ONESHOT_CAP).toEqual({ base: 5, radiant: 3 });
    provenIn(124, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R125 sends fatigue through the whole damage pipeline, so Armor
  // absorbs the early draws". R3's own clause is rulings-a.test.ts "R3 makes the Nth draw from an
  // empty library deal N damage to that hero".
  it("R125 sends fatigue through the whole damage pipeline, Armor and the cap included", () => {
    expect([1, 2, 3, 4].map(config.FATIGUE_DAMAGE)).toEqual([1, 2, 3, 4]);
    provenIn(125, "rulings-c.test.ts");
  });

  // M4 owns #39, #50 and #78; `turn.runDelayed` is the machinery their continuations land in.
  // Proved by rulings-c.test.ts "R126 re-enters a delayed continuation under the `delayed` hook",
  // "R126 re-enters a delayed continuation that lives in the card's `resume` step table".
  it("R126 resolves both shapes a delayed continuation may take through one reader", () => {
    provenIn(126, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R127 resolves a delayed continuation whose instance is gone, with
  // ctx.self null and its data", "R127 resolves a delayed continuation whose instance has since
  // ceased to exist". R113's "a work item that cannot be resumed is a lost sequence" is the rule
  // this one keeps for the delayed path.
  it("R127 resolves a continuation with no instance, by its stored def id and captured data", () => {
    provenIn(127, "rulings-c.test.ts");
  });

  // M4 owns #13, #17, #88 and #100; `effects/damage.ts`'s `damageAll` is the sweep they call.
  // Proved by rulings-c.test.ts "R128 resolves a two-sided sweep as units in R68 order, then one
  // instance per scoped hero in that order".
  it("R128 sweeps units in R68 order, then one instance per scoped side's hero in that order", () => {
    provenIn(128, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R129 has a fizzling effect draw no randomness, which is why a
  // whole-hand discard is its own verb".
  it("R129 has a fizzling effect draw no randomness, so rngCursor never depends on the board", () => {
    provenIn(129, "rulings-c.test.ts");
  });

  // R32's own clause is rulings-a.test.ts "R32 leaves a coin-stat effect alone: Lucky has no defined
  // best, so it changes nothing"; 004-gary-the-gambler.test.ts proves the card.
  // Proved by rulings-c.test.ts "R130 leaves a roll with no better outcome alone, so Lucky costs it
  // no draw".
  it("R130 re-rolls only a roll with a defined better outcome, so Lucky costs a coin effect no draw", () => {
    provenIn(130, "rulings-c.test.ts");
  });

  // M4 owns #92 Felinor Fiender, whose own exclusion clauses are 092-felinor-fiender.test.ts.
  // Proved by rulings-c.test.ts "R131 never counts Felinor Fiender itself, even when it carries the
  // Felinor tag".
  it("R131 never counts Felinor Fiender itself, matching by instance rather than by tag", () => {
    provenIn(131, "rulings-c.test.ts");
  });

  // R150 generalised this row and closed the gap it used to name: the summing read no longer
  // floors each contributor, so the floor is the combined total's alone.
  // R39's own clause is rulings-a.test.ts "R39 gives Felinor Fiender printed plus the sum of your
  // Felinors, never below printed".
  // Proved by rulings-c.test.ts "R132 applies R39's floor to each stat's combined total, not per
  // Felinor and not across the two stats".
  it("R132 applies R39's floor to each stat's combined total, not per Felinor", () => {
    provenIn(132, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R133 weights a card played twice in one turn once, because the pool
  // is the set of cards played".
  it("R133 weights a card played twice in one turn once: the pool is the set of cards played", () => {
    provenIn(133, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R134 keeps a grade counter on the instance through a change of
  // control, and reads the new controller's turn log".
  it("R134 keeps a grade counter on the instance and reads its current controller's turn log", () => {
    provenIn(134, "rulings-c.test.ts");
  });

  // The two verbs this row needed — one that draws a named card out of a library and one that walks
  // library, then hand, then graveyard by cost — have since landed in the effects barrel.
  // R26's own clause is rulings-a.test.ts "R26 reads Genn's Greed
  // as 'exile all odd-cost cards'"; 094-genns-greed.test.ts is already written as the card should
  // behave and fails for the same reason.
  // Proved by rulings-c.test.ts "R135 exiles each card on its own, and needs a verb that walks
  // library, then hand, then graveyard".
  it("R135 exiles library, then hand, then graveyard, each card its own exile, after the draw", () => {
    expect(config.GENN_GREED_EXILES).toBe("odd");
    provenIn(135, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R136 gives a script its own event window, so an earlier event in
  // the same action is not its own".
  it("R136 gives a script its own event window, not the whole action's", () => {
    provenIn(136, "rulings-c.test.ts");
  });

  // M7 owns apps/server/src/match/actor.ts. NOTE: the server suite covers this but names no test
  // after the row, so the index asserts the scope against the actor itself.
  it("R137 gives each seat R109's action allowance, so neither player can spend the other's", () => {
    const source = sourceOf(SERVER_ACTOR);
    // The window is held per seat: one array indexed by player, not one shared list.
    expect(source).toMatch(/function floodExceeded\(player: PlayerId/);
    expect(source).toMatch(/const recent = recentActions\[player\];/);
    // Each seat's budget is R109's number, so the match's aggregate ceiling is twice it.
    expect(source).toMatch(/recent\.length >= MATCH_ACTIONS_PER_SECOND/);
    expect(serverConstant(SERVER_CONFIG, "MATCH_ACTIONS_PER_SECOND")).toBe("5");
  });

  // Proved by rulings-c.test.ts "R138 counts a cast permanent with no zone as played, resolves it,
  // and sends it to its owner's graveyard".
  it("R138 plays and resolves a cast permanent with no zone, then sends it to the graveyard", () => {
    provenIn(138, "rulings-c.test.ts");
  });

  // R103's priority is rulings-c.test.ts "R103 checks once-per-turn before mana, turn and phase".
  // Proved by rulings-c.test.ts "R139 lapses a once-per-turn limit at the turn boundary, so a later
  // turn is told whose turn it is".
  it("R139 lapses a once-per-turn limit at the turn boundary", () => {
    provenIn(139, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R140 gives a zone-less Stack play the leftmost empty zone, and
  // lifts the occupancy refusal only for a zone the play names".
  it("R140 gives a zone-less Stack play the leftmost empty zone, lifting occupancy only when named", () => {
    provenIn(140, "rulings-c.test.ts");
  });

  // NOTE: no server test names this row; the index asserts the two numbers that make it true.
  it("R141 makes L5 unreachable on its own, given R111's one-copy launch grant", () => {
    // R111 grants exactly one copy of every non-token card, and a loadout may use one copy of a
    // card, so using more copies than are owned needs a second copy, a Token, or an id outside the
    // catalog — which is L3, L4 or L6 first. Change either number and L5 becomes reachable alone.
    expect(sourceOf(SERVER_COLLECTION_SQL)).toMatch(/SPEC §11 R111: the launch quantity/);
    expect(sourceOf(SERVER_LOADOUTS_SQL)).toMatch(/L5 card % totals % copies across the loadout, only % owned/);
  });

  // R110's own proof is the SQL heading above; R142 says what the end-to-end suite may assert
  // instead, since no client can ask for a specific room code.
  it("R142 verifies R110 on the server, and end-to-end only through its consequence", () => {
    // The consequence a client can see: once the match is over, both players' in-match state is
    // cleared, so both are queue-eligible again.
    expect(sourceOf(SERVER_SQL)).toMatch(/current_match_id is null as cleared/);
    // And the reuse itself is proved where a caller can name a code: the server's own script.
    provenIn(110, SERVER_SQL);
  });

  // Proved by e2e.test.ts "R143 — the optional seed".
  it("R143 has the server mint a match's seed, with end-to-end mode the one exception", () => {
    provenIn(143, SERVER_E2E_TEST);
  });

  // Proved by e2e.test.ts "R144 — the reseed at boot".
  it("R144 reseeds the fixture accounts and invite codes per run, so a spec is repeatable", () => {
    provenIn(144, SERVER_E2E_TEST);
  });

  // NOTE: no server test names this row; the index asserts the split against the redemption path.
  it("R145 gives every code-dependent refusal the identical error, and reports account state distinctly", () => {
    const source = sourceOf(SERVER_CODES);
    // One message for everything that depends on the code (R107's constant-time floor makes the
    // timing match too).
    expect(source).toMatch(/new ApiError\("invalid_code", REDEMPTION_IDENTICAL_ERROR\)/);
    // And distinct errors for what depends only on the caller's own account, which leaks nothing
    // about the code space.
    expect(source).toMatch(/new ApiError\("account_banned"/);
    expect(source).toMatch(/new ApiError\("email_unverified"/);
  });

  // NOTE: no server test names this row; the index asserts the attribution against the result path.
  it("R146 stamps a lifecycle result with the seat it belongs to, not with whoever was active", () => {
    const source = sourceOf(SERVER_RESULTS);
    expect(source).toMatch(/function scoreForSeat\(outcome: TerminalOutcome, seat: MatchSeat\)/);
    expect(source).toMatch(/outcome\.winner === seat\.player/);
  });

  // NOTE: no server test names this row; the index asserts the guard against the clock.
  it("R147 keeps the first deadline when a second grace starts, so a flapping socket cannot extend it", () => {
    const source = sourceOf(SERVER_CLOCK);
    // The guard: a grace already counting down is left alone rather than re-armed.
    expect(source).toMatch(/startGrace: \(player: PlayerId\): void => \{[\s\S]*?if \(countdown\.timer !== null\) return;/);
  });

  // NOTE: no server test names this row; the index asserts the four codes, as R104 does its alphabet.
  it("R148 mirrors the HTTP statuses in its close codes, with 1011 for an internal fault", () => {
    const source = sourceOf(SERVER_WS);
    expect(source).toMatch(/unauthorized: 4401,/);
    expect(source).toMatch(/forbidden: 4403,/);
    expect(source).toMatch(/notFound: 4404,/);
    expect(source).toMatch(/internal: 1011,/);
    // §9.1: only the close code varies, so a socket never learns which check refused it.
    expect(source).toMatch(/private-use mirrors of the HTTP statuses/);
  });

  // NOTE: no server test names this row; the index asserts the bound against the mint.
  it("R149 mints a room code by retrying a bounded number of times, then reports none available", () => {
    const source = sourceOf(SERVER_ROOMS);
    // Bounded, not an unbounded retry: a fixed count, and a refusal when it runs out.
    expect(source).toMatch(/const CODE_ATTEMPTS = \d+;/);
    expect(source).toMatch(/for \(let attempt = 0; attempt < CODE_ATTEMPTS; attempt \+= 1\)/);
    expect(source).toMatch(/could not allocate a room code/);
  });

  // R132 is the rule this one generalises; R116 fixes what the hook returns.
  // Proved by rulings-c.test.ts "R132 applies R39's floor to each stat's combined total, not per
  // Felinor and not across the two stats".
  it("R150 keeps a stat floor off each contributor of a summing read", () => {
    provenIn(150, "rulings-c.test.ts");
  });

  // R43's own roll clauses are heroPower.test.ts.
  // Proved by rulings-c.test.ts "R151 rolls a Heroic Power's power as it arrives in a hand, not only
  // at the start of the game".
  it("R151 rolls a Heroic Power's power as it arrives anywhere a card can be looked at", () => {
    provenIn(151, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R152 clears the AI lockout at the end of the turn it was set for".
  it("R152 clears the AI lockout at the end of the turn it was set for", () => {
    provenIn(152, "rulings-c.test.ts");
  });

  // Proved by rulings-c.test.ts "R153 registers only the hooks a card's zone allows, so a hand or a
  // graveyard answers no start- or end-of-turn hook".
  it("R153 registers only the hooks a card's zone allows", () => {
    provenIn(153, "rulings-c.test.ts");
  });

  // R97 carries an amendment for this row: a fired trap is consumed into a public graveyard, so the
  // generic zone-keyed redaction would hand the opponent its identity. It is keyed to the controller.
  // Proved by rulings-c.test.ts "R154 carries the trap's row and lane on trapFired, with its
  // identity redacted for the other player".
  it("R154 carries a trap's row and lane on trapFired, its identity following R97's redaction", () => {
    provenIn(154, "rulings-c.test.ts");
  });

  // §5.1 named no step that did the flagging, so the flag was declared and written by nothing.
  // R153's graveyard gate is the flag alone now, which is the second half of this row.
  // Proved by rulings-c.test.ts "R155 flags a Spell that asks to return as step 7 lands it in the
  // graveyard, and clears it that turn", "R155 makes the flag alone the graveyard's gate, so this
  // turn's play log is not enough"; trigger-zones.test.ts "R155 the flag, not the turn log, is what
  // lets a graveyard spell answer its return".
  it("R155 sets the return-to-hand flag at step 7 and clears it at the end of that turn", () => {
    provenIn(155, "rulings-c.test.ts", "trigger-zones.test.ts");
  });

  // Proved by death-pause.test.ts "R156 owes step 3 in full rather than firing a Death hook into an
  // open prompt", with its control "the same death fires at once with no prompt open".
  it("R156 owes §4.5 step 3 in full when the check begins with a prompt already open", () => {
    provenIn(156, "death-pause.test.ts");
  });

  // Proved by apps/server rate-limit.test.ts "R157 keys a request that names no account on its
  // address, and keeps those apart too".
  it("R157 counts an accountless API request against its address, in its own namespace", () => {
    provenIn(157, "../../../apps/server/test/api/rate-limit.test.ts");
  });
});

describe("SPEC §11 index completeness", () => {
  /**
   * The documented invariant of `sqlHeadings` (03_match_lifecycle.sql's header, docs/architecture.md
   * §12): an SQL evidence script credits a row only through a `### R<n>: …` / `=== … (R<n>): … ===`
   * heading, and a bare mention in prose is not a proof.
   *
   * R107, R108 and R109 are the case that breaks first if the matcher is ever loosened to a
   * substring search: `03` names all three in a comment precisely to record that it does **not**
   * prove them, so a substring search would credit exactly the three rows the file disclaims.
   */
  it("credits an SQL row only from a heading, so R107–R109's prose disclaimer is not a proof", () => {
    const sqlFiles = [SERVER_SQL, SERVER_SCHEMA_SQL];
    const credited = (row: number): string[] =>
      sqlFiles.filter((file) => proofsFor(file, row).length > 0);

    // The six rows the SQL genuinely proves, each from a heading.
    for (const row of [104, 105, 106, 110, 111, 112]) {
      expect(credited(row), `R${row} should be credited by an SQL heading`).not.toEqual([]);
    }
    // The three it names only to disclaim. The prose really is there, or this proves nothing.
    for (const row of [107, 108, 109]) {
      expect(sourceOf(SERVER_SQL), `R${row} should still be named in the file's prose`).toMatch(
        new RegExp(`\\bR${row}\\b`),
      );
      expect(credited(row), `R${row} must not be credited from prose`).toEqual([]);
    }
  });

  it("has one test per §11 row and names no row the spec does not have", () => {
    const spec = readFileSync(new URL("../../../SPEC.md", import.meta.url), "utf8");
    const rows = [...spec.matchAll(/^\| R(\d+) \|/gm)].map((match) => Number(match[1]));
    const named = rulingTitles("rulings.test.ts").map((title) => Number(/^R(\d+)/.exec(title)?.[1]));

    expect(rows.length).toBeGreaterThan(0);
    // Ascending, no duplicates, and exactly the rows §11 has: a new row makes this red.
    expect(named).toEqual(rows);
  });
});
