// QA for patch v0.2.0's client items (issue #40, phase 1): one place where each cosmetic item the
// issue asked for is rendered once, from fixture views, and its visible essentials are asserted, so
// a regression of any of them fails here by item number as well as in the item's own suite.
//
//    1  a dealt deck's unknown cards are backs (R433)            7  the turn clock's last 30 s (R439, R506)
//    2  the short Cry and Tribute reminders (R500)               8  "(N) Cost" / "costs (N)" (R432)
//    3  the effects speed slider, 0.25x to 3x (R435)             9  no queue count in Find a match (R505)
//    4  keyword visuals on board units (R438)                   10  Hinder and Blood Ridden, cast on draw (R502)
//    5  the opponent's hand revealed at the end (R434)          11  the coloured corruption mark (R437)
//    6  an empty hand keeps its place (R504)                    12  Call to Chaos names its roll (R436)
//
// Every surface rendered here is also read the way a player reads it (`expectReadable`): no raw
// `{key}` placeholder (B3.4 rule 5), no old cost words (R432), no "library" or "sacrifice" (R373), in
// its text, its aria-labels, its titles or its value texts. The items' own suites hold the detail;
// this file only proves each item is there.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CATALOG } from "@jackioh/cards";
import type { CardView, GameEvent, LibraryView, ModifierView, PlayerView, UnitView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MATCH_CEILING_MS, TURN_CLOCK_MS } from "../../../server/src/config.ts";
import { setAudioEngineForTests } from "../audio/engine.ts";
import type { AudioEngine } from "../audio/types.ts";
import { resetAudioSettingsForTests } from "../audio/settings.ts";
import { marksTestid } from "../cards/CardMarks.tsx";
import { SHORT_REMINDERS } from "../cards/glossary.ts";
import { CardDetail } from "../cards/inspect/CardDetail.tsx";
import { INSPECT_GLOSSARY, INSPECT_LIST_CARD, INSPECT_LIST_SHEET } from "../cards/inspect/testids.ts";
import { closeInspect, costPhrase, faceDownLabel } from "../cards/index.ts";
import { MARK_PALETTES, MARK_WORDS } from "../cards/marks.ts";
import { CARD_FX } from "../fx/cardFx.ts";
import { CHAOS_CORE, chaosNames } from "../fx/chaos.ts";
import { FX_SPEED_MAX, FX_SPEED_MIN, FX_SPEED_STEP } from "../fx/constants.ts";
import { HINDERED_ATTR } from "../fx/manaMarks.ts";
import { getFxSettings, resetFxSettingsForTests } from "../fx/settings.ts";
import { scaleForSpeed } from "../game/animations.ts";
import Board from "../game/Board.tsx";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import Clock, { type ClockFrame } from "../game/Clock.tsx";
import { TURN_CLOCK_FINAL_MS } from "../game/clockConstants.ts";
import { testid } from "../game/contract.ts";
import ManaCurve from "../game/deckbuilder/ManaCurve.tsx";
import { poolCardLabel } from "../game/deckbuilder/PoolGrid.tsx";
import Game from "../game/Game.tsx";
import { HAND_EMPTY_TEXT, handEmptyTestid } from "../game/Hand.tsx";
import Log from "../game/Log.tsx";
import { revealTestid } from "../game/reveal.ts";
import CardShowcase from "../game/showcase/CardShowcase.tsx";
import { CAST_ON_DRAW_TEXT, CHAOS_TEXT, showcaseHoldMs, showcaseTestid } from "../game/showcase/constants.ts";
import {
  dequeue,
  enqueue,
  getCatalog,
  getCollection,
  getDecks,
  getMe,
  getPopulation,
  type DecksResponse,
  type SavedDeck,
} from "../net/api.ts";
import PlayRoute, { MODE_LABEL, playModeTestid, playTestid } from "../routes/play.tsx";
import { SettingsPanel, __resetSettingsForTests, writeSettings } from "../settings/index.ts";
import { DECK_SIZE } from "@jackioh/engine/config";
import { DECK_NAME_MAX_LENGTH, MAX_SAVED_DECKS, MAX_SAVED_TRIOS } from "../../../server/src/config.ts";
import { baseView, card, emptySide, fullBoardView, withEvents } from "./fixtures.ts";
import { setReducedMotion } from "./setup.ts";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    getDecks: vi.fn(),
    getCatalog: vi.fn(),
    getCollection: vi.fn(),
    getPopulation: vi.fn(),
  };
});
vi.mock("../net/navigate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/navigate.ts")>();
  return { ...actual, navigate: vi.fn() };
});

