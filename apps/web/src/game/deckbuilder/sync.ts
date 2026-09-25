// The deck workshop's store: saved decks and trios as this device holds them, and the autosave
// that keeps the server in step (SPEC §9.4, R250, R252, R256).
//
// WHY THE CLIENT MINTS THE IDS. A deck or trio is named by a `crypto.randomUUID()` minted here, the
// moment it is made, so every save is `PUT /api/decks/:id` — an idempotent upsert. A save that
// timed out may have landed or not, and sending it again is always right: it can never make a
// second deck. That one property is what lets this module retry freely and work offline.
//
// NEVER LOSE WORK. Every edit is written to a `localStorage` mirror (`jackioh.decks.v1.<profile>`)
// before anything else happens, so a closed tab, a dead battery or a dropped connection costs
// nothing: the next visit merges the mirror over the server's copy, and what the server never
// confirmed wins (R256). `localStorage` is untrusted and may be missing — private windows, blocked
// site data and sandboxed frames make it throw on access, and a hand-edited value can hold
// anything — so every access sits in try/catch and the store works, unmirrored, without it.
//
// THE SERVER IS LAW. The deck and trio caps, D1–D4 and T1–T3 are the server's to enforce (rule
// 7). This store checks the caps only so the UI can say "you have ten decks" before a request is
// refused, and it cleans a name (`deckNameForSave`) so an empty field saves as "Untitled deck"
// rather than bouncing off D1. A refusal the server does send is shown in its own words and not
// retried until the player edits that item again: sending the same refused body twice would only
// be refused twice.
//
// THE ORDER OF A SAVE. Decks, then trios, then deletions. A trio names decks, and the server
// refuses a trio naming a deck it does not have (409 `details.unknownDeck`), so the decks go
// first; a trio refused that way while one of its decks is still unsaved waits for that deck and
// goes again in the same flush. Deletions go last so a deck is never deleted before a trio PUT
// that still names it has cleared the slot.

import { checkDeckDraft, checkImportRoom, checkTrioDraft, normalizeName } from "@jackioh/validator";

import {
  DECK_AUTOSAVE_DEBOUNCE_MS,
  DECK_AUTOSAVE_RETRY_SECONDS,
  DECK_NAME_MAX_LENGTH,
  MAX_SAVED_DECKS,
  MAX_SAVED_TRIOS,
} from "../../../../server/src/config.ts";
import {
  ApiRequestError,
  ApiUnreachableError,
  type DeckInput,
  type DecksResponse,
  type TrioImportInput,
  type TrioInput,
  type TrioSlots,
} from "../../net/api.ts";

// ---------------------------------------------------------------------------------------------
// The shapes
// ---------------------------------------------------------------------------------------------

export type DeckItem = { id: string; name: string; cards: readonly string[]; createdAt: number; updatedAt: number };
export type TrioItem = { id: string; name: string; deckIds: TrioSlots; createdAt: number; updatedAt: number };

export type SyncState = "saved" | "saving" | "offline" | "error";
export type SyncStatus = { state: SyncState; message: string | null };
export type WorkshopLimits = { decks: number; trios: number; nameLength: number };

export type WorkshopSnapshot = {
  /** Oldest first (created, then id), as `GET /api/decks` lists them. */
  decks: readonly DeckItem[];
  trios: readonly TrioItem[];
  status: SyncStatus;
  /** Deck and trio ids whose latest edit the server has not confirmed (refused ones included). */
  unsynced: ReadonlySet<string>;
  /** Ids the server refused, with its message verbatim; the item's next edit clears it. */
  refused: ReadonlyMap<string, string>;
  limits: WorkshopLimits;
};

/** The writes, bound to the session's token by the route (`routes/decks.tsx`). */
export type DeckSyncApi = {
  putDeck(id: string, input: DeckInput): Promise<unknown>;
  deleteDeck(id: string): Promise<unknown>;
  putTrio(id: string, input: TrioInput): Promise<unknown>;
  deleteTrio(id: string): Promise<unknown>;
  /** R341: a trio code's decks and the trio, all or nothing, in one request. */
  importTrio(input: TrioImportInput): Promise<unknown>;
};

