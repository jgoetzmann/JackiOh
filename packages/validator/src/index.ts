/**
 * The loadout rules L1–L6, as SPEC §9.4 states them, and the draft rules D1–D4 and T1–T3 that a
 * saved deck and a saved trio obey (R250, R252).
 *
 * Since R250 a player keeps up to ten named decks and builds up to five trios from them. A trio is
 * what §9.4 first called a loadout: three decks with no card in common, and L1–L6 are its rules
 * (`validateLoadout`, also exported as `validateTrio`). A Best-of-1 deck is checked by the rules
 * that are about one deck — L2, L3, L5 and L6 (`validateDeck`, R253). Neither is checked at save:
 * a saved deck or trio is a draft, which may be incomplete, hold cards the player does not own, or
 * share cards with another deck of its trio, and it is judged when it is queued. What a save does
 * check is structure (`checkDeckDraft`, `checkTrioDraft`): a name, at most `DECK_SIZE` deckable
 * cards, at most `MAX_COPIES` of each, and three trio slots that name three different decks.
 *
 * §9.4 asks for "one validator module shared by client and server, at save and again at queue",
 * and this is that module. Three callers need the same answer: the deckbuilder in `apps/web`, so a
 * player sees why a deck is illegal before saving; `saveLoadout` in `apps/server`, which is the
 * only authority; and the enqueue path, which re-checks because the collection or the catalog may
 * have moved since the save. A second copy of these rules would drift, and drift here means a deck
 * the builder accepts and the server rejects — or worse, the reverse. So there is one copy, and
 * the client's verdict is UX while the server's is law (§9.3).
 *
 * That is also why §9.4's last line lands on the message: "a queue-time failure names the deck and
 * the card". Every error here carries a human sentence naming both, so the same string can be shown
 * in the builder at save time and returned from the queue endpoint later.
 *
 * Pure and I/O-free, so both sides can run it: no clock, no randomness, no catalog lookup of its
 * own. The caller passes the catalog snapshot and the collection in.
 */
import { DECK_SIZE, MAX_COPIES } from "./config";
import type { CardDef, CardDefs } from "@jackioh/shared";

/** §9.4: exactly 3 decks per loadout. Not in engine config, so it lives here. */
export const LOADOUT_DECKS = 3;

/** R252: a trio is §9.4's loadout of three decks, so it holds `LOADOUT_DECKS` of them. */
export const TRIO_DECKS = LOADOUT_DECKS;

export type CardId = string;

export type LoadoutDeck = {
  /** Optional builder label; messages fall back to `Deck <n>`. */
  name?: string;
  cards: readonly CardId[];
};

/** The static, versioned catalog snapshot (§9.4) a loadout is checked against. */
export type CatalogSnapshot = {
  version: string;
  cards: CardDefs;
  banned?: readonly CardId[];
};

/** The profile's entitlements projected to quantities; an absent id means none owned. */
export type Collection = Readonly<Record<CardId, number>>;

export type LoadoutInput = {
  decks: readonly LoadoutDeck[];
  catalog: CatalogSnapshot;
  collection: Collection;
};

export type LoadoutRule = "L1" | "L2" | "L3" | "L4" | "L5" | "L6";

export type LoadoutError = {
  rule: LoadoutRule;
  message: string;
  /** 1-based deck index; absent on loadout-wide failures (L1, L4, L5). */
  deck?: number;
  cardId?: CardId;
};

export type LoadoutResult = { ok: true } | { ok: false; errors: readonly LoadoutError[] };

// --- message helpers: each string exists exactly once -----------------------

/** §9.4: a failure names the deck. The builder's own label wins, else the 1-based position. */
function deckLabel(deck: LoadoutDeck, index: number): string {
  return deck.name ?? `Deck ${index + 1}`;
}

/** §9.4: a failure names the card. `"Name" (id)` when catalogued, else the bare id. */
function cardLabel(cardId: CardId, cards: CardDefs): string {
  const def = cards[cardId];
  return def === undefined ? `"${cardId}"` : `"${def.name}" (${cardId})`;
}

function copyWord(count: number): string {
  return count === 1 ? "copy" : "copies";
}

/** A deckbuilder reaches "1 card" by deleting, so L2's count is pluralised too. */
function cardWord(count: number): string {
  return count === 1 ? "card" : "cards";
}

