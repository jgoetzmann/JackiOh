// The tutorial's lessons as data (SPEC §9.10, R291): what each teaches, and the two fixed decks,
// the seed and the seat it is played with.
//
// Plain data, no engine import: the practice worker's core reads the decks from here (a lesson game
// is a practice game with these decks and the tutorial handicap, `AI_TUTORIAL`, R290), and the page
// reads the titles and mechanics for the lesson path. What the coach says during a lesson is its
// script (`scripts/`), which only the page loads.
//
// Every deck is fixed, and so is every seed, so a lesson deals the same opening hands and the same
// draws every time it is played, and the coach can name the cards it will point at. The human's
// deck is a legal twenty-card deck (§2.6); the AI's holds exactly `AI_TUTORIAL.deckSize` cards
// (R184) and never a card the lesson has not taught yet: no Spell before lesson 2, no Trap before
// lesson 3 (R291). `lessons.test.ts` holds all of it.

import type { PlayerId } from "@jackioh/shared";

import { lesson as advanced } from "./lessons/advanced.ts";
import { lesson as basics } from "./lessons/basics.ts";
import { lesson as spells } from "./lessons/spells.ts";
import { lesson as traps } from "./lessons/traps.ts";

export type TutorialLesson = {
  /** The URL's `?lesson=` and the progress store's key. */
  id: string;
  /** 1-based: the path's order. */
  number: number;
  title: string;
  /** One line: what the lesson is about. */
  summary: string;
  /** What it teaches, a few words each: the path lists them. */
  mechanics: readonly string[];
  seed: string;
  humanSeat: PlayerId;
  /** DECK_SIZE distinct non-token Core ids. */
  humanDeck: readonly string[];
  /** AI_TUTORIAL.deckSize distinct non-token Core ids, none on the shadow ban (R186). */
  aiDeck: readonly string[];
  /** Shown after a loss, beside Retry. */
  retryTip: string;
};


/** The lesson path, in order. */
export const TUTORIAL_LESSONS: readonly TutorialLesson[] = [basics, spells, traps, advanced];

export function lessonById(id: string): TutorialLesson | undefined {
  return TUTORIAL_LESSONS.find((lesson) => lesson.id === id);
}

/** The lesson after this one on the path, if any. */
export function nextLessonOf(id: string): TutorialLesson | undefined {
  const lesson = lessonById(id);
  return lesson === undefined ? undefined : TUTORIAL_LESSONS.find((candidate) => candidate.number === lesson.number + 1);
}
