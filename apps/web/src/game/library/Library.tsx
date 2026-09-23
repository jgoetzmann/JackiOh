// The deck library's constructor (BUILD M9-T2, SPEC §11 R171): Hearthstone's collection manager.
// Pages of full cards on the left; on the right the saved decks, or, while one is open, its
// decklist as cost-and-name bars.
//
// THE MESSAGES ARE NOT WRITTEN HERE, under the house rule in `Deckbuilder.tsx`'s header: every
// L-rule sentence this screen shows is a `LoadoutError.message`, either `validateDeck`'s own (the
// client's verdict, UX) or the server's relay of the same module's output (law), rendered as
// `{issue.message}` and nothing else. The only refusals made here are `library.ts`'s UX ones.
//
// Presentational and without I/O, like `Deckbuilder.tsx`: the route hands it the catalog, the
// collection, the decks and three functions, and re-renders `decks` after each of them.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type ReactElement,
} from "react";

import { validateDeck, type CatalogSnapshot, type Collection, type LoadoutError } from "@jackioh/validator";

import { BackLink } from "../../routes/nav.tsx";
import { allowDrop, droppedCardId, formatCost, type SaveOutcome } from "../deckbuilder/Deckbuilder.tsx";
import { DECK_SIZE, MAX_COPIES } from "../deckbuilder/deckSize.ts";
import { poolFrom } from "../deckbuilder/loadout.ts";
import { DECK_DRAG_MIME } from "../deckbuilder/testids.ts";
import CardFace from "./CardFace.tsx";
import CardInspector from "./CardInspector.tsx";
import "./library.css";
import {
  FALLBACK_PAGE_SIZE,
  PAGE_GAP,
  addCard,
  barsOf,
  cardWidthFor,
  clampPage,
  copiesIn,
  pageCount,
  pageOf,
  pageSizeFor,
  previewPlacement,
  removeCard,
  sameCards,
  sortByCost,
} from "./library.ts";
import {
  DECKLIST,
  DECK_BACK,
  DECK_BAR_MIME,
  DECK_CARD_COUNT,
  DECK_DISCARD_CONFIRM,
  DECK_ERRORS,
  DECK_NAME_INPUT,
  DECK_SAVE,
  DECK_SAVED,
  DECK_SAVE_ERROR,
  HOVER_PREVIEW,
  LIBRARY,
  LIBRARY_DECKS,
  LIBRARY_DECK_TOTAL,
  LIBRARY_INCOMPLETE,
  LIBRARY_NEW_DECK,
  LIBRARY_PAGES,
  PAGE_INDICATOR,
  PAGE_NEXT,
  PAGE_PREV,
  deckBarId,
  deckErrorId,
  libraryDeckDeleteConfirmId,
  libraryDeckDeleteId,
  libraryDeckId,
  pageCardId,
} from "./testids.ts";

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

const NEW_DECK_NAME = "New deck";
/** The hover preview is this much larger than a page card. */
const PREVIEW_SCALE = 1.5;

/** The deck open in the editor. */
type Editing = LibraryDraft & {
  /** Null until the first save; every save after that is an update. */
  id: string | null;
  /** The deck as last opened or saved, so Back knows whether it would drop edits. */
  stored: LibraryDraft;
};

type Preview = { cardId: string; top: number; left: number; width: number };

/** Arrow keys turn pages, except while the player is typing a deck name. */
function typingIn(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  );
}