/** `Deck 1`, `Deck 1 and Deck 2`, `Deck 1, Deck 2 and Deck 3`. */
function joinLabels(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;
}

/**
 * Mirrors the engine catalog's private token test (§5.1): the printed flag or the tag.
 * L3 bans both spellings from a deck.
 */
function isToken(def: CardDef): boolean {
  return def.token || def.tags.includes("Token");
}

// --- L1–L6 (§9.4) ----------------------------------------------------------

/**
 * Checks every loadout rule and collects every failure, so the deckbuilder can show all of
 * them at once. Pure and total: bad-but-typed input returns errors, never an exception.
 *
 * Catalog staleness ("update required") is not one of L1–L6; the endpoint compares versions
 * (BUILD M6-T2) and this module only checks membership in the snapshot it was handed.
 */
export function validateLoadout(input: LoadoutInput): LoadoutResult {
  return check(input.decks, input.catalog, input.collection, "trio");
}

/** R253: a Best-of-3 trio is §9.4's loadout, so its rules are L1–L6 exactly. */
export const validateTrio = validateLoadout;

export type DeckInput = {
  deck: LoadoutDeck;
  catalog: CatalogSnapshot;
  collection: Collection;
};

/**
 * R253: the rules a Best-of-1 deck must pass to be queued — the four of L1–L6 that are about one
 * deck: L2 (exactly `DECK_SIZE` cards), L3 (copies and Tokens), L5 (owned) and L6 (in the catalog,
 * not banned). L1 and L4 are about three decks together and cannot apply to one. Every error names
 * the deck, as 1, so a message and a `deck` field read the same way they do for a trio.
 */
export function validateDeck(input: DeckInput): LoadoutResult {
  return check([input.deck], input.catalog, input.collection, "deck");
}

/**
 * One pass over the decks for either scope. `"trio"` is L1–L6 over three decks; `"deck"` is one
 * deck, where L1 and L4 do not apply and L5's sentence names the deck rather than the trio.
 */
