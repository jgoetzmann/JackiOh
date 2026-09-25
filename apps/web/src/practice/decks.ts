// The practice decks a human can pick, and the `<select>` values that name them.
//
// The presets are hand-built lists with a name and a one-line identity, so the player knows what
// they are about to play before they press Start (the setup shows each one's cards and curve,
// read from the catalog the worker sends). Each is twenty distinct, token-free Core cards that the
// engine checks like any deck (§2.6), and none is on the AI's shadow ban (R186): the sweep found
// those cards never worth playing, which is no way to meet the game. `core.test.ts` holds both
// rules. The ids are plain data here; the worker's core turns the list into a deck.

import { DECK_SIZE } from "@jackioh/engine/config";

import type { PracticeDeckChoice } from "./protocol.ts";

export type PracticePreset = {
  id: string;
  name: string;
  /** One line: what the deck does and how it wins. */
  identity: string;
  /** Exactly DECK_SIZE distinct non-token Core ids, cheapest first. */
  cards: readonly string[];
};

export const PRACTICE_PRESETS: readonly PracticePreset[] = [
  {
    id: "humans",
    name: "Human Vanguard",
    identity: "Humans hold the line: cheap bodies, Taunt and armor, then The Rock and friends.",
    cards: [
      "core-003", // Right-house defender
      "core-005", // Stockpile
      "core-008", // Mr. Vanilla
      "core-011", // Tempo Timmy
      "core-015", // Me and Mr Token
      "core-081", // Radiant Saintess
      "core-001", // Big D-fender
      "core-016", // Hit Job
      "core-020", // Pointmaster
      "core-045", // Deft Duelist
      "core-061", // Prejudiced Postdoc
      "core-069", // Call to Arms
      "core-077", // Professor Curvature
      "core-091", // Fed Fauci
      "core-013", // Jlockeed Shredder-10
      "core-019", // Midrange Menace
      "core-053", // Reno
      "core-025", // 4-mana 7/7
      "core-054", // Straaza
      "core-066", // The Rock
    ],
  },
  {
    id: "blitz",
    name: "Blitz",
    identity: "Rush, Charge and burn: hit hard early and finish the job with spells.",
    cards: [
      "core-004", // Gary the Gambler
      "core-008", // Mr. Vanilla
      "core-011", // Tempo Timmy
      "core-015", // Me and Mr Token
      "core-035", // Lunar Eclipse
      "core-044", // True Strike
      "core-063", // Plastic Surgery
      "core-074", // Adaptive UI
      "core-012", // Duplicating Felinors
      "core-020", // Pointmaster
      "core-032", // Prem Panther
      "core-045", // Deft Duelist
      "core-056", // Jilliax
      "core-058", // Rush Token Farm
      "core-068", // Twisted Sorcerer
      "core-013", // Jlockeed Shredder-10
      "core-070", // Spiteful Stab
      "core-014", // Jlockeed's Weapons
      "core-025", // 4-mana 7/7
      "core-054", // Straaza
    ],
  },
  {
    id: "fortress",
    name: "Fortress",
    identity: "Removal, Taunts and card draw: weather the storm, then win with giants.",
    cards: [
      "core-003", // Right-house defender
      "core-005", // Stockpile
      "core-035", // Lunar Eclipse
      "core-036", // Magic Jammed
      "core-041", // Sheepish
      "core-044", // True Strike
      "core-009", // Moths to the Flame
      "core-016", // Hit Job
      "core-030", // Archivist
      "core-037", // Gravedigger
      "core-056", // Jilliax
      "core-073", // Anti-oneshot Armor
      "core-013", // Jlockeed Shredder-10
      "core-019", // Midrange Menace
      "core-049", // Snom Bunny Mind Control
      "core-053", // Reno
      "core-088", // Twisting Nether
      "core-025", // 4-mana 7/7
      "core-054", // Straaza
      "core-066", // The Rock
    ],
  },
];

export function presetById(id: string): PracticePreset | undefined {
  return PRACTICE_PRESETS.find((preset) => preset.id === id);
}

/** What the random choice deals, in the same words the setup uses for a preset's identity. */
export const RANDOM_DECK_IDENTITY =
  "A fresh twenty-card deck every game, dealt with a sensible mana curve. You meet it in your opening hand.";

