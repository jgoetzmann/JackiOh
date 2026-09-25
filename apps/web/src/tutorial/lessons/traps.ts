// Lesson "traps" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/traps.ts.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "traps",
  number: 3,
  title: "The backrow",
  summary: "Set traps face-down, spring them on the AI, and watch out for its own.",
  mechanics: ["The backrow", "Traps", "Field Spells", "Quickdraw", "Tokens"],
  // This seed deals Bear Honeypot and Going Long in the opening hand, Rush Token Farm as the first
  // draw and Tempo Timmy on turn 4, and the AI's Sheepish in its first draw: the AI sets it on its
  // third turn, just before Tempo Timmy arrives to test it. Scanned with scripts/lesson-deal.ts.
  seed: "tutorial-traps-2225",
  humanSeat: "p1",
  humanDeck: [
    "core-084", // Going Long (Quickdraw)
    "core-060", // Bear Honeypot
    "core-041", // Sheepish
    "core-058", // Rush Token Farm
    "core-006", // Mana Well
    "core-015", // Me and Mr Token
    "core-011", // Tempo Timmy
    "core-003", // Right-house defender
    "core-020", // Pointmaster
    "core-068", // Twisted Sorcerer
    "core-032", // Prem Panther
    "core-045", // Deft Duelist
    "core-056", // Jilliax
    "core-002", // Bigot
    "core-019", // Midrange Menace
    "core-013", // Jlockeed Shredder-10
    "core-025", // 4-mana 7/7
    "core-044", // True Strike
    "core-016", // Hit Job
    "core-037", // Gravedigger
  ],
  aiDeck: [
    "core-041", // Sheepish
    "core-056", // Jilliax
    "core-040", // Echoes of the Forgotten
    "core-073", // Anti-oneshot Armor
    "core-030", // Archivist
    "core-077", // Professor Curvature
    "core-001", // Big D-fender
    "core-061", // Prejudiced Postdoc
    "core-012", // Duplicating Felinors
    "core-045", // Deft Duelist
    "core-032", // Prem Panther
    "core-006", // Mana Well
  ],
  // Sheepish is the AI's only card that costs 1, so once it has three crystals it spends the last
  // one setting the trap beside a 2-cost card (on its third turn, on the coach's line and on the
  // autopilot's), rather than on a cheap unit or spell. No Gravedigger, which could hand the AI its
  // fired trap back turn after turn.
  retryTip: "A face-down card could be a trap. Test it with a cheap unit before you play your best one.",
};