function check(
  decks: readonly LoadoutDeck[],
  catalog: CatalogSnapshot,
  collection: Collection,
  scope: "trio" | "deck",
): LoadoutResult {
  const errors: LoadoutError[] = [];
  const banned = new Set<CardId>(catalog.banned ?? []);
  const deckLabels: readonly string[] = decks.map((deck, index) => deckLabel(deck, index));
  const labelAt = (index: number): string => deckLabels[index] ?? `Deck ${index + 1}`;
  const label = (cardId: CardId): string => cardLabel(cardId, catalog.cards);

  // L1 — exactly LOADOUT_DECKS decks. Loadout-wide, so no `deck` field.
  if (scope === "trio" && decks.length !== LOADOUT_DECKS) {
    errors.push({
      rule: "L1",
      message: `A trio needs exactly ${LOADOUT_DECKS} decks; this one has ${decks.length}.`,
    });
  }

  /** Distinct ids in first-appearance order across the whole loadout, for L4 and L5. */
  const order: CardId[] = [];
  /** Copies of each id across the whole loadout (L5). */
  const totals = new Map<CardId, number>();
  /** Which decks hold each id, in deck order and without repeats (L4). */
  const decksHolding = new Map<CardId, number[]>();

  // L1 does not stop the per-deck rules: every supplied deck is checked, even a fourth.
  for (const [index, deck] of decks.entries()) {
    const deckNumber = index + 1;

    // L2 — exactly DECK_SIZE cards.
    if (deck.cards.length !== DECK_SIZE) {
      errors.push({
        rule: "L2",
        message:
          `${labelAt(index)} has ${deck.cards.length} ${cardWord(deck.cards.length)}; ` +
          `every deck needs exactly ${DECK_SIZE}.`,
        deck: deckNumber,
      });
    }

    const deckOrder: CardId[] = [];
    const deckCounts = new Map<CardId, number>();
    for (const cardId of deck.cards) {
      const seen = deckCounts.get(cardId);
      if (seen === undefined) deckOrder.push(cardId);
      deckCounts.set(cardId, (seen ?? 0) + 1);

      // A card missing from the snapshot still counts towards L2, L3, L4 and L5.
      const total = totals.get(cardId);
      if (total === undefined) order.push(cardId);
      totals.set(cardId, (total ?? 0) + 1);

      const holders = decksHolding.get(cardId);
      if (holders === undefined) decksHolding.set(cardId, [index]);
      else if (!holders.includes(index)) holders.push(index);
    }

    for (const cardId of deckOrder) {
      const count = deckCounts.get(cardId) ?? 0;
      const def = catalog.cards[cardId];

      // L3 (tokens) — skipped for an unknown id: there is no def to read. L6 reports that id.
      if (def !== undefined && isToken(def)) {
        errors.push({
          rule: "L3",
          message: `${labelAt(index)} cannot contain ${label(cardId)}: Token cards are never deckable.`,
          deck: deckNumber,
          cardId,
        });
      }

      // L3 (copies) — at most MAX_COPIES of a card per deck.
      if (count > MAX_COPIES) {
        errors.push({
          rule: "L3",
          message:
            `${labelAt(index)} has ${count} ${copyWord(count)} of ${label(cardId)}; ` +
            `at most ${MAX_COPIES} ${copyWord(MAX_COPIES)} of a card is allowed per deck.`,
          deck: deckNumber,
          cardId,
        });
      }

      // L6 — the card exists in this snapshot and is not banned.
      if (def === undefined) {
        errors.push({
          rule: "L6",
          message: `${labelAt(index)} cannot contain ${label(cardId)}: no such card in catalog version ${catalog.version}.`,
          deck: deckNumber,
          cardId,
        });
      }
      if (banned.has(cardId)) {
        errors.push({
          rule: "L6",
          message: `${labelAt(index)} cannot contain ${label(cardId)}: that card is banned.`,
          deck: deckNumber,
          cardId,
        });
      }
    }
  }

  // L4 — a card id appears in at most one deck of the loadout. One deck has nothing to share with.
  for (const cardId of scope === "trio" ? order : []) {
    const holders = decksHolding.get(cardId) ?? [];
    if (holders.length < 2) continue;
    errors.push({
      rule: "L4",
      message: `${label(cardId)} appears in ${joinLabels(holders.map(labelAt))}; a card may be in only one deck of a trio.`,
      cardId,
    });
  }

  // L5 — copies across the loadout never exceed the quantity owned; an absent id is 0 owned.
  for (const cardId of order) {
    const used = totals.get(cardId) ?? 0;
    const owned = collection[cardId] ?? 0;
    if (used <= owned) continue;
    errors.push({
      rule: "L5",
      message:
        scope === "deck"
          ? `${labelAt(0)} uses ${used} ${copyWord(used)} of ${label(cardId)} but you own ${owned}.`
          : `Your trio uses ${used} ${copyWord(used)} of ${label(cardId)} but you own ${owned}.`,
      ...(scope === "deck" ? { deck: 1 } : {}),
      cardId,
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

// --- Trio conflicts (R251, R252) -----------------------------------------------------------

/** One card that two or more decks of a trio hold, and which decks (0-based, in trio order). */
export type TrioConflict = { cardId: CardId; decks: readonly number[] };

/**
 * Every card that more than one of `decks` holds, in first-appearance order: the builder's
 * "unavailable, used in <deck>" highlight and L4's input are the same fact. R251: a card is its
 * catalog id — Radiant is a flag on a card in play (§5.2), never a second id, so there is no Radiant
 * copy to tell apart. No rule is decided here and no sentence is written: L4 words it.
 */
export function trioConflicts(decks: readonly { readonly cards: readonly CardId[] }[]): TrioConflict[] {
  const holders = new Map<CardId, number[]>();
  const order: CardId[] = [];
  decks.forEach((deck, index) => {
    for (const cardId of deck.cards) {
      const held = holders.get(cardId);
      if (held === undefined) {
        holders.set(cardId, [index]);
        order.push(cardId);
      } else if (!held.includes(index)) {
        held.push(index);
      }
    }
  });
  return order
    .map((cardId) => ({ cardId, decks: holders.get(cardId) ?? [] }))
    .filter((conflict) => conflict.decks.length > 1);
}

// --- Draft rules: what a save checks (R250, R252) ------------------------------------------

/**
 * R250: a saved deck's structural rules. They are all a save checks, because a saved deck is a
 * draft: incomplete, unowned or conflicting cards are allowed and judged at queue (R253).
 *
 *  D1 — a name of 1 to `nameMaxLength` characters once trimmed, with no control characters;
 *  D2 — at most `DECK_SIZE` cards;
 *  D3 — every card a deckable card of the catalog (it exists and is not a Token);
 *  D4 — at most `MAX_COPIES` copies of a card.
 */
export type DraftRule = "D1" | "D2" | "D3" | "D4";

/** R252: a saved trio's rules. T1 a name as D1; T2 exactly `TRIO_DECKS` slots; T3 no deck twice. */
export type TrioDraftRule = "T1" | "T2" | "T3";

export type DraftIssue<Rule extends string = DraftRule> = {
  rule: Rule;
  message: string;
  cardId?: CardId;
};

export type NameLimits = {
  /** The longest name, in characters, after trimming. The caller's config states the number. */
  nameMaxLength: number;
};

// Control characters (C0, DEL and C1): a name is shown in lists, buttons and messages, and none of
// them has a place there.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

/** A name as it is stored: trimmed, and every run of whitespace inside it one space. */
export function normalizeName(raw: string): string {
  return raw.trim().replace(/\s+/gu, " ");
}

/** The length a name limit counts: code points, so an emoji is one character, as a player sees it. */
function nameLength(name: string): number {
  return [...name].length;
}

function nameIssue<Rule extends string>(
  rule: Rule,
  what: "deck" | "trio",
  raw: string,
  limits: NameLimits,
): DraftIssue<Rule> | null {
  const name = normalizeName(raw);
  if (name.length === 0) return { rule, message: `A ${what} needs a name.` };
  if (CONTROL_CHARACTERS.test(name)) {
    return { rule, message: `A ${what} name cannot contain control characters.` };
  }
  if (nameLength(name) > limits.nameMaxLength) {
    return { rule, message: `A ${what} name can be at most ${limits.nameMaxLength} characters.` };
  }
  return null;
}

export type DeckDraftInput = {
  name: string;
  cards: readonly CardId[];
  /**
   * Whether an id is a deckable card: in the current catalog and not a Token. A predicate rather
   * than a snapshot, because the server holds its catalog as ids and flags and the client holds
   * definitions; both answer the same question.
   */
  isDeckable: (cardId: CardId) => boolean;
} & NameLimits;

/** R250's D1–D4, every failure at once. Empty when the draft may be saved. */
export function checkDeckDraft(input: DeckDraftInput): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const named = nameIssue("D1", "deck", input.name, input);
  if (named !== null) issues.push(named);

  if (input.cards.length > DECK_SIZE) {
    issues.push({
      rule: "D2",
      message: `A deck holds at most ${DECK_SIZE} cards; this one has ${input.cards.length}.`,
    });
  }

  const counts = new Map<CardId, number>();
  for (const cardId of input.cards) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  for (const [cardId, count] of counts) {
    if (!input.isDeckable(cardId)) {
      issues.push({ rule: "D3", message: `"${cardId}" is not a card a deck can hold.`, cardId });
    }
    if (count > MAX_COPIES) {
      issues.push({
        rule: "D4",
        message: `A deck may hold at most ${MAX_COPIES} ${copyWord(MAX_COPIES)} of "${cardId}"; this one has ${count}.`,
        cardId,
      });
    }
  }
  return issues;
}

export type TrioDraftInput = {
  name: string;
  /** Deck ids by slot; `null` is an empty slot, which a draft may have (R252). */
  deckIds: readonly (string | null)[];
} & NameLimits;

/** R252's T1–T3, every failure at once. Empty when the trio may be saved. */
export function checkTrioDraft(input: TrioDraftInput): DraftIssue<TrioDraftRule>[] {
  const issues: DraftIssue<TrioDraftRule>[] = [];
  const named = nameIssue("T1", "trio", input.name, input);
  if (named !== null) issues.push(named);
  if (input.deckIds.length !== TRIO_DECKS) {
    issues.push({
      rule: "T2",
      message: `A trio has exactly ${TRIO_DECKS} slots; this one has ${input.deckIds.length}.`,
    });
  }
  const filled = input.deckIds.filter((id): id is string => id !== null);
  if (new Set(filled).size !== filled.length) {
    issues.push({ rule: "T3", message: "A trio cannot hold the same deck twice." });
  }
  return issues;
}
