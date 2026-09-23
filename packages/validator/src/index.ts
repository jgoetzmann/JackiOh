/**
 * The loadout rules L1–L6, as SPEC §9.4 states them.
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

/**
 * The two deck-shape numbers, for a caller that builds decks to other limits (a deckbuilder
 * launched for another format, say). Absent fields fall back to the engine's `DECK_SIZE` and
 * `MAX_COPIES`, and the server never passes this: its verdict is always config's (§9.3).
 */
export type DeckRules = {
  deckSize?: number;
  maxCopies?: number;
};

export type LoadoutInput = {
  decks: readonly LoadoutDeck[];
  catalog: CatalogSnapshot;
  collection: Collection;
  rules?: DeckRules;
};

/** One library deck (R171), checked on its own rather than as part of a loadout. */
export type DeckInput = {
  deck: LoadoutDeck;
  catalog: CatalogSnapshot;
  collection: Collection;
  rules?: DeckRules;
  /** R171: a library deck saves short of `deckSize`; L2 still refuses one that is over it. */
  allowIncomplete?: boolean;
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
  const { decks, catalog, collection } = input;
  const deckSize = input.rules?.deckSize ?? DECK_SIZE;
  const maxCopies = input.rules?.maxCopies ?? MAX_COPIES;
  const errors: LoadoutError[] = [];
  const banned = new Set<CardId>(catalog.banned ?? []);
  const deckLabels: readonly string[] = decks.map((deck, index) => deckLabel(deck, index));
  const labelAt = (index: number): string => deckLabels[index] ?? `Deck ${index + 1}`;
  const label = (cardId: CardId): string => cardLabel(cardId, catalog.cards);

  // L1 — exactly LOADOUT_DECKS decks. Loadout-wide, so no `deck` field.
  if (decks.length !== LOADOUT_DECKS) {
    errors.push({
      rule: "L1",
      message: `A loadout needs exactly ${LOADOUT_DECKS} decks; this one has ${decks.length}.`,
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
    if (deck.cards.length !== deckSize) {
      errors.push({
        rule: "L2",
        message:
          `${labelAt(index)} has ${deck.cards.length} ${cardWord(deck.cards.length)}; ` +
          `every deck needs exactly ${deckSize}.`,
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
      if (count > maxCopies) {
        errors.push({
          rule: "L3",
          message:
            `${labelAt(index)} has ${count} ${copyWord(count)} of ${label(cardId)}; ` +
            `at most ${maxCopies} ${copyWord(maxCopies)} of a card is allowed per deck.`,
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

  // L4 — a card id appears in at most one deck of the loadout.
  for (const cardId of order) {
    const holders = decksHolding.get(cardId) ?? [];
    if (holders.length < 2) continue;
    errors.push({
      rule: "L4",
      message: `${label(cardId)} appears in ${joinLabels(holders.map(labelAt))}; a card may be in only one deck of a loadout.`,
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
      message: `Your loadout uses ${used} ${copyWord(used)} of ${label(cardId)} but you own ${owned}.`,
      cardId,
    });
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * One library deck (R171): `validateLoadout` over a loadout of just this deck, keeping the rules
 * that are about a deck. L1 (three decks) and L4 (a card in two decks) are loadout rules and never
 * apply here, and with `allowIncomplete` a deck short of `deckSize` is not an L2 failure. Every
 * sentence is `validateLoadout`'s own, so the library shows the same words the loadout does.
 */
export function validateDeck(input: DeckInput): LoadoutResult {
  const { deck, allowIncomplete = false, ...rest } = input;
  const result = validateLoadout({ ...rest, decks: [deck] });
  if (result.ok) return result;
  const deckSize = input.rules?.deckSize ?? DECK_SIZE;
  const short = allowIncomplete && deck.cards.length < deckSize;
  const errors = result.errors.filter(
    // L4 cannot fire on a loadout of one deck, so L1 is the only loadout rule to drop.
    (error) => error.rule !== "L1" && !(short && error.rule === "L2"),
  );
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
