// Lesson "traps" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/traps.ts.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "traps",
  number: 3,
  title: "The backrow",
  summary: "Set traps face-down, spring them on the AI, and watch out for its own.",
  mechanics: ["The backrow", "Traps", "Field Spells", "Quickdraw", "Tokens"],
  seed: "tutorial-traps",
  humanSeat: "p1",
  humanDeck: [
    "core-084", // Going Long (Quickdraw)
    "core-041", // Sheepish
    "core-060", // Bear Honeypot
    "core-036", // Magic Jammed
    "core-058", // Rush Token Farm
    "core-006", // Mana Well
    "core-008", // Mr. Vanilla
    "core-015", // Me and Mr Token
    "core-011", // Tempo Timmy
    "core-012", // Duplicating Felinors
    "core-037", // Gravedigger
    "core-020", // Pointmaster
    "core-013", // Jlockeed Shredder-10
    "core-019", // Midrange Menace
    "core-025", // 4-mana 7/7
    "core-054", // Straaza
    "core-044", // True Strike
    "core-016", // Hit Job
    "core-068", // Twisted Sorcerer
    "core-003", // Right-house defender
  ],
  aiDeck: [
    "core-060", // Bear Honeypot
    "core-008", // Mr. Vanilla
    "core-004", // Gary the Gambler
    "core-012", // Duplicating Felinors
    "core-037", // Gravedigger
    "core-003", // Right-house defender
    "core-030", // Archivist
    "core-077", // Professor Curvature
    "core-011", // Tempo Timmy
    "core-020", // Pointmaster
    "core-005", // Stockpile
    "core-044", // True Strike
  ],
  retryTip: "A face-down card could be a trap. Test it with a cheap card before you play your best one.",
};
