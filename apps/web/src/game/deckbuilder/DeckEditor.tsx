// The deck editor: one saved deck, the card pool beside it, and what the player can do with it
// (SPEC §9.4, R250–R255; docs/polish/6-cards.md, Surface D for the pool and the tiles).
//
// THE MESSAGES ARE NOT WRITTEN HERE. The verdict under the deck ("Before you can queue this
// deck") is `validateDeck`'s list, rendered as `{issue.message}` and nothing else, with the rule in
// `data-rule`; the deck is handed to the validator under the name it is saved with, so the
// sentences name it. A second copy of a sentence would be a second source of truth
// (messages.test.ts).
//
// THE REFUSALS the editor does make are UX (workshop.ts `addCard`): a second copy, a card past
// `DECK_SIZE` (a save would be refused at D2 and D4), and a card a compared deck holds — R251's
// "unavailable, used in <deck>", which is what lets a player build three decks for a trio without
// a clash. Each refusal says so on the polite status line. A clash that already exists is shown on
// the tile and never removed for the player.
//
// Nothing is saved from here: every edit goes to the store (sync.ts), which mirrors it at once
// and saves it after `DECK_AUTOSAVE_DEBOUNCE_MS` (R256). The one exception is the twentieth card:
// completing a deck saves at once, and the status line says "Deck complete — saved" when the
// server has it.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type DragEvent, type ReactElement } from "react";

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import { CardDetail, closeInspect } from "../../cards/index.ts";
import { encodeDeckCode } from "./deckCode.ts";
import DeckSidebar from "./DeckSidebar.tsx";
import { DECK_SIZE } from "./deckSize.ts";
import FilterBar from "./FilterBar.tsx";
import { visiblePool, type PoolFilter, type PoolSort } from "./filters.ts";
import PoolGrid from "./PoolGrid.tsx";
import { UNTITLED_DECK, type DeckItem, type TrioItem, type WorkshopLimits } from "./sync.ts";
import {
  DB_DETAIL_ADD,
  DB_EMPTY,
  DECK_CODE_OUTPUT,
  DECK_COMPARE_SELECT,
  DECK_CONFLICTS,
  DECK_COPY_CODE,
  DECK_DELETE,
  DECK_DELETE_CANCEL,
  DECK_DELETE_CONFIRM,
  DECK_DRAG_MIME,
  DECK_EDITOR,
  DECK_NAME_INPUT,
  DECK_SAVE_ERROR,
  DECK_STATUS,
  DECK_VERDICT,
  LOADOUT_ERRORS,
  WORKSHOP_BACK,
  deckCompareChipId,
  loadoutErrorId,
} from "./testids.ts";
import {
  NO_COMPARE,
  addCard,
  clampName,
  comparedDecks,
  deckLabel,
  deckVerdict,
  holdersOf,
  removeCard,
  trioLabel,
  triosHolding,
  withComparedDeck,
  withoutComparedDeck,
  type Compare,
  type Holder,
} from "./workshop.ts";

/** How long the status line shows what the last add, removal or refusal did. */
export const DECK_STATUS_MS = 2600;

/** What the status line says once a deck reaches `DECK_SIZE` and the server has it (R256). */
export const DECK_COMPLETE_SAVED = "Deck complete — saved";

export type DeckEditorProps = {
  deck: DeckItem;
  /** Every saved deck, for the comparison. */
  decks: readonly DeckItem[];
  trios: readonly TrioItem[];
  catalog: CatalogSnapshot;
  /** Null when `GET /api/collection` could not be read: ownership is then neither claimed nor denied. */
  collection: Collection | null;
  limits: WorkshopLimits;
  /** The server has this deck's latest edit (R256). */
  saved: boolean;
  /** The server's refusal of this deck's last save, verbatim. */
  refusal: string | null;
  filter: PoolFilter;
  onFilter: (next: PoolFilter) => void;
  sort: PoolSort;
  onSort: (next: PoolSort) => void;
  onRename: (name: string) => void;
  onCards: (cards: readonly string[]) => void;
  onDelete: () => void;
  /** Saves now, without waiting for the debounce. */
  onSaveNow: () => void;
  /** A phone's way back to the list. */
  onBack: () => void;
};

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

