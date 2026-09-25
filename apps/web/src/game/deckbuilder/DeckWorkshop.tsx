// `/decks`, the deck workshop (SPEC §9.4, R250–R256): up to ten saved decks and five trios, one
// open at a time beside the list of both.
//
// THE SHAPE. A header (the way back, the title and the save status, which is always on screen), a
// rail listing the decks ("Decks n/10": name, count, a status chip) and the trios ("Trios n/5"),
// and a main column holding whichever is open: the deck editor (DeckEditor.tsx), the trio editor
// (TrioEditor.tsx), the deck import panel (ImportPanel.tsx) or the trio import panel
// (TrioImportPanel.tsx, R339–R341). On a phone the two halves take turns
// (`data-view="list|editor"`): the list first, an item opens the editor, and "← All decks" goes
// back. Everything stays mounted either way; the CSS decides what shows.
//
// THE DATA. This component owns the store (sync.ts) and nothing else of note: the route hands it
// the server's copy, the catalog, the collection and the four writes, and the store merges its
// local mirror over them, saves as the player works and keeps what the server has not confirmed
// on the device (R256). There is no Save button: "Saved", "Saving…", "Offline — kept on this
// device" and "Couldn't save" say where things stand.
//
// NO RULE LIVES HERE (CLAUDE.md rule 7). The caps are the server's; the builder reads them from
// `GET /api/decks`'s `limits` and turns New deck, New trio and Import off at them, with the reason,
// so a player is not refused after the fact. Each chip and verdict is the shared validator's
// (workshop.ts). The component is presentational apart from the store: it does no I/O of its own,
// which is what lets a test (or a component spec) mount it with a fake api.

import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactElement, type RefObject } from "react";

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import "./deckbuilder.css";
import "./workshop.css";
import type { DecksResponse } from "../../net/api.ts";
import { BackLink } from "../../routes/nav.tsx";
import DeckEditor from "./DeckEditor.tsx";
import { DECK_SIZE } from "./deckSize.ts";
import { DEFAULT_FILTER, DEFAULT_SORT, type PoolFilter, type PoolSort } from "./filters.ts";
import ImportPanel from "./ImportPanel.tsx";
import TrioImportPanel from "./TrioImportPanel.tsx";
import {
  createDeckStore,
  type DeckItem,
  type DeckStore,
  type DeckSyncApi,
  type StorageLike,
  type SyncClock,
  type SyncStatus,
  type TrioItem,
  type WorkshopSnapshot,
} from "./sync.ts";
import {
  DECK_CAP,
  DECK_CAP_REASON,
  DECK_IMPORT_OPEN,
  DECK_LIST,
  DECK_NEW,
  SYNC_STATUS,
  TRIO_CAP,
  TRIO_CAP_REASON,
  TRIO_IMPORT_OPEN,
  TRIO_LIST,
  TRIO_NEW,
  WORKSHOP,
  WORKSHOP_BACK,
  WORKSHOP_EMPTY,
  deckRowId,
  trioRowId,
} from "./testids.ts";
import TrioEditor from "./TrioEditor.tsx";
import { deckLabel, deckStatus, deckVerdict, nextName, trioLabel, trioVerdict } from "./workshop.ts";

/**
 * The narrowest screen that shows the rail and the open item side by side; below it they take
 * turns. workshop.css's `@media (max-width: 1100px)` is the same line, drawn.
 */
export const WORKSHOP_SPLIT_MIN_WIDTH_PX = 1101;

/** True where the halves take turns, so moving between them should move the focus too. */
function halvesTakeTurns(): boolean {
  try {
    return window.matchMedia(`(max-width: ${String(WORKSHOP_SPLIT_MIN_WIDTH_PX - 1)}px)`).matches;
  } catch {
    return false;
  }
}

/** What the main column shows. */
export type WorkshopOpen =
  | { kind: "deck"; id: string }
  | { kind: "trio"; id: string }
  | { kind: "import" }
  | { kind: "trio-import" }
  | null;

