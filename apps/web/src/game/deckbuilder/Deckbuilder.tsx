// The loadout editor (BUILD M6-T3, SPEC §9.4 L1–L6).
//
// THE MESSAGES ARE NOT WRITTEN HERE. Every L1–L6 sentence this screen shows is a
// `LoadoutError.message` — either `@jackioh/validator`'s own, computed in the browser as UX
// (§9.3), or the server's relay of the same module's output in the `details` of a 422
// `loadout_invalid` (§9.4: "the client's verdict is UX while the server's is law"). Neither is
// composed, prefixed, suffixed or pluralised on the way to the DOM: an issue renders as
// `{issue.message}` and nothing else, and the rule code travels in `data-rule` rather than in the
// text. A second copy of a sentence would be a second source of truth.
//
// This component is presentational and does no I/O: the route hands it a catalog, a collection, a
// starting draft and a `save` function. That is what makes "the sentence came from the validator"
// testable without a server.
//
// THE LAYOUT (docs/polish/6-cards.md, Surface D). A browse column (`FilterBar` over `PoolGrid`, a
// grid of full cards) beside a deck sidebar (`DeckSidebar`: the tabs, the open deck's mana curve
// and tiles, and the save control); one column with the sidebar first on a phone. The sidebar
// comes first in the DOM too, so the focus and reading order match the phone's visual order (the
// desktop grid places it on the right by area name). This file keeps the state and the moves: the
// draft, the open deck, the filter and sort, the save and its verdict, which card's detail view is
// open, and the status line that names the last add or removal. Filter and sort are never
// persisted.
//
// A click on a pool card opens its detail view, whose "Add to Deck N" adds it (the brief's
// "a click opens a detail view"); the card's "+" and a drag onto a deck add it in one gesture.

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";

import type { CatalogSnapshot, Collection, LoadoutError } from "@jackioh/validator";

import "./deckbuilder.css";
import { CardDetail, closeInspect } from "../../cards/index.ts";
import DeckSidebar from "./DeckSidebar.tsx";
import FilterBar from "./FilterBar.tsx";
import { DEFAULT_FILTER, DEFAULT_SORT, visiblePool, type PoolFilter, type PoolSort } from "./filters.ts";
import {
  DECK_NUMBERS,
  addCard,
  deckHolding,
  draftFrom,
  issuesOf,
  removeCard,
  type Draft,
} from "./loadout.ts";
import PoolGrid from "./PoolGrid.tsx";
import { BackLink } from "../../routes/nav.tsx";
import { DECK_SIZE } from "./deckSize.ts";
import {
  DB_DECK_STATUS,
  DB_DETAIL_ADD,
  DB_EMPTY,
  DECKBUILDER,
  DECK_DRAG_MIME,
  LOADOUT_ERRORS,
  LOADOUT_SAVE,
  LOADOUT_SAVED,
  LOADOUT_SAVE_ERROR,
  loadoutErrorId,
} from "./testids.ts";

/** How long the status line shows what the last add or removal did. */
export const DECK_STATUS_MS = 2600;

/** What `PUT /api/loadout` said, with the server's own words kept intact. */
export type SaveOutcome =
  | { ok: true }
  | {
      ok: false;
      /** `error.message` verbatim. §9.4: the first issue is the error's own message. */
      message: string;
      /** `error.details` verbatim, when the refusal was `loadout_invalid`. */
      issues: readonly LoadoutError[];
    };

export type DeckbuilderProps = {
  catalog: CatalogSnapshot;
  /**
   * The profile's entitlements. `null` when `GET /api/collection` could not be read: L5 cannot be
   * checked without it, so the client verdict is skipped entirely rather than guessed at — the
   * server still refuses an illegal save.
   */
  collection: Collection | null;
  /** `GET /api/loadout`'s `loadout.decks`, or null for a profile that has never saved. */
  initialDecks?: readonly (readonly string[])[] | null;
  save: (decks: readonly (readonly string[])[]) => Promise<SaveOutcome>;
};

