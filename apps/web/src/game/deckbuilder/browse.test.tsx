// Polish 6, slice D: browsing and building on the new deck builder screen (docs/polish/6-cards.md,
// B30–B38; the pure half of the filter and sort rules is filters.test.ts, and the pixel half of
// the layout is e2e/cypress/component/deckbuilder-layout.cy.tsx).
//
// Most tests mount `Deckbuilder` on a small inline catalog built to make each rule visible. The
// fixtures in ./fixtures.ts are used only where the existing contract is the point (every testid
// on a legal loadout, and what `save` receives).
//
// Every validator sentence is computed with `validateLoadout`, never typed: messages.test.ts fails
// any client source, tests included, that spells one out.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { CardCost, CardDef, CardFace, CardType, Rarity, Tag } from "@jackioh/shared";
import { validateLoadout, type CatalogSnapshot, type Collection } from "@jackioh/validator";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  CARD_SETTINGS_DEFAULTS,
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE_BASE,
  INSPECT_HOVER,
  INSPECT_SHEET,
  closeInspect,
  writeCardSettings,
} from "../../cards/index.ts";
// The barrel re-exports the inspect testids but not the timing constants; this is the file the
// Surface names for them.
import { HOVER_DELAY_MS, LONG_PRESS_MS } from "../../cards/inspect/constants.ts";
import Deckbuilder, { DECK_STATUS_MS } from "./Deckbuilder.tsx";
import { DECK_SIZE } from "./deckSize.ts";
import { COST_BUCKETS, FILTER_RARITIES, FILTER_TAGS, FILTER_TYPES, deckListOrder, manaCurve, type SortKey } from "./filters.ts";
import { fixtureCatalog, fixtureCollection, legalDecks } from "./fixtures.ts";
import {
  DB_DETAIL_ADD,
  DB_EMPTY,
  DB_FILTER_CLEAR,
  DB_FILTER_OWNED,
  DB_FILTERS,
  DB_RESULT_COUNT,
  DB_SEARCH,
  DB_SIDEBAR,
  DB_SORT,
  DB_SORT_DIR,
  deckCurveId,
  filterCostId,
  filterRarityId,
  filterTagId,
  filterTypeId,
  addPoolId,
  DB_DECK_STATUS,
} from "./testids.ts";

// ---------------------------------------------------------------------------------------------
// The inline catalog (the same shape as filters.test.ts's, restated so each file stands alone)
// ---------------------------------------------------------------------------------------------

type DefInput = {
  id: string;
  index: string;
  name: string;
  type: CardType;
  rarity: Rarity;
  cost: CardCost;
  tags?: Tag[];
  token?: boolean;
  base?: Partial<CardFace>;
  radiant?: Partial<CardFace>;
};

function def(input: DefInput): CardDef {
  return {
    id: input.id,
    index: input.index,
    name: input.name,
    set: "Core",
    type: input.type,
    tags: input.tags ?? [],
    rarity: input.rarity,
    token: input.token ?? false,
    cost: input.cost,
    base: { keywords: [], text: "", ...input.base },
    radiant: { keywords: [], text: "", ...input.radiant },
  };
}

const DEFS: CardDef[] = [
  def({ id: "x-01", index: "1", name: "Acorn Scout", type: "Unit", tags: ["Human"], rarity: "Common", cost: 0,
    base: { attack: 1, health: 1 }, radiant: { attack: 20, health: 20 } }),
  def({ id: "x-02", index: "2", name: "Bramble Cat", type: "Unit", tags: ["Felinor"], rarity: "Rare", cost: 1,
    base: { attack: 2, health: 3, keywords: [{ kind: "Taunt" }], text: "Taunt" },
    radiant: { attack: 4, health: 6, keywords: [{ kind: "Taunt" }, { kind: "Lifesteal" }], text: "Plus Lifesteal" } }),
  def({ id: "x-03", index: "3", name: "Cinder Wave", type: "Spell", tags: ["Call to Chaos"], rarity: "Epic", cost: 6,
    base: { text: "Deal 3 damage to every unit" }, radiant: { text: "Deal 6 damage to every unit" } }),
  def({ id: "x-04", index: "4", name: "Deep Void", type: "Unit", rarity: "Mythic", cost: 100,
    base: { attack: 10, health: 10, text: "Cry: exile every other permanent" },
    radiant: { attack: 10, health: 10, keywords: [{ kind: "Charge" }], text: "Plus Charge" } }),
  def({ id: "x-05", index: "5", name: "Echo Market", type: "Field Spell", tags: ["Fruit"], rarity: "Legendary", cost: "X",
    base: { text: "Draw X cards" }, radiant: { text: "Draw X cards, then gain a Banana" } }),
  def({ id: "x-06", index: "6", name: "Fuse Box", type: "Trap", tags: ["KY"], rarity: "Common", cost: { base: 2, embiggen: 4 },
    base: { text: "When an enemy attacks: deal 2 (paid 4: deal 5)" }, radiant: { text: "Deal 4 (paid 4: deal 10)" } }),
  def({ id: "x-07", index: "7", name: "Grove Ward", type: "Field Trap", tags: ["CN", "Human"], rarity: "Rare",
    cost: { base: 3, embiggen: 5 },
    base: { text: "Your units have Lifesteal" }, radiant: { text: "Your units have Lifesteal and Rush" } }),
  def({ id: "x-08", index: "8", name: "Hollow Squire", type: "Unit", tags: ["Quickdraw"], rarity: "Epic", cost: 3,
    base: { attack: 5, health: 2, keywords: [{ kind: "Rush" }], text: "Rush" },
    radiant: { attack: 10, health: 4, keywords: [{ kind: "Charge" }], text: "Charge" } }),
  def({ id: "x-09", index: "9", name: "Iron Sentry", type: "Unit", tags: ["Human"], rarity: "Common", cost: 2,
    base: { attack: 0, health: 8, keywords: [{ kind: "Armor", n: 2 }], text: "Armor 2" },
    radiant: { attack: 0, health: 16, keywords: [{ kind: "Armor", n: 4 }], text: "Armor 4" } }),
  def({ id: "x-10", index: "100", name: "Mirror Twin", type: "Unit", rarity: "Common", cost: 4,
    base: { attack: 4, health: 4, text: "Reflects light" },
    radiant: { attack: 8, health: 8, keywords: [{ kind: "Divine Shield" }], text: "Reflects more light" } }),
  def({ id: "x-11", index: "12", name: "mirror twin", type: "Unit", rarity: "Common", cost: 4,
    base: { attack: 4, health: 4, keywords: [{ kind: "Poisonous" }], text: "Reflects light" },
    radiant: { attack: 8, health: 8, text: "Reflects more light" } }),
  def({ id: "x-t1", index: "T-1", name: "Sprout Token", type: "Unit", tags: ["Token"], rarity: "Token", token: true, cost: 1,
    base: { attack: 1, health: 1 }, radiant: { attack: 2, health: 2 } }),
];

