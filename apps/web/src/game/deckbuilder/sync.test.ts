// R256: the workshop's autosave. Every test drives the store through a fake server, an in-memory
// (or broken) storage and a manual clock, so "after the debounce", "offline" and "a new visit"
// are exact moments rather than real waits.

import { afterEach, describe, expect, it } from "vitest";

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
  type SavedDeck,
  type SavedTrio,
  type TrioInput,
  type TrioSlots,
} from "../../net/api.ts";
import { fixtureCardId } from "./fixtures.ts";
import {
  UNTITLED_DECK,
  UNTITLED_TRIO,
  browserStorage,
  createDeckStore,
  deckNameForSave,
  mirrorKey,
  trioNameForSave,
  type DeckStore,
  type DeckStoreOptions,
  type StorageLike,
  type SyncClock,
} from "./sync.ts";

const PROFILE = "profile-1";
const CATALOG_VERSION = "test-catalog-1";
const RETRY_MS = DECK_AUTOSAVE_RETRY_SECONDS * 1000;

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/** Lets every pending promise callback run: the fake server answers in microtasks. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

type ManualClock = SyncClock & { advance(ms: number): Promise<void>; pending(): number };

function manualClock(start = 1_000): ManualClock {
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

function memoryStorage(): StorageLike & { data: Map<string, string> } {
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

function brokenStorage(): StorageLike {
  const refuse = (): never => {
    throw new Error("SecurityError: storage is disabled");
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

type Call = { op: "putDeck" | "deleteDeck" | "putTrio" | "deleteTrio"; id: string; body?: DeckInput | TrioInput };

/** An in-memory server with the refusals `apps/server/src/api/decks.ts` makes that matter here. */
function fakeServer() {
  const decks = new Map<string, DeckInput>();
  const trios = new Map<string, TrioInput>();
  const calls: Call[] = [];
  const state = {
    offline: false,
    /** A refusal per id, thrown until removed. */
    refusals: new Map<string, ApiRequestError>(),
    /** Held requests: resolve() lets the next one answer. */
    hold: null as null | { release: () => void; wait: Promise<void> },
  };

  async function gate(call: Call): Promise<void> {
    calls.push(call);
    if (state.hold !== null) await state.hold.wait;
    if (state.offline) throw new ApiUnreachableError(new TypeError("Failed to fetch"));
    const refusal = state.refusals.get(call.id);
    if (refusal !== undefined) throw refusal;
  }

  const api = {
    async putDeck(id: string, input: DeckInput) {
      await gate({ op: "putDeck", id, body: input });
      decks.set(id, input);
      return { deck: { id } };
    },
    async deleteDeck(id: string) {
      await gate({ op: "deleteDeck", id });
      const deleted = decks.delete(id);
      for (const [trioId, trio] of trios) {
        trios.set(trioId, { ...trio, deckIds: trio.deckIds.map((slot) => (slot === id ? null : slot)) as TrioSlots });
      }
      return { deleted };
    },
    async putTrio(id: string, input: TrioInput) {
      await gate({ op: "putTrio", id, body: input });
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
    async deleteTrio(id: string) {
      await gate({ op: "deleteTrio", id });
      return { deleted: trios.delete(id) };
    },
  };

  function holdRequests(): () => void {
    let release = (): void => {};
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.hold = { release, wait };
    return () => {
      state.hold = null;
      release();
    };
  }

  return { api, calls, decks, trios, state, holdRequests };
}

function savedDeck(id: string, name: string, cards: string[], createdAt: number): SavedDeck {
  return { id, name, cards, catalogVersion: CATALOG_VERSION, createdAt, updatedAt: createdAt };
}

function savedTrio(id: string, name: string, deckIds: TrioSlots, createdAt: number): SavedTrio {
  return { id, name, deckIds, createdAt, updatedAt: createdAt };
}

function response(decks: SavedDeck[] = [], trios: SavedTrio[] = []): DecksResponse {
  return {
    catalogVersion: CATALOG_VERSION,
    decks,
    trios,
    limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS, nameLength: DECK_NAME_MAX_LENGTH },
  };
}

let minted = 0;
function mint(): string {
  minted += 1;
  return `00000000-0000-4000-8000-${String(minted).padStart(12, "0")}`;
}

