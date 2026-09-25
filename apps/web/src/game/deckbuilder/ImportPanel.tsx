// The import panel: paste a deck code, see what it holds, and make it a new deck (SPEC §9.4,
// R255).
//
// An import always makes a NEW deck (R255), so it never overwrites work. The preview is live and
// says everything the code's decoder did: the name (or the fallback when the code's own name is
// unusable), the count, each card it had to leave out and why (a number this catalog does not
// know, a Token, a copy past `MAX_COPIES`, a card past `DECK_SIZE`), and the cards the player does
// not own, which are KEPT and only flagged — they are judged when the deck is queued (R253). A code
// that cannot be read is refused with the decoder's sentence, and nothing is made.
//
// At the deck cap the import is off, with the reason beside it; the pasted code stays in the box,
// so deleting a deck in the rail and coming back finishes the job.

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import { decodeDeckCode, type DroppedCards } from "./deckCode.ts";
import { DECK_SIZE, MAX_COPIES } from "./deckSize.ts";
import {
  DECK_IMPORT,
  DECK_IMPORT_CANCEL,
  DECK_IMPORT_CAP_REASON,
  DECK_IMPORT_INPUT,
  DECK_IMPORT_PREVIEW,
  DECK_IMPORT_SUBMIT,
  WORKSHOP_BACK,
} from "./testids.ts";

export type ImportPanelProps = {
  catalog: CatalogSnapshot;
  collection: Collection | null;
  /** The player already has `deckLimit` decks: an import would be refused at the server. */
  atCap: boolean;
  deckLimit: number;
  onImport: (name: string, cards: readonly string[]) => void;
  onCancel: () => void;
};

/** "1 card", "3 cards". */
function cards(count: number): string {
  return `${String(count)} ${count === 1 ? "card" : "cards"}`;
}

/** Card names, as the preview lists them: "Bigot, Fruit Bat and Coin Toss". */
function namesOf(ids: readonly string[], catalog: CatalogSnapshot): string {
  const names = ids.map((id) => catalog.cards[id]?.name ?? id);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** One sentence per kind of card the code had and the new deck will not. */
export function droppedLines(dropped: DroppedCards, catalog: CatalogSnapshot): string[] {
  const lines: string[] = [];
  if (dropped.unknown.length > 0) {
    const numbers = dropped.unknown.map((number) => `#${String(number)}`).join(", ");
    lines.push(`Left out ${cards(dropped.unknown.length)} this version of JackiOh doesn’t know (${numbers}).`);
  }
  if (dropped.tokens.length > 0) {
    lines.push(`Left out ${namesOf(dropped.tokens, catalog)}: a Token never goes in a deck.`);
  }
  if (dropped.duplicates.length > 0) {
    const count = dropped.duplicates.length;
    lines.push(
      `Left out ${String(count)} extra ${count === 1 ? "copy" : "copies"} (a deck holds ${String(MAX_COPIES)} of each card): ${namesOf([...new Set(dropped.duplicates)], catalog)}.`,
    );
  }
  if (dropped.overflow.length > 0) {
    lines.push(`Left out ${cards(dropped.overflow.length)} past the ${String(DECK_SIZE)} a deck holds: ${namesOf(dropped.overflow, catalog)}.`);
  }
  return lines;
}

export default function ImportPanel(props: ImportPanelProps): ReactElement {
  const { catalog, collection, atCap, deckLimit, onImport, onCancel } = props;
  const [text, setText] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const inputId = useId();
  const reasonId = useId();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const decoded = useMemo(
    () => (text.trim().length === 0 ? null : decodeDeckCode(text, catalog, collection)),
    [text, catalog, collection],
  );

  return (
    <section className="ws-editor ws-import" data-testid={DECK_IMPORT} aria-labelledby={titleId}>
      <div className="ws-editor-head">
        <button type="button" className="ws-back" data-testid={WORKSHOP_BACK} onClick={onCancel}>
          ← All decks
        </button>
        <h2 className="ws-import-title" id={titleId}>
          Import a deck
        </h2>
      </div>
      <p className="ws-hint">Paste a deck code someone shared. It becomes a new deck; nothing you have is changed.</p>
      <label className="ws-field-label" htmlFor={inputId}>
        Deck code
      </label>
      <textarea
        ref={input}
        id={inputId}
        className="ws-import-input"
        data-testid={DECK_IMPORT_INPUT}
        value={text}
        rows={3}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder="JKO1.…"
        onChange={(event) => {
          setText(event.target.value);
        }}
      />

      <div
        className="ws-import-preview"
        data-testid={DECK_IMPORT_PREVIEW}
        data-ok={decoded === null ? undefined : decoded.ok ? "true" : "false"}
        aria-live="polite"
      >
        {decoded === null ? null : decoded.ok ? (
          <>
            <p className="ws-import-name">
              <strong>{decoded.name}</strong>
              {` · ${String(decoded.cards.length)}/${String(DECK_SIZE)} cards`}
            </p>
            {decoded.nameFellBack ? <p>The code’s name couldn’t be used, so the deck gets this one. You can rename it.</p> : null}
            <ul className="ws-import-notes">
              {droppedLines(decoded.dropped, catalog).map((line) => (
                <li key={line} data-kind="dropped">
                  {line}
                </li>
              ))}
              {decoded.unowned.length === 0 ? null : (
                <li data-kind="unowned">
                  {`${cards(decoded.unowned.length)} you don’t own yet ${decoded.unowned.length === 1 ? "is" : "are"} kept: ${namesOf(decoded.unowned, catalog)}. You’ll need ${decoded.unowned.length === 1 ? "it" : "them"} before this deck can queue.`}
                </li>
              )}
            </ul>
          </>
        ) : (
          <p className="notice" role="alert">
            {decoded.message}
          </p>
        )}
      </div>

      {atCap ? (
        <p className="ws-cap-note" id={reasonId} data-testid={DECK_IMPORT_CAP_REASON}>
          {`You have ${String(deckLimit)} decks, the most you can keep. Delete one to import this.`}
        </p>
      ) : null}

      <div className="ws-actions">
        <button
          type="button"
          className="ws-action ws-action--primary"
          data-testid={DECK_IMPORT_SUBMIT}
          disabled={decoded === null || !decoded.ok || atCap}
          aria-describedby={atCap ? reasonId : undefined}
          onClick={() => {
            if (decoded === null || !decoded.ok || atCap) return;
            onImport(decoded.name, decoded.cards);
          }}
        >
          Import as new deck
        </button>
        <button type="button" className="ws-action" data-testid={DECK_IMPORT_CANCEL} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
