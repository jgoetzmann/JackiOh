/**
 * The in-memory halves of the stores R250–R263 added — saved decks, saved trios and the Conquest
 * series — R320's tutorial progress and R376's game records, shared by the two in-memory `Store`s:
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
 *  - `tutorial.merge` only ever grows the lessons and keeps the newest choice (0011, R320);
 *  - `playerSettings.merge` replaces a group only with a strictly later one and caps the result's
 *    groups and bytes (0018, R633, R634);
 *  - `ranked.createSeason` refuses an id that exists, `ranked.recordGame` a second row for one game,
 *    and `ranked.notePeakJlorious` only ever lowers a peak (R608, R609, R611; migration 0019
 *    carries the same tables on Postgres),
 *  - `gameRecords.insert` writes one record per id and refuses a second, and refuses a development
 *    record without a `dev:` id or a live one with one (0014, R376, R378).
 */

import { DEV_RECORD_ID_PREFIX, recordMatches, type GameRecord } from "@jackioh/shared";
import type { SeasonRank } from "../ranked/ladder";
import type {
  BotRating,
  DeckStore,
  PlayerSettingsLimits,
  PlayerSettingsMergeInput,
  PlayerSettingsMergeOutcome,
  PlayerSettingsRow,
  PlayerSettingsStore,
  LastBoardEntry,
  LastBoardKind,
  LastBoardStore,
  GameRecordStore,
  MatchActionRow,
  MatchRow,
  Profile,
  QueueMode,
  RankedStore,
  RatedGameRow,
  RetentionPurgeInput,
  RetentionPurgeResult,
  Room,
  Season,
  SavedDeck,
  SavedTrio,
  SeriesRow,
  SeriesStore,
  TrioStore,
  Ticket,
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

// ---------------------------------------------------------------------------
// Player settings on the account (SPEC §9.1, R633, R634)
// ---------------------------------------------------------------------------

/** The table R633 adds (`public.player_settings`, migration 0018): one row per profile. */
export type PlayerSettingsTables = { playerSettings: PlayerSettingsRow[] };

export function emptyPlayerSettingsTables(): PlayerSettingsTables {
  return { playerSettings: [] };
}

/**
 * The size Postgres measures for the byte cap: `octet_length(groups::text)`. jsonb prints an object
 * with its keys shorter first and then bytewise, a space after each colon and comma, so the
 * in-memory store prints the same text to count the same bytes.
 */
export function jsonbTextBytes(value: unknown): number {
  const text = (node: unknown): string => {
    if (Array.isArray(node)) return `[${node.map(text).join(", ")}]`;
    if (node !== null && typeof node === "object") {
      const keys = Object.keys(node).sort(
        (a, b) => Buffer.byteLength(a) - Buffer.byteLength(b) || Buffer.compare(Buffer.from(a), Buffer.from(b)),
      );
      return `{${keys.map((key) => `${JSON.stringify(key)}: ${text((node as Record<string, unknown>)[key])}`).join(", ")}}`;
    }
    return JSON.stringify(node);
  };
  return Buffer.byteLength(text(value));
}

/**
 * R634's merge, exactly as `app.merge_player_settings` (0018) makes it: each group sent replaces
 * the stored group only when its time is strictly later (the stored one on a tie), and a group the
 * write does not name stays. `limit` when the result would pass a cap; nothing changes then.
 */
export function mergePlayerSettingsRow(
  existing: PlayerSettingsRow | null,
  input: PlayerSettingsMergeInput,
  limits: PlayerSettingsLimits,
): PlayerSettingsRow | "limit" {
  const groups = clone(existing?.groups ?? {});
  for (const [id, sent] of Object.entries(input.groups)) {
    const held = groups[id];
    if (held === undefined || sent.at > held.at) groups[id] = clone(sent);
  }
  if (Object.keys(groups).length > limits.maxGroups || jsonbTextBytes(groups) > limits.maxBytes) return "limit";
  return { profileId: input.profileId, groups };
}

/**
 * The in-memory `PlayerSettingsStore`, shared by both in-memory stores as the tutorial store is.
 * Laxer than Postgres in two places, both listed in `src/db/store.ts`'s KNOWN DIVERGENCES: it
 * writes a row for a profile that is not active, and it does not re-check a group's shape (the
 * handler has).
 */
export function createMemoryPlayerSettingsStore(
  tables: () => PlayerSettingsTables,
  call: (method: string) => void = () => undefined,
): PlayerSettingsStore {
  return {
    get: async (profileId) => {
      call("playerSettings.get");
      const row = tables().playerSettings.find((existing) => existing.profileId === profileId);
      return row === undefined ? null : clone(row);
    },
    merge: async (input, limits): Promise<PlayerSettingsMergeOutcome> => {
      call("playerSettings.merge");
      const rows = tables().playerSettings;
      const at = rows.findIndex((existing) => existing.profileId === input.profileId);
      const merged = mergePlayerSettingsRow(rows[at] ?? null, input, limits);
      if (merged === "limit") return { kind: "limit" };
      if (at < 0) rows.push(clone(merged));
      else rows[at] = clone(merged);
      return { kind: "merged", settings: clone(merged) };
    },
  };
}

// ---------------------------------------------------------------------------
// Last boards (C+ #29 Portal to the Past, R417, R565)
// ---------------------------------------------------------------------------

/** The table R565 adds (`public.last_boards`, migration 0017): one row per profile and kind. */
export type LastBoardTables = { lastBoards: { profileId: string; kind: LastBoardKind; board: LastBoardEntry[] }[] };

/** The in-memory `LastBoardStore`, shared by both in-memory stores as the tutorial store is. */
export function createMemoryLastBoardStore(
  tables: () => LastBoardTables,
  call: (method: string) => void = () => undefined,
): LastBoardStore {
  const find = (profileId: string, kind: LastBoardKind) =>
    tables().lastBoards.find((row) => row.profileId === profileId && row.kind === kind);
  return {
    get: async (profileId, kind) => {
      call("lastBoards.get");
      const row = find(profileId, kind);
      return row === undefined ? null : clone(row.board);
    },
    put: async (profileId, kind, board) => {
      call("lastBoards.put");
      const row = find(profileId, kind);
      if (row === undefined) tables().lastBoards.push({ profileId, kind, board: clone([...board]) });
      else row.board = clone([...board]);
    },
  };
}

// ---------------------------------------------------------------------------
// Game records for the card statistics (SPEC §9.11, R376)
// ---------------------------------------------------------------------------

/**
 * `MatchStore.modeOf` for both in-memory stores, as Postgres answers it: a game of a Conquest series
 * is `bo3`, a room's match has the room's mode, and a queue match its tickets' mode.
 */
export function matchModeIn(
  tables: { series: SeriesRow[]; rooms: Room[]; tickets: Ticket[] },
  matchId: string,
): QueueMode | null {
  if (tables.series.some((row) => row.games.some((game) => game.matchId === matchId))) return "bo3";
  const room = tables.rooms.find((row) => row.matchId === matchId);
  if (room !== undefined) return room.mode;
  return tables.tickets.find((row) => row.matchId === matchId)?.mode ?? null;
}

/** The table R376 adds (`public.game_records`, migration 0014): one row per recorded game. */
export type GameRecordTables = { gameRecords: GameRecord[] };

/**
 * The in-memory `GameRecordStore`: one record per id, as the primary key makes it, and a read in id
 * order that filters by source, mode and patch exactly as `cardStats` does.
 */
export function createMemoryGameRecordStore(
  tables: () => GameRecordTables,
  call: (method: string) => void = () => undefined,
): GameRecordStore {
  return {
    insert: async (record) => {
      call("gameRecords.insert");
      // R378: `game_records_dev_id_check` (0014). A development id begins "dev:", a live one never.
      if ((record.source === "dev") !== record.id.startsWith(DEV_RECORD_ID_PREFIX)) {
        throw new Error(`game_records_dev_id_check: a ${record.source} record cannot have the id ${record.id}`);
      }
      const rows = tables().gameRecords;
      if (rows.some((existing) => existing.id === record.id)) return false;
      rows.push(clone(record));
      return true;
    },
    list: async (query) => {
      call("gameRecords.list");
      return tables()
        .gameRecords.filter((record) => recordMatches(record, { ...query, pilot: "unified" }))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .map(clone);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Account deletion and the retention purge (migrations 0012 and 0013), for both in-memory stores.
// ---------------------------------------------------------------------------------------------

/** The rows `ProfileStore.remove` and `Store.purgeExpired` reach, as both in-memory stores hold them. */
export type AccountTables = DeckTables &
  TutorialTables &
  PlayerSettingsTables &
  RankedTables &
  LastBoardTables & {
    profiles: { id: string }[];
    attempts: { profileId: string | null; at: number }[];
    collection: { profileId: string }[];
    grants: { profileId: string }[];
    matches: MatchRow[];
    matchActions: MatchActionRow[];
    rooms: Room[];
    tickets: Ticket[];
  };

/** Drops the rows `wanted` refuses, in place, and says how many went. */
function keepOnly<T>(rows: T[], wanted: (row: T) => boolean): number {
  const before = rows.length;
  let at = 0;
  for (const row of rows) {
    if (wanted(row)) {
      rows[at] = row;
      at += 1;
    }
  }
  rows.length = at;
  return before - at;
}

/**
 * `ProfileStore.remove`, as migration 0012 makes Postgres do it: the profile's own rows go, its
 * invite-code attempts lose their link to it, and a room it opened that nobody joined goes too.
 * Finished matches, results and series stay for the other player. Postgres empties this profile's
 * seat on them; here the id stays, since no port read of a finished match looks the seat up.
 */
export function removeProfileRows(tables: AccountTables, profileId: string): boolean {
  if (keepOnly(tables.profiles, (row) => row.id !== profileId) === 0) return false;
  for (const attempt of tables.attempts) {
    if (attempt.profileId === profileId) attempt.profileId = null;
  }
  keepOnly(tables.collection, (row) => row.profileId !== profileId);
  keepOnly(tables.grants, (row) => row.profileId !== profileId);
  keepOnly(tables.decks, (row) => row.profileId !== profileId);
  keepOnly(tables.trios, (row) => row.profileId !== profileId);
  keepOnly(tables.tutorial, (row) => row.profileId !== profileId);
  keepOnly(tables.playerSettings, (row) => row.profileId !== profileId);
  keepOnly(tables.lastBoards, (row) => row.profileId !== profileId);
  keepOnly(tables.tickets, (row) => row.profileId !== profileId);
  keepOnly(tables.rooms, (row) => !(row.hostProfileId === profileId && row.guestProfileId === null));
  // 0014: a profile's season rows go with it; the record of its rated games stays for the other
  // player with this side's profile emptied, as Postgres's `on delete set null` does.
  keepOnly(tables.seasonRanks, (row) => row.profileId !== profileId);
  for (const game of tables.ratedGames) {
    for (const side of game.sides) if (side.profileId === profileId) side.profileId = null;
  }
  return true;
}

/** `Store.purgeExpired`: old attempts, and the logs of matches that ended before the cutoff. */
export function purgeExpiredRows(tables: AccountTables, input: RetentionPurgeInput): RetentionPurgeResult {
  const codeAttempts = keepOnly(tables.attempts, (row) => row.at >= input.codeAttemptsBefore);
  const expired = new Set(
    tables.matches
      .filter(
        (match) =>
          match.status === "finished" &&
          match.finishedAt !== null &&
          match.finishedAt < input.matchActionsEndedBefore,
      )
      .map((match) => match.id),
  );
  const matchActions = keepOnly(tables.matchActions, (row) => !expired.has(row.matchId));
  return { codeAttempts, matchActions };
}

// ---------------------------------------------------------------------------------------------
// The ranked ladder (SPEC §9.12; migration 0019 carries it on Postgres), for both in-memory
// stores.
// ---------------------------------------------------------------------------------------------

export type RankedTables = {
  seasons: Season[];
  seasonRanks: SeasonRank[];
  bots: BotRating[];
  ratedGames: RatedGameRow[];
};

export function emptyRankedTables(): RankedTables {
  return { seasons: [], seasonRanks: [], bots: [], ratedGames: [] };
}

const byProfileId = <T extends { profileId: string }>(a: T, b: T): number =>
  a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0;

/**
 * The in-memory `RankedStore`, shared by both in-memory stores. It reads `profiles` for the ratings
 * a standing carries and the soft reset writes, as Postgres joins `public.profiles`.
 */
export function createMemoryRankedStore(
  tables: () => RankedTables & { profiles: Profile[] },
  call: (method: string) => void = () => undefined,
): RankedStore {
  const profileOf = (profileId: string): Profile | undefined => tables().profiles.find((row) => row.id === profileId);
  return {
    // One process owns these tables: there is no second opener to serialize with.
    lockSeasons: async () => {
      call("ranked.lockSeasons");
    },
    seasons: async () => {
      call("ranked.seasons");
      return [...tables().seasons].sort((a, b) => a.startedAt - b.startedAt || (a.id < b.id ? -1 : 1)).map(clone);
    },
    createSeason: async (season) => {
      call("ranked.createSeason");
      if (tables().seasons.some((row) => row.id === season.id)) return false;
      tables().seasons.push(clone(season));
      return true;
    },
    ratedPlayers: async () => {
      call("ranked.ratedPlayers");
      const ids = new Set<string>();
      for (const game of tables().ratedGames) {
        for (const side of game.sides) if (side.profileId !== null && side.botId === null) ids.add(side.profileId);
      }
      return [...ids]
        .flatMap((profileId) => {
          const profile = profileOf(profileId);
          return profile === undefined
            ? []
            : [{ profileId, glicko: { rating: profile.rating, deviation: profile.ratingDeviation, volatility: profile.ratingVolatility } }];
        })
        .sort(byProfileId);
    },
    resetRatings: async (changes) => {
      call("ranked.resetRatings");
      for (const change of changes) {
        const profile = profileOf(change.profileId);
        if (profile === undefined) continue;
        profile.rating = change.after.rating;
        profile.ratingDeviation = change.after.deviation;
        profile.ratingVolatility = change.after.volatility;
      }
    },
    standings: async (seasonId) => {
      call("ranked.standings");
      return tables()
        .seasonRanks.filter((row) => row.seasonId === seasonId)
        .flatMap((row) => {
          const profile = profileOf(row.profileId);
          return profile === undefined ? [] : [{ ...clone(row), rating: profile.rating }];
        })
        .sort(byProfileId);
    },
    rank: async (seasonId, profileId) => {
      call("ranked.rank");
      const row = tables().seasonRanks.find((rank) => rank.seasonId === seasonId && rank.profileId === profileId);
      return row === undefined ? null : clone(row);
    },
    ranksOf: async (profileId) => {
      call("ranked.ranksOf");
      const order = new Map(tables().seasons.map((season) => [season.id, season.startedAt]));
      return tables()
        .seasonRanks.filter((row) => row.profileId === profileId)
        .sort((a, b) => (order.get(a.seasonId) ?? 0) - (order.get(b.seasonId) ?? 0))
        .map(clone);
    },
    putRank: async (row) => {
      call("ranked.putRank");
      const rows = tables().seasonRanks;
      const at = rows.findIndex((rank) => rank.seasonId === row.seasonId && rank.profileId === row.profileId);
      const existing = rows[at];
      if (existing === undefined) rows.push(clone(row));
      else {
        // Same merge as Postgres' upsert: a notePeakJlorious that landed since the writer read
        // the row is not lost.
        const peak = existing.peakJlorious;
        rows[at] = {
          ...clone(row),
          peakJlorious:
            peak === null ? row.peakJlorious : row.peakJlorious === null ? peak : Math.min(peak, row.peakJlorious),
        };
      }
    },
    notePeakJlorious: async (seasonId, profileId, position) => {
      call("ranked.notePeakJlorious");
      const row = tables().seasonRanks.find((rank) => rank.seasonId === seasonId && rank.profileId === profileId);
      if (row === undefined) return;
      row.peakJlorious = row.peakJlorious === null ? position : Math.min(row.peakJlorious, position);
    },
    bot: async (botId) => {
      call("ranked.bot");
      const row = tables().bots.find((bot) => bot.botId === botId);
      return row === undefined ? null : clone(row);
    },
    putBot: async (bot) => {
      call("ranked.putBot");
      const rows = tables().bots;
      const at = rows.findIndex((row) => row.botId === bot.botId);
      if (at < 0) rows.push(clone(bot));
      else rows[at] = clone(bot);
    },
    recordGame: async (row) => {
      call("ranked.recordGame");
      if (tables().ratedGames.some((game) => game.id === row.id)) {
        throw new Error(`rated_games already holds a row for ${row.id}`);
      }
      tables().ratedGames.push(clone(row));
    },
    game: async (id) => {
      call("ranked.game");
      const row = tables().ratedGames.find((game) => game.id === id);
      return row === undefined ? null : clone(row);
    },
  };
}