export type DeckWorkshopProps = {
  catalog: CatalogSnapshot;
  /** Null when `GET /api/collection` could not be read: ownership is then neither claimed nor denied. */
  collection: Collection | null;
  /** `GET /api/decks`: the server's copy, which the store merges its local mirror over (R256). */
  data: DecksResponse;
  /** Whose drafts the local mirror holds (`jackioh.decks.v1.<profileId>`). */
  profileId: string;
  /** The writes, bound to the session's token by the route. */
  api: DeckSyncApi;
  /** What opens first. Default: the first deck (or nothing), with a phone showing the list. */
  initialOpen?: WorkshopOpen;
  /** Test seams (sync.ts): the mirror's storage, the clock, and the id minting. */
  storage?: StorageLike | null;
  clock?: SyncClock;
  newId?: () => string;
};

/** The save status line's words (R256). An error is the server's own sentence after ours. */
export function syncWords(status: SyncStatus): string {
  switch (status.state) {
    case "saved":
      return "Saved";
    case "saving":
      return "Saving…";
    case "offline":
      return "Offline — kept on this device";
    case "error":
      return status.message === null ? "Couldn’t save" : `Couldn’t save: ${status.message}`;
  }
}

function SyncStatusLine({ status }: { status: SyncStatus }): ReactElement {
  return (
    <p className="ws-sync" data-testid={SYNC_STATUS} data-state={status.state} role="status" aria-live="polite">
      <span className="ws-sync-dot" aria-hidden="true" />
      <span>{syncWords(status)}</span>
    </p>
  );
}

type RailProps = {
  railRef: RefObject<HTMLElement | null>;
  snapshot: WorkshopSnapshot;
  catalog: CatalogSnapshot;
  collection: Collection | null;
  open: WorkshopOpen;
  onOpen: (next: WorkshopOpen) => void;
  onNewDeck: () => void;
  onNewTrio: () => void;
};

function Rail(props: RailProps): ReactElement {
  const { railRef, snapshot, catalog, collection, open, onOpen, onNewDeck, onNewTrio } = props;
  const { decks, trios, limits, unsynced } = snapshot;
  const decksAtCap = decks.length >= limits.decks;
  const triosAtCap = trios.length >= limits.trios;
  const decksTitle = useId();
  const triosTitle = useId();
  const deckReason = useId();
  const trioReason = useId();

  return (
    <nav ref={railRef} className="ws-rail" aria-label="Your decks and trios">
      <section className="ws-group" aria-labelledby={decksTitle}>
        <div className="ws-group-head">
          <h2 className="ws-group-title" id={decksTitle}>
            Decks{" "}
            <span className="ws-cap" data-testid={DECK_CAP} data-count={String(decks.length)} data-limit={String(limits.decks)}>
              {`${String(decks.length)}/${String(limits.decks)}`}
            </span>
          </h2>
          <div className="ws-group-actions">
            <button
              type="button"
              className="ws-action ws-action--primary"
              data-testid={DECK_NEW}
              disabled={decksAtCap}
              aria-describedby={decksAtCap ? deckReason : undefined}
              onClick={onNewDeck}
            >
              New deck
            </button>
            <button
              type="button"
              className="ws-action"
              data-testid={DECK_IMPORT_OPEN}
              aria-current={open?.kind === "import" ? "true" : undefined}
              onClick={() => {
                onOpen({ kind: "import" });
              }}
            >
              Import
            </button>
          </div>
        </div>
        {decksAtCap ? (
          <p className="ws-cap-note" id={deckReason} data-testid={DECK_CAP_REASON}>
            {`You have ${String(limits.decks)} decks, the most you can keep. Delete one to make room.`}
          </p>
        ) : null}
        <ul className="ws-list" data-testid={DECK_LIST}>
          {decks.map((deck) => (
            <DeckRow
              key={deck.id}
              deck={deck}
              catalog={catalog}
              collection={collection}
              nameLength={limits.nameLength}
              current={open?.kind === "deck" && open.id === deck.id}
              unsynced={unsynced.has(deck.id)}
              onOpen={() => {
                onOpen({ kind: "deck", id: deck.id });
              }}
            />
          ))}
        </ul>
        {decks.length === 0 ? <p className="ws-hint">No decks yet. Make one, or import a code someone shared.</p> : null}
      </section>

      <section className="ws-group" aria-labelledby={triosTitle}>
        <div className="ws-group-head">
          <h2 className="ws-group-title" id={triosTitle}>
            Trios{" "}
            <span className="ws-cap" data-testid={TRIO_CAP} data-count={String(trios.length)} data-limit={String(limits.trios)}>
              {`${String(trios.length)}/${String(limits.trios)}`}
            </span>
          </h2>
          <div className="ws-group-actions">
            <button
              type="button"
              className="ws-action"
              data-testid={TRIO_NEW}
              disabled={triosAtCap}
              aria-describedby={triosAtCap ? trioReason : undefined}
              onClick={onNewTrio}
            >
              New trio
            </button>
            {/* R340: never off at a cap — the panel says exactly how many slots an import needs. */}
            <button
              type="button"
              className="ws-action"
              data-testid={TRIO_IMPORT_OPEN}
              aria-current={open?.kind === "trio-import" ? "true" : undefined}
              onClick={() => {
                onOpen({ kind: "trio-import" });
              }}
            >
              Import trio
            </button>
          </div>
        </div>
        {triosAtCap ? (
          <p className="ws-cap-note" id={trioReason} data-testid={TRIO_CAP_REASON}>
            {`You have ${String(limits.trios)} trios, the most you can keep. Delete one to make room.`}
          </p>
        ) : null}
        <ul className="ws-list" data-testid={TRIO_LIST}>
          {trios.map((trio) => (
            <TrioRow
              key={trio.id}
              trio={trio}
              decks={decks}
              catalog={catalog}
              collection={collection}
              nameLength={limits.nameLength}
              current={open?.kind === "trio" && open.id === trio.id}
              unsynced={unsynced.has(trio.id)}
              onOpen={() => {
                onOpen({ kind: "trio", id: trio.id });
              }}
            />
          ))}
        </ul>
        {trios.length === 0 ? (
          <p className="ws-hint">A trio is three decks with no card in common, for Conquest.</p>
        ) : null}
      </section>
    </nav>
  );
}