const SNAPSHOT: CatalogSnapshot = {
  version: "polish-6-browse",
  cards: Object.fromEntries(DEFS.map((d) => [d.id, d])),
};

const UNOWNED = "x-09";
const TOKEN = "x-t1";

/** Everything but x-09, the token included. */
const COLLECTION: Collection = Object.fromEntries(DEFS.filter((d) => d.id !== UNOWNED).map((d) => [d.id, 1]));

const NON_TOKEN_IDS: readonly string[] = DEFS.filter((d) => !d.token).map((d) => d.id);

/** Hand-worked orders over every non-token card; see filters.test.ts for the reasoning. */
const SORTED: Record<SortKey, { asc: string[]; desc: string[] }> = {
  cost: {
    asc: ["x-01", "x-02", "x-06", "x-09", "x-07", "x-08", "x-11", "x-10", "x-03", "x-04", "x-05"],
    desc: ["x-05", "x-04", "x-03", "x-11", "x-10", "x-07", "x-08", "x-06", "x-09", "x-02", "x-01"],
  },
  name: {
    asc: ["x-01", "x-02", "x-03", "x-04", "x-05", "x-06", "x-07", "x-08", "x-09", "x-11", "x-10"],
    desc: ["x-11", "x-10", "x-09", "x-08", "x-07", "x-06", "x-05", "x-04", "x-03", "x-02", "x-01"],
  },
  rarity: {
    asc: ["x-01", "x-06", "x-09", "x-11", "x-10", "x-02", "x-07", "x-08", "x-03", "x-05", "x-04"],
    desc: ["x-04", "x-05", "x-08", "x-03", "x-02", "x-07", "x-01", "x-06", "x-09", "x-11", "x-10"],
  },
  attack: {
    asc: ["x-09", "x-01", "x-02", "x-11", "x-10", "x-08", "x-04", "x-06", "x-07", "x-03", "x-05"],
    desc: ["x-04", "x-08", "x-11", "x-10", "x-02", "x-01", "x-09", "x-06", "x-07", "x-03", "x-05"],
  },
  health: {
    asc: ["x-01", "x-08", "x-02", "x-11", "x-10", "x-09", "x-04", "x-06", "x-07", "x-03", "x-05"],
    desc: ["x-04", "x-09", "x-11", "x-10", "x-02", "x-08", "x-01", "x-06", "x-07", "x-03", "x-05"],
  },
  type: {
    asc: ["x-01", "x-02", "x-09", "x-08", "x-11", "x-10", "x-04", "x-03", "x-05", "x-06", "x-07"],
    desc: ["x-07", "x-06", "x-05", "x-03", "x-01", "x-02", "x-09", "x-08", "x-11", "x-10", "x-04"],
  },
};

function owned(ids: readonly string[]): string[] {
  return ids.filter((id) => id !== UNOWNED);
}

const DEFAULT_ORDER = owned(SORTED.cost.asc);

function card(id: string): CardDef {
  const found = SNAPSHOT.cards[id];
  if (found === undefined) throw new Error(`inline catalog has no ${id}`);
  return found;
}

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

type Decks = readonly (readonly string[])[];

const EMPTY: Decks = [[], [], []];

function mount(decks: Decks | null = EMPTY, collection: Collection | null = COLLECTION) {
  const save = vi.fn().mockResolvedValue({ ok: true });
  render(<Deckbuilder catalog={SNAPSHOT} collection={collection} initialDecks={decks} save={save} />);
  return save;
}

/** The pool's cards, in DOM order. */
function poolOrder(): string[] {
  const pool = screen.getByTestId("card-pool");
  return Array.from(pool.querySelectorAll<HTMLElement>(".db-item")).map((item) => item.getAttribute("data-card") ?? "");
}

function poolCard(id: string): HTMLElement {
  return screen.getByTestId(`card-pool-${id}`);
}

function tileOrder(deck: number): string[] {
  const list = screen.getByTestId(`deck-list-${String(deck)}`);
  return Array.from(list.querySelectorAll<HTMLElement>(".db-tile")).map((tile) => tile.getAttribute("data-card") ?? "");
}

function expectCount(n: number): void {
  expect(poolOrder()).toHaveLength(n);
  expect(screen.getByTestId(DB_RESULT_COUNT)).toHaveAttribute("data-count", String(n));
}

function search(query: string): void {
  fireEvent.change(screen.getByTestId(DB_SEARCH), { target: { value: query } });
}

function sortBy(key: SortKey, dir: "asc" | "desc"): void {
  fireEvent.change(screen.getByTestId(DB_SORT), { target: { value: key } });
  const toggle = screen.getByTestId(DB_SORT_DIR);
  if (toggle.getAttribute("data-dir") !== dir) fireEvent.click(toggle);
  expect(toggle).toHaveAttribute("data-dir", dir);
}

function curve(deck: number): { bucket: string | null; count: number }[] {
  const root = screen.getByTestId(deckCurveId(deck));
  return Array.from(root.querySelectorAll<HTMLElement>(".db-bar")).map((bar) => ({
    bucket: bar.getAttribute("data-bucket"),
    count: Number(bar.getAttribute("data-count")),
  }));
}

function shownL5(): string[] {
  return screen.queryAllByTestId("loadout-error-L5").map((node) => node.textContent ?? "");
}

function openInspectOverlays(): string[] {
  return [INSPECT_HOVER, INSPECT_SHEET, INSPECT_DETAIL].flatMap((id) => screen.queryAllByTestId(id).map(() => id));
}

