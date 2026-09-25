// The trio import panel: paste a trio code, see what it holds, and make it three new decks and a
// trio (SPEC §9.4, R339–R341).
//
// Like a deck import it never overwrites work: every deck the code carries becomes a NEW deck, and
// the trio a new trio naming them. The preview is live and says everything the decoder did, deck by
// deck: the name, the count, what it had to leave out and why, and the cards the player does not
// own, which are KEPT and only flagged (judged at queue, R253). Cards two of the decks share are
// allowed too — a trio is a draft (R252) — and the preview says so; the trio editor marks each one.
//
// THE CAPS (R340). The shared validator's `checkImportRoom` says, before anything is sent, how many
// deck and trio slots the import needs and how many the player has; short of either, Import is off
// with that sentence beside it and nothing is made. The server checks the same again and writes
// the decks and the trio in one transaction, so an import is all or nothing (R341). A refusal is
// shown in the server's words, and the pasted code stays in the box.

import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from "react";

import { checkImportRoom, trioConflicts, type CatalogSnapshot, type Collection } from "@jackioh/validator";

import { DECK_SIZE } from "./deckSize.ts";
import { droppedLines } from "./ImportPanel.tsx";
import type { TrioImport, TrioImportResult, WorkshopLimits } from "./sync.ts";
import {
  TRIO_IMPORT,
  TRIO_IMPORT_CANCEL,
  TRIO_IMPORT_CAP_REASON,
  TRIO_IMPORT_ERROR,
  TRIO_IMPORT_INPUT,
  TRIO_IMPORT_PREVIEW,
  TRIO_IMPORT_SHARED,
  TRIO_IMPORT_SUBMIT,
  WORKSHOP_BACK,
  trioImportSlotId,
} from "./testids.ts";
import { decodeTrioCode } from "./trioCode.ts";

export type TrioImportPanelProps = {
  catalog: CatalogSnapshot;
  collection: Collection | null;
  /** What the player has saved now, and the caps (R340). */
  saved: { decks: number; trios: number };
  limits: WorkshopLimits;
  /** Makes the decks and the trio; settles with the new trio's id, or why nothing was made. */
  onImport: (init: TrioImport) => Promise<TrioImportResult>;
  /** Opens the trio an import made. */
  onImported: (trioId: string) => void;
  onCancel: () => void;
};

/** "1 card", "3 cards". */
function cardsWord(count: number): string {
  return `${String(count)} ${count === 1 ? "card" : "cards"}`;
}

