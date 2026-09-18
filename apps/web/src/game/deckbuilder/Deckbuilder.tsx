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

import { useCallback, useMemo, useRef, useState } from "react";

import type { CardCost, CardDef } from "@jackioh/shared";
import type { CatalogSnapshot, Collection, LoadoutError } from "@jackioh/validator";

import "./deckbuilder.css";
import {
  DECK_NUMBERS,
  addCard,
  deckHolding,
  issuesOf,
  poolFrom,
  removeCard,
  type Draft,
} from "./loadout.ts";
import {
  CARD_POOL,
  DECKBUILDER,
  DECK_DRAG_MIME,
  LOADOUT_ERRORS,
  LOADOUT_SAVE,
  LOADOUT_SAVED,
  LOADOUT_SAVE_ERROR,
  deckCardId,
  deckCardRowId,
  deckDropId,
  deckListId,
  deckTabId,
  poolCardId,
} from "./testids.ts";

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

function nameOf(def: CardDef | undefined, cardId: string): string {
  return def?.name ?? cardId;
}

/** §5's three shapes of `CardCost`: a number, `X`, or an embiggen pair. Display only. */
export function formatCost(cost: CardCost | undefined): string {
  if (cost === undefined) return "";
  if (typeof cost === "number") return String(cost);
  if (cost === "X") return cost;
  return `${String(cost.base)}/${String(cost.embiggen)}`;
}

export default function Deckbuilder(props: DeckbuilderProps) {
  const { catalog, collection, save } = props;

  const [draft, setDraft] = useState<Draft>(() =>
    DECK_NUMBERS.map((deck) => [...(props.initialDecks?.[deck - 1] ?? [])]),
  );
  const [activeDeck, setActiveDeck] = useState(DECK_NUMBERS[0] ?? 1);
  const [serverIssues, setServerIssues] = useState<readonly LoadoutError[] | null>(null);
  const [serverMessage, setServerMessage] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [refusedCardId, setRefusedCardId] = useState<string | null>(null);
  const dragged = useRef<string | null>(null);

  const pool = useMemo(() => poolFrom(catalog, collection), [catalog, collection]);

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
        return;
      }
      setRefusedCardId(null);
      edited(move.draft);
    },
    [draft, edited],
  );

  const takeFromDeck = useCallback(
    (deck: number, cardId: string) => {
      const move = removeCard(draft, deck, cardId);
      if (!move.applied) return;
      setRefusedCardId(null);
      edited(move.draft);
    },
    [draft, edited],
  );

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

  return (
    <div className="app-shell deckbuilder" data-testid={DECKBUILDER}>
      <h1>JackiOh — decks</h1>

      <div className="db-tabs" role="tablist" aria-label="Decks">
        {DECK_NUMBERS.map((deck) => (
          <button
            key={deck}
            type="button"
            role="tab"
            data-testid={deckTabId(deck)}
            data-deck={deck}
            aria-selected={deck === activeDeck}
            data-active={deck === activeDeck ? "true" : "false"}
            onClick={() => {
              setActiveDeck(deck);
            }}
            onDragOver={allowDrop}
            onDrop={(event) => {
              event.preventDefault();
              const cardId = droppedCardId(event, dragged.current);
              if (cardId === null) return;
              setActiveDeck(deck);
              putInDeck(deck, cardId);
            }}
          >
            {`Deck ${String(deck)}`}
            <span className="db-count" data-testid={`deck-count-${String(deck)}`}>
              {String(draft[deck - 1]?.length ?? 0)}
            </span>
          </button>
        ))}
      </div>

      <div className="db-panes">
        <section className="db-pool" aria-label="Card pool" data-testid={CARD_POOL}>
          {pool.map((cardId) => {
            const heldBy = deckHolding(draft, cardId);
            const def = catalog.cards[cardId];
            return (
              <button
                key={cardId}
                type="button"
                className="db-card"
                data-testid={poolCardId(cardId)}
                data-card={cardId}
                // `e2e/support/testids.ts` already exports this as ILLEGAL (M5-T2's vocabulary):
                // a card the builder will not put in the open deck, because one is already held.
                data-legal={heldBy === null ? "true" : "false"}
                data-in-deck={heldBy === null ? undefined : String(heldBy)}
                data-refused={refusedCardId === cardId ? "true" : undefined}
                aria-disabled={heldBy !== null}
                draggable
                onDragStart={(event) => {
                  dragged.current = cardId;
                  try {
                    event.dataTransfer.setData(DECK_DRAG_MIME, cardId);
                    event.dataTransfer.setData("text/plain", cardId);
                    event.dataTransfer.effectAllowed = "move";
                  } catch {
                    // Cypress and jsdom synthesise drag events without a DataTransfer; the id is
                    // already in `dragged`, which is what `onDrop` reads first.
                  }
                }}
                onDragEnd={() => {
                  dragged.current = null;
                }}
                onClick={() => {
                  putInDeck(activeDeck, cardId);
                }}
              >
                <span className="db-card-name">{nameOf(def, cardId)}</span>
                <span className="db-card-cost">{formatCost(def?.cost)}</span>
              </button>
            );
          })}
        </section>

        {DECK_NUMBERS.map((deck) => (
          <section
            key={deck}
            className="db-deck"
            aria-label={`Deck ${String(deck)}`}
            data-testid={deckDropId(deck)}
            data-deck={deck}
            // All three decks are on screen at once: L1 fixes the count at three, L4 is about all
            // of them together, and `09-deckbuilder.cy.ts` reads a card out of each. The tab only
            // says which deck a click or a drop lands in.
            data-active={deck === activeDeck ? "true" : "false"}
            onDragOver={allowDrop}
            onDrop={(event) => {
              event.preventDefault();
              const cardId = droppedCardId(event, dragged.current);
              if (cardId === null) return;
              putInDeck(deck, cardId);
            }}
          >
            <ul className="db-deck-list" data-testid={deckListId(deck)}>
              {(draft[deck - 1] ?? []).map((cardId) => (
                <li key={`${String(deck)}:${cardId}`} data-testid={deckCardRowId(deck, cardId)}>
                  <button
                    type="button"
                    className="db-card"
                    data-testid={deckCardId(deck, cardId)}
                    data-card={cardId}
                    onClick={() => {
                      takeFromDeck(deck, cardId);
                    }}
                  >
                    <span className="db-card-name">{nameOf(catalog.cards[cardId], cardId)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

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
            data-testid={`loadout-error-${issue.rule}`}
            data-rule={issue.rule}
            data-deck={issue.deck === undefined ? undefined : String(issue.deck)}
            data-card={issue.cardId}
            data-source={serverIssues === null ? "client" : "server"}
          >
            {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A drop target has to say so, or the browser never fires `drop`. */
function allowDrop(event: React.DragEvent<HTMLElement>): void {
  event.preventDefault();
  try {
    event.dataTransfer.dropEffect = "move";
  } catch {
    // Synthesised events carry no DataTransfer; `preventDefault` is the part that matters.
  }
}

/** The dragged card: the id this component recorded, else whatever the DataTransfer carries. */
function droppedCardId(event: React.DragEvent<HTMLElement>, held: string | null): string | null {
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