function detailName(): string {
  const base = within(screen.getByTestId(INSPECT_DETAIL)).getByTestId(INSPECT_FACE_BASE);
  return base.querySelector(".card-name")?.textContent ?? "";
}

/** Keeps `pointerType` on synthetic pointer events if the window's PointerEvent would drop it. */
function ensurePointerEvent(): void {
  const win = document.defaultView;
  if (win === null) return;
  const probe = typeof win.PointerEvent === "function" ? new win.PointerEvent("pointerdown", { pointerType: "touch" }) : null;
  if (probe !== null && probe.pointerType === "touch") return;

  class TestPointerEvent extends win.MouseEvent {
    readonly pointerType: string;
    readonly pointerId: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "";
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  for (const target of [win, globalThis]) {
    Object.defineProperty(target, "PointerEvent", { value: TestPointerEvent, configurable: true, writable: true });
  }
}

function pointer(pointerType: "mouse" | "touch"): PointerEventInit {
  return { pointerType, clientX: 40, clientY: 40, pointerId: 1, isPrimary: true, button: 0 };
}

/** A contextmenu as Chrome sends it. Returns false when the native menu was prevented. */
function contextMenu(element: Element, pointerType: "mouse" | "touch"): boolean {
  const win = document.defaultView;
  if (win === null) throw new Error("jsdom has a window");
  return fireEvent(
    element,
    new win.PointerEvent("contextmenu", { bubbles: true, cancelable: true, pointerType, button: 2, clientX: 40, clientY: 40 }),
  );
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));

beforeAll(() => {
  ensurePointerEvent();
});

afterEach(() => {
  act(() => {
    closeInspect();
  });
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  writeCardSettings(CARD_SETTINGS_DEFAULTS);
});

// ---------------------------------------------------------------------------------------------
// B30: the pool
// ---------------------------------------------------------------------------------------------

