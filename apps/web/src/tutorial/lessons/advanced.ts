// Lesson "advanced" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/advanced.ts.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "advanced",
  number: 4,
  title: "Tricks of the trade",
  summary: "The mulligan, The Coin, Radiant cards, tribes and tokens.",
  mechanics: ["Mulligan", "The Coin", "Radiant", "Tribes", "Tokens", "Tribute"],
  seed: "tutorial-advanced",
  humanSeat: "p2",
  humanDeck: [
    "core-062", // Friend of Felinors
    "core-012", // Duplicating Felinors
    "core-043", // Big Felinor
    "core-092", // Felinor Fiender
    "core-026", // Glowy Jelly Bean
    "core-081", // Radiant Saintess
    "core-066", // The Rock
    "core-008", // Mr. Vanilla
    "core-011", // Tempo Timmy
    "core-020", // Pointmaster
    "core-013", // Jlockeed Shredder-10
    "core-019", // Midrange Menace
    "core-025", // 4-mana 7/7
    "core-044", // True Strike
    "core-016", // Hit Job
    "core-035", // Lunar Eclipse
    "core-032", // Prem Panther
    "core-045", // Deft Duelist
    "core-068", // Twisted Sorcerer
    "core-054", // Straaza
  ],
  aiDeck: [
    "core-003", // Right-house defender
    "core-008", // Mr. Vanilla
    "core-004", // Gary the Gambler
    "core-037", // Gravedigger
    "core-001", // Big D-fender
    "core-030", // Archivist
    "core-077", // Professor Curvature
    "core-020", // Pointmaster
    "core-011", // Tempo Timmy
    "core-041", // Sheepish
    "core-044", // True Strike
    "core-005", // Stockpile
  ],
  retryTip: "Send expensive cards back in the mulligan, and use The Coin to play a big card a turn early.",
};
