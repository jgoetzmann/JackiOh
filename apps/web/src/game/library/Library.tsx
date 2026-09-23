// The deck library's constructor (BUILD M9-T2, SPEC §11 R171).
//
// STUB from the contracts commit: the props below are final, the body is not. M9-T2 replaces the
// body with the paged card grid, the decklist, the hover preview and the inspector.

import type { ReactElement } from "react";

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import type { SaveOutcome } from "../deckbuilder/Deckbuilder.tsx";
import { LIBRARY } from "./testids.ts";

/** One saved deck, as the route hands it down from `GET /api/decks`. */
export type LibraryDeck = { id: string; name: string; cards: readonly string[] };

/** What a save sends. */
export type LibraryDraft = { name: string; cards: readonly string[] };

/** A save's answer: the stored deck on success, else the server's own words (`SaveOutcome`). */
export type LibrarySaveOutcome = { ok: true; deck: LibraryDeck } | Extract<SaveOutcome, { ok: false }>;

export type LibraryProps = {
  catalog: CatalogSnapshot;
  /** Null when `GET /api/collection` failed: the pool shows every card and L5 is left to the server. */
  collection: Collection | null;
  /** Most recently updated first. The route owns this list and re-renders it after each save. */
  decks: readonly LibraryDeck[];
  /** R171's cap, from `GET /api/decks`. */
  maxDecks: number;
  /** The deck-shape limits this builder is launched with; default `DECK_SIZE` / `MAX_COPIES`. */
  deckSize?: number;
  maxCopies?: number;
  /** A deck that has never been saved. */
  create: (draft: LibraryDraft) => Promise<LibrarySaveOutcome>;
  save: (deckId: string, draft: LibraryDraft) => Promise<LibrarySaveOutcome>;
  remove: (deckId: string) => Promise<SaveOutcome>;
};

export default function Library(_props: LibraryProps): ReactElement {
  return <div className="app-shell app-shell--wide library" data-testid={LIBRARY} />;
}
