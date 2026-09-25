// Lesson "advanced" as data (SPEC §9.10, R291): ../lessons.ts says what every field means and the
// rules every lesson keeps. Its coach script is ../scripts/advanced.ts.

import type { TutorialLesson } from "../lessons.ts";

export const lesson: TutorialLesson = {
  id: "advanced",
  number: 4,
  title: "Tricks of the trade",
  summary: "The mulligan, The Coin, Radiant cards, tribes, tokens and Tribute.",
  mechanics: ["Mulligan", "The Coin", "Radiant", "Tribes", "Tokens", "Tribute"],
  // The human goes second, so The Coin is theirs (R244). This seed deals Felinor Fiender, Friend of
  // Felinors, Glowy Jelly Bean and the 4-mana 7/7 as the opening hand: the 7/7 is the card to send
  // back, and True Strike comes in its place. The Rock is the third draw, in hand just as Glowy
  // Jelly Bean becomes affordable, and Reno the fourth, glowing yellow once the hero is hurt.
  // Scanned with scripts/lesson-deal.ts.
  seed: "tutorial-advanced-16076",
  humanSeat: "p2",
  humanDeck: [
    "core-062", // Friend of Felinors (Common)
    "core-092", // Felinor Fiender (Legendary: the tribe's payoff)
    "core-026", // Glowy Jelly Bean (Rare)
    "core-066", // The Rock (Common)
    "core-081", // Radiant Saintess (Epic)
    "core-012", // Duplicating Felinors (Rare)
    "core-053", // Reno (Common)
    "core-025", // 4-mana 7/7 (Common)
    "core-015", // Me and Mr Token (Common)
    "core-008", // Mr. Vanilla (Common)
    "core-011", // Tempo Timmy (Common)
    "core-020", // Pointmaster (Common)
    "core-068", // Twisted Sorcerer (Common)
    "core-032", // Prem Panther (Rare)
    "core-045", // Deft Duelist (Rare)
    "core-019", // Midrange Menace (Common)
    "core-013", // Jlockeed Shredder-10 (Common)
    "core-044", // True Strike (Common)
    "core-016", // Hit Job (Common)
    "core-035", // Lunar Eclipse (Rare)
  ],
  // Cheap units and a few small spells: enough to fight over the board and to thin the Felinor
  // Tokens, so The Rock finds a free zone, but nothing that can race a Radiant Rock.
  aiDeck: [
    "core-003", // Right-house defender
    "core-008", // Mr. Vanilla
    "core-004", // Gary the Gambler
    "core-037", // Gravedigger
    "core-005", // Stockpile
    "core-030", // Archivist
    "core-077", // Professor Curvature
    "core-001", // Big D-fender
    "core-011", // Tempo Timmy
    "core-015", // Me and Mr Token
    "core-044", // True Strike
    "core-010", // Rapid Replenish
  ],
  retryTip: "Send expensive cards back in the mulligan, play The Coin on your first turn, and let big units like The Rock do the fighting.",
};
