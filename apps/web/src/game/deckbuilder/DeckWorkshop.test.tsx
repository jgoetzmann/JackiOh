// The deck workshop (SPEC §9.4, R250–R256): the list of decks and trios, making, renaming, filling
// and deleting a deck, comparing it with other decks (R251), the trio editor and its verdict
// (R252, R253), import and copy of deck codes (R255), and the autosave the player sees (R256).
//
// The pool browser, the filters and the tiles are browse.test.tsx's; the store's own rules are
// sync.test.ts's. Every validator sentence here is computed with the validator, never typed
// (messages.test.ts fails any client source that spells one out).

import type { CardDef } from "@jackioh/shared";
import { validateDeck, validateTrio, type Collection } from "@jackioh/validator";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DECK_AUTOSAVE_DEBOUNCE_MS, MAX_SAVED_DECKS, MAX_SAVED_TRIOS } from "../../../../server/src/config.ts";
import { ApiRequestError, type SavedDeck, type SavedTrio } from "../../net/api.ts";
import { DECK_COMPLETE_SAVED } from "./DeckEditor.tsx";
import { decodeDeckCode, encodeDeckCode } from "./deckCode.ts";
import { DECK_SIZE } from "./deckSize.ts";
import DeckWorkshop, { syncWords, type WorkshopOpen } from "./DeckWorkshop.tsx";
import { TOKEN_ID, fixtureCardId, fixtureCardName, fixtureCatalog, fixtureCollection, legalDecks } from "./fixtures.ts";
import { droppedLines } from "./ImportPanel.tsx";
import { OFFLINE_MESSAGE, UNTITLED_DECK, mirrorKey } from "./sync.ts";
import {
  TEST_PROFILE,
  decksResponse,
  fakeDeckServer,
  manualClock,
  memoryStorage,
  savedDeck,
  savedTrio,
} from "./testkit.ts";
import {
  DECK_CAP,
  DECK_CAP_REASON,
  DECK_CODE_OUTPUT,
  DECK_COMPARE_SELECT,
  DECK_CONFLICTS,
  DECK_COPY_CODE,
  DECK_COUNT,
  DECK_DELETE,
  DECK_DELETE_CANCEL,
  DECK_DELETE_CONFIRM,
  DECK_EDITOR,
  DECK_IMPORT,
  DECK_IMPORT_CAP_REASON,
  DECK_IMPORT_INPUT,
  DECK_IMPORT_OPEN,
  DECK_IMPORT_PREVIEW,
  DECK_IMPORT_SUBMIT,
  DECK_NAME_INPUT,
  DECK_NEW,
  DECK_SAVE_ERROR,
  DECK_STATUS,
  DECK_VERDICT,
  SYNC_STATUS,
  TRIO_CAP_REASON,
  TRIO_COMPARE,
  TRIO_DELETE,
  TRIO_DELETE_CONFIRM,
  TRIO_EDITOR,
  TRIO_NAME_INPUT,
  TRIO_NEW,
  TRIO_VERDICT,
  WORKSHOP,
  WORKSHOP_BACK,
  addPoolId,
  deckCardId,
  deckCompareChipId,
  deckRowId,
  loadoutErrorId,
  poolCardId,
  trioCardId,
  trioOpenDeckId,
  trioRowId,
  trioSlotId,
} from "./testids.ts";

const catalog = fixtureCatalog();
const collection = fixtureCollection();
const [ONE = [], TWO = [], THREE = []] = legalDecks();

type Mounted = {
  server: ReturnType<typeof fakeDeckServer>;
  storage: ReturnType<typeof memoryStorage>;
  /** Advances the store's clock by `ms` and lets every save it starts settle. */
  tick: (ms: number) => Promise<void>;
};

type MountOptions = {
  decks?: SavedDeck[];
  trios?: SavedTrio[];
  collection?: Collection | null;
  initialOpen?: WorkshopOpen;
  server?: ReturnType<typeof fakeDeckServer>;
  storage?: ReturnType<typeof memoryStorage>;
  catalogOverride?: typeof catalog;
};