const stores: DeckStore[] = [];

function open(overrides: Partial<DeckStoreOptions> & Pick<DeckStoreOptions, "api">): DeckStore {
  const store = createDeckStore({
    profileId: PROFILE,
    catalogVersion: CATALOG_VERSION,
    server: response(),
    storage: memoryStorage(),
    clock: manualClock(),
    newId: mint,
    ...overrides,
  });
  stores.push(store);
  return store;
}

afterEach(() => {
  for (const store of stores.splice(0)) store.stop();
});

// ---------------------------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------------------------

describe("the debounced save", () => {
  it("R256 an edit is saved by one PUT once the debounce has passed, and not before", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const id = store.createDeck({ name: "Aggro" }) ?? "";

    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS - 1);
    expect(server.calls).toEqual([]);
    expect(store.getSnapshot().status.state).toBe("saving");

    await clock.advance(1);
    expect(server.calls.map((call) => `${call.op} ${call.id}`)).toEqual([`putDeck ${id}`]);
    expect(store.getSnapshot().status.state).toBe("saved");
    expect(store.getSnapshot().unsynced.has(id)).toBe(false);
  });

  it("R256 quick edits coalesce into one PUT carrying the last state", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS / 2);
    store.updateDeck(id, { cards: [fixtureCardId(1)] });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS / 2);
    store.updateDeck(id, { cards: [fixtureCardId(1), fixtureCardId(2)] });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);

    expect(server.calls).toHaveLength(1);
    expect(server.decks.get(id)?.cards).toEqual([fixtureCardId(1), fixtureCardId(2)]);
  });

  it("R256 the PUT sends the cleaned name, the cards and the catalog version", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const id = store.createDeck({ name: "  Big   Tempo  " }) ?? "";
    store.updateDeck(id, { cards: [fixtureCardId(3), fixtureCardId(1)] });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);

    expect(server.decks.get(id)).toEqual({
      name: "Big Tempo",
      cards: [fixtureCardId(3), fixtureCardId(1)],
      catalogVersion: CATALOG_VERSION,
    });
    // The field keeps what the player typed; only the save is cleaned.
    expect(store.getSnapshot().decks[0]?.name).toBe("  Big   Tempo  ");
  });

  it("R256 an edit that changes nothing sends nothing", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock, server: response([savedDeck("d1", "Aggro", [fixtureCardId(1)], 1)]) });
    store.updateDeck("d1", { name: "Aggro", cards: [fixtureCardId(1)] });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS * 2);
    expect(server.calls).toEqual([]);
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 an edit made while its PUT is in flight stays unsaved and goes again", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    const release = server.holdRequests();
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.calls).toHaveLength(1);

    store.updateDeck(id, { cards: [fixtureCardId(7)] });
    release();
    await settle();
    expect(store.getSnapshot().unsynced.has(id), "the confirmation was for the older revision").toBe(true);

    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get(id)?.cards).toEqual([fixtureCardId(7)]);
    expect(store.getSnapshot().unsynced.has(id)).toBe(false);
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 pagehide saves at once, without waiting for the debounce", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    store.start();
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    window.dispatchEvent(new Event("pagehide"));
    await settle();
    expect(server.calls.map((call) => call.id)).toEqual([id]);
  });

  it("R256 a page going hidden saves at once", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    store.start();
    store.createDeck({ name: "Aggro" });
    const visibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    try {
      document.dispatchEvent(new Event("visibilitychange"));
      await settle();
    } finally {
      if (visibility === undefined) Reflect.deleteProperty(document, "visibilityState");
      else Object.defineProperty(document, "visibilityState", visibility);
    }
    expect(server.calls).toHaveLength(1);
  });

  it("R256 createDeck and createTrio return null at the caps", () => {
    const server = fakeServer();
    const store = open({ api: server.api });
    for (let index = 0; index < MAX_SAVED_DECKS; index += 1) {
      expect(store.createDeck({ name: `Deck ${String(index)}` })).not.toBeNull();
    }
    expect(store.createDeck({ name: "One too many" })).toBeNull();
    expect(store.getSnapshot().decks).toHaveLength(MAX_SAVED_DECKS);
    for (let index = 0; index < MAX_SAVED_TRIOS; index += 1) {
      expect(store.createTrio({ name: `Trio ${String(index)}` })).not.toBeNull();
    }
    expect(store.createTrio({ name: "One too many" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Offline, and the next visit
// ---------------------------------------------------------------------------------------------

describe("offline", () => {
  it("R256 a failed transport shows offline, keeps the draft in the mirror, and a new visit restores and saves it", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const clock = manualClock();
    const first = open({
      api: server.api,
      clock,
      storage,
      server: response([savedDeck("d1", "Aggro", [fixtureCardId(1)], 1)]),
    });
    server.state.offline = true;
    first.updateDeck("d1", { name: "Aggro v2", cards: [fixtureCardId(1), fixtureCardId(2)] });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);

    expect(first.getSnapshot().status.state).toBe("offline");
    const mirrored = storage.data.get(mirrorKey(PROFILE)) ?? "";
    expect(mirrored).toContain("Aggro v2");

    // The tab closes. Next visit: the server still has the old copy, and is reachable again.
    first.stop();
    server.state.offline = false;
    server.calls.length = 0;
    const secondClock = manualClock();
    const second = open({
      api: server.api,
      clock: secondClock,
      storage,
      server: response([savedDeck("d1", "Aggro", [fixtureCardId(1)], 1)]),
    });
    expect(second.getSnapshot().decks[0]).toMatchObject({ name: "Aggro v2", cards: [fixtureCardId(1), fixtureCardId(2)] });
    expect(second.getSnapshot().unsynced.has("d1")).toBe(true);

    await secondClock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("d1")).toMatchObject({ name: "Aggro v2", cards: [fixtureCardId(1), fixtureCardId(2)] });
    expect(second.getSnapshot().status.state).toBe("saved");
  });

  it("R256 an offline save is tried again after the retry delay", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    server.state.offline = true;
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(store.getSnapshot().status.state).toBe("offline");

    server.state.offline = false;
    await clock.advance(RETRY_MS - 1);
    expect(server.decks.has(id)).toBe(false);
    await clock.advance(1);
    expect(server.decks.has(id)).toBe(true);
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 coming back online saves at once", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    store.start();
    server.state.offline = true;
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    server.state.offline = false;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(server.decks.has(id)).toBe(true);
  });

  it("R256 a deck made offline and never saved survives the next visit", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const clock = manualClock();
    const first = open({ api: server.api, clock, storage });
    server.state.offline = true;
    const id = first.createDeck({ name: "Made on the train", cards: [fixtureCardId(4)] }) ?? "";
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    first.stop();
    await settle();

    const second = open({ api: server.api, clock: manualClock(), storage });
    expect(second.getSnapshot().decks.map((deck) => deck.id)).toEqual([id]);
  });
});