describe("the pool grid (B30)", () => {
  it("B30 the pool is a grid of div.db-item, each with the card-pool button holding the base CardFace and a sibling db-add button", () => {
    mount();
    const pool = screen.getByTestId("card-pool");
    const items = Array.from(pool.querySelectorAll<HTMLElement>(".db-item"));
    expect(items.map((item) => item.tagName)).toEqual(DEFAULT_ORDER.map(() => "DIV"));

    for (const item of items) {
      const id = item.getAttribute("data-card") ?? "";
      const def = card(id);
      const button = within(item).getByTestId(`card-pool-${id}`);
      expect(button.tagName, id).toBe("BUTTON");
      expect(button).toHaveClass("db-card");
      expect(button).toHaveAttribute("data-card", id);
      // The card, not only its name: cost, type and rarity, then what a click does.
      const label = button.getAttribute("aria-label") ?? "";
      expect(label.startsWith(`${def.name}, `), id).toBe(true);
      expect(label, id).toContain(def.type);
      expect(label, id).toContain(def.rarity);
      expect(label.endsWith("Show details"), id).toBe(true);

      const face = button.querySelector(".cf");
      expect(face, `${id} has a CardFace`).not.toBeNull();
      expect(face).toHaveAttribute("data-layout", "full");
      expect(face).not.toHaveAttribute("data-radiant-face");
      expect(face?.querySelector(".card-name")).toHaveTextContent(def.name);

      const add = within(item).getByTestId(addPoolId(id));
      expect(add.tagName).toBe("BUTTON");
      expect(add).toHaveClass("db-add");
      expect(add).toHaveAttribute("aria-label", `Add ${def.name} to Deck 1`);
      expect(button.contains(add), "a sibling, never a button inside a button").toBe(false);
    }
  });

  it("B35 the deck sidebar comes before the browse column in the DOM, as the phone draws it first", () => {
    mount();
    const sidebar = screen.getByTestId(DB_SIDEBAR);
    const pool = screen.getByTestId("card-pool");
    // Focus and reading order follow the DOM: the tabs and the deck list before 100 pool cards.
    expect(sidebar.compareDocumentPosition(pool) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const css = readFileSync(join(HERE, "deckbuilder.css"), "utf8");
    // The desktop grid still puts the sidebar on the right by area name, whatever the DOM order.
    expect(css).toMatch(/grid-template-areas:\s*"browse sidebar"/);
  });

  it("B30 a token is never offered, even one the collection lists", () => {
    mount();
    expect(COLLECTION[TOKEN]).toBe(1);
    expect(screen.queryByTestId(`card-pool-${TOKEN}`)).toBeNull();
    expect(poolOrder()).not.toContain(TOKEN);
  });

  it("B30 the existing testids and data attributes hold on the fixture loadout", () => {
    const decks = legalDecks();
    render(
      <Deckbuilder
        catalog={fixtureCatalog()}
        collection={fixtureCollection()}
        initialDecks={decks}
        save={vi.fn().mockResolvedValue({ ok: true })}
      />,
    );
    expect(screen.getByTestId("deckbuilder")).toBeInTheDocument();
    for (const [index, deck] of decks.entries()) {
      const n = String(index + 1);
      expect(screen.getByTestId(`deck-tab-${n}`)).toBeInTheDocument();
      expect(screen.getByTestId(`deck-count-${n}`)).toHaveAttribute("data-count", String(DECK_SIZE));
      expect(screen.getByTestId(`deck-drop-${n}`)).toBeInTheDocument();
      expect(screen.getByTestId(`deck-list-${n}`)).toBeInTheDocument();
      for (const id of deck) {
        expect(screen.getByTestId(`deck-card-${n}-${id}`)).toHaveAttribute("data-card", id);
        expect(screen.getByTestId(`deck-${n}-card-${id}`)).toBeInTheDocument();
        expect(screen.getByTestId(`card-pool-${id}`)).toHaveAttribute("data-in-deck", n);
        expect(screen.getByTestId(`card-pool-${id}`)).toHaveAttribute("data-legal", "false");
      }
    }
    expect(screen.getByTestId("loadout-save")).toBeInTheDocument();
    expect(screen.getByTestId("loadout-errors")).toHaveAttribute("data-count", "0");
  });

  it("B30 deckbuilder.css declares nothing sticky or fixed that takes the pointer, so Cypress can reach every target", () => {
    const css = readFileSync(join(HERE, "deckbuilder.css"), "utf8");
    expect(css).not.toMatch(/position\s*:\s*sticky/);
    // The one fixed element is the status toast, and it is blind to the pointer, so
    // elementFromPoint (what Cypress asks before a click) never returns it.
    const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
    const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
      selector: (match[1] ?? "").trim(),
      body: match[2] ?? "",
    }));
    const fixed = rules.filter((rule) => /position\s*:\s*fixed/.test(rule.body));
    expect(fixed.map((rule) => rule.selector)).toEqual([".db-deck-status"]);
    for (const rule of fixed) expect(rule.body).toMatch(/pointer-events\s*:\s*none/);
  });

  it("B35 a deck tile's focus ring is drawn inside the tile, where the scrolling list cannot clip it", () => {
    // The list scrolls (overflow-y: auto clips both axes) and its tiles fill its width, so a ring
    // outside the tile was cut to a hairline top and bottom.
    const css = readFileSync(join(HERE, "deckbuilder.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const focus = /\.db-tile:focus-visible\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(focus).toMatch(/outline\s*:/);
    const offset = /outline-offset\s*:\s*(-?\d+(?:\.\d+)?)px/.exec(focus)?.[1];
    expect(offset, "outline-offset").toBeDefined();
    expect(Number(offset) + 2, "a 2px ring sits wholly inside the tile").toBeLessThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------------------------
// B31: filters
// ---------------------------------------------------------------------------------------------

describe("filtering (B31)", () => {
  it("B31 every cost, type, tag and rarity chip is a toggle button with aria-pressed, inside db-filters", () => {
    mount();
    const filters = screen.getByTestId(DB_FILTERS);
    const ids = [
      ...COST_BUCKETS.map(filterCostId),
      ...FILTER_TYPES.map(filterTypeId),
      ...FILTER_TAGS.map(filterTagId),
      ...FILTER_RARITIES.map(filterRarityId),
    ];
    expect(ids).toHaveLength(8 + 5 + 7 + 5);
    for (const id of ids) {
      const chip = within(filters).getByTestId(id);
      expect(chip.tagName, id).toBe("BUTTON");
      expect(chip, id).toHaveAttribute("aria-pressed", "false");
    }

    const chip = within(filters).getByTestId(filterCostId("6+"));
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(chip);
    expect(chip).toHaveAttribute("aria-pressed", "false");
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
  });

  it("B31 db-filters holds the search, the owned checkbox, the sort, the clear button and the count", () => {
    mount();
    const filters = screen.getByTestId(DB_FILTERS);
    for (const id of [DB_SEARCH, DB_FILTER_OWNED, DB_SORT, DB_SORT_DIR, DB_FILTER_CLEAR, DB_RESULT_COUNT]) {
      expect(within(filters).getByTestId(id), id).toBeInTheDocument();
    }
  });

  it("B31 the count matches the pool from the start", () => {
    mount();
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
    expectCount(DEFAULT_ORDER.length);
    expect(screen.queryByTestId(DB_EMPTY)).toBeNull();
  });

  it("B31 the 6+ chip shows the 6-cost and the 100-cost card", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("6+")));
    expect(poolOrder()).toEqual(["x-03", "x-04"]);
    expectCount(2);
  });

  it("B31 the X chip shows only the X card", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("X")));
    expect(poolOrder()).toEqual(["x-05"]);
    expectCount(1);
  });

  it("B31 an embiggen card is under its base price, not its embiggen price", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("2")));
    expect(poolOrder()).toEqual(["x-06"]);
    fireEvent.click(screen.getByTestId(filterCostId("2")));
    fireEvent.click(screen.getByTestId(filterCostId("4")));
    expect(poolOrder()).toEqual(["x-11", "x-10"]);
  });

  it("B31 chips in one group OR together", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("0")));
    fireEvent.click(screen.getByTestId(filterCostId("1")));
    expect(poolOrder()).toEqual(["x-01", "x-02"]);
    expectCount(2);
  });

  it("B31 groups AND together", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("3")));
    fireEvent.click(screen.getByTestId(filterTypeId("Unit")));
    expect(poolOrder()).toEqual(["x-08"]);

    fireEvent.click(screen.getByTestId(DB_FILTER_CLEAR));
    fireEvent.click(screen.getByTestId(filterTagId("Human")));
    fireEvent.click(screen.getByTestId(filterRarityId("Rare")));
    expect(poolOrder()).toEqual(["x-07"]);
  });

  it("B31 the Trap chip leaves Field Traps out", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterTypeId("Trap")));
    expect(poolOrder()).toEqual(["x-06"]);
  });

  it("B31 a filter nothing passes empties the pool, shows db-empty and counts 0", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("5")));
    expect(poolOrder()).toEqual([]);
    expect(screen.getByTestId(DB_EMPTY)).toBeInTheDocument();
    expect(screen.getByTestId(DB_RESULT_COUNT)).toHaveAttribute("data-count", "0");
  });

  it("B31 groups that share no card empty the pool", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterTypeId("Spell")));
    fireEvent.click(screen.getByTestId(filterRarityId("Mythic")));
    expectCount(0);
    expect(screen.getByTestId(DB_EMPTY)).toBeInTheDocument();
  });

  it("B31 db-filter-clear restores the default filter", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("6+")));
    fireEvent.click(screen.getByTestId(filterTagId("Call to Chaos")));
    search("cinder");
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(poolOrder()).toEqual(["x-03"]);

    fireEvent.click(screen.getByTestId(DB_FILTER_CLEAR));
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
    expect(screen.getByTestId(filterCostId("6+"))).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId(filterTagId("Call to Chaos"))).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId(DB_SEARCH)).toHaveValue("");
    expect(screen.getByTestId(DB_FILTER_OWNED)).toBeChecked();
    expect(screen.queryByTestId(DB_EMPTY)).toBeNull();
  });

  it("B31 filters and sort start from the defaults on every mount: nothing is persisted", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("6+")));
    sortBy("name", "desc");
    cleanup();

    mount();
    expect(screen.getByTestId(filterCostId("6+"))).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId(DB_SORT)).toHaveValue("cost");
    expect(screen.getByTestId(DB_SORT_DIR)).toHaveAttribute("data-dir", "asc");
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
  });
});