/** What a trio import makes (R339): the trio's name, and each slot's deck or nothing. */
export type TrioImport = {
  name: string;
  slots: readonly ({ name: string; cards: readonly string[] } | null)[];
};

/** How an import ended: the new trio's id, or the sentence saying why nothing was made (R340). */
export type TrioImportResult = { ok: true; trioId: string } | { ok: false; message: string };

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type SyncClock = {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
};

export type DeckStoreOptions = {
  profileId: string;
  /** Stamped on every deck PUT: the catalog the builder is showing (R253's `update_required`). */
  catalogVersion: string;
  /** `GET /api/decks`. */
  server: DecksResponse;
  api: DeckSyncApi;
  /** Default `browserStorage()`. `null`: no mirror at all. */
  storage?: StorageLike | null;
  clock?: SyncClock;
  newId?: () => string;
};

export type DeckStore = {
  /** The same object until something changes, as `useSyncExternalStore` wants. */
  getSnapshot(): WorkshopSnapshot;
  subscribe(listener: () => void): () => void;
  /** Null at `limits.decks`. The UI supplies the name. */
  createDeck(init: { name: string; cards?: readonly string[] }): string | null;
  updateDeck(id: string, patch: { name?: string; cards?: readonly string[] }): void;
  /** Also empties every trio slot that named it (R252), as the server does. */
  deleteDeck(id: string): void;
  /** Null at `limits.trios`. */
  createTrio(init: { name: string; deckIds?: TrioSlots }): string | null;
  updateTrio(id: string, patch: { name?: string; deckIds?: TrioSlots }): void;
  deleteTrio(id: string): void;
  /**
   * R340, R341: imports a trio code's decks and the trio, all or nothing, in one request — never
   * through the autosave, which would leave half an import behind a refusal. What is unsaved goes
   * first (a deck deleted to make room is then gone at the server too), the caps are checked here
   * for a sentence without a round trip, and on success the decks and the trio join the list as
   * saved. The ids are minted once per import and reused when the same import is tried again, so a
   * retry after a lost answer updates what the first attempt made instead of making it twice.
   */
  importTrio(init: TrioImport): Promise<TrioImportResult>;
  /** Saves now (the debounce is skipped); settles once this flush and any re-run it caused have. */
  flush(): Promise<void>;
  /** Saves on `pagehide`, on the page going hidden and on coming back online. Idempotent. */
  start(): void;
  /** Detaches, clears the timers and sends what is unsaved one last time. Idempotent. */
  stop(): void;
};

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

export const UNTITLED_DECK = "Untitled deck";
export const UNTITLED_TRIO = "Untitled trio";

/** Truncates to `max` code points, as D1 counts them (an emoji is one character to a player). */
function truncateCodePoints(value: string, max: number): string {
  const points = [...value];
  return points.length <= max ? value : points.slice(0, max).join("");
}

/**
 * The name a deck PUT sends: `normalizeName`, cut to `nameLength` characters, and "Untitled deck"
 * whenever the validator's D1 would refuse what is left (empty, or a control character). The field
 * keeps what the player typed; only the save is cleaned, so D1 is met gently rather than refused.
 */
export function deckNameForSave(raw: string, nameLength: number): string {
  const name = truncateCodePoints(normalizeName(raw), nameLength);
  const refused = checkDeckDraft({ name, cards: [], isDeckable: () => true, nameMaxLength: nameLength }).some(
    (issue) => issue.rule === "D1",
  );
  return refused ? UNTITLED_DECK : name;
}