// ---------------------------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------------------------

describe("merging the mirror over the server", () => {
  it("R256 a server item the mirror does not know is taken, and a clean local one the server lacks is dropped", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const clock = manualClock();
    const first = open({ api: server.api, clock, storage, server: response([savedDeck("gone", "Deleted elsewhere", [], 1)]) });
    expect(first.getSnapshot().decks.map((deck) => deck.id)).toEqual(["gone"]);
    first.stop();

    const second = open({
      api: server.api,
      clock: manualClock(),
      storage,
      server: response([savedDeck("new", "Made on another device", [fixtureCardId(9)], 2)]),
    });
    expect(second.getSnapshot().decks.map((deck) => deck.id)).toEqual(["new"]);
    expect(second.getSnapshot().status.state).toBe("saved");
  });

  it("R256 a malformed mirror is ignored", () => {
    const server = fakeServer();
    for (const raw of ["{", "null", "[]", '{"v":1,"decks":"nope"}', '{"v":99,"decks":[]}', '{"v":1,"decks":[{"item":{"id":7}}]}']) {
      const storage = memoryStorage();
      storage.setItem(mirrorKey(PROFILE), raw);
      const store = open({ api: server.api, storage, server: response([savedDeck("d1", "Aggro", [], 1)]) });
      expect(store.getSnapshot().decks.map((deck) => deck.id)).toEqual(["d1"]);
    }
  });

  it("R256 a mirror naming one unsaved deck or trio twice restores it once, and saves it once", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const deck = { id: "dup-deck", name: "Twice", cards: [fixtureCardId(3)], createdAt: 5, updatedAt: 5 };
    const trio = { id: "dup-trio", name: "Twice", deckIds: ["dup-deck", null, null], createdAt: 6, updatedAt: 6 };
    storage.setItem(
      mirrorKey(PROFILE),
      JSON.stringify({
        v: 1,
        decks: [
          { item: deck, dirty: true },
          { item: { ...deck, name: "Twice, again" }, dirty: true },
        ],
        trios: [
          { item: trio, dirty: true },
          { item: trio, dirty: true },
        ],
        deletedDecks: [],
        deletedTrios: [],
      }),
    );
    const clock = manualClock();
    const store = open({ api: server.api, clock, storage });
    // One of each: a list keyed by id cannot hold one id twice, and a second copy would be sent twice.
    expect(store.getSnapshot().decks.map((item) => item.id)).toEqual(["dup-deck"]);
    expect(store.getSnapshot().trios.map((item) => item.id)).toEqual(["dup-trio"]);
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.calls.filter((call) => call.op === "putDeck").map((call) => call.id)).toEqual(["dup-deck"]);
    expect(server.calls.filter((call) => call.op === "putTrio").map((call) => call.id)).toEqual(["dup-trio"]);
  });

  it("R256 a deletion made offline stays deleted on the next visit, and is sent", async () => {
    const server = fakeServer();
    const storage = memoryStorage();
    const clock = manualClock();
    const initial = response([savedDeck("d1", "Aggro", [], 1)]);
    const first = open({ api: server.api, clock, storage, server: initial });
    server.state.offline = true;
    first.deleteDeck("d1");
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    first.stop();
    await settle();

    server.state.offline = false;
    const secondClock = manualClock();
    const second = open({ api: server.api, clock: secondClock, storage, server: initial });
    expect(second.getSnapshot().decks).toEqual([]);
    await secondClock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.calls.some((call) => call.op === "deleteDeck" && call.id === "d1")).toBe(true);
  });

  it("R256 storage that throws on every access leaves a working store that still saves", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock, storage: brokenStorage() });
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    store.updateDeck(id, { cards: [fixtureCardId(1)] });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get(id)?.cards).toEqual([fixtureCardId(1)]);
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 browserStorage is null where reading localStorage throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get: () => {
        throw new Error("SecurityError");
      },
    });
    try {
      expect(browserStorage()).toBeNull();
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Deletes, trios and refusals
// ---------------------------------------------------------------------------------------------

describe("deletes and trios", () => {
  it("R256 a trio naming a new deck is sent after the deck has landed", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const deck = store.createDeck({ name: "Aggro" }) ?? "";
    const trio = store.createTrio({ name: "Ladder", deckIds: [deck, null, null] }) ?? "";
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);

    expect(server.calls.map((call) => `${call.op} ${call.id}`)).toEqual([`putDeck ${deck}`, `putTrio ${trio}`]);
    expect(server.trios.get(trio)?.deckIds).toEqual([deck, null, null]);
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 deleting a deck empties the trio slot naming it, and the DELETE goes after the PUTs", async () => {
    const server = fakeServer();
    for (const id of ["d1", "d2"]) server.decks.set(id, { name: id, cards: [], catalogVersion: CATALOG_VERSION });
    const clock = manualClock();
    const store = open({
      api: server.api,
      clock,
      server: response(
        [savedDeck("d1", "Aggro", [], 1), savedDeck("d2", "Control", [], 2)],
        [savedTrio("t1", "Ladder", ["d1", "d2", null], 3)],
      ),
    });
    store.deleteDeck("d1");
    expect(store.getSnapshot().decks.map((deck) => deck.id)).toEqual(["d2"]);
    expect(store.getSnapshot().trios[0]?.deckIds).toEqual([null, "d2", null]);

    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.calls.map((call) => `${call.op} ${call.id}`)).toEqual(["putTrio t1", "deleteDeck d1"]);
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 deleting a trio sends its DELETE", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock, server: response([], [savedTrio("t1", "Ladder", [null, null, null], 1)]) });
    store.deleteTrio("t1");
    expect(store.getSnapshot().trios).toEqual([]);
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.calls.map((call) => `${call.op} ${call.id}`)).toEqual(["deleteTrio t1"]);
  });

  it("R256 a trio refused for an unsaved deck waits for that deck, and lands once the deck does", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const deck = store.createDeck({ name: "Aggro" }) ?? "";
    const trio = store.createTrio({ name: "Ladder", deckIds: [null, deck, null] }) ?? "";
    server.state.refusals.set(deck, new ApiRequestError(400, { code: "bad_request", message: "That deck was refused." }));
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);

    expect(store.getSnapshot().refused.get(deck)).toBe("That deck was refused.");
    expect(store.getSnapshot().refused.has(trio), "waiting on its deck, not refused").toBe(false);
    expect(store.getSnapshot().unsynced.has(trio)).toBe(true);

    server.state.refusals.delete(deck);
    store.updateDeck(deck, { name: "Aggro, fixed" });
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.trios.get(trio)?.deckIds).toEqual([null, deck, null]);
    expect(store.getSnapshot().unsynced.size).toBe(0);
    expect(store.getSnapshot().status.state).toBe("saved");
  });
});

