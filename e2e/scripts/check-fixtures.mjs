// Pre-flight for e2e/fixtures/decks/*.json: the checks the engine's `validateDeck` would make
// (SPEC §9.4 L2/L3/L6, DECK_SIZE = 20, MAX_COPIES = 1, no Token cards), run without a browser or
// a built client so a bad fixture is caught before the suite ever starts.
//
// A fixture may carry a `handicap` (R180), the seat's resources when a scenario needs other than
// SPEC's own (spec 25: a 4-card library, a 9-card opening hand, a 60-card library). It is checked as
// the engine's `validateHandicap` checks one — five non-negative integers, 1 <= deckSize <=
// LIBRARY_CAP (R184) and an optional positive heroHealth (R290) — and L2 is then its deckSize.
//
//   pnpm --dir e2e check:fixtures
//
// Fixtures named 09-illegal-*.json are exempt: spec 09 needs loadouts that break L1-L6 on
// purpose. They still have to say which rule they break.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const here = path.dirname(new URL(import.meta.url).pathname);
const decksDir = path.join(here, "..", "fixtures", "decks");
const catalogPath = path.join(here, "..", "..", "packages", "cards", "catalog.json");

const DECK_SIZE = 20;
/** R80: a library holds at most this many cards, so no handicap deck is larger (R184). */
const LIBRARY_CAP = 60;
const HANDICAP_FIELDS = ["deckSize", "manaBonus", "manaCap", "extraOpeningCards", "extraDrawsPerTurn"];

const isCount = (value) => Number.isInteger(value) && value >= 0;

/** The problems with a fixture's `handicap`, as `validateHandicap` would name them. */
function handicapProblems(handicap, where) {
  if (typeof handicap !== "object" || handicap === null || Array.isArray(handicap)) {
    return [`${where}: "handicap" must be an object (R180)`];
  }
  const out = [];
  for (const field of HANDICAP_FIELDS) {
    if (!isCount(handicap[field])) out.push(`${where}: handicap.${field} must be a non-negative integer (R180)`);
  }
  if (isCount(handicap.deckSize) && (handicap.deckSize < 1 || handicap.deckSize > LIBRARY_CAP)) {
    out.push(`${where}: handicap.deckSize must be between 1 and ${LIBRARY_CAP} (R184), got ${handicap.deckSize}`);
  }
  if (handicap.heroHealth !== undefined && !(isCount(handicap.heroHealth) && handicap.heroHealth >= 1)) {
    out.push(`${where}: handicap.heroHealth must be a positive integer (R290)`);
  }
  const known = new Set([...HANDICAP_FIELDS, "heroHealth"]);
  for (const key of Object.keys(handicap)) {
    if (!known.has(key)) out.push(`${where}: handicap.${key} is not a handicap field (R180)`);
  }
  return out;
}

if (!existsSync(decksDir)) {
  console.error(`no fixture decks at ${decksDir}`);
  process.exit(1);
}

let catalog = null;
if (existsSync(catalogPath)) {
  catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
} else {
  console.warn("packages/cards/catalog.json is missing (M4 not landed): skipping the id checks.");
}

const problems = [];
const files = readdirSync(decksDir).filter((name) => name.endsWith(".json")).sort();

for (const file of files) {
  const id = file.replace(/\.json$/, "");
  const where = `decks/${file}`;
  let deck;
  try {
    deck = JSON.parse(readFileSync(path.join(decksDir, file), "utf8"));
  } catch (error) {
    problems.push(`${where}: not valid JSON (${error.message})`);
    continue;
  }

  if (deck.id !== id) problems.push(`${where}: "id" is "${deck.id}", expected "${id}"`);
  if (typeof deck.spec !== "string" || deck.spec.length === 0) problems.push(`${where}: missing "spec"`);
  if (typeof deck.description !== "string" || deck.description.length === 0) {
    problems.push(`${where}: missing "description" (say why these cards)`);
  }
  if (!Array.isArray(deck.cards)) {
    problems.push(`${where}: "cards" must be an array`);
    continue;
  }

  const illegalOnPurpose = /^09-illegal-/.test(id);
  if (illegalOnPurpose) {
    if (!/L[1-6]/.test(deck.description ?? "")) {
      problems.push(`${where}: an illegal fixture must name the rule it breaks (L1-L6)`);
    }
    continue;
  }

  let size = DECK_SIZE;
  let sized = true;
  if (deck.handicap !== undefined) {
    const wrong = handicapProblems(deck.handicap, where);
    problems.push(...wrong);
    // A handicap that is itself wrong names no deck size to hold the cards to.
    if (wrong.length === 0) size = deck.handicap.deckSize;
    else sized = false;
  }
  if (sized && deck.cards.length !== size) {
    problems.push(
      deck.handicap === undefined
        ? `${where}: ${deck.cards.length} cards, DECK_SIZE is ${DECK_SIZE} (L2)`
        : `${where}: ${deck.cards.length} cards, its handicap's deckSize is ${size} (R184)`,
    );
  }
  const seen = new Set();
  for (const card of deck.cards) {
    if (seen.has(card)) problems.push(`${where}: "${card}" appears twice (L3, MAX_COPIES = 1)`);
    seen.add(card);
    if (catalog === null) continue;
    const def = catalog[card];
    if (def === undefined) {
      problems.push(`${where}: "${card}" is not in the catalog (L6)`);
      continue;
    }
    if (def.token === true || (def.tags ?? []).includes("Token")) {
      problems.push(`${where}: "${card}" (${def.name}) is a Token card (L3)`);
    }
  }
}

if (files.length === 0) problems.push("no deck fixtures found");

if (problems.length > 0) {
  console.error(`${problems.length} problem(s) in e2e/fixtures/decks:`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`${files.length} deck fixture(s) OK`);