export default function Library(props: LibraryProps): ReactElement {
  const { catalog, collection, decks, maxDecks, create, save, remove } = props;
  const deckSize = props.deckSize ?? DECK_SIZE;
  const maxCopies = props.maxCopies ?? MAX_COPIES;

  const [editing, setEditing] = useState<Editing | null>(null);
  const [serverIssues, setServerIssues] = useState<readonly LoadoutError[] | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [page, setPage] = useState(0);
  const [layout, setLayout] = useState(() => ({ ...FALLBACK_PAGE_SIZE, cardWidth: cardWidthFor(window.innerWidth) }));
  const grid = useRef<HTMLDivElement>(null);
  const decklist = useRef<HTMLElement>(null);
  const draggedCard = useRef<string | null>(null);
  const draggedBar = useRef<string | null>(null);

  const pool = useMemo(() => sortByCost(poolFrom(catalog, collection), catalog), [catalog, collection]);
  const offered = useMemo(() => new Set(pool), [pool]);
  const perPage = layout.cols * layout.rows;
  const pages = pageCount(pool.length, perPage);
  const current = clampPage(page, pages);
  // The page count shrank under the open page (a resize, a smaller pool): settle on the last one.
  if (current !== page) setPage(current);

  // The page is as many whole cards as the grid's measured box holds.
  useEffect(() => {
    const node = grid.current;
    if (node === null || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry === undefined) return;
      const cardWidth = cardWidthFor(window.innerWidth);
      setLayout({ ...pageSizeFor(entry.contentRect.width, entry.contentRect.height, cardWidth), cardWidth });
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    if (inspecting !== null) return;
    function onKey(event: KeyboardEvent): void {
      if (typingIn(event.target)) return;
      if (event.key === "ArrowLeft") setPage((p) => clampPage(p - 1, pages));
      if (event.key === "ArrowRight") setPage((p) => clampPage(p + 1, pages));
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [inspecting, pages]);

  /** Any edit retires the last save's verdict: it was about a deck that no longer exists. */
  const edited = useCallback((next: Editing) => {
    setEditing(next);
    setServerIssues(null);
    setServerMessage(null);
    setSaved(false);
    setConfirmDiscard(false);
  }, []);

  const open = useCallback(
    (deck: LibraryDeck | null) => {
      const stored = deck === null ? { name: NEW_DECK_NAME, cards: [] } : { name: deck.name, cards: [...deck.cards] };
      edited({ id: deck?.id ?? null, ...stored, stored });
      setArmedDelete(null);
    },
    [edited],
  );

  const close = useCallback(() => {
    setEditing(null);
    setServerIssues(null);
    setServerMessage(null);
    setSaved(false);
    setConfirmDiscard(false);
    setPreview(null);
  }, []);

  const closeInspector = useCallback(() => {
    setInspecting(null);
  }, []);

  /** One more copy, or null: past a limit, or not a card the pages offer (a token, any stray text dropped). */
  const plusOne = useCallback(
    (cards: readonly string[], cardId: string) =>
      offered.has(cardId) ? addCard(cards, cardId, { deckSize, maxCopies }) : null,
    [offered, deckSize, maxCopies],
  );

  const add = useCallback(
    (cardId: string) => {
      if (editing === null) return;
      const cards = plusOne(editing.cards, cardId);
      if (cards !== null) edited({ ...editing, cards });
    },
    [editing, edited, plusOne],
  );

  const take = useCallback(
    (cardId: string) => {
      if (editing === null) return;
      const cards = removeCard(editing.cards, cardId);
      if (cards !== null) edited({ ...editing, cards });
    },
    [editing, edited],
  );

  const onSave = useCallback(() => {
    if (editing === null) return;
    const draft: LibraryDraft = { name: editing.name, cards: [...editing.cards] };
    const deckId = editing.id;
    const sentFrom = editing.stored;
    setBusy(true);
    setSaved(false);
    void Promise.resolve(deckId === null ? create(draft) : save(deckId, draft))
      .then((outcome) => {
        if (outcome.ok) {
          // Keep editing the stored deck, so the next save is an update of it: the server's copy
          // (a trimmed name) when the draft is still what was sent, else the draft as edited since,
          // dirty against the new baseline. `sentFrom` is the open deck's identity: the answer
          // never lands in an editor closed, or opened on another deck, while it was in flight.
          const stored = { name: outcome.deck.name, cards: [...outcome.deck.cards] };
          const id = outcome.deck.id;
          setEditing((now) => {
            if (now?.stored !== sentFrom) return now;
            const untouched = now.name === draft.name && sameCards(now.cards, draft.cards);
            return untouched ? { id, ...stored, stored } : { ...now, id, stored };
          });
          setServerIssues(null);
          setServerMessage(null);
          setSaved(true);
          setConfirmDiscard(false);
          return;
        }
        setServerIssues(outcome.issues);
        setServerMessage(outcome.issues.length === 0 ? outcome.message : null);
      })
      .finally(() => {
        setBusy(false);
      });
  }, [editing, create, save]);

  const onDelete = useCallback(
    (deckId: string) => {
      setBusy(true);
      void Promise.resolve(remove(deckId))
        .then((outcome) => {
          setArmedDelete(null);
          setServerMessage(outcome.ok ? null : outcome.message);
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [remove],
  );

  // §9.3: the client's verdict is UX, skipped entirely without a collection (L5 needs it); the
  // server's verdict on this exact deck, once given, is what is shown until the next edit.
  const clientIssues = useMemo((): readonly LoadoutError[] => {
    if (editing === null || collection === null) return [];
    const result = validateDeck({
      deck: { name: editing.name, cards: editing.cards },
      catalog,
      collection,
      rules: { deckSize, maxCopies },
      allowIncomplete: true,
    });
    return result.ok ? [] : result.errors;
  }, [editing, catalog, collection, deckSize, maxCopies]);
  const issues = serverIssues ?? clientIssues;

  function showPreview(cardId: string, bar: HTMLElement): void {
    const rect = bar.getBoundingClientRect();
    setPreview({
      cardId,
      ...previewPlacement({
        bar: { top: rect.top, height: rect.height },
        listLeft: decklist.current?.getBoundingClientRect().left ?? rect.left,
        width: layout.cardWidth * PREVIEW_SCALE,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    });
  }

  function onPagesDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    let cardId = draggedBar.current;
    if (cardId === null) {
      try {
        cardId = event.dataTransfer.getData(DECK_BAR_MIME) || null;
      } catch {
        // A synthesised drag has no DataTransfer; with no bar recorded there is nothing to remove.
      }
    }
    draggedBar.current = null;
    draggedCard.current = null;
    if (cardId !== null) take(cardId);
  }

  function onDecklistDrop(event: DragEvent<HTMLElement>): void {
    event.preventDefault();
    // A bar carries only DECK_BAR_MIME, so dropping one back on the list finds no card to add.
    const cardId = draggedBar.current === null ? droppedCardId(event, draggedCard.current) : null;
    draggedCard.current = null;
    draggedBar.current = null;
    if (cardId !== null) add(cardId);
  }

  const cardCount = editing?.cards.length ?? 0;
  const dirty = editing !== null && (editing.name !== editing.stored.name || !sameCards(editing.cards, editing.stored.cards));
  const inspected = inspecting === null ? undefined : catalog.cards[inspecting];
  const previewDef =
    preview !== null && editing !== null && editing.cards.includes(preview.cardId)
      ? catalog.cards[preview.cardId]
      : undefined;

  function inspectorToggle(cardId: string): "add" | "remove" | null {
    if (editing === null) return null;
    if (plusOne(editing.cards, cardId) !== null) return "add";
    return copiesIn(editing.cards, cardId) > 0 ? "remove" : null;
  }

  const saveError =
    serverMessage === null ? null : (
      // Not a rule failure (a stale catalog, the cap, a bad name): the server's sentence, unchanged.
      <p className="notice notice--error" data-testid={DECK_SAVE_ERROR}>
        {serverMessage}
      </p>
    );

  return (
    <div className="app-shell app-shell--wide library" data-testid={LIBRARY}>
      <header className="lib-top">
        {editing === null ? <BackLink /> : null}
        <h1>Deck library</h1>
      </header>

      <div className="lib-main">
        <section
          className="lib-book"
          aria-label="Card pages"
          data-testid={LIBRARY_PAGES}
          onDragOver={allowDrop}
          onDrop={onPagesDrop}
        >
          <button
            type="button"
            className="lib-arrow"
            data-testid={PAGE_PREV}
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
            }}
          >
            ‹
          </button>
          <div
            ref={grid}
            className="lib-grid"
            style={
              {
                "--lib-card-w": `${String(layout.cardWidth)}px`,
                "--lib-gap": `${String(PAGE_GAP)}px`,
                "--lib-cols": layout.cols,
              } as CSSProperties
            }
          >
            {pageOf(pool, current, perPage).map((cardId) => {
              const def = catalog.cards[cardId];
              if (def === undefined) return null;
              const full = editing !== null && copiesIn(editing.cards, cardId) >= maxCopies;
              return (
                <button
                  key={cardId}
                  type="button"
                  className="lib-page-card"
                  data-testid={pageCardId(cardId)}
                  data-card={cardId}
                  data-in-deck={full ? "true" : undefined}
                  aria-label={full ? `${def.name} (in deck)` : def.name}
                  draggable
                  onDragStart={(event) => {
                    draggedCard.current = cardId;
                    draggedBar.current = null;
                    try {
                      event.dataTransfer.setData(DECK_DRAG_MIME, cardId);
                      event.dataTransfer.setData("text/plain", cardId);
                      event.dataTransfer.effectAllowed = "copy";
                    } catch {
                      // Synthesised drags carry no DataTransfer; `draggedCard` is read first anyway.
                    }
                  }}
                  onDragEnd={() => {
                    draggedCard.current = null;
                  }}
                  onClick={() => {
                    setInspecting(cardId);
                  }}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    add(cardId);
                  }}
                >
                  <CardFace def={def} />
                  {full ? <span className="lib-in-deck">In deck</span> : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="lib-arrow"
            data-testid={PAGE_NEXT}
            aria-label="Next page"
            disabled={current >= pages - 1}
            onClick={() => {
              setPage(current + 1);
            }}
          >
            ›
          </button>
          <p
            className="lib-page-indicator"
            data-testid={PAGE_INDICATOR}
            data-page={String(current + 1)}
            data-pages={String(pages)}
            data-rows={String(layout.rows)}
            data-cols={String(layout.cols)}
          >
            {`Page ${String(current + 1)} / ${String(pages)}`}
          </p>
        </section>

        {editing === null ? (
          <section className="lib-side" aria-label="Your decks">
            <div className="lib-side-head">
              <h2>Your decks</h2>
              <span className="lib-count" data-testid={LIBRARY_DECK_TOTAL}>
                {`${String(decks.length)}/${String(maxDecks)}`}
              </span>
            </div>
            <button
              type="button"
              className="button-primary"
              data-testid={LIBRARY_NEW_DECK}
              disabled={decks.length >= maxDecks}
              onClick={() => {
                open(null);
              }}
            >
              New deck
            </button>
            <ul className="lib-decks" data-testid={LIBRARY_DECKS}>
              {decks.map((deck) => (
                <li key={deck.id} className="lib-deck-row">
                  <button
                    type="button"
                    className="lib-deck-open"
                    data-testid={libraryDeckId(deck.id)}
                    onClick={() => {
                      open(deck);
                    }}
                  >
                    <span className="lib-deck-name">{deck.name}</span>
                    <span className="lib-count">{`${String(deck.cards.length)}/${String(deckSize)}`}</span>
                    {deck.cards.length < deckSize ? (
                      <span className="lib-badge" data-testid={LIBRARY_INCOMPLETE}>
                        Incomplete
                      </span>
                    ) : null}
                  </button>
                  {armedDelete === deck.id ? (
                    <>
                      <button
                        type="button"
                        className="lib-danger"
                        data-testid={libraryDeckDeleteConfirmId(deck.id)}
                        disabled={busy}
                        onClick={() => {
                          onDelete(deck.id);
                        }}
                      >
                        Delete
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setArmedDelete(null);
                        }}
                      >
                        Keep
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="lib-deck-delete"
                      data-testid={libraryDeckDeleteId(deck.id)}
                      aria-label={`Delete ${deck.name}`}
                      onClick={() => {
                        setArmedDelete(deck.id);
                      }}
                    >
                      ×
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {decks.length === 0 ? <p className="lib-hint">No decks yet. Start one with New deck.</p> : null}
            {saveError}
          </section>
        ) : (
          <section
            ref={decklist}
            className="lib-side lib-decklist"
            aria-label="Decklist"
            data-testid={DECKLIST}
            onDragOver={allowDrop}
            onDrop={onDecklistDrop}
          >
            <div className="lib-side-head">
              <input
                className="lib-name"
                data-testid={DECK_NAME_INPUT}
                aria-label="Deck name"
                value={editing.name}
                onChange={(event) => {
                  edited({ ...editing, name: event.target.value });
                }}
              />
              <span
                className="lib-count"
                data-testid={DECK_CARD_COUNT}
                data-count={String(cardCount)}
                data-deck-size={String(deckSize)}
              >
                {`${String(cardCount)}/${String(deckSize)}`}
              </span>
              {cardCount < deckSize ? (
                <span className="lib-badge" data-testid={LIBRARY_INCOMPLETE}>
                  Incomplete
                </span>
              ) : null}
            </div>

            <ul className="lib-bars">
              {barsOf(editing.cards, catalog).map(({ cardId, count }) => {
                const def = catalog.cards[cardId];
                return (
                  <li key={cardId}>
                    <button
                      type="button"
                      className="lib-bar"
                      data-testid={deckBarId(cardId)}
                      data-card={cardId}
                      data-count={String(count)}
                      draggable
                      onDragStart={(event) => {
                        draggedBar.current = cardId;
                        draggedCard.current = null;
                        setPreview(null);
                        try {
                          // Only the bar MIME: a `text/plain` copy would read as "add" on the list.
                          event.dataTransfer.setData(DECK_BAR_MIME, cardId);
                          event.dataTransfer.effectAllowed = "move";
                        } catch {
                          // Synthesised drags carry no DataTransfer; `draggedBar` is read first.
                        }
                      }}
                      onDragEnd={() => {
                        draggedBar.current = null;
                      }}
                      onClick={() => {
                        setInspecting(cardId);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        take(cardId);
                      }}
                      onMouseEnter={(event) => {
                        showPreview(cardId, event.currentTarget);
                      }}
                      onFocus={(event) => {
                        showPreview(cardId, event.currentTarget);
                      }}
                      onMouseLeave={() => {
                        setPreview(null);
                      }}
                      onBlur={() => {
                        setPreview(null);
                      }}
                    >
                      <span className="lib-bar-cost">{formatCost(def?.cost)}</span>
                      <span className="lib-bar-name">{def?.name ?? cardId}</span>
                      {count > 1 ? <span className="lib-bar-count">{`×${String(count)}`}</span> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
            {cardCount === 0 ? <p className="lib-hint">Drag cards here, or right-click them.</p> : null}

            <ul className="lib-errors" data-testid={DECK_ERRORS} data-count={String(issues.length)}>
              {issues.map((issue, position) => (
                <li
                  key={`${issue.rule}:${issue.cardId ?? ""}:${String(position)}`}
                  data-testid={deckErrorId(issue.rule)}
                  data-rule={issue.rule}
                  data-card={issue.cardId}
                  data-source={serverIssues === null ? "client" : "server"}
                >
                  {issue.message}
                </li>
              ))}
            </ul>
            {saveError}

            <div className="lib-deck-actions">
              {confirmDiscard ? (
                <>
                  <span className="lib-hint">Discard unsaved changes?</span>
                  <button
                    type="button"
                    className="lib-danger"
                    data-testid={DECK_DISCARD_CONFIRM}
                    // As Back: a save in flight is about to settle whether anything is unsaved.
                    disabled={busy}
                    onClick={close}
                  >
                    Discard
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmDiscard(false);
                    }}
                  >
                    Keep editing
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid={DECK_BACK}
                  // A save in flight is about to settle whether anything is unsaved.
                  disabled={busy}
                  onClick={() => {
                    if (dirty) setConfirmDiscard(true);
                    else close();
                  }}
                >
                  Back
                </button>
              )}
              <button
                type="button"
                className="button-primary"
                data-testid={DECK_SAVE}
                disabled={busy}
                aria-busy={busy}
                onClick={onSave}
              >
                Save
              </button>
              {/* Not while edits made during the save's flight are still unsaved. */}
              {saved && !dirty ? (
                <span className="lib-saved" data-testid={DECK_SAVED} role="status">
                  Saved
                </span>
              ) : null}
            </div>
          </section>
        )}
      </div>

      {previewDef === undefined || preview === null ? null : (
        <div
          className="lib-preview"
          data-testid={HOVER_PREVIEW}
          aria-hidden="true"
          style={{ top: preview.top, left: preview.left, width: preview.width }}
        >
          <CardFace def={previewDef} />
        </div>
      )}

      {inspecting === null || inspected === undefined ? null : (
        <CardInspector
          def={inspected}
          toggle={inspectorToggle(inspecting)}
          onToggle={() => {
            if (inspectorToggle(inspecting) === "add") add(inspecting);
            else take(inspecting);
          }}
          onClose={closeInspector}
        />
      )}
    </div>
  );
}