describe("refusals", () => {
  it("R256 a refusal shows the server's message, is not retried, and goes again once the deck is edited", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    const message = "You already have 10 decks. Delete one first.";
    server.state.refusals.set(id, new ApiRequestError(409, { code: "conflict", message, details: { limit: MAX_SAVED_DECKS } }));
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);

    expect(store.getSnapshot().status).toEqual({ state: "error", message });
    expect(store.getSnapshot().refused.get(id)).toBe(message);
    const sent = server.calls.length;
    await clock.advance(RETRY_MS * 3);
    expect(server.calls.length, "a refused body is not sent again unchanged").toBe(sent);

    server.state.refusals.delete(id);
    store.updateDeck(id, { name: "Aggro 2" });
    expect(store.getSnapshot().refused.has(id)).toBe(false);
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get(id)?.name).toBe("Aggro 2");
    expect(store.getSnapshot().status.state).toBe("saved");
  });

  it("R256 a server error is shown and tried again after the retry delay", async () => {
    const server = fakeServer();
    const clock = manualClock();
    const store = open({ api: server.api, clock });
    const id = store.createDeck({ name: "Aggro" }) ?? "";
    server.state.refusals.set(id, new ApiRequestError(503, { code: "unavailable", message: "The server is waking up." }));
    await clock.advance(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(store.getSnapshot().status).toEqual({ state: "error", message: "The server is waking up." });

    server.state.refusals.delete(id);
    await clock.advance(RETRY_MS);
    expect(server.decks.has(id)).toBe(true);
    expect(store.getSnapshot().status.state).toBe("saved");
  });
});

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