/**
 * One of the player's saved decks, as `GET /api/decks` lists them (R250): oldest first, named, and
 * possibly a draft that is not complete yet.
 */
export type PracticeSavedDeck = { name: string; cards: readonly string[] };

/**
 * Whether a saved deck can start a practice game: exactly `DECK_SIZE` cards. A saved deck is a draft
 * (R250), so a shorter one is listed but not offered. It is a label, not a rule: the worker's
 * `createGame` checks every deck it is given (§2.6), a complete one included.
 */
export function isPlayableSavedDeck(deck: PracticeSavedDeck): boolean {
  return deck.cards.length === DECK_SIZE;
}

const RANDOM_VALUE = "random";
const PRESET_PREFIX = "preset:";
const SAVED_PREFIX = "saved:";

/** "random" | "preset:<id>" | "saved:<n>", n the 1-based position in the saved list */
export function deckChoiceValue(choice: PracticeDeckChoice): string {
  switch (choice.kind) {
    case "random":
      return RANDOM_VALUE;
    case "preset":
      return `${PRESET_PREFIX}${choice.id}`;
    case "saved":
      return `${SAVED_PREFIX}${String(choice.index)}`;
  }
}

/**
 * The choice a `<select>` value names, or null when it names nothing this device can play: an
 * unknown preset, or a saved deck when none are loaded, the number is out of range or the deck is
 * not complete.
 */
export function deckChoiceFromValue(
  value: string,
  saved: readonly PracticeSavedDeck[] | null,
): PracticeDeckChoice | null {
  if (value === RANDOM_VALUE) return { kind: "random" };

  if (value.startsWith(PRESET_PREFIX)) {
    const id = value.slice(PRESET_PREFIX.length);
    return presetById(id) === undefined ? null : { kind: "preset", id };
  }

  if (value.startsWith(SAVED_PREFIX)) {
    if (saved === null) return null;
    const digits = value.slice(SAVED_PREFIX.length);
    if (!/^[0-9]+$/.test(digits)) return null;
    const index = Number(digits);
    const deck = saved[index - 1];
    if (index < 1 || deck === undefined || !isPlayableSavedDeck(deck)) return null;
    return { kind: "saved", index, cards: [...deck.cards] };
  }

  return null;
}

/** Whether a value is well-formed without the saved decks to check it against (URL params). */
export function isDeckValue(value: string): boolean {
  if (value === RANDOM_VALUE) return true;
  if (value.startsWith(PRESET_PREFIX)) return presetById(value.slice(PRESET_PREFIX.length)) !== undefined;
  return /^saved:[1-9][0-9]*$/.test(value);
}

/** Whether the route may start a game from this value alone, with no saved decks (`?deck=` autostart). */
export function isAutostartDeckValue(value: string): boolean {
  return value === RANDOM_VALUE || (value.startsWith(PRESET_PREFIX) && isDeckValue(value));
}

type DeckOption = { value: string; label: string; disabled: boolean };

/**
 * A saved deck's option label: its name, and for one that is not complete, why it cannot be picked
 * ("Aggro (12 of 20 cards, not complete)").
 */
export function savedDeckLabel(deck: PracticeSavedDeck): string {
  if (isPlayableSavedDeck(deck)) return deck.name;
  return `${deck.name} (${String(deck.cards.length)} of ${String(DECK_SIZE)} cards, not complete)`;
}

/**
 * The setup `<select>`'s options, in order: random, each preset, then each saved deck by name, in
 * the saved list's order. A deck that is not complete is listed, disabled, with the reason.
 */
export function deckOptions(saved: readonly PracticeSavedDeck[] | null): DeckOption[] {
  const options: DeckOption[] = [{ value: RANDOM_VALUE, label: "Random deck", disabled: false }];
  for (const preset of PRACTICE_PRESETS) {
    options.push({ value: `${PRESET_PREFIX}${preset.id}`, label: preset.name, disabled: false });
  }
  if (saved !== null) {
    saved.forEach((deck, i) => {
      options.push({
        value: `${SAVED_PREFIX}${String(i + 1)}`,
        label: savedDeckLabel(deck),
        disabled: !isPlayableSavedDeck(deck),
      });
    });
  }
  return options;
}