function mount(options: MountOptions = {}): Mounted {
  const server = options.server ?? fakeDeckServer();
  const data = decksResponse(options.decks ?? [], options.trios ?? [], catalog.version);
  server.seed(data);
  const storage = options.storage ?? memoryStorage();
  const clock = manualClock();
  let minted = 0;
  render(
    <DeckWorkshop
      catalog={options.catalogOverride ?? catalog}
      collection={options.collection === undefined ? collection : options.collection}
      data={data}
      profileId={TEST_PROFILE}
      api={server.api}
      storage={storage}
      clock={clock}
      newId={() => {
        minted += 1;
        return `new-${String(minted)}`;
      }}
      {...(options.initialOpen === undefined ? {} : { initialOpen: options.initialOpen })}
    />,
  );
  return {
    server,
    storage,
    tick: async (ms) => {
      await act(async () => {
        await clock.advance(ms);
      });
    },
  };
}

function syncState(): string | null {
  return screen.getByTestId(SYNC_STATUS).getAttribute("data-state");
}

function nameOf(cardId: string): string {
  return catalog.cards[cardId]?.name ?? cardId;
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------------------------

describe("the rail", () => {
  it("R250 lists every saved deck with its count and status chip, and the caps", () => {
    mount({
      decks: [savedDeck("full", "Aggro", ONE, 1), savedDeck("part", "Tempo", TWO.slice(0, 7), 2)],
      trios: [savedTrio("t", "Ladder", ["full", null, null], 3)],
    });
    expect(screen.getByTestId(DECK_CAP)).toHaveTextContent(`2/${String(MAX_SAVED_DECKS)}`);
    const full = screen.getByTestId(deckRowId("full"));
    expect(full).toHaveAttribute("data-count", String(DECK_SIZE));
    expect(full).toHaveAttribute("data-status", "ready");
    expect(full).toHaveTextContent("Ready");
    const part = screen.getByTestId(deckRowId("part"));
    expect(part).toHaveAttribute("data-count", "7");
    expect(part).toHaveAttribute("data-status", "incomplete");
    expect(part).toHaveTextContent(`7/${String(DECK_SIZE)}`);
    expect(screen.getByTestId(trioRowId("t"))).toHaveAttribute("data-ready", "false");
    expect(syncState()).toBe("saved");
  });

  it("R250 a deck holding cards the player does not own says how many", () => {
    const missing: Record<string, number> = { ...collection };
    delete missing[ONE[0] ?? ""];
    mount({ decks: [savedDeck("full", "Aggro", ONE, 1)], collection: missing });
    const row = screen.getByTestId(deckRowId("full"));
    expect(row).toHaveAttribute("data-status", "unowned");
    expect(row).toHaveTextContent("1 not owned");
  });

  it("R250 New deck is off at the cap and says why; New trio likewise", () => {
    const decks = Array.from({ length: MAX_SAVED_DECKS }, (_unused, index) => savedDeck(`d${String(index)}`, `Deck ${String(index)}`, [], index));
    const trios = Array.from({ length: MAX_SAVED_TRIOS }, (_unused, index) => savedTrio(`t${String(index)}`, `Trio ${String(index)}`, [null, null, null], index));
    mount({ decks, trios });
    expect(screen.getByTestId(DECK_NEW)).toBeDisabled();
    expect(screen.getByTestId(DECK_CAP_REASON)).toHaveTextContent(String(MAX_SAVED_DECKS));
    expect(screen.getByTestId(DECK_NEW)).toHaveAttribute("aria-describedby", screen.getByTestId(DECK_CAP_REASON).id);
    expect(screen.getByTestId(TRIO_NEW)).toBeDisabled();
    expect(screen.getByTestId(TRIO_CAP_REASON)).toHaveTextContent(String(MAX_SAVED_TRIOS));
  });

  it("a phone shows the list first, an opened deck next, and the way back", () => {
    mount({ decks: [savedDeck("a", "Aggro", ONE.slice(0, 3), 1)] });
    const root = screen.getByTestId(WORKSHOP);
    expect(root).toHaveAttribute("data-view", "list");
    fireEvent.click(screen.getByTestId(deckRowId("a")));
    expect(root).toHaveAttribute("data-view", "editor");
    expect(screen.getByTestId(deckRowId("a"))).toHaveAttribute("aria-current", "true");
    fireEvent.click(screen.getByTestId(WORKSHOP_BACK));
    expect(root).toHaveAttribute("data-view", "list");
  });
});

// ---------------------------------------------------------------------------------------------
// Making and editing a deck
// ---------------------------------------------------------------------------------------------

describe("a deck", () => {
  it("R256 New deck makes a named deck, opens it, and saves it after the debounce", async () => {
    const { server, tick } = mount();
    fireEvent.click(screen.getByTestId(DECK_NEW));
    const editor = screen.getByTestId(DECK_EDITOR);
    expect(editor).toHaveAttribute("data-deck", "new-1");
    expect(screen.getByTestId(DECK_NAME_INPUT)).toHaveValue("Deck 1");
    expect(screen.getByTestId(deckRowId("new-1"))).toHaveAttribute("data-unsynced", "true");
    expect(syncState()).toBe("saving");
    expect(screen.getByTestId(SYNC_STATUS)).toHaveTextContent(syncWords({ state: "saving", message: null }));

    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("new-1")).toMatchObject({ name: "Deck 1", cards: [] });
    expect(syncState()).toBe("saved");
    expect(screen.getByTestId(deckRowId("new-1"))).not.toHaveAttribute("data-unsynced");
  });

  it("R256 renaming saves the new name; an emptied name saves as Untitled deck and settles there on blur", async () => {
    const { server, tick } = mount({ decks: [savedDeck("a", "Aggro", [], 1)], initialOpen: { kind: "deck", id: "a" } });
    const input = screen.getByTestId(DECK_NAME_INPUT);
    fireEvent.change(input, { target: { value: "Big Tempo" } });
    expect(screen.getByTestId(deckRowId("a"))).toHaveTextContent("Big Tempo");
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("a")?.name).toBe("Big Tempo");

    fireEvent.change(input, { target: { value: "   " } });
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("a")?.name).toBe(UNTITLED_DECK);
    fireEvent.blur(input);
    expect(input).toHaveValue(UNTITLED_DECK);
  });

  it("R250 cards added and taken out move the deck's count and its row", async () => {
    const { server, tick } = mount({ decks: [savedDeck("a", "Aggro", [], 1)], initialOpen: { kind: "deck", id: "a" } });
    fireEvent.click(screen.getByTestId(addPoolId(fixtureCardId(1))));
    fireEvent.click(screen.getByTestId(addPoolId(fixtureCardId(2))));
    expect(screen.getByTestId(DECK_COUNT)).toHaveAttribute("data-count", "2");
    expect(screen.getByTestId(deckRowId("a"))).toHaveAttribute("data-count", "2");
    fireEvent.click(screen.getByTestId(deckCardId(fixtureCardId(1))));
    expect(screen.getByTestId(DECK_COUNT)).toHaveAttribute("data-count", "1");
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("a")?.cards).toEqual([fixtureCardId(2)]);
  });

  it("R250 a full deck takes no more, and says so", () => {
    mount({ decks: [savedDeck("a", "Aggro", ONE, 1)], initialOpen: { kind: "deck", id: "a" } });
    const spare = TWO[0] ?? "";
    fireEvent.click(screen.getByTestId(addPoolId(spare)));
    expect(screen.getByTestId(DECK_COUNT)).toHaveAttribute("data-count", String(DECK_SIZE));
    expect(screen.queryByTestId(deckCardId(spare))).toBeNull();
    expect(screen.getByTestId(DECK_STATUS)).toHaveTextContent(`Aggro has ${String(DECK_SIZE)} cards`);
  });

  it("R253 the verdict is validateDeck's list, verbatim, under 'Before you can queue this deck'", () => {
    const cards = ONE.slice(0, 4);
    mount({ decks: [savedDeck("a", "Aggro", cards, 1)], initialOpen: { kind: "deck", id: "a" } });
    const verdict = screen.getByTestId(DECK_VERDICT);
    expect(verdict).toHaveAttribute("data-ready", "false");
    expect(verdict).toHaveTextContent("Before you can queue this deck");
    const want = validateDeck({ deck: { name: "Aggro", cards }, catalog, collection });
    const messages = want.ok ? [] : want.errors.map((issue) => issue.message);
    expect(messages.length).toBeGreaterThan(0);
    expect(within(verdict).getAllByTestId(loadoutErrorId("L2")).map((node) => node.textContent)).toEqual(messages);
    expect(within(verdict).getByTestId(loadoutErrorId("L2"))).toHaveAttribute("data-rule", "L2");
  });

  it("R256 the twentieth card saves at once and says 'Deck complete — saved' once the server has it", async () => {
    const { server } = mount({ decks: [savedDeck("a", "Aggro", ONE.slice(0, DECK_SIZE - 1), 1)], initialOpen: { kind: "deck", id: "a" } });
    const last = ONE[DECK_SIZE - 1] ?? "";
    await act(async () => {
      fireEvent.click(screen.getByTestId(addPoolId(last)));
      await Promise.resolve();
    });
    // No debounce: completing a deck saves at once.
    await act(async () => {
      for (let turn = 0; turn < 50; turn += 1) await Promise.resolve();
    });
    expect(server.decks.get("a")?.cards).toHaveLength(DECK_SIZE);
    expect(screen.getByTestId(DECK_STATUS)).toHaveTextContent(DECK_COMPLETE_SAVED);
    expect(screen.getByTestId(DECK_VERDICT)).toHaveAttribute("data-ready", "true");
  });

  it("R250 Delete asks first; Keep it keeps the deck, Delete removes it and sends the DELETE", async () => {
    const { server, tick } = mount({
      decks: [savedDeck("a", "Aggro", [], 1), savedDeck("b", "Brawl", [], 2)],
      initialOpen: { kind: "deck", id: "a" },
    });
    fireEvent.click(screen.getByTestId(DECK_DELETE));
    expect(screen.getByTestId(DECK_DELETE_CANCEL)).toHaveFocus();
    fireEvent.click(screen.getByTestId(DECK_DELETE_CANCEL));
    expect(screen.getByTestId(deckRowId("a"))).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(DECK_DELETE));
    fireEvent.click(screen.getByTestId(DECK_DELETE_CONFIRM));
    expect(screen.queryByTestId(deckRowId("a"))).toBeNull();
    expect(screen.getByTestId(DECK_EDITOR)).toHaveAttribute("data-deck", "b");
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.calls.some((call) => call.op === "deleteDeck" && call.id === "a")).toBe(true);
    expect(server.decks.has("a")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Comparing (R251)
// ---------------------------------------------------------------------------------------------

describe("comparing a deck with others (R251)", () => {
  const clash = TWO[0] ?? "";

  it("R251 cards a compared deck holds are unavailable in the pool, marked 'In <deck name>', and adding one is refused naming it", () => {
    mount({
      decks: [savedDeck("a", "Aggro", ONE.slice(0, 3), 1), savedDeck("c", "Control", TWO, 2)],
      initialOpen: { kind: "deck", id: "a" },
    });
    const before = screen.getByTestId(poolCardId(clash));
    expect(before).not.toHaveAttribute("data-unavailable");

    fireEvent.change(screen.getByTestId(DECK_COMPARE_SELECT), { target: { value: "deck:c" } });
    expect(screen.getByTestId(deckCompareChipId("c"))).toHaveTextContent("Control");
    const held = screen.getByTestId(poolCardId(clash));
    expect(held).toHaveAttribute("data-unavailable", "true");
    expect(held).toHaveAttribute("data-held-by", "Control");
    expect(held).toHaveAttribute("data-legal", "false");
    expect(held.querySelector(".db-held")).toHaveTextContent("In Control");
    // A card no compared deck holds is untouched.
    expect(screen.getByTestId(poolCardId(THREE[0] ?? ""))).not.toHaveAttribute("data-unavailable");

    fireEvent.click(screen.getByTestId(addPoolId(clash)));
    expect(screen.queryByTestId(deckCardId(clash))).toBeNull();
    expect(screen.getByTestId(DECK_STATUS)).toHaveTextContent(`${nameOf(clash)} is in Control.`);
    expect(held).toHaveAttribute("data-refused", "true");

    // Stopping the comparison makes it available again.
    fireEvent.click(screen.getByTestId(deckCompareChipId("c")));
    expect(screen.getByTestId(poolCardId(clash))).not.toHaveAttribute("data-unavailable");
    fireEvent.click(screen.getByTestId(addPoolId(clash)));
    expect(screen.getByTestId(deckCardId(clash))).toBeInTheDocument();
  });

  it("R251 picking a trio the deck is in compares it with that trio's other two decks", () => {
    mount({
      decks: [savedDeck("a", "Aggro", ONE.slice(0, 3), 1), savedDeck("c", "Control", TWO, 2), savedDeck("m", "Midrange", THREE, 3)],
      trios: [savedTrio("t", "Ladder", ["a", "c", "m"], 4)],
      initialOpen: { kind: "deck", id: "a" },
    });
    fireEvent.change(screen.getByTestId(DECK_COMPARE_SELECT), { target: { value: "trio:t" } });
    expect(screen.getByTestId(deckCompareChipId("c"))).toBeInTheDocument();
    expect(screen.getByTestId(deckCompareChipId("m"))).toBeInTheDocument();
    expect(screen.getByTestId(poolCardId(TWO[3] ?? ""))).toHaveAttribute("data-held-by", "Control");
    expect(screen.getByTestId(poolCardId(THREE[3] ?? ""))).toHaveAttribute("data-held-by", "Midrange");

    fireEvent.change(screen.getByTestId(DECK_COMPARE_SELECT), { target: { value: "none" } });
    expect(screen.queryByTestId(deckCompareChipId("c"))).toBeNull();
    expect(screen.getByTestId(poolCardId(TWO[3] ?? ""))).not.toHaveAttribute("data-unavailable");
  });

  it("R251 a clash that already exists is shown on the tile and counted, never taken out", () => {
    mount({
      decks: [savedDeck("a", "Aggro", [...ONE.slice(0, 3), clash], 1), savedDeck("c", "Control", TWO, 2)],
      initialOpen: { kind: "deck", id: "a" },
    });
    fireEvent.change(screen.getByTestId(DECK_COMPARE_SELECT), { target: { value: "deck:c" } });
    const tile = screen.getByTestId(deckCardId(clash));
    expect(tile).toHaveAttribute("data-conflict", "true");
    expect(tile).toHaveAttribute("data-conflict-with", "Control");
    expect(screen.getByTestId(deckCardId(ONE[0] ?? ""))).not.toHaveAttribute("data-conflict");
    expect(screen.getByTestId(DECK_CONFLICTS)).toHaveAttribute("data-count", "1");
    expect(screen.getByTestId(DECK_COUNT)).toHaveAttribute("data-count", "4");
  });
});

// ---------------------------------------------------------------------------------------------
// Trios (R252, R253)
// ---------------------------------------------------------------------------------------------

describe("a trio", () => {
  const full = [savedDeck("a", "Aggro", ONE, 1), savedDeck("c", "Control", TWO, 2), savedDeck("m", "Midrange", THREE, 3)];

  it("R253 three full decks with no card in common are Ready for Best of 3", () => {
    mount({ decks: full, trios: [savedTrio("t", "Ladder", ["a", "c", "m"], 4)], initialOpen: { kind: "trio", id: "t" } });
    const verdict = screen.getByTestId(TRIO_VERDICT);
    expect(verdict).toHaveAttribute("data-ready", "true");
    expect(verdict).toHaveTextContent("Ready for Best of 3");
    expect(screen.getByTestId(trioRowId("t"))).toHaveAttribute("data-ready", "true");
    expect(screen.getByTestId(trioCardId(1, ONE[0] ?? ""))).toHaveAttribute("data-conflict", "false");
  });

  it("R252 a trio with an empty slot is saved, and its verdict is the validator's L1, verbatim", async () => {
    const { server, tick } = mount({ decks: full, initialOpen: null });
    fireEvent.click(screen.getByTestId(TRIO_NEW));
    expect(screen.getByTestId(TRIO_EDITOR)).toHaveAttribute("data-trio", "new-1");
    expect(screen.getByTestId(TRIO_NAME_INPUT)).toHaveValue("Trio 1");
    fireEvent.change(screen.getByTestId(trioSlotId(1)), { target: { value: "a" } });
    fireEvent.change(screen.getByTestId(trioSlotId(3)), { target: { value: "m" } });

    const verdict = screen.getByTestId(TRIO_VERDICT);
    expect(verdict).toHaveAttribute("data-ready", "false");
    const want = validateTrio({
      decks: [
        { name: "Aggro", cards: ONE },
        { name: "Midrange", cards: THREE },
      ],
      catalog,
      collection,
    });
    const l1 = want.ok ? [] : want.errors.filter((issue) => issue.rule === "L1").map((issue) => issue.message);
    expect(l1).toHaveLength(1);
    expect(within(verdict).getAllByTestId(loadoutErrorId("L1")).map((node) => node.textContent)).toEqual(l1);

    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.trios.get("new-1")).toEqual({ name: "Trio 1", deckIds: ["a", null, "m"] });
  });

  it("R251 R252 decks that share a card are saved but not ready: the shared card is marked on both sides, and L4 names both decks", () => {
    const shared = TWO[0] ?? "";
    const clashing = [savedDeck("a", "Aggro", [...ONE.slice(1), shared], 1), full[1] as SavedDeck, full[2] as SavedDeck];
    mount({ decks: clashing, trios: [savedTrio("t", "Ladder", ["a", "c", "m"], 4)], initialOpen: { kind: "trio", id: "t" } });

    const compare = screen.getByTestId(TRIO_COMPARE);
    const inAggro = within(compare).getByTestId(trioCardId(1, shared));
    const inControl = within(compare).getByTestId(trioCardId(2, shared));
    expect(inAggro).toHaveAttribute("data-conflict", "true");
    expect(inAggro).toHaveAttribute("data-conflict-with", "Control");
    expect(inControl).toHaveAttribute("data-conflict", "true");
    expect(inControl).toHaveAttribute("data-conflict-with", "Aggro");
    expect(inAggro.parentElement).toHaveTextContent("Also in Control");
    expect(within(compare).getByTestId(trioCardId(3, THREE[0] ?? ""))).toHaveAttribute("data-conflict", "false");

    const verdict = screen.getByTestId(TRIO_VERDICT);
    expect(verdict).toHaveAttribute("data-ready", "false");
    const want = validateTrio({
      decks: [
        { name: "Aggro", cards: clashing[0]?.cards ?? [] },
        { name: "Control", cards: TWO },
        { name: "Midrange", cards: THREE },
      ],
      catalog,
      collection,
    });
    const l4 = want.ok ? [] : want.errors.filter((issue) => issue.rule === "L4").map((issue) => issue.message);
    expect(l4).toHaveLength(1);
    expect(within(verdict).getAllByTestId(loadoutErrorId("L4")).map((node) => node.textContent)).toEqual(l4);
    expect(screen.getByTestId(trioRowId("t"))).toHaveAttribute("data-ready", "false");
  });

  it("R252 a slot cannot pick a deck another slot holds", () => {
    mount({ decks: full, trios: [savedTrio("t", "Ladder", ["a", null, null], 4)], initialOpen: { kind: "trio", id: "t" } });
    const second = screen.getByTestId(trioSlotId(2));
    const option = within(second).getByRole("option", { name: /Aggro/ });
    expect(option).toBeDisabled();
    expect(within(second).getByRole("option", { name: "Control" })).toBeEnabled();
  });

  it("R252 deleting a deck empties the trio slot that named it", async () => {
    const { server, tick } = mount({ decks: full, trios: [savedTrio("t", "Ladder", ["a", "c", "m"], 4)], initialOpen: { kind: "trio", id: "t" } });
    fireEvent.click(screen.getByTestId(trioOpenDeckId(2)));
    expect(screen.getByTestId(DECK_EDITOR)).toHaveAttribute("data-deck", "c");
    fireEvent.click(screen.getByTestId(DECK_DELETE));
    fireEvent.click(screen.getByTestId(DECK_DELETE_CONFIRM));
    fireEvent.click(screen.getByTestId(trioRowId("t")));
    expect(screen.getByTestId(trioSlotId(2))).toHaveValue("");
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.trios.get("t")?.deckIds).toEqual(["a", null, "m"]);
  });

  it("R252 Delete trio asks first, then removes only the trio", async () => {
    const { server, tick } = mount({ decks: full, trios: [savedTrio("t", "Ladder", ["a", "c", "m"], 4)], initialOpen: { kind: "trio", id: "t" } });
    fireEvent.click(screen.getByTestId(TRIO_DELETE));
    fireEvent.click(screen.getByTestId(TRIO_DELETE_CONFIRM));
    expect(screen.queryByTestId(trioRowId("t"))).toBeNull();
    expect(screen.getByTestId(deckRowId("a"))).toBeInTheDocument();
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.trios.has("t")).toBe(false);
    expect(server.decks.has("a")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Deck codes (R255)
// ---------------------------------------------------------------------------------------------

describe("deck codes (R255)", () => {
  function stubClipboard(writeText: (text: string) => Promise<void>): void {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, "clipboard");
  });

  it("R255 Copy code puts the code on the clipboard and in the read-only field, and it reads back as the deck", async () => {
    const writeText = vi.fn(async () => {});
    stubClipboard(writeText);
    mount({ decks: [savedDeck("a", "Aggro", ONE.slice(0, 6), 1)], initialOpen: { kind: "deck", id: "a" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId(DECK_COPY_CODE));
      await Promise.resolve();
    });
    const output = screen.getByTestId(DECK_CODE_OUTPUT);
    expect(output).toHaveAttribute("readonly");
    const code = (output as HTMLInputElement).value;
    expect(writeText).toHaveBeenCalledWith(code);
    const decoded = decodeDeckCode(code, catalog, collection);
    expect(decoded.ok && decoded.name).toBe("Aggro");
    expect(decoded.ok && decoded.cards).toEqual(ONE.slice(0, 6));
    expect(screen.getByTestId(DECK_STATUS)).toHaveTextContent("Code copied");
  });

  it("R255 with no clipboard the code is still shown to copy by hand", () => {
    mount({ decks: [savedDeck("a", "Aggro", ONE.slice(0, 2), 1)], initialOpen: { kind: "deck", id: "a" } });
    fireEvent.click(screen.getByTestId(DECK_COPY_CODE));
    expect((screen.getByTestId(DECK_CODE_OUTPUT) as HTMLInputElement).value).toBe(encodeDeckCode("Aggro", ONE.slice(0, 2), catalog));
    expect(screen.getByTestId(DECK_STATUS)).toHaveTextContent("Copy the code below");
  });

  it("R255 an import previews the code and makes a NEW deck from it, which is saved", async () => {
    const { server, tick } = mount({ decks: [savedDeck("a", "Aggro", ONE, 1)], initialOpen: { kind: "deck", id: "a" } });
    const code = encodeDeckCode("Shared list", TWO.slice(0, 5), catalog);
    fireEvent.click(screen.getByTestId(DECK_IMPORT_OPEN));
    expect(screen.getByTestId(DECK_IMPORT)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId(DECK_IMPORT_INPUT), { target: { value: `  ${code.slice(0, 10)}\n${code.slice(10)}  ` } });
    const preview = screen.getByTestId(DECK_IMPORT_PREVIEW);
    expect(preview).toHaveAttribute("data-ok", "true");
    expect(preview).toHaveTextContent("Shared list");
    expect(preview).toHaveTextContent(`5/${String(DECK_SIZE)}`);

    fireEvent.click(screen.getByTestId(DECK_IMPORT_SUBMIT));
    expect(screen.getByTestId(DECK_EDITOR)).toHaveAttribute("data-deck", "new-1");
    expect(screen.getByTestId(DECK_NAME_INPUT)).toHaveValue("Shared list");
    expect(screen.getByTestId(deckRowId("a")), "the deck that was open is untouched").toHaveAttribute("data-count", String(DECK_SIZE));
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("new-1")).toMatchObject({ name: "Shared list", cards: TWO.slice(0, 5) });
  });

  it("R255 the preview says what was left out and which kept cards are not owned", () => {
    const extra: CardDef = { ...(catalog.cards[fixtureCardId(1)] as CardDef), id: "core-999", index: "999", name: "From the future" };
    const newer = { ...catalog, cards: { ...catalog.cards, [extra.id]: extra } };
    const code = encodeDeckCode("Mixed", [fixtureCardId(1), extra.id, fixtureCardId(2)], newer);
    const missing: Record<string, number> = { ...collection };
    delete missing[fixtureCardId(2)];
    mount({ collection: missing, initialOpen: { kind: "import" } });
    fireEvent.change(screen.getByTestId(DECK_IMPORT_INPUT), { target: { value: code } });
    const preview = screen.getByTestId(DECK_IMPORT_PREVIEW);
    expect(preview).toHaveAttribute("data-ok", "true");
    expect(preview).toHaveTextContent(`2/${String(DECK_SIZE)}`);
    expect(preview).toHaveTextContent("#999");
    expect(preview).toHaveTextContent(fixtureCardName(2));
  });

  it("R255 the preview names every kind of card an import leaves out", () => {
    const lines = droppedLines(
      {
        unknown: [101, 140],
        tokens: [TOKEN_ID],
        duplicates: [fixtureCardId(1), fixtureCardId(1)],
        overflow: [fixtureCardId(2), fixtureCardId(3)],
      },
      catalog,
    );
    expect(lines).toHaveLength(4);
    expect(lines[0]).toContain("#101, #140");
    expect(lines[1]).toContain(nameOf(TOKEN_ID));
    expect(lines[2]).toContain("2 extra copies");
    expect(lines[2]).toContain(fixtureCardName(1));
    expect(lines[3]).toContain(`2 cards past the ${String(DECK_SIZE)}`);
    expect(droppedLines({ unknown: [], tokens: [], duplicates: [], overflow: [] }, catalog)).toEqual([]);
  });

  it("R255 a code that cannot be read shows the decoder's own sentence and imports nothing", () => {
    mount({ initialOpen: { kind: "import" } });
    fireEvent.change(screen.getByTestId(DECK_IMPORT_INPUT), { target: { value: "hello there" } });
    const decoded = decodeDeckCode("hello there", catalog, collection);
    expect(decoded.ok).toBe(false);
    const preview = screen.getByTestId(DECK_IMPORT_PREVIEW);
    expect(preview).toHaveAttribute("data-ok", "false");
    expect(preview).toHaveTextContent(decoded.ok ? "" : decoded.message);
    expect(screen.getByTestId(DECK_IMPORT_SUBMIT)).toBeDisabled();
  });

  it("R255 at the deck cap the import is off, with the reason beside it", () => {
    const decks = Array.from({ length: MAX_SAVED_DECKS }, (_unused, index) => savedDeck(`d${String(index)}`, `Deck ${String(index)}`, [], index));
    mount({ decks, initialOpen: { kind: "import" } });
    fireEvent.change(screen.getByTestId(DECK_IMPORT_INPUT), { target: { value: encodeDeckCode("One more", ONE.slice(0, 2), catalog) } });
    expect(screen.getByTestId(DECK_IMPORT_PREVIEW)).toHaveAttribute("data-ok", "true");
    expect(screen.getByTestId(DECK_IMPORT_SUBMIT)).toBeDisabled();
    expect(screen.getByTestId(DECK_IMPORT_CAP_REASON)).toHaveTextContent(String(MAX_SAVED_DECKS));
  });
});