// ---------------------------------------------------------------------------------------------
// B32: search
// ---------------------------------------------------------------------------------------------

describe("searching (B32)", () => {
  it("B32 every term must occur: 'field trap' finds the Field Trap only", () => {
    mount();
    search("field trap");
    expect(poolOrder()).toEqual(["x-07"]);
    expectCount(1);
  });

  it("B32 the search ignores case", () => {
    mount();
    search("BRAMBLE");
    expect(poolOrder()).toEqual(["x-02"]);
  });

  it("B32 finds a word only the radiant text has", () => {
    mount();
    search("banana");
    expect(poolOrder()).toEqual(["x-05"]);
  });

  it("B32 finds a printed keyword kind the text never names", () => {
    mount();
    search("divine");
    expect(poolOrder()).toEqual(["x-10"]);
    search("poisonous");
    expect(poolOrder()).toEqual(["x-11"]);
  });

  it("B32 finds tags and rarities", () => {
    mount();
    search("felinor");
    expect(poolOrder()).toEqual(["x-02"]);
    search("legendary");
    expect(poolOrder()).toEqual(["x-05"]);
  });

  it("B32 surrounding and repeated whitespace does not matter", () => {
    mount();
    search("   cat    rare  ");
    expect(poolOrder()).toEqual(["x-02"]);
  });

  it("B32 a query nothing matches shows db-empty", () => {
    mount();
    search("zzz");
    expectCount(0);
    expect(screen.getByTestId(DB_EMPTY)).toBeInTheDocument();
  });

  it("B32 one unmatched term rules out a card the other terms match", () => {
    mount();
    search("bramble zzz");
    expectCount(0);
  });

  it("B32 clearing the search brings the pool back", () => {
    mount();
    search("zzz");
    search("");
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
  });
});

// ---------------------------------------------------------------------------------------------
// B33: owned
// ---------------------------------------------------------------------------------------------

describe("the owned filter (B33)", () => {
  it("B33 is checked by default and limits the pool to owned cards", () => {
    mount();
    const box = screen.getByTestId(DB_FILTER_OWNED);
    expect(box).toBeChecked();
    expect(box).toBeEnabled();
    expect(screen.queryByTestId(`card-pool-${UNOWNED}`)).toBeNull();
    for (const id of poolOrder()) expect(poolCard(id), id).toHaveAttribute("data-owned", "true");
  });

  it("B33 unchecked, it shows every non-token card and marks the unowned one data-owned=false", () => {
    mount();
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(screen.getByTestId(DB_FILTER_OWNED)).not.toBeChecked();
    expect(poolOrder()).toEqual(SORTED.cost.asc);
    expect(poolOrder()).toHaveLength(NON_TOKEN_IDS.length);
    expect(poolCard(UNOWNED)).toHaveAttribute("data-owned", "false");
    for (const id of owned(NON_TOKEN_IDS)) expect(poolCard(id), id).toHaveAttribute("data-owned", "true");
  });

  it("B33 the + still adds an unowned card, and the validator's L5 sentence appears", () => {
    mount();
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(poolCard(UNOWNED).getAttribute("aria-label")).toContain("not in your collection");
    fireEvent.click(screen.getByTestId(addPoolId(UNOWNED)));
    expect(screen.getByTestId(`deck-card-1-${UNOWNED}`)).toBeInTheDocument();

    const verdict = validateLoadout({
      decks: [[UNOWNED], [], []].map((cards) => ({ cards })),
      catalog: SNAPSHOT,
      collection: COLLECTION,
    });
    const want = verdict.ok ? [] : verdict.errors.filter((e) => e.rule === "L5").map((e) => e.message);
    expect(want, "the draft really breaks L5").toHaveLength(1);
    expect(shownL5()).toEqual(want);
  });

  it("B33 with no collection the checkbox is disabled, every non-token card shows, and no data-owned is rendered", () => {
    mount(EMPTY, null);
    expect(screen.getByTestId(DB_FILTER_OWNED)).toBeDisabled();
    expect(poolOrder()).toEqual(SORTED.cost.asc);
    for (const id of NON_TOKEN_IDS) expect(poolCard(id), id).not.toHaveAttribute("data-owned");
  });

  it("B33 clicking the disabled checkbox changes nothing", () => {
    mount(EMPTY, null);
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(screen.getByTestId(DB_FILTER_OWNED)).toBeDisabled();
    expect(poolOrder()).toEqual(SORTED.cost.asc);
  });

  it("B33 turning the owned filter back on hides the unowned card again", () => {
    mount();
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(poolOrder()).toContain(UNOWNED);
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(screen.getByTestId(DB_FILTER_OWNED)).toBeChecked();
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
  });

  it("B33 a search for an unowned card finds it only once the owned filter is off", () => {
    mount();
    search("iron");
    expectCount(0);
    fireEvent.click(screen.getByTestId(DB_FILTER_OWNED));
    expect(poolOrder()).toEqual([UNOWNED]);
  });
});

// ---------------------------------------------------------------------------------------------
// B34: sorting
// ---------------------------------------------------------------------------------------------

describe("sorting (B34)", () => {
  it("B34 the default is cost ascending", () => {
    mount();
    expect(screen.getByTestId(DB_SORT)).toHaveValue("cost");
    expect(screen.getByTestId(DB_SORT_DIR)).toHaveAttribute("data-dir", "asc");
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
  });

  for (const key of ["cost", "name", "rarity", "attack", "health", "type"] as const) {
    for (const dir of ["asc", "desc"] as const) {
      it(`B34 orders the grid by ${key} ${dir}`, () => {
        mount();
        sortBy(key, dir);
        expect(poolOrder()).toEqual(owned(SORTED[key][dir]));
      });
    }
  }

  it("B34 the direction toggles back to ascending", () => {
    mount();
    const toggle = screen.getByTestId(DB_SORT_DIR);
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-dir", "desc");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("data-dir", "asc");
    expect(poolOrder()).toEqual(DEFAULT_ORDER);
  });

  it("B34 cards with no stats stay last when sorting by attack, in both directions", () => {
    mount();
    const statless = ["x-03", "x-05", "x-06", "x-07"];
    for (const dir of ["asc", "desc"] as const) {
      sortBy("attack", dir);
      expect([...poolOrder().slice(-statless.length)].sort(), dir).toEqual(statless);
    }
  });

  it("B34 sorting keeps the active filters", () => {
    mount();
    fireEvent.click(screen.getByTestId(filterCostId("3")));
    fireEvent.click(screen.getByTestId(filterCostId("4")));
    sortBy("name", "desc");
    expect(poolOrder()).toEqual(["x-11", "x-10", "x-08", "x-07"]);
  });
});