/** Card names, as the preview lists them: "Bigot, Fruit Bat and Coin Toss". */
function namesOf(ids: readonly string[], catalog: CatalogSnapshot): string {
  const names = ids.map((id) => catalog.cards[id]?.name ?? id);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

export default function TrioImportPanel(props: TrioImportPanelProps): ReactElement {
  const { catalog, collection, saved, limits, onImport, onImported, onCancel } = props;
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const titleId = useId();
  const inputId = useId();
  const reasonId = useId();

  useEffect(() => {
    input.current?.focus();
  }, []);

  const decoded = useMemo(
    () => (text.trim().length === 0 ? null : decodeTrioCode(text, catalog, collection)),
    [text, catalog, collection],
  );

  const filled = decoded === null || !decoded.ok ? 0 : decoded.slots.filter((slot) => slot !== null).length;
  const room =
    decoded === null || !decoded.ok
      ? null
      : checkImportRoom({
          saved,
          limits: { decks: limits.decks, trios: limits.trios },
          adding: { decks: filled, trios: 1 },
        });
  const shared =
    decoded === null || !decoded.ok ? [] : trioConflicts(decoded.slots.map((slot) => ({ cards: slot?.cards ?? [] })));
  const blocked = decoded === null || !decoded.ok || room === null || !room.ok || busy;

  const submit = (): void => {
    if (decoded === null || !decoded.ok || blocked) return;
    setBusy(true);
    setRefusal(null);
    const init: TrioImport = {
      name: decoded.name,
      slots: decoded.slots.map((slot) => (slot === null ? null : { name: slot.name, cards: slot.cards })),
    };
    void onImport(init)
      .then(
        (result) => {
          if (result.ok) onImported(result.trioId);
          else setRefusal(result.message);
        },
        (cause: unknown) => {
          setRefusal(cause instanceof Error ? cause.message : String(cause));
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section className="ws-editor ws-import" data-testid={TRIO_IMPORT} aria-labelledby={titleId}>
      <div className="ws-editor-head">
        <button type="button" className="ws-back" data-testid={WORKSHOP_BACK} onClick={onCancel}>
          ← All decks
        </button>
        <h2 className="ws-import-title" id={titleId}>
          Import a trio
        </h2>
      </div>
      <p className="ws-hint">
        Paste a trio code someone shared. Its decks become new decks and the trio a new trio; nothing you have is changed.
      </p>
      <label className="ws-field-label" htmlFor={inputId}>
        Trio code
      </label>
      <textarea
        ref={input}
        id={inputId}
        className="ws-import-input"
        data-testid={TRIO_IMPORT_INPUT}
        value={text}
        rows={4}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        placeholder="JKT1.…"
        onChange={(event) => {
          setText(event.target.value);
          setRefusal(null);
        }}
      />

      <div
        className="ws-import-preview"
        data-testid={TRIO_IMPORT_PREVIEW}
        data-ok={decoded === null ? undefined : decoded.ok ? "true" : "false"}
        aria-live="polite"
      >
        {decoded === null ? null : decoded.ok ? (
          <>
            <p className="ws-import-name">
              <strong>{decoded.name}</strong>
              {` · ${String(filled)} ${filled === 1 ? "deck" : "decks"}`}
            </p>
            {decoded.nameFellBack ? <p>The code’s trio name couldn’t be used, so the trio gets this one. You can rename it.</p> : null}
            <ol className="ws-import-slots">
              {decoded.slots.map((slot, at) => (
                <li
                  key={at}
                  data-testid={trioImportSlotId(at + 1)}
                  data-empty={slot === null ? "true" : "false"}
                  data-count={slot === null ? undefined : String(slot.cards.length)}
                >
                  {slot === null ? (
                    <span className="ws-import-name">{`Deck ${String(at + 1)}: empty slot`}</span>
                  ) : (
                    <>
                      <span className="ws-import-name">
                        <strong>{slot.name}</strong>
                        {` · ${String(slot.cards.length)}/${String(DECK_SIZE)} cards`}
                      </span>
                      <ul className="ws-import-notes">
                        {slot.nameFellBack ? (
                          <li data-kind="dropped">The code’s name for this deck couldn’t be used, so it gets this one.</li>
                        ) : null}
                        {droppedLines(slot.dropped, catalog).map((line) => (
                          <li key={line} data-kind="dropped">
                            {line}
                          </li>
                        ))}
                        {slot.unowned.length === 0 ? null : (
                          <li data-kind="unowned">
                            {`${cardsWord(slot.unowned.length)} you don’t own yet ${slot.unowned.length === 1 ? "is" : "are"} kept: ${namesOf(slot.unowned, catalog)}.`}
                          </li>
                        )}
                      </ul>
                    </>
                  )}
                </li>
              ))}
            </ol>
            {shared.length === 0 ? null : (
              <p className="ws-import-shared" data-testid={TRIO_IMPORT_SHARED} data-count={String(shared.length)}>
                {`${cardsWord(shared.length)} ${shared.length === 1 ? "is" : "are"} in more than one of these decks: ${namesOf(
                  shared.map((conflict) => conflict.cardId),
                  catalog,
                )}. They’re kept, and the trio editor marks each one; the trio can’t queue Conquest until every card is in one deck only.`}
              </p>
            )}
          </>
        ) : (
          <p className="notice" role="alert">
            {decoded.message}
          </p>
        )}
      </div>

      {room !== null && !room.ok ? (
        <p className="ws-cap-note" id={reasonId} data-testid={TRIO_IMPORT_CAP_REASON} data-decks-short={String(room.decksShort)} data-trios-short={String(room.triosShort)}>
          {room.message}
        </p>
      ) : null}
      {refusal === null ? null : (
        <p className="notice" role="alert" data-testid={TRIO_IMPORT_ERROR}>
          {refusal}
        </p>
      )}

      <div className="ws-actions">
        <button
          type="button"
          className="ws-action ws-action--primary"
          data-testid={TRIO_IMPORT_SUBMIT}
          disabled={blocked}
          aria-busy={busy ? "true" : undefined}
          aria-describedby={room !== null && !room.ok ? reasonId : undefined}
          onClick={submit}
        >
          {busy ? "Importing…" : "Import as new trio"}
        </button>
        <button type="button" className="ws-action" data-testid={TRIO_IMPORT_CANCEL} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </section>
  );
}
