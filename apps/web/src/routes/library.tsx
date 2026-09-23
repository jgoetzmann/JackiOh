// `/library` — the deck library (BUILD M9-T3, SPEC §11 R171).
//
// The screen's I/O, as `routes/decks.tsx` is for the loadout: the constructor itself is
// `game/library/Library.tsx`, which does no I/O and holds no rule. The gate is `main.tsx`'s
// `<Gated>`, which hands this route the token.
//
// THE READS. `GET /api/decks` (the decks, R171's cap and the catalog version every save is stamped
// with), `GET /api/catalog` and `GET /api/collection`. As on `/decks`, only the collection is
// optional: without it the constructor skips L5 and the server still refuses an illegal save.
//
// THE WRITES. Each save answers with the stored deck, which this route puts into its own list (a
// new deck at the top, an edited one in place) so the constructor re-renders from the server's
// copy. A refusal goes through `saveOutcomeFrom`, so a 422's validator sentences arrive verbatim.

import { useEffect, useState, type ReactElement } from "react";

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import type { SaveOutcome } from "../game/deckbuilder/Deckbuilder.tsx";
import { collectionFrom } from "../game/deckbuilder/loadout.ts";
import Library, {
  type LibraryDeck,
  type LibraryDraft,
  type LibrarySaveOutcome,
} from "../game/library/Library.tsx";
import { LIBRARY_ERROR, LIBRARY_LOADING } from "../game/library/testids.ts";
import {
  createDeck,
  deleteDeck,
  getCatalog,
  getCollection,
  listDecks,
  updateDeck,
} from "../net/api.ts";
import { saveOutcomeFrom } from "./decks.tsx";

type Loaded = {
  catalog: CatalogSnapshot;
  collection: Collection | null;
  decks: readonly LibraryDeck[];
  maxDecks: number;
  /** The version a save is stamped with (§9.4: stale versions are refused at save). */
  catalogVersion: string;
};

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; data: Loaded };

export type LibraryRouteProps = { token: string };

export default function LibraryRoute({ token }: LibraryRouteProps): ReactElement {
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      listDecks(token),
      getCatalog(),
      getCollection(token).then(
        (response) => response,
        () => null,
      ),
    ])
      .then(([library, catalog, collection]) => {
        if (cancelled) return;
        setScreen({
          kind: "ready",
          data: {
            catalog: { version: catalog.version, cards: catalog.defs },
            collection: collection === null ? null : collectionFrom(collection.entries),
            decks: library.decks,
            maxDecks: library.maxDecks,
            catalogVersion: library.catalogVersion,
          },
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setScreen({ kind: "error", message: cause instanceof Error ? cause.message : String(cause) });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (screen.kind !== "ready") {
    return (
      <div className="app-shell">
        <h1>JackiOh — my decks</h1>
        {screen.kind === "loading" ? (
          <p data-testid={LIBRARY_LOADING}>Loading…</p>
        ) : (
          <p className="notice" data-testid={LIBRARY_ERROR}>
            {screen.message}
          </p>
        )}
      </div>
    );
  }

  const { catalogVersion } = screen.data;

  function withDecks(change: (decks: readonly LibraryDeck[]) => readonly LibraryDeck[]): void {
    setScreen((current) =>
      current.kind === "ready"
        ? { kind: "ready", data: { ...current.data, decks: change(current.data.decks) } }
        : current,
    );
  }

  async function create(draft: LibraryDraft): Promise<LibrarySaveOutcome> {
    try {
      const { deck } = await createDeck(token, catalogVersion, draft);
      withDecks((decks) => [deck, ...decks]);
      return { ok: true, deck };
    } catch (cause: unknown) {
      return saveOutcomeFrom(cause);
    }
  }

  async function save(deckId: string, draft: LibraryDraft): Promise<LibrarySaveOutcome> {
    try {
      const { deck } = await updateDeck(token, catalogVersion, deckId, draft);
      withDecks((decks) => decks.map((held) => (held.id === deckId ? deck : held)));
      return { ok: true, deck };
    } catch (cause: unknown) {
      return saveOutcomeFrom(cause);
    }
  }

  async function remove(deckId: string): Promise<SaveOutcome> {
    try {
      await deleteDeck(token, deckId);
      withDecks((decks) => decks.filter((held) => held.id !== deckId));
      return { ok: true };
    } catch (cause: unknown) {
      return saveOutcomeFrom(cause);
    }
  }

  return (
    <Library
      catalog={screen.data.catalog}
      collection={screen.data.collection}
      decks={screen.data.decks}
      maxDecks={screen.data.maxDecks}
      create={create}
      save={save}
      remove={remove}
    />
  );
}