/** As `deckNameForSave`, for a trio (T1). */
export function trioNameForSave(raw: string, nameLength: number): string {
  const name = truncateCodePoints(normalizeName(raw), nameLength);
  const refused = checkTrioDraft({ name, deckIds: [null, null, null], nameMaxLength: nameLength }).some(
    (issue) => issue.rule === "T1",
  );
  return refused ? UNTITLED_TRIO : name;
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

export const DECK_MIRROR_PREFIX = "jackioh.decks.v1.";

export function mirrorKey(profileId: string): string {
  return `${DECK_MIRROR_PREFIX}${profileId}`;
}

/** `window.localStorage`, or null where reading it throws or there is none. */
export function browserStorage(): StorageLike | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** The mirror's format version, so a later shape can tell an old value apart and drop it. */
const MIRROR_VERSION = 1;

type Tracked<T> = {
  item: T;
  /** The server has not confirmed this item's latest edit. */
  dirty: boolean;
  /** Bumped by every edit, so a confirmation of an older revision does not clear `dirty`. */
  rev: number;
  /** The server's refusal of the latest edit, verbatim. Not retried until the next edit. */
  refused: string | null;
  /** A trio refused for naming a deck not saved yet: it goes again once a deck lands. */
  blocked: boolean;
};

type MirrorEntry<T> = { item: T; dirty: boolean };

type Mirror = {
  decks: MirrorEntry<DeckItem>[];
  trios: MirrorEntry<TrioItem>[];
  deletedDecks: string[];
  deletedTrios: string[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function deckFrom(value: unknown): DeckItem | null {
  if (!isRecord(value)) return null;
  const { id, name, cards, createdAt, updatedAt } = value;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string" || !isStringArray(cards)) return null;
  if (!isFiniteNumber(createdAt) || !isFiniteNumber(updatedAt)) return null;
  return { id, name, cards: [...cards], createdAt, updatedAt };
}

function slotsFrom(value: unknown): TrioSlots | null {
  if (!Array.isArray(value) || value.length !== TRIO_SLOT_COUNT) return null;
  const slots = value.map((slot) => (typeof slot === "string" && slot.length > 0 ? slot : null));
  if (value.some((slot) => slot !== null && typeof slot !== "string")) return null;
  return [slots[0] ?? null, slots[1] ?? null, slots[2] ?? null];
}

function trioFrom(value: unknown): TrioItem | null {
  if (!isRecord(value)) return null;
  const { id, name, deckIds, createdAt, updatedAt } = value;
  if (typeof id !== "string" || id.length === 0 || typeof name !== "string") return null;
  const slots = slotsFrom(deckIds);
  if (slots === null || !isFiniteNumber(createdAt) || !isFiniteNumber(updatedAt)) return null;
  return { id, name, deckIds: slots, createdAt, updatedAt };
}

/** A trio's slots. `TrioSlots` is a 3-tuple, and this is its length, for the parser. */
const TRIO_SLOT_COUNT = 3;

function entriesFrom<T>(value: unknown, read: (raw: unknown) => T | null): MirrorEntry<T>[] {
  if (!Array.isArray(value)) return [];
  const entries: MirrorEntry<T>[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    const item = read(raw.item);
    if (item === null) continue;
    entries.push({ item, dirty: raw.dirty === true });
  }
  return entries;
}

/** Tolerant: a malformed value, or one from another format version, reads as no mirror at all. */
export function parseMirror(raw: string | null): Mirror | null {
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.v !== MIRROR_VERSION) return null;
    return {
      decks: entriesFrom(value.decks, deckFrom),
      trios: entriesFrom(value.trios, trioFrom),
      deletedDecks: isStringArray(value.deletedDecks) ? value.deletedDecks : [],
      deletedTrios: isStringArray(value.deletedTrios) ? value.deletedTrios : [],
    };
  } catch {
    return null;
  }
}

function readMirror(storage: StorageLike | null, key: string): Mirror | null {
  if (storage === null) return null;
  try {
    return parseMirror(storage.getItem(key));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// The clock
// ---------------------------------------------------------------------------------------------

const MS_PER_SECOND = 1000;
const RETRY_MS = DECK_AUTOSAVE_RETRY_SECONDS * MS_PER_SECOND;

function browserClock(): SyncClock {
  return {
    now: () => Date.now(),
    setTimeout: (run, ms) => globalThis.setTimeout(run, ms),
    clearTimeout: (handle) => {
      globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
    },
  };
}

function randomId(): string {
  return globalThis.crypto.randomUUID();
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** What the status line says while a failed save waits to go again. */
export const OFFLINE_MESSAGE = "Offline — your changes are kept on this device.";

/** R341: why an import made nothing, when the server could not be asked. */
export const IMPORT_OFFLINE_MESSAGE = "You’re offline, so nothing was imported. Try again once you’re back online.";

const HTTP_UNAUTHORIZED = 401;
const HTTP_TIMEOUT = 408;
const HTTP_CONFLICT = 409;
const HTTP_TOO_MANY = 429;
const HTTP_SERVER_ERROR = 500;

type Failure =
  | { kind: "offline" }
  /** Worth sending again later: the server is down, busy, or the token is being renewed. */
  | { kind: "transient"; message: string }
  /** The server refused this body. Sending it again would be refused again. */
  | { kind: "refused"; message: string; unknownDeck: boolean };

function failureOf(cause: unknown): Failure {
  if (cause instanceof ApiUnreachableError) return { kind: "offline" };
  if (cause instanceof ApiRequestError) {
    const status = cause.status;
    if (status === HTTP_UNAUTHORIZED || status === HTTP_TIMEOUT || status === HTTP_TOO_MANY || status >= HTTP_SERVER_ERROR) {
      return { kind: "transient", message: cause.message };
    }
    const details = cause.details;
    const unknownDeck = status === HTTP_CONFLICT && isRecord(details) && details.unknownDeck === true;
    return { kind: "refused", message: cause.message, unknownDeck };
  }
  return { kind: "transient", message: cause instanceof Error ? cause.message : String(cause) };
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

function byAge<T extends { createdAt: number; id: string }>(left: Tracked<T>, right: Tracked<T>): number {
  if (left.item.createdAt !== right.item.createdAt) return left.item.createdAt - right.item.createdAt;
  return left.item.id < right.item.id ? -1 : left.item.id > right.item.id ? 1 : 0;
}

function tracked<T>(item: T, dirty: boolean): Tracked<T> {
  return { item, dirty, rev: 0, refused: null, blocked: false };
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameSlots(left: TrioSlots, right: TrioSlots): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

/**
 * R256's merge. Unsynced local edits win over the server's copy; server items the mirror does not
 * know are taken; local items the server lacks survive only while unsynced (new work made here),
 * since a synced one missing from the server was deleted elsewhere. A pending deletion stays
 * pending while the server still has the id.
 */
function merge<T extends { id: string; createdAt: number }>(
  serverItems: readonly T[],
  local: readonly MirrorEntry<T>[],
  deleted: readonly string[],
): { items: Tracked<T>[]; deleting: Set<string> } {
  const localById = new Map(local.map((entry) => [entry.item.id, entry]));
  const serverIds = new Set(serverItems.map((item) => item.id));
  const deleting = new Set(deleted.filter((id) => serverIds.has(id)));
  const items: Tracked<T>[] = [];
  for (const item of serverItems) {
    if (deleting.has(item.id)) continue;
    const mine = localById.get(item.id);
    items.push(mine?.dirty === true ? tracked(mine.item, true) : tracked(item, false));
  }
  // The mirror is untrusted text: one id listed twice is restored once, or the workshop would list
  // it twice and send it twice.
  const restored = new Set<string>();
  for (const entry of local) {
    const { id } = entry.item;
    if (serverIds.has(id) || !entry.dirty || deleting.has(id) || restored.has(id)) continue;
    restored.add(id);
    items.push(tracked(entry.item, true));
  }
  items.sort(byAge);
  return { items, deleting };
}

export function createDeckStore(options: DeckStoreOptions): DeckStore {
  const { api, catalogVersion } = options;
  const storage = options.storage === undefined ? browserStorage() : options.storage;
  const clock = options.clock ?? browserClock();
  const newId = options.newId ?? randomId;
  const key = mirrorKey(options.profileId);
  // A server from before R250's limits would not send them; the shared config says the same.
  const serverLimits: Partial<WorkshopLimits> = (options.server.limits as Partial<WorkshopLimits> | undefined) ?? {};
  const limits: WorkshopLimits = {
    decks: serverLimits.decks ?? MAX_SAVED_DECKS,
    trios: serverLimits.trios ?? MAX_SAVED_TRIOS,
    nameLength: serverLimits.nameLength ?? DECK_NAME_MAX_LENGTH,
  };

  const mirror = readMirror(storage, key);
  const mergedDecks = merge(
    options.server.decks.map((deck) => ({ ...deck, cards: [...deck.cards] })),
    mirror?.decks ?? [],
    mirror?.deletedDecks ?? [],
  );
  const mergedTrios = merge(
    options.server.trios.map((trio) => ({ ...trio, deckIds: [...trio.deckIds] as TrioSlots })),
    mirror?.trios ?? [],
    mirror?.deletedTrios ?? [],
  );

  let decks: Tracked<DeckItem>[] = mergedDecks.items;
  let trios: Tracked<TrioItem>[] = mergedTrios.items;
  const deletingDecks = mergedDecks.deleting;
  const deletingTrios = mergedTrios.deleting;

  // A slot naming a deck that is not here (deleted on this device, or elsewhere) empties, as the
  // server's foreign key empties it, and the trio is sent again so both sides agree.
  {
    const known = new Set(decks.map((deck) => deck.item.id));
    for (const trio of trios) {
      const slots = trio.item.deckIds.map((id) => (id !== null && known.has(id) ? id : null)) as TrioSlots;
      if (!sameSlots(slots, trio.item.deckIds)) {
        trio.item = { ...trio.item, deckIds: slots };
        trio.dirty = true;
      }
    }
  }

  const listeners = new Set<() => void>();
  let snapshot: WorkshopSnapshot | null = null;

  let debounce: unknown = null;
  let retry: unknown = null;
  let running: Promise<void> | null = null;
  let rerun = false;
  /** The last pass stopped on a transport failure; a retry is scheduled. */
  let offline = false;
  /** The last pass stopped on a failure worth retrying; its message, until a pass gets through. */
  let transient: string | null = null;
  let started = false;
  /** After `stop()`: nothing is scheduled any more, so a left screen leaves no timer behind. */
  let stopped = false;

  function persist(): void {
    if (storage === null) return;
    try {
      const value = {
        v: MIRROR_VERSION,
        decks: decks.map((entry) => ({ item: entry.item, dirty: entry.dirty })),
        trios: trios.map((entry) => ({ item: entry.item, dirty: entry.dirty })),
        deletedDecks: [...deletingDecks],
        deletedTrios: [...deletingTrios],
      };
      storage.setItem(key, JSON.stringify(value));
    } catch {
      // Quota, private mode or blocked storage: the in-memory state stays in force, and the
      // server copy is the only copy once it lands.
    }
  }

  /** Unsaved, not refused, and not waiting on a deck: something a pass would send. */
  function sendable<T>(entry: Tracked<T>): boolean {
    return entry.dirty && entry.refused === null && !entry.blocked;
  }

  function hasWork(): boolean {
    return decks.some(sendable) || trios.some(sendable) || deletingDecks.size > 0 || deletingTrios.size > 0;
  }

  function statusNow(): SyncStatus {
    if (offline) return { state: "offline", message: OFFLINE_MESSAGE };
    if (transient !== null) return { state: "error", message: transient };
    if (debounce !== null || running !== null || hasWork()) return { state: "saving", message: null };
    const refusal = [...decks, ...trios].find((entry) => entry.refused !== null)?.refused ?? null;
    if (refusal !== null) return { state: "error", message: refusal };
    return { state: "saved", message: null };
  }

  function emit(): void {
    snapshot = null;
    for (const listener of [...listeners]) listener();
  }

  function changed(): void {
    persist();
    emit();
  }

  function schedule(): void {
    if (stopped) return;
    if (debounce !== null) clock.clearTimeout(debounce);
    debounce = clock.setTimeout(() => {
      debounce = null;
      void flush();
    }, DECK_AUTOSAVE_DEBOUNCE_MS);
  }

  function scheduleRetry(): void {
    if (stopped) return;
    if (retry !== null) clock.clearTimeout(retry);
    retry = clock.setTimeout(() => {
      retry = null;
      void flush();
    }, RETRY_MS);
  }

  function edited<T>(entry: Tracked<T>, item: T): void {
    entry.item = item;
    entry.dirty = true;
    entry.rev += 1;
    entry.refused = null;
    entry.blocked = false;
    changed();
    schedule();
  }

  function deckInput(item: DeckItem): DeckInput {
    return { name: deckNameForSave(item.name, limits.nameLength), cards: [...item.cards], catalogVersion };
  }

  function trioInput(item: TrioItem): TrioInput {
    return { name: trioNameForSave(item.name, limits.nameLength), deckIds: [...item.deckIds] as TrioSlots };
  }

  /** How a pass ended: everything it could send went, or it stopped on a failure worth retrying. */
  type PassEnd = "done" | "stopped";

  function halt(failure: Failure): PassEnd {
    if (failure.kind === "offline") {
      offline = true;
      transient = null;
    } else if (failure.kind === "transient") {
      offline = false;
      transient = failure.message;
    }
    scheduleRetry();
    return "stopped";
  }

  /** One pass. Returns whether it stopped early, and whether any deck landed (for blocked trios). */
  async function pass(): Promise<{ end: PassEnd; deckLanded: boolean }> {
    let deckLanded = false;

    for (const entry of decks.filter(sendable)) {
      const { id } = entry.item;
      const rev = entry.rev;
      try {
        await api.putDeck(id, deckInput(entry.item));
      } catch (cause: unknown) {
        const failure = failureOf(cause);
        if (failure.kind !== "refused") return { end: halt(failure), deckLanded };
        const current = decks.find((candidate) => candidate.item.id === id);
        if (current !== undefined && current.rev === rev) current.refused = failure.message;
        changed();
        continue;
      }
      offline = false;
      transient = null;
      deckLanded = true;
      const current = decks.find((candidate) => candidate.item.id === id);
      if (current !== undefined && current.rev === rev) current.dirty = false;
      changed();
    }

    for (const entry of trios.filter(sendable)) {
      const { id } = entry.item;
      const rev = entry.rev;
      try {
        await api.putTrio(id, trioInput(entry.item));
      } catch (cause: unknown) {
        const failure = failureOf(cause);
        if (failure.kind !== "refused") return { end: halt(failure), deckLanded };
        const current = trios.find((candidate) => candidate.item.id === id);
        if (current !== undefined && current.rev === rev) {
          const waiting =
            failure.unknownDeck &&
            current.item.deckIds.some((deckId) => deckId !== null && decks.some((deck) => deck.item.id === deckId && deck.dirty));
          if (waiting) current.blocked = true;
          else current.refused = failure.message;
        }
        changed();
        continue;
      }
      offline = false;
      transient = null;
      const current = trios.find((candidate) => candidate.item.id === id);
      if (current !== undefined && current.rev === rev) current.dirty = false;
      changed();
    }

    for (const [pending, remove] of [
      [deletingTrios, api.deleteTrio],
      [deletingDecks, api.deleteDeck],
    ] as const) {
      for (const id of [...pending]) {
        try {
          await remove.call(api, id);
        } catch (cause: unknown) {
          const failure = failureOf(cause);
          if (failure.kind !== "refused") return { end: halt(failure), deckLanded };
          // A refused deletion (someone else's id, say) has nothing to try again: forget it.
        }
        offline = false;
        transient = null;
        pending.delete(id);
        changed();
      }
    }

    return { end: "done", deckLanded };
  }

  async function run(): Promise<void> {
    for (;;) {
      rerun = false;
      const { end, deckLanded } = await pass();
      if (end === "stopped") return;
      // Nothing failed on the way: whatever the last failed pass said no longer holds.
      offline = false;
      transient = null;
      // A deck that landed may be the one a blocked trio names: let those go again now.
      let unblocked = false;
      if (deckLanded) {
        for (const trio of trios) {
          if (trio.blocked) {
            trio.blocked = false;
            unblocked = true;
          }
        }
      }
      if (retry !== null) {
        clock.clearTimeout(retry);
        retry = null;
      }
      if (!rerun && !unblocked) return;
    }
  }

  function flush(): Promise<void> {
    if (debounce !== null) {
      clock.clearTimeout(debounce);
      debounce = null;
    }
    if (running !== null) {
      rerun = true;
      return running;
    }
    running = run()
      .catch(() => {
        // `pass` turns every failure into state; nothing is expected here, and nothing is lost.
      })
      .finally(() => {
        running = null;
        emit();
      });
    emit();
    return running;
  }

  /** The ids of the import last tried, so trying the same import again reuses them (R341). */
  let lastImport: { key: string; trioId: string; deckIds: readonly string[] } | null = null;

  function importedDeck(value: unknown, fallback: DeckItem): DeckItem {
    const read = deckFrom(value);
    return read !== null && read.id === fallback.id ? read : fallback;
  }

  function importedTrio(value: unknown, fallback: TrioItem): TrioItem {
    const read = trioFrom(value);
    return read !== null && read.id === fallback.id ? read : fallback;
  }

  async function importTrio(init: TrioImport): Promise<TrioImportResult> {
    await flush();
    const filled = init.slots.filter((slot) => slot !== null).length;
    const room = checkImportRoom({
      saved: { decks: decks.length, trios: trios.length },
      limits: { decks: limits.decks, trios: limits.trios },
      adding: { decks: filled, trios: 1 },
    });
    if (!room.ok) return { ok: false, message: room.message };

    const key = JSON.stringify(init);
    const ids =
      lastImport !== null && lastImport.key === key
        ? lastImport
        : { key, trioId: newId(), deckIds: init.slots.map(() => newId()) };
    lastImport = ids;

    const now = clock.now();
    const deckItems = init.slots.map((slot, at): DeckItem | null =>
      slot === null
        ? null
        : { id: ids.deckIds[at] ?? newId(), name: deckNameForSave(slot.name, limits.nameLength), cards: [...slot.cards], createdAt: now, updatedAt: now },
    );
    const slotIds = [0, 1, 2].map((at) => deckItems[at]?.id ?? null) as TrioSlots;
    const trioItem: TrioItem = {
      id: ids.trioId,
      name: trioNameForSave(init.name, limits.nameLength),
      deckIds: slotIds,
      createdAt: now,
      updatedAt: now,
    };
    const input: TrioImportInput = {
      catalogVersion,
      trio: { id: trioItem.id, name: trioItem.name },
      slots: [0, 1, 2].map((at) => {
        const deck = deckItems[at] ?? null;
        return deck === null ? null : { id: deck.id, name: deck.name, cards: [...deck.cards] };
      }) as TrioImportInput["slots"],
    };

    let answer: unknown;
    try {
      answer = await api.importTrio(input);
    } catch (cause: unknown) {
      const failure = failureOf(cause);
      if (failure.kind === "offline") return { ok: false, message: IMPORT_OFFLINE_MESSAGE };
      if (failure.kind === "transient") return { ok: false, message: `Nothing was imported (${failure.message}). Try again.` };
      return { ok: false, message: failure.message };
    }
    lastImport = null;

    const body = isRecord(answer) ? answer : {};
    const answered = Array.isArray(body.decks) ? body.decks : [];
    const known = new Set(decks.map((entry) => entry.item.id));
    for (const deck of deckItems) {
      if (deck === null || known.has(deck.id)) continue;
      const saved = importedDeck(answered.find((entry) => isRecord(entry) && entry.id === deck.id), deck);
      decks = [...decks, tracked(saved, false)];
    }
    decks.sort(byAge);
    if (!trios.some((entry) => entry.item.id === trioItem.id)) {
      trios = [...trios, tracked(importedTrio(body.trio, trioItem), false)];
      trios.sort(byAge);
    }
    changed();
    return { ok: true, trioId: trioItem.id };
  }

  const onPageHide = (): void => {
    void flush();
  };
  const onVisibility = (): void => {
    if (typeof document !== "undefined" && document.visibilityState === "hidden") void flush();
  };
  const onOnline = (): void => {
    void flush();
  };

  const store: DeckStore = {
    getSnapshot() {
      if (snapshot === null) {
        const unsynced = new Set<string>();
        const refused = new Map<string, string>();
        for (const entry of [...decks, ...trios]) {
          if (entry.dirty) unsynced.add((entry.item as { id: string }).id);
          if (entry.refused !== null) refused.set((entry.item as { id: string }).id, entry.refused);
        }
        snapshot = {
          decks: decks.map((entry) => entry.item),
          trios: trios.map((entry) => entry.item),
          status: statusNow(),
          unsynced,
          refused,
          limits,
        };
      }
      return snapshot;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    createDeck(init) {
      if (decks.length >= limits.decks) return null;
      const now = clock.now();
      const item: DeckItem = { id: newId(), name: init.name, cards: [...(init.cards ?? [])], createdAt: now, updatedAt: now };
      const entry = tracked(item, true);
      decks = [...decks, entry];
      changed();
      schedule();
      return item.id;
    },

    updateDeck(id, patch) {
      const entry = decks.find((candidate) => candidate.item.id === id);
      if (entry === undefined) return;
      const name = patch.name ?? entry.item.name;
      const cards = patch.cards ?? entry.item.cards;
      if (name === entry.item.name && sameList(cards, entry.item.cards)) return;
      edited(entry, { ...entry.item, name, cards: [...cards], updatedAt: clock.now() });
    },

    deleteDeck(id) {
      if (!decks.some((entry) => entry.item.id === id)) return;
      decks = decks.filter((entry) => entry.item.id !== id);
      deletingDecks.add(id);
      for (const trio of trios) {
        if (!trio.item.deckIds.includes(id)) continue;
        const slots = trio.item.deckIds.map((slot) => (slot === id ? null : slot)) as TrioSlots;
        trio.item = { ...trio.item, deckIds: slots, updatedAt: clock.now() };
        trio.dirty = true;
        trio.rev += 1;
        trio.refused = null;
        trio.blocked = false;
      }
      changed();
      schedule();
    },

    createTrio(init) {
      if (trios.length >= limits.trios) return null;
      const now = clock.now();
      const item: TrioItem = {
        id: newId(),
        name: init.name,
        deckIds: [...(init.deckIds ?? [null, null, null])] as TrioSlots,
        createdAt: now,
        updatedAt: now,
      };
      trios = [...trios, tracked(item, true)];
      changed();
      schedule();
      return item.id;
    },

    updateTrio(id, patch) {
      const entry = trios.find((candidate) => candidate.item.id === id);
      if (entry === undefined) return;
      const name = patch.name ?? entry.item.name;
      const deckIds = patch.deckIds ?? entry.item.deckIds;
      if (name === entry.item.name && sameSlots(deckIds, entry.item.deckIds)) return;
      edited(entry, { ...entry.item, name, deckIds: [...deckIds] as TrioSlots, updatedAt: clock.now() });
    },

    deleteTrio(id) {
      if (!trios.some((entry) => entry.item.id === id)) return;
      trios = trios.filter((entry) => entry.item.id !== id);
      deletingTrios.add(id);
      changed();
      schedule();
    },

    importTrio,

    flush,

    start() {
      stopped = false;
      if (started || typeof window === "undefined") return;
      started = true;
      window.addEventListener("pagehide", onPageHide);
      window.addEventListener("online", onOnline);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    },

    stop() {
      if (started && typeof window !== "undefined") {
        window.removeEventListener("pagehide", onPageHide);
        window.removeEventListener("online", onOnline);
        if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
      }
      started = false;
      if (retry !== null) {
        clock.clearTimeout(retry);
        retry = null;
      }
      // One last send of what is unsaved (the mirror already holds it either way), then quiet.
      const unsaved = hasWork();
      stopped = true;
      if (unsaved) void flush();
      else if (debounce !== null) {
        clock.clearTimeout(debounce);
        debounce = null;
      }
    },
  };

  // Work the merge found unsaved (an offline edit from the last visit) goes as soon as it can.
  if (hasWork()) schedule();
  persist();

  return store;
}