// ---------------------------------------------------------------------------------------------
// The save status (R256)
// ---------------------------------------------------------------------------------------------

describe("the save status (R256)", () => {
  it("R256 offline, the edit is kept on this device, and the next visit restores it and saves it", async () => {
    const server = fakeDeckServer();
    const storage = memoryStorage();
    const decks = [savedDeck("a", "Aggro", ONE.slice(0, 2), 1)];
    server.state.offline = true;
    const first = mount({ decks, server, storage, initialOpen: { kind: "deck", id: "a" } });
    fireEvent.click(screen.getByTestId(addPoolId(ONE[5] ?? "")));
    await first.tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(syncState()).toBe("offline");
    expect(screen.getByTestId(SYNC_STATUS)).toHaveTextContent(syncWords({ state: "offline", message: OFFLINE_MESSAGE }));
    expect(storage.data.get(mirrorKey(TEST_PROFILE))).toContain(ONE[5] ?? "");
    cleanup();

    // The next visit: the server still has the old copy, and is reachable again.
    server.state.offline = false;
    const second = mount({ decks, server, storage, initialOpen: { kind: "deck", id: "a" } });
    expect(screen.getByTestId(DECK_COUNT)).toHaveAttribute("data-count", "3");
    expect(screen.getByTestId(deckRowId("a"))).toHaveAttribute("data-unsynced", "true");
    await second.tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(server.decks.get("a")?.cards).toEqual([...ONE.slice(0, 2), ONE[5]]);
    expect(syncState()).toBe("saved");
  });

  it("R256 a refusal shows the server's message in the status line and on the deck", async () => {
    const server = fakeDeckServer();
    const message = "This page is out of date. Reload it to keep building.";
    server.state.refusals.set("a", new ApiRequestError(409, { code: "update_required", message }));
    const { tick } = mount({ decks: [savedDeck("a", "Aggro", [], 1)], server, initialOpen: { kind: "deck", id: "a" } });
    fireEvent.change(screen.getByTestId(DECK_NAME_INPUT), { target: { value: "Aggro 2" } });
    await tick(DECK_AUTOSAVE_DEBOUNCE_MS);
    expect(syncState()).toBe("error");
    expect(screen.getByTestId(SYNC_STATUS)).toHaveTextContent(message);
    expect(screen.getByTestId(DECK_SAVE_ERROR)).toHaveTextContent(message);
  });

  it("R256 the status line is a polite live region", () => {
    mount();
    const status = screen.getByTestId(SYNC_STATUS);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
  });
});