// ---------------------------------------------------------------------------------------------
// B35: the sidebar
// ---------------------------------------------------------------------------------------------

describe("the deck sidebar (B35)", () => {
  const HELD: Decks = [["x-01", "x-05"], ["x-02"], []];

  it("B35 db-sidebar holds the tabs, their n/20 counts and one panel per deck", () => {
    mount(HELD);
    const sidebar = screen.getByTestId(DB_SIDEBAR);
    for (const [index, deck] of HELD.entries()) {
      const n = String(index + 1);
      expect(within(sidebar).getByTestId(`deck-tab-${n}`)).toBeInTheDocument();
      const count = within(sidebar).getByTestId(`deck-count-${n}`);
      expect(count).toHaveAttribute("data-count", String(deck.length));
      expect(count).toHaveTextContent(`${String(deck.length)}/${String(DECK_SIZE)}`);
      const panel = within(sidebar).getByTestId(`deck-drop-${n}`);
      expect(panel).toHaveAttribute("role", "tabpanel");
      expect(panel).toHaveAttribute("data-deck", n);
    }
  });

  it("B35 only the active panel is visible; the others are hidden but mounted", () => {
    mount(HELD);
    const one = screen.getByTestId("deck-drop-1");
    const two = screen.getByTestId("deck-drop-2");
    const three = screen.getByTestId("deck-drop-3");
    expect(one).not.toHaveAttribute("hidden");
    expect(one).toHaveAttribute("data-active", "true");
    expect(one).toBeVisible();
    for (const panel of [two, three]) {
      expect(panel).toHaveAttribute("hidden");
      expect(panel).not.toHaveAttribute("data-active", "true");
      expect(panel).not.toBeVisible();
    }
    expect(within(two).getByTestId("deck-card-2-x-02"), "a hidden panel still holds its tiles").toBeInTheDocument();
  });

  it("B35 choosing a tab shows its panel and hides the one that was open", () => {
    mount(HELD);
    fireEvent.click(screen.getByTestId("deck-tab-2"));
    expect(screen.getByTestId("deck-drop-2")).not.toHaveAttribute("hidden");
    expect(screen.getByTestId("deck-drop-2")).toHaveAttribute("data-active", "true");
    expect(screen.getByTestId("deck-drop-1")).toHaveAttribute("hidden");
  });

  it("B35 deckbuilder.css keeps a hidden panel display: none", () => {
    const css = readFileSync(join(HERE, "deckbuilder.css"), "utf8");
    expect(css).toMatch(/\.db-deck\[hidden\][^{]*\{[^}]*display\s*:\s*none/);
  });

  it("B35 tiles are ordered by cost then name, each with a cost gem, the name, an art strip and a rarity pip", () => {
    const draft = ["x-05", "x-08", "x-01", "x-07", "x-02"];
    mount([draft, [], []]);
    expect(tileOrder(1)).toEqual(["x-01", "x-02", "x-07", "x-08", "x-05"]);

    for (const id of draft) {
      const def = card(id);
      const tile = screen.getByTestId(`deck-card-1-${id}`);
      expect(tile.tagName).toBe("BUTTON");
      expect(tile).toHaveClass("db-tile");
      expect(tile).toHaveAttribute("data-card", id);
      expect(tile).toHaveAttribute("data-rarity", def.rarity);
      expect(tile.querySelector(".db-tile-cost"), `${id} cost gem`).not.toBeNull();
      expect(tile.querySelector(".db-tile-name")).toHaveTextContent(def.name);
      expect(tile.querySelector(".db-tile-art .cf-art"), `${id} art strip`).toHaveClass("cf-art--strip");
      expect(tile.querySelector(".db-tile-pip")).toHaveAttribute("data-rarity", def.rarity);
    }
  });

  it("B35 a tile's cost gem shows the printed price: the number, X, or an embiggen card's base price", () => {
    // x-01 costs 0, x-04 costs 100, x-05 costs X, x-06 is "2 embiggen 4" and x-07 "3 embiggen 5".
    mount([["x-01", "x-04", "x-05", "x-06", "x-07"], [], []]);
    const gem = (id: string): string =>
      screen.getByTestId(`deck-card-1-${id}`).querySelector(".db-tile-cost")?.textContent ?? "";
    expect(gem("x-01")).toBe("0");
    expect(gem("x-04")).toBe("100");
    expect(gem("x-05")).toBe("X");
    expect(gem("x-06")).toBe("2");
    expect(gem("x-07")).toBe("3");
  });

  it("B35 a card another deck holds has no tile in this deck's list", () => {
    mount(HELD);
    const listOne = screen.getByTestId("deck-list-1");
    expect(within(listOne).queryByTestId("deck-card-1-x-02")).toBeNull();
    expect(tileOrder(1)).not.toContain("x-02");
    expect(tileOrder(2)).toEqual(["x-02"]);
  });

  it("B35 an empty deck shows no tiles", () => {
    mount(EMPTY);
    expect(tileOrder(1)).toEqual([]);
    expect(screen.getByTestId("deck-count-1")).toHaveTextContent(`0/${String(DECK_SIZE)}`);
  });

  it("B35 save still sends each deck in draft order, whatever order the tiles show", async () => {
    const catalog = fixtureCatalog();
    const decks = legalDecks();
    const first = [...(decks[0] ?? [])];
    // Whichever of the fixture order and its reverse is NOT already tile order.
    const draft = deckListOrder(first, catalog).join() === first.join() ? [...first].reverse() : first;
    expect(draft, "the premise: the draft is not in tile order").not.toEqual(deckListOrder(draft, catalog));
    const loadout = [draft, decks[1] ?? [], decks[2] ?? []];

    const save = vi.fn().mockResolvedValue({ ok: true });
    render(<Deckbuilder catalog={catalog} collection={fixtureCollection()} initialDecks={loadout} save={save} />);
    expect(tileOrder(1)).toEqual(deckListOrder(draft, catalog));

    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(save).toHaveBeenCalledTimes(1);
    });
    expect(save.mock.calls[0]?.[0]).toEqual(loadout);
  });
});

