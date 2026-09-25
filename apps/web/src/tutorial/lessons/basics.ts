// Lesson "basics" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/basics.ts.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "basics",
  number: 1,
  title: "First steps",
  summary: "Play units, attack, and bring the enemy hero down to 0.",
  mechanics: ["Mana", "Playing units", "Lanes", "Attacking", "Hero health", "Winning"],
  seed: "tutorial-basics",
  humanSeat: "p1",
  humanDeck: [
    "core-008", // Mr. Vanilla
    "core-004", // Gary the Gambler
    "core-012", // Duplicating Felinors
    "core-037", // Gravedigger
    "core-077", // Professor Curvature
    "core-013", // Jlockeed Shredder-10
    "core-053", // Reno
    "core-025", // 4-mana 7/7
    "core-054", // Straaza
    "core-020", // Pointmaster
    "core-030", // Archivist
    "core-003", // Right-house defender
    "core-011", // Tempo Timmy
    "core-015", // Me and Mr Token
    "core-019", // Midrange Menace
    "core-045", // Deft Duelist
    "core-056", // Jilliax
    "core-068", // Twisted Sorcerer
    "core-032", // Prem Panther
    "core-066", // The Rock
  ],
  aiDeck: [
    "core-008", // Mr. Vanilla
    "core-004", // Gary the Gambler
    "core-012", // Duplicating Felinors
    "core-037", // Gravedigger
    "core-077", // Professor Curvature
    "core-030", // Archivist
    "core-061", // Prejudiced Postdoc
    "core-001", // Big D-fender
    "core-020", // Pointmaster
    "core-015", // Me and Mr Token
    "core-011", // Tempo Timmy
    "core-091", // Fed Fauci
  ],
  retryTip: "Attack the enemy hero whenever nothing stands in the way: every point of damage counts.",
};
