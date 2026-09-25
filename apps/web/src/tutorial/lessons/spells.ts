// Lesson "spells" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/spells.ts.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "spells",
  number: 2,
  title: "Spells and keywords",
  summary: "Cast spells at targets, and learn what Taunt, Rush, Charge and friends do.",
  mechanics: ["Spells", "Targets", "Cry", "Taunt", "Rush and Charge", "Divine Shield", "Defense Position"],
  seed: "tutorial-spells",
  humanSeat: "p1",
  humanDeck: [
    "core-011", // Tempo Timmy
    "core-044", // True Strike
    "core-035", // Lunar Eclipse
    "core-016", // Hit Job
    "core-045", // Deft Duelist
    "core-068", // Twisted Sorcerer
    "core-020", // Pointmaster
    "core-056", // Jilliax
    "core-003", // Right-house defender
    "core-032", // Prem Panther
    "core-013", // Jlockeed Shredder-10
    "core-019", // Midrange Menace
    "core-025", // 4-mana 7/7
    "core-054", // Straaza
    "core-008", // Mr. Vanilla
    "core-005", // Stockpile
    "core-047", // Fig of Life
    "core-053", // Reno
    "core-037", // Gravedigger
    "core-077", // Professor Curvature
  ],
  aiDeck: [
    "core-003", // Right-house defender
    "core-008", // Mr. Vanilla
    "core-004", // Gary the Gambler
    "core-012", // Duplicating Felinors
    "core-037", // Gravedigger
    "core-001", // Big D-fender
    "core-030", // Archivist
    "core-077", // Professor Curvature
    "core-061", // Prejudiced Postdoc
    "core-005", // Stockpile
    "core-020", // Pointmaster
    "core-011", // Tempo Timmy
  ],
  retryTip: "Spells can clear a Taunt out of the way, so your units can reach the hero.",
};