const HERE = dirname(fileURLToPath(import.meta.url));
const lookup = lookupFromDefs(CATALOG);
const nameOf = (defId: string): string => CATALOG[defId]?.name ?? defId;

const HINDER = "core-021";
const BLOOD = "core-027";
const CUBE = "core-022";

function withCatalog(node: ReactElement): ReactElement {
  return <CatalogContext.Provider value={lookup}>{node}</CatalogContext.Provider>;
}

function renderBoard(view: PlayerView): HTMLElement {
  return render(withCatalog(<Board view={view} />)).container;
}

function renderGame(view: PlayerView): void {
  render(withCatalog(<Game view={view} legal={[]} onAction={vi.fn()} />));
}

// ---------------------------------------------------------------------------------------------
// what a player reads
// ---------------------------------------------------------------------------------------------

/** A placeholder the catalog writes ("{amount}", "{cards|card|cards}") that was never filled in. */
const PLACEHOLDER = /\{[A-Za-z][\w|]*\}/;

/** R432's old ways, as wording.test.ts lists them, and a mana amount used as a card's cost noun. */
const OLD_COST: readonly RegExp[] = [/\bCost \(/, /\bcost(s|ing)? \d/i, /\b\d+-cost\b/i, /\b\d+ mana (Unit|Spell|Trap|Field|card)/i];

/** R373's old words. */
const OLD_WORDS = /\b(librar(y|ies)|sacrific\w*)\b/i;

/** Everything a player reads on the page: its text, and every name, title and value text. */
function readableTexts(root: ParentNode): string[] {
  const texts = [root instanceof HTMLElement ? root.innerText || (root.textContent ?? "") : ""];
  if (root instanceof Node) texts.push(root.textContent ?? "");
  for (const element of Array.from(root.querySelectorAll("[aria-label], [title], [aria-valuetext], [placeholder]"))) {
    for (const name of ["aria-label", "title", "aria-valuetext", "placeholder"]) {
      const value = element.getAttribute(name);
      if (value !== null) texts.push(value);
    }
  }
  return texts;
}

function expectReadable(root: ParentNode = document.body): void {
  for (const text of readableTexts(root)) {
    expect(text, "a raw placeholder reached the screen").not.toMatch(PLACEHOLDER);
    expect(text, "R373: Deck and Tribute").not.toMatch(OLD_WORDS);
    for (const pattern of OLD_COST) expect(text, `R432: ${String(pattern)}`).not.toMatch(pattern);
  }
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // Storage is optional.
  }
  __resetSettingsForTests();
  resetFxSettingsForTests();
  resetAudioSettingsForTests();
});

afterEach(() => {
  // Whatever the test drew is read as a player reads it before it goes.
  try {
    expectReadable();
  } finally {
    act(() => {
      closeInspect();
    });
    cleanup();
    vi.useRealTimers();
    setReducedMotion(false);
    setAudioEngineForTests(null);
    __resetSettingsForTests();
    resetFxSettingsForTests();
    resetAudioSettingsForTests();
    try {
      window.localStorage.clear();
    } catch {
      // Storage is optional.
    }
  }
});

// ---------------------------------------------------------------------------------------------
// 1-12
// ---------------------------------------------------------------------------------------------

