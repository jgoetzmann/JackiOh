/**
 * The in-memory halves of the stores R250–R263 added — saved decks, saved trios and the Best-of-3
 * series — and R320's tutorial progress, shared by the two in-memory `Store`s:
 * `src/api/e2e-store.ts` (the end-to-end server) and `test/fakes/store.ts` (the unit tests). One
 * implementation, so the two cannot answer an upsert, a compare-and-set or a merge differently
 * while only one of them runs under `test/db/contract.ts`.
 *
 * Each factory closes over a `tables()` getter rather than the arrays themselves, because both
 * stores replace their tables wholesale (a rolled-back `tx`, `reset()`), and a captured array
 * would keep writing to the discarded copy.
 *
 * Strict where Postgres is strict (migrations 0007, 0008, 0011):
 *  - `decks.upsert` / `trios.upsert` refuse an id owned by another profile (`not_owner`) and a
 *    create past the cap (`limit`), exactly as `app.upsert_deck` / `app.upsert_trio` do;
 *  - `trios.upsert` refuses a slot naming a deck that is not this profile's (`unknown_deck`, the
 *    composite foreign key) and one deck in two slots (the check constraint);
 *  - `decks.remove` empties every trio slot that named the deck (`on delete set null`);
 *  - `series.update` is compare-and-set on `version`;
 *  - `tutorial.merge` only ever grows the lessons and keeps the newest choice (0011, R320).
 */

import type {
  DeckStore,
  SavedDeck,
  SavedTrio,
  SeriesRow,
  SeriesStore,
  TrioStore,
  TrioUpsertOutcome,
  TutorialMergeInput,
  TutorialMergeOutcome,
  TutorialProgressRow,
  TutorialStore,
  UpsertOutcome,
} from "./ports";

const clone = <T>(value: T): T => structuredClone(value);

export type DeckTables = {
  decks: SavedDeck[];
  trios: SavedTrio[];
  series: SeriesRow[];
};

export function emptyDeckTables(): DeckTables {
  return { decks: [], trios: [], series: [] };
}

/** Oldest first, ties on id: the order `DeckStore.list` and `TrioStore.list` promise. */
function byCreation<T extends { createdAt: number; id: string }>(a: T, b: T): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * `call` is the unit-test fake's fault-injection hook (`MemoryStore.onCall`), charged with the
 * port method's name before each operation; the e2e store passes nothing.
 */
export function createMemoryDeckStores(
  tables: () => DeckTables,
  call: (method: string) => void = () => undefined,
): { decks: DeckStore; trios: TrioStore; series: SeriesStore } {
  const decks: DeckStore = {
    list: async (profileId) => {
      call("decks.list");
      return tables()
        .decks.filter((deck) => deck.profileId === profileId)
        .sort(byCreation)
        .map(clone);
    },
    get: async (deckId) => {
      call("decks.get");
      const row = tables().decks.find((deck) => deck.id === deckId);
      return row === undefined ? null : clone(row);
    },
    upsert: async (deck, maxDecks): Promise<UpsertOutcome> => {
      call("decks.upsert");
      const rows = tables().decks;
      const existing = rows.find((row) => row.id === deck.id);
      if (existing !== undefined) {
        if (existing.profileId !== deck.profileId) return "not_owner";
        existing.name = deck.name;
        existing.cards = [...deck.cards];
        existing.catalogVersion = deck.catalogVersion;
        existing.updatedAt = deck.updatedAt;
        return "updated";
      }
      const count = rows.filter((row) => row.profileId === deck.profileId).length;
      if (count >= maxDecks) return "limit";
      rows.push(clone(deck));
      return "created";
    },
    remove: async (profileId, deckId) => {
      call("decks.remove");
      const t = tables();
      const at = t.decks.findIndex((deck) => deck.id === deckId && deck.profileId === profileId);
      if (at < 0) return false;
      t.decks.splice(at, 1);
      // `on delete set null (deckN_id)`: the trio keeps its other slots and its place.
      for (const trio of t.trios) {
        if (trio.profileId !== profileId) continue;
        trio.deckIds = trio.deckIds.map((id) => (id === deckId ? null : id)) as SavedTrio["deckIds"];
      }
      return true;
    },
  };

  const trios: TrioStore = {
    list: async (profileId) => {
      call("trios.list");
      return tables()
        .trios.filter((trio) => trio.profileId === profileId)
        .sort(byCreation)
        .map(clone);
    },
    get: async (trioId) => {
      call("trios.get");
      const row = tables().trios.find((trio) => trio.id === trioId);
      return row === undefined ? null : clone(row);
    },
    upsert: async (trio, maxTrios): Promise<TrioUpsertOutcome> => {
      call("trios.upsert");
      const t = tables();
      const existing = t.trios.find((row) => row.id === trio.id);
      if (existing !== undefined && existing.profileId !== trio.profileId) return "not_owner";

      const filled = trio.deckIds.filter((id): id is string => id !== null);
      if (new Set(filled).size !== filled.length) {
        throw new Error("trios_decks_distinct: a trio cannot hold the same deck twice");
      }
      const mine = (deckId: string): boolean =>
        t.decks.some((deck) => deck.id === deckId && deck.profileId === trio.profileId);
      if (!filled.every(mine)) return "unknown_deck";

      if (existing !== undefined) {
        existing.name = trio.name;
        existing.deckIds = [...trio.deckIds];
        existing.updatedAt = trio.updatedAt;
        return "updated";
      }
      const count = t.trios.filter((row) => row.profileId === trio.profileId).length;
      if (count >= maxTrios) return "limit";
      t.trios.push(clone(trio));
      return "created";
    },
    remove: async (profileId, trioId) => {
      call("trios.remove");
      const t = tables();
      const at = t.trios.findIndex((trio) => trio.id === trioId && trio.profileId === profileId);
      if (at < 0) return false;
      t.trios.splice(at, 1);
      return true;
    },
  };

  const series: SeriesStore = {
    create: async (row) => {
      call("series.create");
      const t = tables();
      if (t.series.some((existing) => existing.id === row.id)) {
        throw new Error(`series.id is unique: ${row.id}`);
      }
      t.series.push(clone(row));
    },
    get: async (seriesId) => {
      call("series.get");
      const row = tables().series.find((existing) => existing.id === seriesId);
      return row === undefined ? null : clone(row);
    },
    update: async (next) => {
      call("series.update");
      const t = tables();
      const at = t.series.findIndex((existing) => existing.id === next.id);
      const current = t.series[at];
      if (current === undefined || current.version !== next.version - 1) return false;
      t.series[at] = clone(next);
      return true;
    },
    byMatch: async (matchId) => {
      call("series.byMatch");
      const row = tables().series.find(
        (existing) => existing.status === "playing" && existing.nextMatchId === matchId,
      );
      return row === undefined ? null : clone(row);
    },
    withGame: async (matchId) => {
      call("series.withGame");
      const row = tables().series.find((existing) =>
        existing.games.some((game) => game.matchId === matchId),
      );
      return row === undefined ? null : clone(row);
    },
    activeFor: async (profileId) => {
      call("series.activeFor");
      const row = tables().series.find(
        (existing) =>
          existing.status !== "over" && existing.sides.some((side) => side.profileId === profileId),
      );
      return row === undefined ? null : clone(row);
    },
    active: async () => {
      call("series.active");
      return tables()
        .series.filter((existing) => existing.status !== "over")
        .sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1))
        .map(clone);
    },
  };

  return { decks, trios, series };
}

