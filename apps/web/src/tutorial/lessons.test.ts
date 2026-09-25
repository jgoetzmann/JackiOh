// The tutorial's lessons as data (tutorial/lessons.ts): R291.
//
// A lesson is a practice game (R187) with two fixed decks, a fixed seed and seat, and the tutorial
// handicap on the AI seat (R290). These tests hold what every lesson must be, whatever its content:
// legal decks, an AI deck of exactly the handicap's size with nothing the AI's shadow ban holds
// back (R186) and nothing the lesson has not taught yet, a deal that is the same every time, and a
// start through the real practice core that hands the page only what the human may see (rule 7).

import { describe, expect, it } from "vitest";

import { registerAll } from "@jackioh/cards";
import { beginGame, createGame, hashState, registeredCatalog } from "@jackioh/engine";
import { AI_TUTORIAL, DECK_SIZE, HERO_HEALTH } from "@jackioh/engine/config";
import { SHADOW_BAN_IDS } from "@jackioh/ai";
import { opponentOf, type CardDef, type PlayerId } from "@jackioh/shared";

import { PRACTICE_SEED_MAX_LENGTH } from "../practice/config.ts";
import { createPracticeCore } from "../practice/core.ts";
import type { PracticeResponse } from "../practice/protocol.ts";
import { TUTORIAL_LESSONS, lessonById, nextLessonOf, type TutorialLesson } from "./lessons.ts";
import { lessonStartConfig } from "./start.ts";
import { scriptFor } from "./scripts/index.ts";

registerAll();
const catalog = registeredCatalog();

/** "Mostly Commons, Rares and Epics; a few fun cards": at most this many Legendary or Mythic cards in a human deck. */
const HUMAN_SHOWPIECES_MAX = 2;
const SHOWPIECE_RARITIES: readonly string[] = ["Legendary", "Mythic"];

/**
 * R291: what the AI may not hold before the lesson that teaches it. Lesson 1 teaches units and
 * combat, so its AI plays plain units only; lesson 2 teaches spells and keywords; lesson 3 the
 * backrow, so no Trap, Field Trap or Field Spell reaches the AI before it.
 */
const BACKROW_TYPES: readonly string[] = ["Trap", "Field Trap", "Field Spell"];
const BACKROW_LESSON = 3;
const SPELL_LESSON = 2;
/** Keywords that change how attacking works (§4, §6.1): lesson 2's subject, so never on lesson 1's AI. */
const COMBAT_KEYWORDS: readonly string[] = [
  "Taunt",
  "Rush",
  "Charge",
  "First Strike",
  "Divine Shield",
  "Reborn",
  "Poisonous",
  "Lifesteal",
  "Trample",
  "Cleave",
  "Indestructible",
  "Stack",
  "Can't attack",
];

/**
 * R290, R291: cards that read their controller's health against §2's 30, which the tutorial hero's
 * 20 bends: #53 Reno would lift the AI's hero from 20 to 30, and #70 Spiteful Stab counts ten health
 * as already missing (R72), so both would hand the tutorial opponent more than a human gets.
 */
const READS_THIRTY: readonly string[] = ["core-053", "core-070"];

function def(id: string): CardDef {
  const found = catalog[id];
  if (found === undefined) throw new Error(`${id} is not in the catalog`);
  return found;
}

function decksOf(lesson: TutorialLesson): [string[], string[]] {
  return lesson.humanSeat === "p1" ? [[...lesson.humanDeck], [...lesson.aiDeck]] : [[...lesson.aiDeck], [...lesson.humanDeck]];
}

function dealOf(lesson: TutorialLesson, seed = lesson.seed) {
  const aiSeat = opponentOf(lesson.humanSeat);
  return beginGame(createGame({ seed, decks: decksOf(lesson), handicaps: { [aiSeat]: AI_TUTORIAL } })).state;
}