/** "Control", "Control and Midrange": the compared decks, as the conflict line names them. */
function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export default function DeckEditor(props: DeckEditorProps): ReactElement {
  const { deck, decks, trios, catalog, collection, limits, saved, refusal } = props;
  const { filter, onFilter, sort, onSort, onRename, onCards, onDelete, onSaveNow, onBack } = props;

  const label = deckLabel(deck, limits.nameLength);
  const [compare, setCompare] = useState<Compare>(NO_COMPARE);
  const [status, setStatus] = useState<string | null>(null);
  const [refusedCardId, setRefusedCardId] = useState<string | null>(null);
  const [detailCardId, setDetailCardId] = useState<string | null>(null);
  const [codeShown, setCodeShown] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [awaitingComplete, setAwaitingComplete] = useState(false);
  const dragged = useRef<string | null>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const nameId = useId();
  const verdictTitleId = useId();
  const confirmTextId = useId();

  // The status line fades after a moment; the next add, removal or refusal replaces it.
  useEffect(() => {
    if (status === null) return undefined;
    const timer = window.setTimeout(() => {
      setStatus(null);
    }, DECK_STATUS_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [status]);

  // R256: completing a deck saves at once, and says so once the server has it. A card taken out
  // first calls the announcement off.
  useEffect(() => {
    if (!awaitingComplete) return;
    if (deck.cards.length < DECK_SIZE) {
      setAwaitingComplete(false);
      return;
    }
    if (saved) {
      setAwaitingComplete(false);
      setStatus(DECK_COMPLETE_SAVED);
    }
  }, [awaitingComplete, saved, deck.cards.length]);

  // The confirm opens on its safe answer, so a stray Enter keeps the deck.
  useEffect(() => {
    if (confirming) keepButton.current?.focus();
  }, [confirming]);

  const compared = useMemo(() => comparedDecks(compare, deck.id, decks, trios), [compare, deck.id, decks, trios]);
  const holders = useMemo(() => holdersOf(compared, limits.nameLength), [compared, limits.nameLength]);
  const inDeck = useMemo(() => new Set(deck.cards), [deck.cards]);
  const conflicts = useMemo(() => {
    const clashing = new Map<string, Holder>();
    for (const cardId of deck.cards) {
      const holder = holders.get(cardId);
      if (holder !== undefined) clashing.set(cardId, holder);
    }
    return clashing;
  }, [deck.cards, holders]);

  const pool = useMemo(() => visiblePool(catalog, collection, filter, sort), [catalog, collection, filter, sort]);
  const verdict = useMemo(
    () => deckVerdict(deck, catalog, collection, limits.nameLength),
    [deck, catalog, collection, limits.nameLength],
  );
  const code = useMemo(() => (codeShown ? encodeDeckCode(label, deck.cards, catalog) : ""), [codeShown, label, deck.cards, catalog]);

  const nameOf = useCallback((cardId: string) => catalog.cards[cardId]?.name ?? cardId, [catalog]);

  const add = useCallback(
    (cardId: string) => {
      const move = addCard(deck.cards, cardId, holders);
      if (!move.ok) {
        setRefusedCardId(cardId);
        if (move.reason === "here") setStatus(`${nameOf(cardId)} is already in this deck.`);
        else if (move.reason === "held") setStatus(`${nameOf(cardId)} is in ${move.holder.name}.`);
        else setStatus(`${label} has ${String(DECK_SIZE)} cards. Take one out to add another.`);
        return;
      }
      setRefusedCardId(null);
      onCards(move.cards);
      setStatus(`${nameOf(cardId)} added · ${String(move.cards.length)}/${String(DECK_SIZE)}`);
      if (move.cards.length === DECK_SIZE) {
        setAwaitingComplete(true);
        onSaveNow();
      }
    },
    [deck.cards, holders, label, nameOf, onCards, onSaveNow],
  );

  const remove = useCallback(
    (cardId: string) => {
      const next = removeCard(deck.cards, cardId);
      if (next === null) return;
      setRefusedCardId(null);
      onCards(next);
      setStatus(`${nameOf(cardId)} removed · ${String(next.length)}/${String(DECK_SIZE)}`);
    },
    [deck.cards, nameOf, onCards],
  );

  const startDrag = useCallback((cardId: string, event: DragEvent<HTMLElement>) => {
    dragged.current = cardId;
    // A drag is not an inspection: any preview still open would sit over the drop target.
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

  const drop = useCallback(
    (event: DragEvent<HTMLElement>) => {
      event.preventDefault();
      const cardId = droppedCardId(event, dragged.current);
      if (cardId !== null) add(cardId);
    },
    [add],
  );

  const openDetail = useCallback((cardId: string) => {
    // At most one inspect overlay at a time: a hover preview on a tile gives way to the detail.
    closeInspect();
    setDetailCardId(cardId);
  }, []);

  const copyCode = useCallback(() => {
    setCodeShown(true);
    const text = encodeDeckCode(label, deck.cards, catalog);
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    const fallback = "Copy the code below to share this deck.";
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
      setStatus(fallback);
      return;
    }
    // A page without clipboard permission (an embedded frame, an old browser) still gets the code
    // in the field under the button, which is why the field is always shown.
    clipboard.writeText(text).then(
      () => {
        setStatus("Code copied. Paste it anywhere to share this deck.");
      },
      () => {
        setStatus(fallback);
      },
    );
  }, [catalog, deck.cards, label]);

  const pickCompare = useCallback(
    (value: string) => {
      if (value === "none") setCompare(NO_COMPARE);
      else if (value.startsWith("trio:")) setCompare({ kind: "trio", trioId: value.slice("trio:".length) });
      else if (value.startsWith("deck:")) setCompare((current) => withComparedDeck(current, value.slice("deck:".length)));
    },
    [],
  );

  const inTrios = triosHolding(deck.id, trios);
  const others = decks.filter((candidate) => candidate.id !== deck.id);
  const errors = verdict.ok ? [] : verdict.errors;
  const detailDef = detailCardId === null ? undefined : catalog.cards[detailCardId];
  const detailPlace: "deck" | Holder | null =
    detailCardId === null ? null : inDeck.has(detailCardId) ? "deck" : (holders.get(detailCardId) ?? null);
  const detailOwned = detailCardId === null || collection === null ? null : (collection[detailCardId] ?? 0) > 0;
  const full = deck.cards.length >= DECK_SIZE;
  const triosNamingIt = inTrios.length;

  const head = (
    <div className="ws-editor-head">
      <button type="button" className="ws-back" data-testid={WORKSHOP_BACK} onClick={onBack}>
        ← All decks
      </button>
      <label className="ws-name" htmlFor={nameId}>
        <span className="ws-field-label">Deck name</span>
        <input
          id={nameId}
          className="ws-name-input"
          data-testid={DECK_NAME_INPUT}
          value={deck.name}
          placeholder={UNTITLED_DECK}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => {
            onRename(clampName(event.target.value, limits.nameLength));
          }}
          onBlur={() => {
            // D1, gently: the field settles on the name the save sends ("Untitled deck" for none).
            if (deck.name !== label) onRename(label);
          }}
        />
      </label>
      {refusal === null ? null : (
        <p className="notice ws-save-error" data-testid={DECK_SAVE_ERROR} role="alert">
          {refusal}
        </p>
      )}
    </div>
  );

  return (
    <section className="ws-editor ws-editor--deck" data-testid={DECK_EDITOR} data-deck={deck.id} aria-label={`Deck: ${label}`}>
      <div className="db-layout">
        <DeckSidebar
          deckName={label}
          cards={deck.cards}
          catalog={catalog}
          conflicts={conflicts}
          head={head}
          onDropCard={drop}
          onRemove={remove}
          onInspect={openDetail}
        >
          <div className="ws-compare">
            <label className="ws-compare-pick">
              <span className="ws-field-label">Compare with</span>
              <select
                className="ws-select"
                data-testid={DECK_COMPARE_SELECT}
                value=""
                disabled={others.length === 0}
                onChange={(event) => {
                  pickCompare(event.target.value);
                }}
              >
                <option value="" disabled>
                  {others.length === 0 ? "No other decks yet" : "Another deck or a trio…"}
                </option>
                {inTrios.length === 0 ? null : (
                  <optgroup label="Trios with this deck">
                    {inTrios.map((trio) => (
                      <option key={trio.id} value={`trio:${trio.id}`}>
                        {`${trioLabel(trio, limits.nameLength)}: its other decks`}
                      </option>
                    ))}
                  </optgroup>
                )}
                {others.length === 0 ? null : (
                  <optgroup label="Other decks">
                    {others.map((other) => (
                      <option key={other.id} value={`deck:${other.id}`}>
                        {deckLabel(other, limits.nameLength)}
                      </option>
                    ))}
                  </optgroup>
                )}
                {compare.kind === "none" ? null : <option value="none">Stop comparing</option>}
              </select>
            </label>
            {compared.length === 0 ? null : (
              <ul className="ws-chips" aria-label="Compared decks">
                {compared.map((other) => {
                  const otherLabel = deckLabel(other, limits.nameLength);
                  return (
                    <li key={other.id}>
                      <button
                        type="button"
                        className="ws-chip-button"
                        data-testid={deckCompareChipId(other.id)}
                        aria-label={`Stop comparing with ${otherLabel}`}
                        onClick={() => {
                          setCompare((current) => withoutComparedDeck(current, compared, other.id));
                        }}
                      >
                        <span>{otherLabel}</span>
                        <span aria-hidden="true">×</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            {compared.length === 0 ? null : (
              <p className="ws-hint">Cards in these decks are marked in the pool and can’t be added here.</p>
            )}
            {conflicts.size === 0 ? null : (
              <p className="ws-conflicts" data-testid={DECK_CONFLICTS} data-count={String(conflicts.size)}>
                {`${String(conflicts.size)} ${conflicts.size === 1 ? "card here is" : "cards here are"} also in ${joinNames([...new Set([...conflicts.values()].map((holder) => holder.name))])}. They stay until you take them out.`}
              </p>
            )}
          </div>

          <section className="ws-verdict" data-testid={DECK_VERDICT} data-ready={verdict.ok ? "true" : "false"} aria-labelledby={verdictTitleId}>
            <h3 className="ws-verdict-title" id={verdictTitleId}>
              {verdict.ok ? (collection === null ? "Complete" : "Ready to queue") : "Before you can queue this deck"}
            </h3>
            <ul
              className="db-errors"
              data-testid={LOADOUT_ERRORS}
              data-count={String(errors.length)}
              data-tone="hint"
              aria-labelledby={verdictTitleId}
            >
              {errors.map((issue, position) => (
                <li
                  key={`${issue.rule}:${issue.cardId ?? ""}:${String(position)}`}
                  data-testid={loadoutErrorId(issue.rule)}
                  data-rule={issue.rule}
                  data-deck={issue.deck === undefined ? undefined : String(issue.deck)}
                  data-card={issue.cardId}
                  data-source="client"
                >
                  {issue.message}
                </li>
              ))}
            </ul>
            {collection === null ? (
              <p className="ws-hint">Your collection couldn’t be loaded, so cards you don’t own aren’t flagged here.</p>
            ) : null}
          </section>

          <div className="ws-actions">
            <button type="button" className="ws-action" data-testid={DECK_COPY_CODE} onClick={copyCode}>
              Copy code
            </button>
            <button
              type="button"
              className="ws-action ws-action--danger"
              data-testid={DECK_DELETE}
              aria-expanded={confirming}
              onClick={() => {
                setConfirming(true);
              }}
            >
              Delete deck
            </button>
          </div>
          {codeShown ? (
            <label className="ws-code">
              <span className="ws-field-label">Deck code</span>
              <input
                className="ws-code-input"
                data-testid={DECK_CODE_OUTPUT}
                readOnly
                value={code}
                onFocus={(event) => {
                  event.currentTarget.select();
                }}
              />
            </label>
          ) : null}
          {confirming ? (
            <div className="ws-confirm" role="group" aria-labelledby={confirmTextId}>
              <p id={confirmTextId}>
                {triosNamingIt === 0
                  ? `Delete “${label}”? This can’t be undone.`
                  : `Delete “${label}”? Its slot in ${String(triosNamingIt)} ${triosNamingIt === 1 ? "trio" : "trios"} will be empty. This can’t be undone.`}
              </p>
              <div className="ws-confirm-actions">
                <button type="button" className="ws-action ws-action--danger" data-testid={DECK_DELETE_CONFIRM} onClick={onDelete}>
                  Delete
                </button>
                <button
                  ref={keepButton}
                  type="button"
                  className="ws-action"
                  data-testid={DECK_DELETE_CANCEL}
                  onClick={() => {
                    setConfirming(false);
                  }}
                >
                  Keep it
                </button>
              </div>
            </div>
          ) : null}
        </DeckSidebar>

        <section className="db-browse" aria-label="Browse cards">
          <FilterBar
            filter={filter}
            onFilter={onFilter}
            sort={sort}
            onSort={onSort}
            count={pool.length}
            ownedUnavailable={collection === null}
          />
          {/* What the last add, removal or refusal did, as a toast at the foot of the screen: deep in
              the pool on a phone, the deck's own count has scrolled away. Polite, so a screen reader
              hears each one too. It ignores the pointer, so it never covers a card (deckbuilder.css). */}
          <p className="db-deck-status" data-testid={DECK_STATUS} role="status" aria-live="polite">
            {status ?? ""}
          </p>
          {/* The frame is what the pool's cards are sized against on a desktop (deckbuilder.css): its
              height is whatever the filters above leave, and two rows of cards fill it. */}
          <div className="db-pool-frame">
            <PoolGrid
              ids={pool}
              deckName={label}
              catalog={catalog}
              collection={collection}
              inDeck={inDeck}
              holders={holders}
              refusedCardId={refusedCardId}
              onAdd={add}
              onInspect={openDetail}
              onDragStart={startDrag}
              onDragEnd={endDrag}
            />
            {pool.length === 0 ? (
              <p className="db-empty" data-testid={DB_EMPTY}>
                No card matches these filters.
              </p>
            ) : null}
          </div>
        </section>
      </div>

      {detailCardId === null || detailDef === undefined ? null : (
        <CardDetail
          def={detailDef}
          onClose={() => {
            setDetailCardId(null);
          }}
          meta={
            <span className="db-detail-meta">
              {detailPlace === null ? "Not in this deck" : detailPlace === "deck" ? "In this deck" : `In ${detailPlace.name}`}
              {detailOwned === false ? " · not in your collection" : ""}
            </span>
          }
          actions={
            <button
              type="button"
              className="db-detail-add"
              data-testid={DB_DETAIL_ADD}
              // The same refusals the "+" and a drop get, so the action says so by being unavailable.
              disabled={detailPlace !== null || full}
              onClick={() => {
                add(detailCardId);
              }}
            >
              {`Add to ${label}`}
            </button>
          }
        />
      )}
    </section>
  );
}
