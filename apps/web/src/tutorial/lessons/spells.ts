// Lesson "spells" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/spells.ts.
//
// The ORDER of each deck list is part of the deal: the seed shuffles by position, so with this seed
// the player is dealt Tempo Timmy, Mr. Vanilla and Twisted Sorcerer and then draws Lunar Eclipse,
// Deft Duelist, True Strike, Hit Job, Big D-fender, Jlockeed Shredder-10, Prem Panther, ... — every
// card the coach teaches with, the turn it needs it (`lesson-deal.ts spells` prints the deal).
// Reordering a list, or swapping one card for another, deals a different game: re-run the lesson's
// tests.
//
// The player's deck is the strong one: the lesson's spells and keyword units, then big finishers.
// The AI's is deliberately weak and plain: small units and one wall (Big D-fender), a Taunt with
// Divine Shield and Reborn that it plays on its first turn (Right-house defender), a second Taunt
// and Divine Shield later (Jilliax), Lunar Eclipse and Stockpile, and nothing from the backrow
// (lesson 3) or beyond the lesson. One card of its twelve is dead weight on purpose: GIGA Glowy
// Jelly Bean costs 6 and the tutorial AI never has more than 4 mana (its cap of 3 and The Coin), so
// it is never cast and the player never sees it.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "spells",
  number: 2,
  title: "Spells and keywords",
  summary: "Cast spells at targets, and learn what Taunt, Rush, Charge and friends do.",
  mechanics: ["Spells and targets", "Cry", "Taunt", "Divine Shield", "Reborn", "Rush and Charge", "First Strike", "Defense Position"],
  seed: "tutorial-spells-367887",
  humanSeat: "p1",
  humanDeck: [
    "core-008", // Mr. Vanilla
    "core-011", // Tempo Timmy
    "core-035", // Lunar Eclipse
    "core-044", // True Strike
    "core-001", // Big D-fender
    "core-068", // Twisted Sorcerer
    "core-016", // Hit Job
    "core-012", // Duplicating Felinors
    "core-003", // Right-house defender
    "core-045", // Deft Duelist
    "core-019", // Midrange Menace
    "core-013", // Jlockeed Shredder-10
    "core-020", // Pointmaster
    "core-037", // Gravedigger
    "core-056", // Jilliax
    "core-005", // Stockpile
    "core-025", // 4-mana 7/7
    "core-053", // Reno
    "core-032", // Prem Panther
    "core-077", // Professor Curvature
  ],
  aiDeck: [
    "core-003", // Right-house defender
    "core-005", // Stockpile
    "core-029", // GIGA Glowy Jelly Bean: costs 6, above the AI's 3 (+ The Coin), so it is never cast
    "core-015", // Me and Mr Token
    "core-056", // Jilliax
    "core-035", // Lunar Eclipse
    "core-030", // Archivist
    "core-077", // Professor Curvature
    "core-045", // Deft Duelist
    "core-037", // Gravedigger
    "core-001", // Big D-fender
    "core-008", // Mr. Vanilla
  ],
  retryTip: "Break a Divine Shield with a small hit before a big one, and clear Taunts with spells, so your units can reach the hero.",
};