describe("R291 the tutorial's lessons", () => {
  it("R291 are three or four, numbered in path order, each with a script whose last step is final", () => {
    expect(TUTORIAL_LESSONS.length).toBeGreaterThanOrEqual(3);
    expect(TUTORIAL_LESSONS.length).toBeLessThanOrEqual(4);
    expect(TUTORIAL_LESSONS.map((lesson) => lesson.number)).toEqual(TUTORIAL_LESSONS.map((_lesson, index) => index + 1));
    expect(new Set(TUTORIAL_LESSONS.map((lesson) => lesson.id)).size).toBe(TUTORIAL_LESSONS.length);

    for (const lesson of TUTORIAL_LESSONS) {
      expect(lessonById(lesson.id)).toBe(lesson);
      expect(lesson.title.length, lesson.id).toBeGreaterThan(0);
      expect(lesson.mechanics.length, lesson.id).toBeGreaterThan(0);
      expect(lesson.retryTip.length, lesson.id).toBeGreaterThan(0);
      expect(lesson.seed.length, lesson.id).toBeGreaterThan(0);
      expect(lesson.seed.length, lesson.id).toBeLessThanOrEqual(PRACTICE_SEED_MAX_LENGTH);

      const script = scriptFor(lesson.id);
      expect(script, lesson.id).toBeDefined();
      if (script === undefined) continue;
      expect(script.lessonId).toBe(lesson.id);
      const ids = [...script.steps.map((step) => step.id), ...script.tips.map((tip) => tip.id)];
      expect(new Set(ids).size, `${lesson.id}: step and tip ids are unique`).toBe(ids.length);
      expect(script.steps.at(-1)?.final, `${lesson.id}: the last step ends with the game`).toBe(true);
      for (const step of script.steps) {
        if (step.kind === "act") expect(step.done, `${lesson.id}/${step.id}: an act step says when it is done`).toBeDefined();
      }
    }
    const [first] = TUTORIAL_LESSONS;
    expect(first === undefined ? undefined : nextLessonOf(first.id)).toBe(TUTORIAL_LESSONS[1]);
    expect(nextLessonOf(TUTORIAL_LESSONS.at(-1)?.id ?? "")).toBeUndefined();
  });

  it("R291 give the human a legal twenty-card deck, mostly Commons, Rares and Epics", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      expect(lesson.humanDeck.length, lesson.id).toBe(DECK_SIZE);
      expect(new Set(lesson.humanDeck).size, `${lesson.id}: no duplicates (§2.6)`).toBe(DECK_SIZE);
      for (const id of lesson.humanDeck) expect(def(id).token, `${lesson.id}: ${id} is no Token`).toBe(false);
      const showpieces = lesson.humanDeck.filter((id) => SHOWPIECE_RARITIES.includes(def(id).rarity));
      expect(showpieces.length, `${lesson.id}: ${showpieces.join(", ")}`).toBeLessThanOrEqual(HUMAN_SHOWPIECES_MAX);
    }
  });

  it("R291 give the AI exactly the tutorial handicap's deck, free of the shadow ban and of anything not yet taught", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      const deck = lesson.aiDeck;
      expect(deck.length, lesson.id).toBe(AI_TUTORIAL.deckSize);
      expect(new Set(deck).size, `${lesson.id}: no duplicates`).toBe(deck.length);
      for (const id of deck) {
        const card = def(id);
        const where = `${lesson.id}: ${id} ${card.name}`;
        expect(card.token, where).toBe(false);
        if (lesson.aiShadowBanned?.[id] === undefined) expect(SHADOW_BAN_IDS, where).not.toContain(id);
        expect(SHOWPIECE_RARITIES, where).not.toContain(card.rarity);
        expect(READS_THIRTY, `${where}: reads its hero's health against 30`).not.toContain(id);
        if (lesson.number < BACKROW_LESSON) expect(BACKROW_TYPES, `${where}: no backrow card before lesson ${String(BACKROW_LESSON)}`).not.toContain(card.type);
        if (lesson.number < SPELL_LESSON) {
          expect(card.type, `${where}: units only in lesson 1`).toBe("Unit");
          // The base face only: nothing in a lesson-1 deck makes a card Radiant.
          const keywords = card.base.keywords.map((keyword) => keyword.kind);
          for (const keyword of keywords) expect(COMBAT_KEYWORDS, `${where}: ${keyword}`).not.toContain(keyword);
        }
      }
    }
  });

  it("R291 name every shadow-banned card of an AI deck with its reason, and name no other", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      for (const [id, reason] of Object.entries(lesson.aiShadowBanned ?? {})) {
        expect(lesson.aiDeck, `${lesson.id}: ${id} is in the AI's deck`).toContain(id);
        expect(SHADOW_BAN_IDS, `${lesson.id}: ${id} is on the shadow ban`).toContain(id);
        expect(reason.length, `${lesson.id}: ${id} says why`).toBeGreaterThan(0);
      }
    }
  });

  it("R291 deal the same opening hands and libraries every time, and a different seed deals differently", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      const a = dealOf(lesson);
      const b = dealOf(lesson);
      expect(hashState(a), lesson.id).toBe(hashState(b));
      const human = lesson.humanSeat;
      expect(a.players[human].hand.map((card) => card.defId), lesson.id).toEqual(b.players[human].hand.map((card) => card.defId));
      const other = dealOf(lesson, `${lesson.seed}:other`);
      expect(hashState(other), lesson.id).not.toBe(hashState(a));
    }
  });

  it("R291 start through the practice core with the lesson's decks and the tutorial handicap, showing the page only the human's side", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      const core = createPracticeCore({ now: () => 0, dev: true });
      const started: PracticeResponse = core.handle({ id: 1, type: "start", config: lessonStartConfig(lesson) });
      expect(started.type, lesson.id).toBe("started");
      if (started.type !== "started") continue;
      const aiSeat: PlayerId = opponentOf(lesson.humanSeat);
      expect(started.aiSeat).toBe(aiSeat);

      const { view } = started.snapshot;
      expect(view.viewer).toBe(lesson.humanSeat);
      expect(view.you.hero.health).toBe(HERO_HEALTH);
      expect(view.opponent.hero.health).toBe(AI_TUTORIAL.heroHealth);
      // Rule 7: the AI's hand is a count, never its cards.
      expect(Array.isArray(view.opponent.hand), lesson.id).toBe(false);

      const debug = core.handle({ id: 2, type: "debug" });
      expect(debug.type).toBe("debug");
      if (debug.type !== "debug") continue;
      expect(debug.debug.lesson).toBe(lesson.id);
      expect(debug.debug.seed).toBe(lesson.seed);
      expect(debug.debug.decks).toEqual(decksOf(lesson));
      expect(debug.debug.handicaps).toEqual({ [aiSeat]: AI_TUTORIAL });
    }
  });

  it("R291 refuse an unknown lesson rather than play some other game", () => {
    const core = createPracticeCore({ now: () => 0, dev: true });
    const [lesson] = TUTORIAL_LESSONS;
    if (lesson === undefined) throw new Error("no lessons");
    const response = core.handle({ id: 1, type: "start", config: { ...lessonStartConfig(lesson), lesson: "no-such-lesson" } });
    expect(response.type).toBe("failed");
  });

  it("R291 seat the human second in the lesson that teaches The Coin, and first before it", () => {
    for (const lesson of TUTORIAL_LESSONS) {
      const coin = lesson.mechanics.includes("The Coin");
      expect(lesson.humanSeat, lesson.id).toBe(coin ? "p2" : "p1");
    }
  });
});