type DeckRowProps = {
  deck: DeckItem;
  catalog: CatalogSnapshot;
  collection: Collection | null;
  nameLength: number;
  current: boolean;
  unsynced: boolean;
  onOpen: () => void;
};

function DeckRow({ deck, catalog, collection, nameLength, current, unsynced, onOpen }: DeckRowProps): ReactElement {
  const status = deckStatus(deckVerdict(deck, catalog, collection, nameLength), collection !== null);
  const label = deckLabel(deck, nameLength);
  return (
    <li>
      <button
        type="button"
        className="ws-row"
        data-testid={deckRowId(deck.id)}
        data-count={String(deck.cards.length)}
        data-status={status.kind}
        data-unsynced={unsynced ? "true" : undefined}
        aria-current={current ? "true" : undefined}
        aria-label={`${label}, ${String(deck.cards.length)} of ${String(DECK_SIZE)} cards, ${status.label}${unsynced ? ", not saved yet" : ""}`}
        onClick={onOpen}
      >
        <span className="ws-row-name">{label}</span>
        <span className="ws-row-meta">
          <span className="ws-row-count">{`${String(deck.cards.length)}/${String(DECK_SIZE)}`}</span>
          <span className="ws-chip" data-status={status.kind}>
            {status.label}
          </span>
        </span>
        {unsynced ? <span className="ws-row-dot" aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

type TrioRowProps = {
  trio: TrioItem;
  decks: readonly DeckItem[];
  catalog: CatalogSnapshot;
  collection: Collection | null;
  nameLength: number;
  current: boolean;
  unsynced: boolean;
  onOpen: () => void;
};

function TrioRow({ trio, decks, catalog, collection, nameLength, current, unsynced, onOpen }: TrioRowProps): ReactElement {
  const ready = trioVerdict(trio, decks, catalog, collection, nameLength).ok;
  const filled = trio.deckIds.filter((id) => id !== null && decks.some((deck) => deck.id === id)).length;
  const label = trioLabel(trio, nameLength);
  return (
    <li>
      <button
        type="button"
        className="ws-row"
        data-testid={trioRowId(trio.id)}
        data-ready={ready ? "true" : "false"}
        data-unsynced={unsynced ? "true" : undefined}
        aria-current={current ? "true" : undefined}
        aria-label={`${label}, ${String(filled)} of ${String(trio.deckIds.length)} decks, ${ready ? "ready for Conquest" : "not ready"}${unsynced ? ", not saved yet" : ""}`}
        onClick={onOpen}
      >
        <span className="ws-row-name">{label}</span>
        <span className="ws-row-meta">
          <span className="ws-row-count">{`${String(filled)}/${String(trio.deckIds.length)} decks`}</span>
          <span className="ws-chip" data-status={ready ? "ready" : "incomplete"}>
            {ready ? "Ready" : "Not ready"}
          </span>
        </span>
        {unsynced ? <span className="ws-row-dot" aria-hidden="true" /> : null}
      </button>
    </li>
  );
}

/** The item that follows `id` in `items`, else the one before it, else null. */
function neighbourOf<T extends { id: string }>(items: readonly T[], id: string): T | null {
  const at = items.findIndex((item) => item.id === id);
  if (at < 0) return null;
  return items[at + 1] ?? items[at - 1] ?? null;
}

export default function DeckWorkshop(props: DeckWorkshopProps): ReactElement {
  const { catalog, collection, data, profileId, api, initialOpen } = props;

  const [store] = useState<DeckStore>(() =>
    createDeckStore({
      profileId,
      catalogVersion: catalog.version,
      server: data,
      api,
      ...(props.storage === undefined ? {} : { storage: props.storage }),
      ...(props.clock === undefined ? {} : { clock: props.clock }),
      ...(props.newId === undefined ? {} : { newId: props.newId }),
    }),
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);

  // Saves on leaving (pagehide, a hidden tab) while the screen is open, and once more on unmount.
  useEffect(() => {
    store.start();
    return () => {
      store.stop();
    };
  }, [store]);

  const [open, setOpen] = useState<WorkshopOpen>(() => {
    if (initialOpen !== undefined) return initialOpen;
    const first = store.getSnapshot().decks[0];
    return first === undefined ? null : { kind: "deck", id: first.id };
  });
  // A phone shows one half at a time: the list until something is opened from it.
  const [view, setView] = useState<"list" | "editor">(
    initialOpen === undefined || initialOpen === null ? "list" : "editor",
  );
  // Filter and sort outlive a switch between decks, and are never persisted (Surface D).
  const [filter, setFilter] = useState<PoolFilter>(DEFAULT_FILTER);
  const [sort, setSort] = useState<PoolSort>(DEFAULT_SORT);

  // On a phone the half that held the focus disappears when the other opens, so the focus follows:
  // to the editor's way back when an item opens, and to the open item's row on the way back.
  const railRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const [moveFocus, setMoveFocus] = useState<"editor" | "list" | null>(null);
  useEffect(() => {
    if (moveFocus === null) return;
    setMoveFocus(null);
    if (!halvesTakeTurns()) return;
    const target =
      moveFocus === "editor"
        ? mainRef.current?.querySelector<HTMLElement>(`[data-testid="${WORKSHOP_BACK}"]`)
        : (railRef.current?.querySelector<HTMLElement>('[aria-current="true"]') ??
          railRef.current?.querySelector<HTMLElement>("button"));
    target?.focus();
  }, [moveFocus]);

  const { decks, trios, limits, unsynced, refused } = snapshot;
  const openDeck = open?.kind === "deck" ? (decks.find((deck) => deck.id === open.id) ?? null) : null;
  const openTrio = open?.kind === "trio" ? (trios.find((trio) => trio.id === open.id) ?? null) : null;

  const openItem = (next: WorkshopOpen): void => {
    setOpen(next);
    setView(next === null ? "list" : "editor");
    // The import panels take the focus themselves, into the box a code is pasted in.
    if (next !== null && next.kind !== "import" && next.kind !== "trio-import") setMoveFocus("editor");
  };

  const newDeck = (): void => {
    const id = store.createDeck({ name: nextName("Deck", decks.map((deck) => deck.name)) });
    if (id !== null) openItem({ kind: "deck", id });
  };

  const newTrio = (): void => {
    const id = store.createTrio({ name: nextName("Trio", trios.map((trio) => trio.name)) });
    if (id !== null) openItem({ kind: "trio", id });
  };

  const backToList = (): void => {
    setView("list");
    setMoveFocus("list");
  };

  let main: ReactElement;
  if (openDeck !== null) {
    main = (
      <DeckEditor
        key={openDeck.id}
        deck={openDeck}
        decks={decks}
        trios={trios}
        catalog={catalog}
        collection={collection}
        limits={limits}
        saved={!unsynced.has(openDeck.id)}
        refusal={refused.get(openDeck.id) ?? null}
        filter={filter}
        onFilter={setFilter}
        sort={sort}
        onSort={setSort}
        onRename={(name) => {
          store.updateDeck(openDeck.id, { name });
        }}
        onCards={(cards) => {
          store.updateDeck(openDeck.id, { cards });
        }}
        onDelete={() => {
          const next = neighbourOf(decks, openDeck.id);
          store.deleteDeck(openDeck.id);
          setOpen(next === null ? null : { kind: "deck", id: next.id });
          setView("list");
        }}
        onSaveNow={() => {
          void store.flush();
        }}
        onBack={backToList}
      />
    );
  } else if (openTrio !== null) {
    main = (
      <TrioEditor
        key={openTrio.id}
        trio={openTrio}
        decks={decks}
        catalog={catalog}
        collection={collection}
        limits={limits}
        refusal={refused.get(openTrio.id) ?? null}
        onRename={(name) => {
          store.updateTrio(openTrio.id, { name });
        }}
        onSlots={(deckIds) => {
          store.updateTrio(openTrio.id, { deckIds });
        }}
        onDelete={() => {
          store.deleteTrio(openTrio.id);
          setOpen(null);
          setView("list");
        }}
        onOpenDeck={(deckId) => {
          openItem({ kind: "deck", id: deckId });
        }}
        onBack={backToList}
      />
    );
  } else if (open?.kind === "import") {
    main = (
      <ImportPanel
        catalog={catalog}
        collection={collection}
        atCap={decks.length >= limits.decks}
        deckLimit={limits.decks}
        onImport={(name, cards) => {
          const id = store.createDeck({ name, cards });
          if (id !== null) openItem({ kind: "deck", id });
        }}
        onCancel={() => {
          const first = decks[0];
          setOpen(first === undefined ? null : { kind: "deck", id: first.id });
          setView("list");
        }}
      />
    );
  } else if (open?.kind === "trio-import") {
    main = (
      <TrioImportPanel
        catalog={catalog}
        collection={collection}
        saved={{ decks: decks.length, trios: trios.length }}
        limits={limits}
        onImport={(init) => store.importTrio(init)}
        onImported={(trioId) => {
          openItem({ kind: "trio", id: trioId });
        }}
        onCancel={() => {
          const first = trios[0];
          setOpen(first === undefined ? null : { kind: "trio", id: first.id });
          setView("list");
        }}
      />
    );
  } else {
    main = (
      <div className="ws-empty" data-testid={WORKSHOP_EMPTY}>
        <p>
          {decks.length === 0
            ? "Make your first deck, or import a code someone shared."
            : "Pick a deck or a trio from the list to work on it."}
        </p>
      </div>
    );
  }

  return (
    <div className="app-shell app-shell--wide deckbuilder workshop" data-testid={WORKSHOP} data-view={view}>
      <header className="db-header">
        <BackLink />
        {/* The same words as the loading and error screens (routes/decks.tsx). */}
        <h1 className="db-title">
          <span className="db-title-brand">JackiOh</span>
          <span className="db-title-sep"> — </span>
          <span className="db-title-page">decks</span>
        </h1>
        <SyncStatusLine status={snapshot.status} />
      </header>

      <div className="ws-layout">
        <Rail
          railRef={railRef}
          snapshot={snapshot}
          catalog={catalog}
          collection={collection}
          open={open}
          onOpen={openItem}
          onNewDeck={newDeck}
          onNewTrio={newTrio}
        />
        <main ref={mainRef} className="ws-main">
          {main}
        </main>
      </div>
    </div>
  );
}