describe("the name a save sends", () => {
  it("R256 an empty or blank name saves as the fallback", () => {
    expect(deckNameForSave("", DECK_NAME_MAX_LENGTH)).toBe(UNTITLED_DECK);
    expect(deckNameForSave("   ", DECK_NAME_MAX_LENGTH)).toBe(UNTITLED_DECK);
    expect(trioNameForSave("", DECK_NAME_MAX_LENGTH)).toBe(UNTITLED_TRIO);
  });

  it("R256 whitespace is collapsed and trimmed", () => {
    expect(deckNameForSave("  Big \n  Tempo ", DECK_NAME_MAX_LENGTH)).toBe("Big Tempo");
  });

  it("R256 a long name is cut to the limit in characters, an emoji counting as one", () => {
    const long = "🂡".repeat(DECK_NAME_MAX_LENGTH + 5);
    const saved = deckNameForSave(long, DECK_NAME_MAX_LENGTH);
    expect([...saved]).toHaveLength(DECK_NAME_MAX_LENGTH);
    expect(deckNameForSave("x".repeat(DECK_NAME_MAX_LENGTH), DECK_NAME_MAX_LENGTH)).toHaveLength(DECK_NAME_MAX_LENGTH);
  });

  it("R256 a name with a control character saves as the fallback", () => {
    expect(deckNameForSave("Aggro\u0007", DECK_NAME_MAX_LENGTH)).toBe(UNTITLED_DECK);
    expect(trioNameForSave("Ladder\u0000", DECK_NAME_MAX_LENGTH)).toBe(UNTITLED_TRIO);
  });
});