describe("QA v0.2.0, Global Cosmetic", () => {
  it("item 1: a dealt deck lists the cards its owner has seen and one back for the rest, which names and opens nothing (R433)", () => {
    const library: LibraryView = { cards: [{ defId: "core-010", radiant: false, count: 1 }], unknown: 19 };
    renderBoard(baseView({ you: emptySide("p1", { libraryCount: 20, ownLibrary: library }) }));
    fireEvent.click(screen.getByTestId("library-you"));
    const sheet = screen.getByTestId(INSPECT_LIST_SHEET);
    const tiles = within(sheet).getAllByTestId(INSPECT_LIST_CARD);
    expect(tiles.map((tile) => tile.getAttribute("data-def-name"))).toEqual([nameOf("core-010"), ""]);
    const back = tiles[1];
    expect(back).toHaveAttribute("data-unknown", "true");
    expect(back).toHaveAccessibleName("19 × Unknown card");
    expect(back?.tagName).not.toBe("BUTTON");
    expect(back?.querySelector(".cf")).toBeNull();
  });

  it("item 2: the inspect glossary prints Cry and Tribute as one short line each (R500)", () => {
    const def = CATALOG[CUBE];
    if (def === undefined) throw new Error(`${CUBE} is missing`);
    render(withCatalog(<CardDetail def={def} onClose={() => undefined} />));
    const glossary = screen.getAllByTestId(INSPECT_GLOSSARY)[0];
    if (glossary === undefined) throw new Error("no glossary");
    for (const term of ["Cry", "Tribute"] as const) {
      const row = glossary.querySelector(`[data-glossary-term="${term}"]`);
      expect(row, term).not.toBeNull();
      const rule = row?.querySelector(".inspect-glossary-rule")?.textContent ?? "";
      expect(rule).toBe(SHORT_REMINDERS[term]);
      expect(rule.split(/\s+/).length, term).toBeLessThanOrEqual(16);
      expect(rule, term).not.toContain("\n");
    }
  });

  it("item 3: the effects speed is a slider from 0.25x to 3x that the runner's durations follow (R435)", () => {
    render(<SettingsPanel onClose={() => undefined} />);
    const range = screen.getByTestId("setting-fxSpeed") as HTMLInputElement;
    expect(range.type).toBe("range");
    expect([Number(range.min), Number(range.max), Number(range.step)]).toEqual([FX_SPEED_MIN, FX_SPEED_MAX, FX_SPEED_STEP]);
    expect([FX_SPEED_MIN, FX_SPEED_MAX]).toEqual([0.25, 3]);
    fireEvent.change(range, { target: { value: String(FX_SPEED_MAX) } });
    expect(getFxSettings().speed).toBe(FX_SPEED_MAX);
    expect(screen.getByTestId("setting-fxSpeed-value")).toHaveTextContent("3×");
    fireEvent.change(range, { target: { value: String(FX_SPEED_MIN) } });
    expect(screen.getByTestId("setting-fxSpeed-value")).toHaveTextContent("0.25×");
    const entryMs = 1200;
    expect(scaleForSpeed(entryMs, FX_SPEED_MAX)).toBe(entryMs / FX_SPEED_MAX);
    expect(scaleForSpeed(entryMs, FX_SPEED_MIN)).toBe(entryMs / FX_SPEED_MIN);
    expect(showcaseHoldMs(FX_SPEED_MIN)).toBeGreaterThan(showcaseHoldMs(FX_SPEED_MAX));
  });

  it("item 4: Taunt and Divine Shield, and the other keywords, are drawn on both seats' board units (R438)", () => {
    const view = fullBoardView();
    const root = renderBoard(view);
    const at = (u: UnitView | null | undefined): Element | null =>
      u === null || u === undefined ? null : root.querySelector(`[data-testid="${testid.card(u.instanceId)}"]`);
    const taunt = at(view.you.units[0]);
    expect(taunt?.querySelector('[data-keyword-fx="Taunt"]')).not.toBeNull();
    const shielded = at(view.opponent.units[0]);
    expect(shielded?.querySelector('.shield-icon[data-keyword-fx="Divine Shield"]')).not.toBeNull();
    const trample = at(view.opponent.units[4]);
    expect(trample?.querySelector('[data-keyword-fx="Trample"]')).not.toBeNull();
    // A unit with every keyword draws a treatment per layer, capped, and its chips still name them all.
    const everything = at(view.you.units[1]);
    expect(everything?.querySelectorAll("[data-keyword-fx]").length).toBeGreaterThan(5);
    expect(everything?.querySelectorAll("[data-kw-motion='on']").length).toBeLessThanOrEqual(2);
    // A unit with no keyword draws none.
    expect(at(view.you.units[2])?.querySelector("[data-keyword-fx]")).toBeNull();
  });

  it("item 5: at the game's end the opponent's hand turns face up on the board and is listed on the result; never before (R434)", () => {
    vi.useFakeTimers();
    const theirs: CardView[] = ["core-002", "core-019"].map((defId, index) => card({ instanceId: `t${String(index)}`, defId }));
    const running = baseView({ opponent: emptySide("p2", { hand: { count: theirs.length } }) });
    renderGame(running);
    const backs = screen.getByTestId("hand-opponent");
    expect(backs).not.toHaveAttribute("data-revealed");
    expect(backs.querySelectorAll('[data-testid^="revealed-hand-card-"]')).toHaveLength(0);
    expect(backs.textContent).not.toContain(nameOf("core-002"));
    expect(screen.queryByTestId(revealTestid.theirHand)).toBeNull();
    cleanup();

    renderGame(baseView({ phase: "over", result: { winner: "p1", reason: "hero-death" }, opponent: emptySide("p2", { hand: theirs }) }));
    const row = screen.getByTestId("hand-opponent");
    expect(row).toHaveAttribute("data-revealed", "true");
    for (const own of theirs) expect(within(row).getByTestId(revealTestid.handCard(own.instanceId))).toBeInTheDocument();
    const section = screen.getByTestId(revealTestid.theirHand);
    expect(section).toHaveAttribute("data-count", String(theirs.length));
    expect(within(section).getByTestId(revealTestid.theirHandCard("t0"))).toHaveAttribute("data-def-name", nameOf("core-002"));
  });

  it("item 6: an empty hand keeps a card-sized outline on both seats instead of collapsing (R504)", () => {
    renderBoard(baseView({ you: emptySide("p1", { hand: [] }), opponent: emptySide("p2", { hand: { count: 0 } }) }));
    for (const side of ["you", "opponent"] as const) {
      const hand = screen.getByTestId(`hand-${side}`);
      expect(hand).toHaveAttribute("data-empty", "true");
      const outline = within(hand).getByTestId(handEmptyTestid(side));
      expect(outline).toHaveTextContent(HAND_EMPTY_TEXT);
      expect(outline).toHaveClass("hand-empty");
      expect(hand.querySelector(".card")).toBeNull();
    }
  });

  it("item 7: the viewer's own last 30 seconds are the urgent readout, the fuse and a beat each second; the opponent's are quieter and silent (R439, R506)", () => {
    vi.useFakeTimers();
    const beats: string[] = [];
    const engine = {
      state: () => "running",
      playSfx: (id: string) => {
        beats.push(id);
        return true;
      },
    } as unknown as AudioEngine;
    setAudioEngineForTests(engine);
    const NOW = 1_700_000_000_000;
    const left = 12_300;
    const frame: ClockFrame = {
      now: NOW,
      clocks: { turnDeadline: NOW + left, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt: NOW + MATCH_CEILING_MS },
    };
    const at = { ms: 0 };
    const clock = (active: "p1" | "p2"): ReactElement => (
      <Clock youMs={null} opponentMs={null} viewer="p1" activePlayer={active} frame={frame} monotonic={() => at.ms} />
    );
    const { rerender } = render(clock("p1"));
    const root = document.querySelector(".clock");
    expect(root).toHaveAttribute("data-clock-urgency", "final");
    expect(root).toHaveAttribute("data-clock-side", "you");
    expect(screen.getByTestId("clock-you")).toHaveAccessibleName("Your turn ends in 13 seconds");
    expect(screen.getByTestId("turn-clock-fuse")).toBeInTheDocument();
    for (const ms of [200, 400, 1000]) {
      at.ms = ms;
      rerender(clock("p1"));
    }
    expect(beats).toEqual(["heartbeat", "heartbeat"]);
    expect(TURN_CLOCK_FINAL_MS).toBeLessThan(TURN_CLOCK_MS);
    cleanup();

    beats.length = 0;
    at.ms = 0;
    const theirs = render(clock("p2"));
    expect(screen.getByTestId("clock-opponent")).toHaveTextContent("Their turn");
    expect(screen.queryByTestId("turn-clock-fuse")).toBeNull();
    for (const ms of [200, 400, 1000]) {
      at.ms = ms;
      theirs.rerender(clock("p2"));
    }
    expect(beats).toEqual([]);
    cleanup();

    // Reduced motion keeps the urgent readout and drops the fuse.
    writeSettings({ reduceMotion: true });
    at.ms = 0;
    render(clock("p1"));
    expect(document.querySelector(".clock")).toHaveAttribute("data-motion", "reduced");
    expect(screen.getByTestId("clock-you")).toHaveAttribute("data-urgency", "final");
    expect(screen.queryByTestId("turn-clock-fuse")).toBeNull();
  });

  it("item 8: a cost is \"(N) Cost\" as a noun and \"costs (N)\" as a verb wherever the client writes one (R432)", () => {
    const bigot = CATALOG["core-002"];
    if (bigot === undefined) throw new Error("core-002 is missing");
    expect(poolCardLabel(bigot, null, true)).toBe(`${bigot.name}, Unit, (${String(bigot.cost)}) Cost, ${bigot.rarity}. Show details`);
    expect(faceDownLabel(2)).toBe("Face-down trap, (2) Cost");
    expect(costPhrase(0)).toBe("(0) Cost");

    render(<ManaCurve cardIds={["core-002", "core-019"]} catalog={{ version: "v", cards: CATALOG }} />);
    const curve = screen.getByRole("img", { name: /^Mana curve/ });
    expect(curve.getAttribute("aria-label")).toContain("(2) Cost: 1");
    expect(curve.getAttribute("aria-label")).toContain("(3) Cost: 1");

    const held = card({ instanceId: "h1", defId: "core-002" });
    const changed: GameEvent = { type: "costChanged", instanceId: "h1", cost: 1 };
    render(withCatalog(<Log view={withEvents(baseView({ you: emptySide("p1", { hand: [held] }) }), [changed])} revealed />));
    expect(document.body).toHaveTextContent(`${nameOf("core-002")} now costs (1)`);
  });

  it("item 9: the Find a match box repeats no queue count; the mode tiles carry them (R505)", async () => {
    const ids = Array.from({ length: DECK_SIZE }, (_, i) => `core-${String(i + 1).padStart(3, "0")}`);
    const deck: SavedDeck = { id: "d1", name: "Aggro", cards: ids, catalogVersion: "v1", createdAt: 0, updatedAt: 0 };
    const decks: DecksResponse = {
      catalogVersion: "v1",
      decks: [deck],
      trios: [],
      limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS, nameLength: DECK_NAME_MAX_LENGTH },
    };
    vi.mocked(getMe).mockResolvedValue({
      profile: { id: "p1", status: "active" },
      needsInviteCode: false,
      emailVerified: true,
      currentMatchId: null,
      currentSeriesId: null,
      email: "player1@example.com",
    });
    vi.mocked(getDecks).mockResolvedValue(decks);
    vi.mocked(getCatalog).mockResolvedValue({ version: "v1", defs: CATALOG });
    vi.mocked(getCollection).mockResolvedValue({ catalogVersion: "v1", entries: ids.map((cardId) => ({ cardId, quantity: 1 })) });
    vi.mocked(getPopulation).mockResolvedValue({ population: 97, byMode: { bo1: 41, bo3: 23, random: 33 } });
    vi.mocked(enqueue).mockResolvedValue({ ticketId: "tk", status: "open", matchId: null, seriesId: null, population: 98, mode: "bo1" });
    vi.mocked(dequeue).mockResolvedValue({ cancelled: true });

    render(<PlayRoute token="token" />);
    await screen.findByTestId(playTestid.deckSelect);
    await waitFor(() => {
      expect(screen.getByTestId(playTestid.population)).toHaveAttribute("data-bo1", "41");
    });
    expect(screen.getByTestId(playModeTestid("bo1")).closest("label")).toHaveTextContent("41 waiting");
    const box = screen.getByRole("region", { name: "Find a match" });
    /** No count of any queue (the mode labels carry digits of their own, "Best of 1"), and no "waiting". */
    const COUNTS = /waiting|\b(41|23|33|97|98)\b/;
    expect(box).not.toHaveTextContent(COUNTS);
    fireEvent.click(within(box).getByTestId(playTestid.queue));
    const status = await screen.findByTestId(playTestid.status);
    expect(status).toHaveTextContent(`In the ${MODE_LABEL.bo1} queue.`);
    expect(status).not.toHaveTextContent(COUNTS);
    expect(within(box).getByTestId(playTestid.searching)).toHaveTextContent(`Looking for a ${MODE_LABEL.bo1} opponent`);
    expect(box).not.toHaveTextContent(COUNTS);
    vi.mocked(getMe).mockReset();

    // The searching beacon's rings hold still, and stay drawn, under either reduced motion.
    const lobbyCss = readFileSync(join(HERE, "../routes/lobby.css"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const still = /\{\s*animation: none;\s*opacity: 0\.6;\s*\}/;
    expect(lobbyCss).toMatch(new RegExp(`@media \\(prefers-reduced-motion: reduce\\) \\{\\s*\\.tavern\\.play-screen \\.play-search__ring \\s*${still.source}`));
    expect(lobbyCss).toMatch(new RegExp(`:root\\[data-reduce-motion="true"\\] \\.tavern\\.play-screen \\.play-search__ring \\s*${still.source}`));
  });
});

describe("QA v0.2.0, Card Cosmetic", () => {
  const TURN: GameEvent = { type: "turnStarted", player: "p2", turn: 4 };
  const drawn = (player: "p1" | "p2", instanceId: string, defId: string): GameEvent => ({ type: "drawn", player, instanceId, defId });
  const cast = (player: "p1" | "p2", instanceId: string, defId: string): GameEvent => ({ type: "cardPlayed", player, instanceId, defId, costPaid: 0 });

  /** Mounts the showcase on a first view, then hands it `events` after TURN. */
  function showcase(events: GameEvent[], view: PlayerView = baseView()): void {
    const utils = render(withCatalog(<CardShowcase view={withEvents(view, [TURN])} />));
    utils.rerender(withCatalog(<CardShowcase view={withEvents(view, [TURN, ...events])} />));
  }

  const rider = (lower: number): ModifierView => ({ id: "nextTurnMana", label: `Next refresh −${String(lower)} mana` });

  it("item 10: the opponent's Hinder and Blood Ridden Glowy Jelly Bean are held up under a 'Cast on draw!' ribbon, and a hidden one names nothing (R502)", () => {
    vi.useFakeTimers();
    for (const defId of [HINDER, BLOOD]) {
      showcase([drawn("p2", `c-${defId}`, defId), cast("p2", `c-${defId}`, defId)]);
      const root = screen.getByTestId(showcaseTestid.root);
      expect(root, defId).toHaveAttribute("data-showcase", "cast");
      expect(root, defId).toHaveAttribute("data-showcase-def", defId);
      expect(screen.getByTestId(showcaseTestid.ribbon)).toHaveTextContent(CAST_ON_DRAW_TEXT.ribbon);
      expect(screen.getByTestId(showcaseTestid.caption)).toHaveTextContent(CAST_ON_DRAW_TEXT.opponent);
      expect(screen.getByTestId(showcaseTestid.face)).toHaveTextContent(nameOf(defId));
      expect(screen.getByTestId(showcaseTestid.live)).toHaveTextContent(`${CAST_ON_DRAW_TEXT.opponent} ${nameOf(defId)}: ${CAST_ON_DRAW_TEXT.said}`);
      cleanup();
    }
    // Each has its own signature recipe over its resolution.
    expect(CARD_FX[HINDER]).toBe("manaCrack");
    expect(CARD_FX[BLOOD]).toBe("bloodDrain");

    showcase([drawn("p2", "hidden", "hidden"), cast("p2", "hidden", "hidden")]);
    expect(screen.getByTestId(showcaseTestid.back)).toContainElement(screen.getByTestId(showcaseTestid.ribbon));
    expect(screen.getByTestId(showcaseTestid.caption)).toHaveTextContent(CAST_ON_DRAW_TEXT.hidden);
    expect(document.body.innerHTML).not.toMatch(/core-\d{3}/);
  });

  it("item 10: Hinder's victim's crystals crack, on the victim's tray in both seats' views, even under reduced motion (R502)", () => {
    vi.useFakeTimers();
    setReducedMotion(true);
    const mana = { current: 1, max: 3 };
    renderGame(baseView({ you: emptySide("p1", { mana, modifiers: [rider(1)] }) }));
    expect(document.querySelectorAll(`[data-testid="mana-you"] .mana-crystal[${HINDERED_ATTR}]`)).toHaveLength(1);
    expect(screen.getByTestId("mana-you")).toHaveAttribute(HINDERED_ATTR, "1");
    expect(document.querySelectorAll(`[data-testid="mana-opponent"] .mana-crystal[${HINDERED_ATTR}]`)).toHaveLength(0);
    cleanup();
    // The caster's view: the victim is the opponent.
    renderGame(baseView({ opponent: emptySide("p2", { hand: { count: 3 }, mana, modifiers: [rider(2)] }) }));
    expect(document.querySelectorAll(`[data-testid="mana-opponent"] .mana-crystal[${HINDERED_ATTR}]`)).toHaveLength(2);
  });

  it("item 11: K-Pop Fanatic's pending steal is a purple corruption mark on its target in both seats' views, and the mark takes any colour (R437)", () => {
    const view = fullBoardView();
    const mine = view.you.units[0] as UnitView;
    const theirs = view.opponent.units[0] as UnitView;
    const marked: PlayerView = {
      ...view,
      you: { ...view.you, units: view.you.units.map((u) => (u === mine ? { ...u, marks: [{ mark: "steal", color: "green" }] } : u)) },
      opponent: {
        ...view.opponent,
        units: view.opponent.units.map((u) => (u === theirs ? { ...u, marks: [{ mark: "steal", color: "purple" }] } : u)),
      },
    };
    const root = renderBoard(marked);
    const purple = root.querySelector(`[data-testid="${marksTestid(theirs.instanceId)}"]`) as HTMLElement | null;
    expect(purple).not.toBeNull();
    expect(root.querySelector(`[data-testid="${testid.card(theirs.instanceId)}"]`)?.contains(purple)).toBe(true);
    expect(purple).toHaveAttribute("data-mark-color", "purple");
    expect(purple?.style.getPropertyValue("--mark-rim")).toBe(MARK_PALETTES.purple.rim);
    expect(purple?.querySelector(".card-marks__aura")).toHaveAttribute("aria-hidden", "true");
    expect(purple?.querySelector(".card-mark-badge")).toHaveAttribute("title", MARK_WORDS.steal?.text);
    const green = root.querySelector(`[data-testid="${marksTestid(mine.instanceId)}"]`) as HTMLElement | null;
    expect(green).toHaveAttribute("data-mark-color", "green");
    expect(green?.style.getPropertyValue("--mark-rim")).toBe(MARK_PALETTES.green.rim);
    cleanup();

    // The log names the mark as its badge does, never by the engine's key; a card it cannot read is "a card".
    const events: GameEvent[] = [
      { type: "marked", instanceId: theirs.instanceId, mark: "steal", color: "purple", added: true },
      { type: "marked", instanceId: "facedown-elsewhere", mark: "doom", color: "ultraviolet", added: true },
      { type: "marked", instanceId: theirs.instanceId, mark: "steal", color: "purple", added: false },
    ];
    render(withCatalog(<Log view={withEvents(marked, events)} revealed />));
    const lines = Array.from(document.querySelectorAll(".log li")).map((line) => line.textContent ?? "");
    expect(lines).toContain(`${nameOf(theirs.defId)} was marked (${MARK_WORDS.steal?.name ?? ""})`);
    expect(lines).toContain("A card was marked (Mark)");
    expect(lines.join("\n")).not.toMatch(/\((steal|doom)\)/);
  });

  it("item 12: Call to Chaos names what it rolled on both seats, and shows it still where the effects draw nothing (R436)", () => {
    vi.useFakeTimers();
    const effects = ["Summon 3 random (3) Cost Units", "Summon a Chaos Golem", "Cast a random Call to Chaos"];
    const names = chaosNames({ player: "p2", instanceId: "c95", defId: CHAOS_CORE, effects });
    expect(names).toEqual(["Summon 3 random (3) Cost Units", "Summon a Chaos Golem", "Cast a random Call to Chaos"]);
    for (const player of ["p2", "p1"] as const) {
      const rolled: GameEvent = { type: "chaosRolled", player, instanceId: "c95", defId: CHAOS_CORE, effects };
      showcase([rolled]);
      expect(screen.getByTestId(showcaseTestid.chaosLive)).toHaveTextContent(`${CHAOS_TEXT.said}: ${names.join(", ")}`);
      // The effects layer draws the reveal under full motion, so no still banner.
      expect(screen.queryByTestId(showcaseTestid.chaos)).toBeNull();
      cleanup();
    }
    // The log says the same words: the card's name, or Call to Chaos for one the viewer cannot read.
    const logged: GameEvent[] = [
      { type: "chaosRolled", player: "p2", instanceId: "c95", defId: CHAOS_CORE, effects },
      { type: "chaosRolled", player: "p2", instanceId: "hidden", defId: "hidden", effects: ["Heal your hero 30"] },
    ];
    render(withCatalog(<Log view={withEvents(baseView(), logged)} revealed />));
    const lines = Array.from(document.querySelectorAll(".log li")).map((line) => line.textContent ?? "");
    expect(lines).toContain(`${nameOf(CHAOS_CORE)} rolled: ${names.join("; ")}`);
    expect(lines).toContain(`${CHAOS_TEXT.title} rolled: Heal the caster's hero 30`);
    cleanup();

    writeSettings({ reduceMotion: true });
    showcase([{ type: "chaosRolled", player: "p2", instanceId: "hidden", defId: "hidden", effects }]);
    const banner = screen.getByTestId(showcaseTestid.chaos);
    expect(banner).toHaveTextContent(CHAOS_TEXT.title);
    // A hidden card's roll is still named: the roll is public (R97 redacts the card, never the roll).
    expect(within(banner).getAllByTestId(showcaseTestid.chaosLine).map((line) => line.textContent)).toEqual([
      "Summon 3 random (3) Cost Units",
      "Summon a Chaos Golem",
      "Cast a random Call to Chaos",
    ]);
  });
});

describe("QA v0.2.0, the reader", () => {
  it("expectReadable catches a raw placeholder, the old cost words and the old zone words", () => {
    const probe = (text: string): boolean => {
      const element = document.createElement("div");
      element.textContent = text;
      try {
        expectReadable(element);
        return true;
      } catch {
        return false;
      }
    };
    expect(probe("Deal {amount} damage")).toBe(false);
    expect(probe("Discover a Cost (2) card")).toBe(false);
    expect(probe("It costs 3")).toBe(false);
    expect(probe("Bigot, 2 mana Unit")).toBe(false);
    expect(probe("Your library")).toBe(false);
    expect(probe("Discover a (2) Cost card. It costs (1) less. Gain 2 mana.")).toBe(true);
  });
});