// ---------------------------------------------------------------------------
// Tutorial progress on the account (SPEC §9.10, R320)
// ---------------------------------------------------------------------------

/** The table R320 adds (`public.tutorial_progress`, migration 0011): one row per profile. */
export type TutorialTables = { tutorial: TutorialProgressRow[] };

export function emptyTutorialTables(): TutorialTables {
  return { tutorial: [] };
}

/**
 * R320's merge, exactly as `app.merge_tutorial_progress` (0011) makes it: the lessons become the
 * union of the stored and the sent, each once in code-point order (`collate "C"` in Postgres), and
 * the stored choice is replaced only by a strictly newer one. `limit` when the union would pass
 * `maxLessons`; nothing changes then.
 */
export function mergeTutorialRow(
  existing: TutorialProgressRow | null,
  input: TutorialMergeInput,
  maxLessons: number,
): TutorialProgressRow | "limit" {
  const completed = [...new Set([...(existing?.completed ?? []), ...input.completed])].sort();
  if (completed.length > maxLessons) return "limit";
  const stored = existing?.hiddenChoice ?? null;
  const incoming = input.hiddenChoice;
  const hiddenChoice = incoming !== null && (stored === null || incoming.at > stored.at) ? incoming : stored;
  return {
    profileId: input.profileId,
    completed,
    hiddenChoice: hiddenChoice === null ? null : { hidden: hiddenChoice.hidden, at: hiddenChoice.at },
  };
}

/**
 * The in-memory `TutorialStore`, shared by both in-memory stores as the deck stores are. Laxer than
 * Postgres in two places, both listed in `src/db/store.ts`'s KNOWN DIVERGENCES: it writes a row for
 * a profile that is not active, and it does not re-check an id's shape (the handler has).
 */
export function createMemoryTutorialStore(
  tables: () => TutorialTables,
  call: (method: string) => void = () => undefined,
): TutorialStore {
  return {
    get: async (profileId) => {
      call("tutorial.get");
      const row = tables().tutorial.find((existing) => existing.profileId === profileId);
      return row === undefined ? null : clone(row);
    },
    merge: async (input, maxLessons): Promise<TutorialMergeOutcome> => {
      call("tutorial.merge");
      const rows = tables().tutorial;
      const at = rows.findIndex((existing) => existing.profileId === input.profileId);
      const merged = mergeTutorialRow(rows[at] ?? null, input, maxLessons);
      if (merged === "limit") return { kind: "limit" };
      if (at < 0) rows.push(clone(merged));
      else rows[at] = clone(merged);
      return { kind: "merged", progress: clone(merged) };
    },
  };
}