// ---------------------------------------------------------------------------------------------
// B36: the mana curve
// ---------------------------------------------------------------------------------------------

describe("the mana curve (B36)", () => {
  const DECK = ["x-05", "x-08", "x-01", "x-07", "x-02", "x-04", "x-06"];

  it("B36 deck-curve-<n> has one bar per bucket, in order, counting the deck's cards", () => {
    mount([DECK, [], []]);
    const bars = curve(1);
    expect(bars.map((bar) => bar.bucket)).toEqual([...COST_BUCKETS]);
    expect(bars.map((bar) => bar.count)).toEqual([1, 1, 1, 2, 0, 0, 1, 1]);
    const pure = manaCurve(DECK, SNAPSHOT);
    expect(bars.map((bar) => bar.count)).toEqual(COST_BUCKETS.map((bucket) => pure[bucket]));
  });

  it("B36 an empty deck still has all eight bars, each at zero", () => {
    mount([DECK, [], []]);
    const bars = curve(2);
    expect(bars.map((bar) => bar.bucket)).toEqual([...COST_BUCKETS]);
    expect(bars.every((bar) => bar.count === 0)).toBe(true);
  });

  it("B36 a deck's curve never counts another deck's cards", () => {
    mount([["x-01"], ["x-03", "x-04", "x-05"], []]);
    expect(curve(1).map((bar) => bar.count)).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(curve(2).map((bar) => bar.count)).toEqual([0, 0, 0, 0, 0, 0, 2, 1]);
  });

  it("B36 the curve follows a card added and a card removed", () => {
    mount([DECK, [], []]);
    fireEvent.click(screen.getByTestId(addPoolId("x-03")));
    expect(curve(1).find((bar) => bar.bucket === "6+")?.count).toBe(2);
    fireEvent.click(screen.getByTestId("deck-card-1-x-01"));
    expect(curve(1).find((bar) => bar.bucket === "0")?.count).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// B37: held badges
// ---------------------------------------------------------------------------------------------

describe("held badges (B37)", () => {
  it("B37 a pool card any deck holds shows .db-held naming that deck, beside data-in-deck", () => {
    mount([["x-01"], ["x-02"], []]);
    expect(poolCard("x-01")).toHaveAttribute("data-in-deck", "1");
    expect(poolCard("x-01").querySelector(".db-held")).toHaveTextContent("Deck 1");
    expect(poolCard("x-02")).toHaveAttribute("data-in-deck", "2");
    expect(poolCard("x-02").querySelector(".db-held")).toHaveTextContent("Deck 2");
  });

  it("B37 a card no deck holds has no badge and no data-in-deck", () => {
    mount([["x-01"], ["x-02"], []]);
    expect(poolCard("x-06")).not.toHaveAttribute("data-in-deck");
    expect(poolCard("x-06").querySelector(".db-held")).toBeNull();
  });

  it("B37 the badge follows a card into a deck and out again", () => {
    mount();
    fireEvent.click(screen.getByTestId("deck-tab-3"));
    fireEvent.click(screen.getByTestId(addPoolId("x-06")));
    expect(poolCard("x-06").querySelector(".db-held")).toHaveTextContent("Deck 3");
    expect(poolCard("x-06").getAttribute("aria-label")).toContain("in Deck 3");
    fireEvent.click(screen.getByTestId("deck-card-3-x-06"));
    expect(poolCard("x-06").querySelector(".db-held")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B38: inspect in the builder
// ---------------------------------------------------------------------------------------------

describe("inspecting in the builder (B38)", () => {
  it("B38 a right-click on a pool card opens inspect-detail for it, prevents the menu and adds nothing", () => {
    mount();
    expect(contextMenu(poolCard("x-02"), "mouse")).toBe(false);
    expect(detailName()).toBe(card("x-02").name);
    expect(screen.queryByTestId("deck-card-1-x-02")).toBeNull();
  });

  it("B38 a click on a pool card opens inspect-detail for it and adds nothing (the brief: a click opens a detail view)", () => {
    mount();
    fireEvent.click(poolCard("x-08"));
    expect(openInspectOverlays()).toEqual([INSPECT_DETAIL]);
    expect(detailName()).toBe(card("x-08").name);
    expect(screen.queryByTestId("deck-card-1-x-08")).toBeNull();
  });

  it("B38 Enter or Space on a focused pool card opens its detail too (it is a button)", () => {
    mount();
    const target = poolCard("x-08");
    target.focus();
    // A button's keyboard activation is a click event in every browser; jsdom leaves that to us.
    fireEvent.click(target, { detail: 0 });
    expect(detailName()).toBe(card("x-08").name);
  });

  it("B38 a touch long-press on a pool card opens inspect-detail, not the sheet, and the click after it adds nothing", () => {
    vi.useFakeTimers();
    mount();
    const target = poolCard("x-02");
    fireEvent.pointerDown(target, pointer("touch"));
    advance(LONG_PRESS_MS);
    fireEvent.pointerUp(target, pointer("touch"));
    expect(openInspectOverlays()).toEqual([INSPECT_DETAIL]);
    expect(detailName()).toBe(card("x-02").name);

    fireEvent.click(target);
    expect(screen.queryByTestId("deck-card-1-x-02")).toBeNull();
  });

  it("B38 db-detail-add puts the card into the active deck", () => {
    mount();
    fireEvent.click(screen.getByTestId("deck-tab-3"));
    fireEvent.click(poolCard("x-01"));
    const add = screen.getByTestId(DB_DETAIL_ADD);
    expect(within(screen.getByTestId(INSPECT_DETAIL)).getByTestId(DB_DETAIL_ADD)).toBe(add);
    expect(add).toHaveTextContent("Add to Deck 3");
    expect(add).toBeEnabled();
    fireEvent.click(add);
    expect(screen.getByTestId("deck-card-3-x-01")).toBeInTheDocument();
  });

  it("B38 db-detail-add is disabled while another deck holds the card, and adds nothing", () => {
    mount([[], ["x-02"], []]);
    fireEvent.click(poolCard("x-02"));
    const add = screen.getByTestId(DB_DETAIL_ADD);
    expect(add).toBeDisabled();
    fireEvent.click(add);
    expect(screen.queryByTestId("deck-card-1-x-02")).toBeNull();
  });

  it("B38 db-detail-add is disabled while the active deck itself holds the card", () => {
    mount([["x-01"], [], []]);
    fireEvent.click(poolCard("x-01"));
    expect(screen.getByTestId(DB_DETAIL_ADD)).toBeDisabled();
  });

  it("B38 the + on a pool card adds it to the open deck and opens nothing", () => {
    mount();
    fireEvent.click(screen.getByTestId("deck-tab-2"));
    expect(screen.getByTestId(addPoolId("x-02"))).toHaveAttribute("aria-label", `Add ${card("x-02").name} to Deck 2`);
    fireEvent.click(screen.getByTestId(addPoolId("x-02")));
    expect(screen.getByTestId("deck-card-2-x-02")).toBeInTheDocument();
    expect(openInspectOverlays()).toEqual([]);
  });

  it("B38 the + on a card another deck holds is marked off and refused, as a drag is", () => {
    mount([["x-02"], [], []]);
    fireEvent.click(screen.getByTestId("deck-tab-2"));
    const add = screen.getByTestId(addPoolId("x-02"));
    expect(add).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(add);
    expect(screen.queryByTestId("deck-card-2-x-02")).toBeNull();
    expect(poolCard("x-02")).toHaveAttribute("data-refused", "true");
  });

  it("B38 resting a mouse on a pool card opens no hover preview", () => {
    vi.useFakeTimers();
    mount();
    fireEvent.pointerEnter(poolCard("x-02"), pointer("mouse"));
    advance(HOVER_DELAY_MS * 2);
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("B38 hovering a deck tile opens inspect-hover, and clicking the tile still removes the card", () => {
    vi.useFakeTimers();
    mount([["x-02"], [], []]);
    const tile = screen.getByTestId("deck-card-1-x-02");
    fireEvent.pointerEnter(tile, pointer("mouse"));
    advance(HOVER_DELAY_MS);
    const preview = screen.getByTestId(INSPECT_HOVER);
    expect(preview.querySelector(".card-name")).toHaveTextContent(card("x-02").name);

    fireEvent.pointerLeave(tile, pointer("mouse"));
    fireEvent.click(tile);
    expect(screen.queryByTestId("deck-card-1-x-02")).toBeNull();
    expect(poolCard("x-02")).not.toHaveAttribute("data-in-deck");
  });

  it("B38 inspect-close closes the detail", () => {
    mount();
    fireEvent.click(poolCard("x-02"));
    expect(screen.getByTestId(INSPECT_DETAIL)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(INSPECT_CLOSE));
    expect(screen.queryByTestId(INSPECT_DETAIL)).toBeNull();
  });

  it("B24 a touch long-press on a deck tile opens the sheet, and the click after it does not remove the card", () => {
    vi.useFakeTimers();
    mount([["x-02"], [], []]);
    const tile = screen.getByTestId("deck-card-1-x-02");
    fireEvent.pointerDown(tile, pointer("touch"));
    advance(LONG_PRESS_MS);
    fireEvent.pointerUp(tile, pointer("touch"));
    expect(openInspectOverlays()).toEqual([INSPECT_SHEET]);

    fireEvent.click(tile);
    expect(screen.getByTestId("deck-card-1-x-02"), "the swallowed click removed nothing").toBeInTheDocument();
  });

  it("B38 a deck tile says a click removes the card, and a right-click or the I key opens its detail", () => {
    mount([["x-02"], [], []]);
    const tile = screen.getByTestId("deck-card-1-x-02");
    expect(tile).toHaveAttribute("aria-label", `Remove ${card("x-02").name} from Deck 1`);
    expect(tile).toHaveAttribute("aria-keyshortcuts", "I");

    expect(contextMenu(tile, "mouse")).toBe(false);
    expect(detailName()).toBe(card("x-02").name);
    fireEvent.click(screen.getByTestId(INSPECT_CLOSE));
    expect(screen.queryByTestId(INSPECT_DETAIL)).toBeNull();

    for (const key of [{ key: "i" }, { key: "ContextMenu" }, { key: "F10", shiftKey: true }]) {
      fireEvent.keyDown(tile, key);
      expect(detailName(), key.key).toBe(card("x-02").name);
      fireEvent.click(screen.getByTestId(INSPECT_CLOSE));
    }
    // None of them removed the card; only a click does.
    expect(screen.getByTestId("deck-card-1-x-02")).toBeInTheDocument();
  });

  it("B24 contextmenu during a touch press on a pool card is prevented", () => {
    vi.useFakeTimers();
    mount();
    const target = poolCard("x-02");
    fireEvent.pointerDown(target, pointer("touch"));
    expect(contextMenu(target, "touch")).toBe(false);
    fireEvent.pointerUp(target, pointer("touch"));
  });
});

// ---------------------------------------------------------------------------------------------
// The status toast: what the last add or removal did, where a phone deep in the pool can see it
// ---------------------------------------------------------------------------------------------

describe("the deck status line", () => {
  it("names each add and removal with the deck's count, is polite, and clears after DECK_STATUS_MS", () => {
    vi.useFakeTimers();
    mount([["x-01"], [], []]);
    const status = screen.getByTestId(DB_DECK_STATUS);
    expect(status).toHaveAttribute("role", "status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("");

    fireEvent.click(screen.getByTestId(addPoolId("x-02")));
    expect(status).toHaveTextContent(`${card("x-02").name} added to Deck 1 · 2/20`);

    fireEvent.click(screen.getByTestId("deck-card-1-x-01"));
    expect(status).toHaveTextContent(`${card("x-01").name} removed from Deck 1 · 1/20`);

    advance(DECK_STATUS_MS);
    expect(status).toHaveTextContent("");
  });

  it("says which deck already holds a card a + could not add", () => {
    mount([[], ["x-02"], []]);
    fireEvent.click(screen.getByTestId(addPoolId("x-02")));
    expect(screen.getByTestId(DB_DECK_STATUS)).toHaveTextContent(`${card("x-02").name} is already in Deck 2`);
  });
});
