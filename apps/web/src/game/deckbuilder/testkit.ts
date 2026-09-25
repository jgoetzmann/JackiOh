// Test fakes for the deck workshop: saved decks and trios as `GET /api/decks` returns them, an
// in-memory server with the refusals that matter to the store (R256), an in-memory storage and a
// manual clock. Only tests import this file.

import {
  DECK_NAME_MAX_LENGTH,
  MAX_SAVED_DECKS,
  MAX_SAVED_TRIOS,
} from "../../../../server/src/config.ts";
import {
  ApiRequestError,
  ApiUnreachableError,
  type DeckInput,
  type DecksResponse,
  type SavedDeck,
  type SavedTrio,
  type TrioImportInput,
  type TrioInput,
  type TrioSlots,
} from "../../net/api.ts";
import type { DeckSyncApi, StorageLike, SyncClock } from "./sync.ts";

export const TEST_PROFILE = "profile-test";

export function savedDeck(id: string, name: string, cards: readonly string[], createdAt: number, catalogVersion = "test"): SavedDeck {
  return { id, name, cards: [...cards], catalogVersion, createdAt, updatedAt: createdAt };
}

export function savedTrio(id: string, name: string, deckIds: TrioSlots, createdAt: number): SavedTrio {
  return { id, name, deckIds: [...deckIds] as TrioSlots, createdAt, updatedAt: createdAt };
}

export function decksResponse(decks: SavedDeck[] = [], trios: SavedTrio[] = [], catalogVersion = "test"): DecksResponse {
  return {
    catalogVersion,
    decks,
    trios,
    limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS, nameLength: DECK_NAME_MAX_LENGTH },
  };
}

/** Microtask turns `settle` gives a save: a pass awaits a few promises per request. */
const SETTLE_TURNS = 50;

/** Lets every pending promise callback run: the fake server answers in microtasks. */
export async function settle(): Promise<void> {
  for (let turn = 0; turn < SETTLE_TURNS; turn += 1) {
    await Promise.resolve();
  }
}

export type ManualClock = SyncClock & { advance(ms: number): Promise<void>; pending(): number };

/** A clock whose timers fire only when `advance` passes their moment. */
export function manualClock(start = 1_000): ManualClock {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { at: now + ms, run });
      return id;
    },
    clearTimeout(handle) {
      timers.delete(handle as number);
    },
    pending: () => timers.size,
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        let due: [number, { at: number; run: () => void }] | null = null;
        for (const entry of timers) {
          if (entry[1].at <= target && (due === null || entry[1].at < due[1].at)) due = entry;
        }
        if (due === null) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        await settle();
      }
      now = target;
      await settle();
    },
  };
}

export function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => {
      data.set(key, value);
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

export type ServerCall = {
  op: "putDeck" | "deleteDeck" | "putTrio" | "deleteTrio" | "importTrio";
  id: string;
  body?: DeckInput | TrioInput | TrioImportInput;
};

/** An in-memory `/api/decks` and `/api/trios`, with the refusals the store has to handle. */
export function fakeDeckServer() {
  const decks = new Map<string, DeckInput>();
  const trios = new Map<string, TrioInput>();
  const calls: ServerCall[] = [];
  const state = {
    offline: false,
    /** A refusal per id, thrown until removed. */
    refusals: new Map<string, ApiRequestError>(),
  };

  function gate(call: ServerCall): void {
    calls.push(call);
    if (state.offline) throw new ApiUnreachableError(new TypeError("Failed to fetch"));
    const refusal = state.refusals.get(call.id);
    if (refusal !== undefined) throw refusal;
  }

  const api: DeckSyncApi = {
    async putDeck(id, input) {
      gate({ op: "putDeck", id, body: input });
      decks.set(id, input);
      return { deck: { id } };
    },
    async deleteDeck(id) {
      gate({ op: "deleteDeck", id });
      return { deleted: decks.delete(id) };
    },
    async putTrio(id, input) {
      gate({ op: "putTrio", id, body: input });
      if (input.deckIds.some((deckId) => deckId !== null && !decks.has(deckId))) {
        throw new ApiRequestError(409, {
          code: "conflict",
          message: "That trio names a deck that is not saved.",
          details: { unknownDeck: true },
        });
      }
      trios.set(id, input);
      return { trio: { id } };
    },
    async deleteTrio(id) {
      gate({ op: "deleteTrio", id });
      return { deleted: trios.delete(id) };
    },
    async importTrio(input) {
      gate({ op: "importTrio", id: input.trio.id, body: input });
      const catalogVersion = input.catalogVersion;
      for (const deck of input.slots) {
        if (deck !== null) decks.set(deck.id, { name: deck.name, cards: deck.cards, catalogVersion });
      }
      const deckIds = input.slots.map((deck) => deck?.id ?? null) as TrioSlots;
      trios.set(input.trio.id, { name: input.trio.name, deckIds });
      return {};
    },
  };

  /** Seeds the server with what a `GET /api/decks` answer says it holds. */
  function seed(response: DecksResponse): void {
    for (const deck of response.decks) {
      decks.set(deck.id, { name: deck.name, cards: deck.cards, catalogVersion: deck.catalogVersion });
    }
    for (const trio of response.trios) trios.set(trio.id, { name: trio.name, deckIds: trio.deckIds });
  }

  return { api, calls, decks, trios, state, seed };
}

/** An api that accepts everything and remembers nothing. */
export function quietDeckApi(): DeckSyncApi {
  return {
    putDeck: async () => ({}),
    deleteDeck: async () => ({}),
    putTrio: async () => ({}),
    deleteTrio: async () => ({}),
    importTrio: async () => ({}),
  };
}