export default function Deckbuilder(props: DeckbuilderProps) {
  const { catalog, collection, save } = props;

  // `draftFrom` pads a short stored loadout and keeps a long one: L1 is the validator's to report,
  // and quietly dropping a fourth deck would hide it.
  const [draft, setDraft] = useState<Draft>(() => draftFrom(props.initialDecks));
  const [activeDeck, setActiveDeck] = useState(DECK_NUMBERS[0] ?? 1);
  const [serverIssues, setServerIssues] = useState<readonly LoadoutError[] | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusedCardId, setRefusedCardId] = useState<string | null>(null);
  const [filter, setFilter] = useState<PoolFilter>(DEFAULT_FILTER);
  const [sort, setSort] = useState<PoolSort>(DEFAULT_SORT);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);

  // The status line fades after a moment; the next add or removal replaces it.
  useEffect(() => {
    if (status === null) return undefined;
    const timer = window.setTimeout(() => {
      setStatus(null);
    }, DECK_STATUS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [status]);

  const nameOf = useCallback((cardId: string) => catalog.cards[cardId]?.name ?? cardId, [catalog]);

  // `poolFrom(catalog, filter.ownedOnly ? collection : null)`, filtered and sorted. With the
  // default filter this is exactly the shelf the builder always offered: the owned cards.
  const pool = useMemo(
    () => visiblePool(catalog, collection, filter, sort),
    [catalog, collection, filter, sort],
  );

  /** One tab and one panel per deck the draft actually has, so an L1 draft is visible, not hidden. */
  const deckNumbers = useMemo(
    () =>
      draft.length <= DECK_NUMBERS.length
        ? DECK_NUMBERS
        : Array.from({ length: draft.length }, (_unused, index) => index + 1),
    [draft.length],
  );

  /** Any edit retires the last save's verdict: it was about a draft that no longer exists. */
  const edited = useCallback((next: Draft) => {
    setDraft(next);
    setServerIssues(null);
    setServerMessage(null);
    setSaved(false);
  }, []);

  const putInDeck = useCallback(
    (deck: number, cardId: string) => {
      const move = addCard(draft, deck, cardId);
      if (!move.applied) {
        // BUILD M8: "a card dragged into a second deck is refused". Refused, not reworded.
        setRefusedCardId(cardId);
        const holder = deckHolding(draft, cardId);
        setStatus(holder === null ? null : `${nameOf(cardId)} is already in Deck ${String(holder)}`);
        return;
      }
      setRefusedCardId(null);
      edited(move.draft);
      const size = move.draft[deck - 1]?.length ?? 0;
      setStatus(`${nameOf(cardId)} added to Deck ${String(deck)} · ${String(size)}/${String(DECK_SIZE)}`);
    },
    [draft, edited, nameOf],
  );

  const takeFromDeck = useCallback(
    (deck: number, cardId: string) => {
      const move = removeCard(draft, deck, cardId);
      if (!move.applied) return;
      setRefusedCardId(null);
      edited(move.draft);
      const size = move.draft[deck - 1]?.length ?? 0;
      setStatus(`${nameOf(cardId)} removed from Deck ${String(deck)} · ${String(size)}/${String(DECK_SIZE)}`);
    },
    [draft, edited, nameOf],
  );

  const addToActiveDeck = useCallback(
    (cardId: string) => {
      putInDeck(activeDeck, cardId);
    },
    [activeDeck, putInDeck],
  );

  const startDrag = useCallback((cardId: string, event: DragEvent<HTMLElement>) => {
    dragged.current = cardId;
    // A drag is not an inspection: any preview still open would sit over the drop targets.
    closeInspect();
    try {
      event.dataTransfer.setData(DECK_DRAG_MIME, cardId);
      event.dataTransfer.setData("text/plain", cardId);
      event.dataTransfer.effectAllowed = "move";
    } catch {
      // Cypress and jsdom synthesise drag events without a DataTransfer; the id is already in
      // `dragged`, which is what a drop reads first.
    }
  }, []);

  const endDrag = useCallback(() => {
    dragged.current = null;
  }, []);

  /** A drop on a deck's tab (which also opens that deck) or on its panel. */
  const dropCard = useCallback(
    (deck: number, event: DragEvent<HTMLElement>, select: boolean) => {
      event.preventDefault();
      const cardId = droppedCardId(event, dragged.current);
      if (cardId === null) return;
      if (select) setActiveDeck(deck);
      putInDeck(deck, cardId);
    },
    [putInDeck],
  );

  const openDetail = useCallback((cardId: string) => {
    // At most one inspect overlay at a time: a hover preview on a deck tile gives way to the detail.
    closeInspect();
    setDetailCardId(cardId);
  }, []);

  const closeDetail = useCallback(() => {
    setDetailCardId(null);
  }, []);

  const onSave = useCallback(() => {
    setSaving(true);
    setSaved(false);
    void Promise.resolve(save(draft.map((cards) => [...cards])))
      .then((outcome) => {
        if (outcome.ok) {
          setServerIssues(null);
          setServerMessage(null);
          setSaved(true);
          return;
        }
        setServerIssues(outcome.issues);
        setServerMessage(outcome.issues.length === 0 ? outcome.message : null);
      })
      .finally(() => {
        setSaving(false);
      });
  }, [draft, save]);

  const clientIssues = useMemo(
    () => (collection === null ? [] : issuesOf(draft, catalog, collection)),
    [draft, catalog, collection],
  );

  // §9.3: the server's verdict is law, so once it has spoken about this exact draft it is what is
  // shown. Editing clears it (see `edited`) and the client's own verdict takes over again.
  const issues: readonly LoadoutError[] = serverIssues ?? clientIssues;

  const detailDef = detailCardId === null ? undefined : catalog.cards[detailCardId];
  const detailHeldBy = detailCardId === null ? null : deckHolding(draft, detailCardId);
  const detailOwned =
    detailCardId === null || collection === null ? null : (collection[detailCardId] ?? 0) > 0;

  return (
    <div className="app-shell app-shell--wide deckbuilder" data-testid={DECKBUILDER}>
      <header className="db-header">
        <BackLink />
        {/* The same words as the loading and error screens (routes/decks.tsx); only the look is
            the builder's own. */}
        <h1 className="db-title">
          <span className="db-title-brand">JackiOh</span>
          <span className="db-title-sep"> — </span>
          <span className="db-title-page">decks</span>
        </h1>
      </header>

      <div className="db-layout">
        <DeckSidebar
          deckNumbers={deckNumbers}
          activeDeck={activeDeck}
          draft={draft}
          catalog={catalog}
          onSelectDeck={setActiveDeck}
          onDropCard={dropCard}
          onRemove={takeFromDeck}
          onInspect={openDetail}
        >
          <div className="db-actions">
            <button
              type="button"
              data-testid={LOADOUT_SAVE}
              onClick={onSave}
              disabled={saving}
              aria-busy={saving}
            >
              Save loadout
            </button>
            {saved ? (
              <span className="db-saved" data-testid={LOADOUT_SAVED} role="status">
                Saved
              </span>
            ) : null}
          </div>
        </DeckSidebar>

        <section className="db-browse" aria-label="Browse cards">
          <FilterBar
            filter={filter}
            onFilter={setFilter}
            sort={sort}
            onSort={setSort}
            count={pool.length}
            ownedUnavailable={collection === null}
          />
          {/* What the last add or removal did, as a toast at the foot of the screen: deep in the
              pool on a phone, the deck's own count has scrolled away. Polite, so a screen reader
              hears each add too. It ignores the pointer, so it never covers a card (deckbuilder.css). */}
          <p className="db-deck-status" data-testid={DB_DECK_STATUS} role="status" aria-live="polite">
            {status ?? ""}
          </p>
          <PoolGrid
            ids={pool}
            activeDeck={activeDeck}
            catalog={catalog}
            collection={collection}
            draft={draft}
            refusedCardId={refusedCardId}
            onAdd={addToActiveDeck}
            onInspect={openDetail}
            onDragStart={startDrag}
            onDragEnd={endDrag}
          />
          {pool.length === 0 ? (
            <p className="db-empty" data-testid={DB_EMPTY}>
              No card matches these filters.
            </p>
          ) : null}
        </section>
      </div>

      {serverMessage === null ? null : (
        // Not a rule failure (a stale catalog version, a closed gate): the server's own sentence,
        // unchanged. The client has no second wording for any of these.
        <p className="notice" data-testid={LOADOUT_SAVE_ERROR}>
          {serverMessage}
        </p>
      )}

      <ul className="db-errors" data-testid={LOADOUT_ERRORS} data-count={String(issues.length)}>
        {issues.map((issue, position) => (
          <li
            key={`${issue.rule}:${String(issue.deck ?? "")}:${issue.cardId ?? ""}:${String(position)}`}
            data-testid={loadoutErrorId(issue.rule)}
            data-rule={issue.rule}
            data-deck={issue.deck === undefined ? undefined : String(issue.deck)}
            data-card={issue.cardId}
            data-source={serverIssues === null ? "client" : "server"}
          >
            {issue.message}
          </li>
        ))}
      </ul>

      {detailCardId === null || detailDef === undefined ? null : (
        <CardDetail
          def={detailDef}
          onClose={closeDetail}
          meta={
            <span className="db-detail-meta">
              {detailHeldBy === null ? "In no deck" : `In Deck ${String(detailHeldBy)}`}
              {detailOwned === false ? " · not in your collection" : ""}
            </span>
          }
          actions={
            <button
              type="button"
              className="db-detail-add"
              data-testid={DB_DETAIL_ADD}
              // One copy per loadout: a card any deck holds cannot be added again (the same
              // refusal a click or a drop gets), so the action says so by being unavailable.
              disabled={detailHeldBy !== null}
              onClick={() => {
                putInDeck(activeDeck, detailCardId);
              }}
            >
              {`Add to Deck ${String(activeDeck)}`}
            </button>
          }
        />
      )}
    </div>
  );
}

/** The dragged card: the id this component recorded, else whatever the DataTransfer carries. */
function droppedCardId(event: DragEvent<HTMLElement>, held: string | null): string | null {
  if (held !== null && held.length > 0) return held;
  for (const mime of [DECK_DRAG_MIME, "text/plain"]) {
    try {
      const carried = event.dataTransfer.getData(mime);
      if (carried.length > 0) return carried;
    } catch {
      // No DataTransfer on a synthesised event: try the next type, then give up.
    }
  }
  return null;
}
