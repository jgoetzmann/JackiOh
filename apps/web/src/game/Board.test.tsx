// BUILD M5-T1 acceptance. Every assertion here is about what the board draws from one
// `PlayerView` and about what it refuses to draw: the opponent's hand as backs only, a
// face-down trap with no identity anywhere in its subtree, the cards under a Stack as a number.
//
// The fixture is the only input. If a component needed something a `PlayerView` does not carry,
// no test here could pass without inventing it, which is the point (src/test/fixtures.ts).

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { KEYWORD_KINDS } from "@jackioh/shared";

import Board from "./Board.tsx";
import { LANES, NO_HIGHLIGHT, testid, type ClickTarget, type Highlight } from "./contract.ts";
import { fullBoardView, withEvents } from "../test/fixtures.ts";

const FIELD_SLOTS = [
  { side: "opponent", row: "backrow" },
  { side: "opponent", row: "units" },
  { side: "you", row: "units" },
  { side: "you", row: "backrow" },
] as const;

/** vitest stubs CSS imports, so the stylesheet is read as text. */
const boardCss = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "board.css"), "utf8");

function highlightOf(legal: string[], selected: string[] = []): Highlight {
  return { legal: new Set(legal), selected: new Set(selected) };
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, writable: true, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, writable: true, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

/** jsdom has no `DataTransfer`; drag-to-attack only needs set/get/types. */
function stubDataTransfer(): DataTransfer {
  const store = new Map<string, string>();
  return {
    setData: (format: string, data: string) => void store.set(format, data),
    getData: (format: string) => store.get(format) ?? "",
    get types() {
      return Array.from(store.keys());
    },
    effectAllowed: "none",
    dropEffect: "none",
  } as unknown as DataTransfer;
}

afterEach(() => {
  // `globals: false` means @testing-library/react cannot register its own cleanup.
  cleanup();
  setViewport(1024, 768);
});

describe("Board", () => {
  it("renders the full board from a PlayerView", () => {
    const { container } = render(<Board view={fullBoardView()} />);
    expect(container.firstChild).toMatchSnapshot();
  });

  it("is given the fixture BUILD M5-T1 asks for: 10 units, 10 backrow cards and a stacked pile", () => {
    // The acceptance names the fixture's contents, so the fixture is asserted rather than trusted:
    // one `null` in a backrow lane made this 9 backrow cards while every test above still passed,
    // because none of them counts. Both sides are counted, since "10 units" is the board's total.
    const view = fullBoardView();
    const units = [...view.you.units, ...view.opponent.units].filter((unit) => unit !== null);
    const backrow = [...view.you.backrow, ...view.opponent.backrow].filter((slot) => slot !== null);

    expect(units, "BUILD M5-T1: the fixture board holds 10 units").toHaveLength(10);
    expect(backrow, "BUILD M5-T1: the fixture board holds 10 backrow cards").toHaveLength(10);
    expect(units.filter((unit) => unit.buried > 0), "BUILD M5-T1: a stacked pile").not.toHaveLength(0);

    // And the board draws all twenty: a card for every unit, and a card or a back for every
    // backrow slot — so a fixture that grew a lane cannot pass while the board drops it.
    render(<Board view={view} />);
    const drawn = FIELD_SLOTS.flatMap((slot) =>
      LANES.map((lane) => screen.getByTestId(testid.zone(slot.side, slot.row, lane))),
    ).filter((zone) => zone.querySelector(".card, .card-back") !== null);
    expect(drawn).toHaveLength(20);
  });

  it("renders every zone of every lane, with no element wider than the viewport", () => {
    // jsdom has no layout engine, so this is structural: `document.body.scrollWidth` is always 0
    // there and asserting on it would be a fake pass. The real pixel check at 1280x720 and
    // 390x844 is the Cypress spec's job (BUILD M8); what is checkable here is that the DOM has
    // every lane at both sizes, that nothing declares a width wider than the viewport, and that
    // the grid itself is built out of `minmax(0, 1fr)` columns.
    for (const [width, height] of [
      [1280, 720],
      [390, 844],
    ] as const) {
      setViewport(width, height);
      const { container, unmount } = render(<Board view={fullBoardView()} />);

      for (const lane of LANES) {
        expect(container.querySelector(`.lane[data-lane="${lane}"]`)).not.toBeNull();
        for (const slot of FIELD_SLOTS) {
          const zone = container.querySelector(`[data-testid="${testid.zone(slot.side, slot.row, lane)}"]`);
          expect(zone).not.toBeNull();
          expect(zone?.getAttribute("data-lane")).toBe(String(lane));
        }
      }

      for (const element of container.querySelectorAll<HTMLElement>("*")) {
        for (const property of ["width", "minWidth"] as const) {
          for (const value of [element.style[property], window.getComputedStyle(element)[property]]) {
            const px = /^([\d.]+)px$/.exec(value ?? "");
            if (px === null) continue;
            expect(Number(px[1])).toBeLessThanOrEqual(width);
          }
        }
      }

      unmount();
    }

    expect(boardCss).toContain("grid-template-columns: repeat(5, minmax(0, 1fr))");
    const declared = [...boardCss.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*([\d.]+)px/g)].map((match) => Number(match[1]));
    expect(declared.length).toBeGreaterThan(0);
    expect(Math.max(...declared)).toBeLessThanOrEqual(390);
  });

  it("shows the opponent's hand as a count of backs with no card identity (SPEC §10.8)", () => {
    const view = fullBoardView();
    const { count } = view.opponent.hand as { count: number };
    render(<Board view={view} />);

    const hand = screen.getByTestId("hand-opponent");
    const backs = hand.querySelectorAll(".card-back");
    expect(backs).toHaveLength(count);
    expect(screen.getByTestId("hand-count-opponent")).toHaveTextContent(String(count));

    for (const back of backs) {
      expect(back.textContent).toBe("");
      expect(back.getAttribute("data-def-id")).toBeNull();
      expect(back.getAttribute("data-testid")).toBeNull();
    }
    expect(hand.querySelectorAll('[data-testid^="hand-card-"]')).toHaveLength(0);
    expect(hand.querySelectorAll(".card-name")).toHaveLength(0);

    // The viewer's own hand is the other half of the union: full cards with their own testids.
    const yours = screen.getByTestId("hand-you");
    expect(yours.querySelectorAll('[data-testid^="hand-card-"]')).toHaveLength(4);
  });

  it("renders a face-down trap with no def id and no name in its subtree (R33)", () => {
    const view = fullBoardView();
    expect(view.opponent.backrow[0]).toEqual({ faceDown: true });
    render(<Board view={view} />);

    const zone = screen.getByTestId(testid.zone("opponent", "backrow", 1));
    expect(zone.querySelector(".card-back")).not.toBeNull();
    expect(zone.querySelectorAll("[data-def-id]")).toHaveLength(0);
    expect(zone.querySelectorAll(".card-name")).toHaveLength(0);
    expect(zone.querySelectorAll('[data-testid^="card-"]')).toHaveLength(0);
    expect(zone.textContent).toBe("");
    expect(zone.innerHTML).not.toMatch(/core-\d+/);
  });

  it("shows a Stack pile's buried count and no card for the buried cards (§3.2)", () => {
    const view = fullBoardView();
    const pile = view.you.units[3];
    expect(pile?.buried).toBe(3);
    render(<Board view={view} />);

    const zone = screen.getByTestId(testid.zone("you", "units", 4));
    const badge = zone.querySelector('[data-buried="3"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveTextContent("3");
    // The view gives a depth only, so exactly one card is drawn for the pile.
    expect(zone.querySelectorAll(".card")).toHaveLength(1);
  });

  it("draws DEF rotation, radiant glow, counters and every keyword icon", () => {
    const view = fullBoardView();
    render(<Board view={view} />);

    const def = view.you.units[2];
    expect(def?.position).toBe("DEF");
    const defCard = screen.getByTestId(testid.card(def?.instanceId ?? ""));
    expect(defCard.getAttribute("style")).toContain("rotate(90deg)");
    expect(defCard.getAttribute("data-position")).toBe("DEF");

    const atk = view.you.units[0];
    expect(screen.getByTestId(testid.card(atk?.instanceId ?? "")).getAttribute("style")).toBeNull();

    const radiant = view.you.units[1];
    expect(radiant?.radiant).toBe(true);
    const radiantCard = screen.getByTestId(testid.card(radiant?.instanceId ?? ""));
    expect(radiantCard.className.split(/\s+/)).toContain("radiant");

    expect(radiantCard.querySelector('[data-counter="plague"]')).toHaveTextContent("2");
    expect(radiantCard.querySelector('[data-counter="grade"]')).toHaveTextContent("3");

    // Every keyword in the union is on that unit in the fixture, so every one has an icon.
    for (const kind of KEYWORD_KINDS) {
      const icon = radiantCard.querySelector(`[data-keyword="${kind}"]`);
      expect(icon, `missing keyword icon for ${kind}`).not.toBeNull();
    }
    expect(radiantCard.querySelector('[data-keyword="Armor"]')).toHaveTextContent("2");
    expect(radiantCard.querySelector('[data-keyword="Lucky"]')).toHaveTextContent("3");
    expect(radiantCard.querySelector(".shield-icon")).not.toBeNull();

    // A grade counter on a face-up backrow card comes off `BackrowView.counters`.
    const trap = view.you.backrow[1];
    if (trap === undefined || trap === null || trap.faceDown) throw new Error("fixture: you.backrow[1] is a face-up card");
    const trapCard = screen.getByTestId(testid.card(trap.instanceId));
    expect(trapCard.querySelector('[data-counter="grade"]')).toHaveTextContent("2");
  });

  it("fires onClick only for a legal target, and never computes legality itself", () => {
    const view = fullBoardView();
    const legalUnit = view.you.units[0];
    const illegalUnit = view.you.units[1];
    const onClick = vi.fn<(target: ClickTarget) => void>();

    render(<Board view={view} highlight={highlightOf([testid.card(legalUnit?.instanceId ?? "")])} onClick={onClick} />);

    const illegal = screen.getByTestId(testid.card(illegalUnit?.instanceId ?? ""));
    expect(illegal.getAttribute("data-legal")).toBe("false");
    expect(illegal.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(illegal);
    fireEvent.click(screen.getByTestId(testid.zone("you", "units", 5)));
    fireEvent.click(screen.getByTestId(testid.hero("opponent")));
    expect(onClick).not.toHaveBeenCalled();

    const legal = screen.getByTestId(testid.card(legalUnit?.instanceId ?? ""));
    expect(legal.getAttribute("data-legal")).toBe("true");
    fireEvent.click(legal);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith({ on: "unit", instanceId: legalUnit?.instanceId, side: "you", lane: 1 });
  });

  it("greys everything out with no highlight, and marks the selected element", () => {
    const view = fullBoardView();
    const { container, unmount } = render(<Board view={view} highlight={NO_HIGHLIGHT} />);
    expect(container.querySelectorAll('[data-legal="true"]')).toHaveLength(0);
    expect(container.querySelectorAll('[data-legal="false"]').length).toBeGreaterThan(0);
    unmount();

    const id = testid.card(view.you.units[0]?.instanceId ?? "");
    render(<Board view={view} highlight={highlightOf([id], [id])} />);
    expect(screen.getByTestId(id).getAttribute("data-selected")).toBe("true");
  });

  it("reports a drag as the source click then the drop-target click", () => {
    const view = fullBoardView();
    const attacker = view.you.units[0];
    const onClick = vi.fn<(target: ClickTarget) => void>();
    render(<Board view={view} highlight={highlightOf([testid.card(attacker?.instanceId ?? "")])} onClick={onClick} />);

    const dataTransfer = stubDataTransfer();
    fireEvent.dragStart(screen.getByTestId(testid.card(attacker?.instanceId ?? "")), { dataTransfer });
    fireEvent.drop(screen.getByTestId(testid.hero("opponent")), { dataTransfer });

    expect(onClick.mock.calls.map((call) => call[0])).toEqual([
      { on: "unit", instanceId: attacker?.instanceId, side: "you", lane: 1 },
      { on: "hero", side: "opponent" },
    ]);
  });

  it("marks locked zones with data-locked (BUILD M5-T4 `locked`)", () => {
    const view = fullBoardView();
    const { container } = render(<Board view={view} />);

    expect(screen.getByTestId(testid.zone("you", "backrow", 3)).getAttribute("data-locked")).toBe("true");
    expect(screen.getByTestId(testid.zone("opponent", "units", 2)).getAttribute("data-locked")).toBe("true");
    expect(container.querySelectorAll('[data-locked="true"]')).toHaveLength(2);
    expect(screen.getByTestId(testid.zone("you", "backrow", 1)).getAttribute("data-locked")).toBeNull();
  });

  it("renders the seats, piles, crystals, controls and log the animation table reads", () => {
    const view = fullBoardView();
    render(<Board view={view} highlight={highlightOf([testid.endTurn, testid.power])} />);

    expect(screen.getByTestId(testid.hero("you"))).toHaveTextContent("21");
    expect(screen.getByTestId(testid.hero("opponent"))).toHaveTextContent("30");
    expect(screen.getByTestId("library-count-you")).toHaveTextContent("12");
    expect(screen.getByTestId("graveyard-count-you")).toHaveTextContent("2");
    expect(screen.getByTestId("exile-count-you")).toHaveTextContent("1");
    expect(screen.getByTestId("library-count-opponent")).toHaveTextContent("9");

    // `manaChanged`: "crystal count equals mana".
    const mana = screen.getByTestId("mana-you");
    expect(mana.querySelectorAll(".mana-crystal")).toHaveLength(view.you.mana.max);
    expect(mana.querySelectorAll('.mana-crystal[data-filled="true"]')).toHaveLength(view.you.mana.current);

    // The hero power button is the one `power` testid; `turnEnded` wants end-turn disable-able.
    expect(screen.getByTestId(testid.power)).toBeEnabled();
    expect(screen.getByTestId(testid.endTurn)).toBeEnabled();
    expect(screen.getByTestId(testid.offerDraw)).toBeDisabled();
    expect(screen.getByTestId(testid.concede)).toBeDisabled();
    expect(screen.getByTestId(testid.log)).toBeInTheDocument();
  });

  it("sets data-animating and takes the pop text from the matching event", () => {
    const view = fullBoardView();
    const target = view.you.units[0];
    const withDamage = withEvents(view, [
      { type: "damage", sourceId: null, targetId: target?.instanceId ?? "", amount: 3, combat: true },
      { type: "healthLost", player: view.you.player, amount: 5 },
    ]);
    const cardId = testid.card(target?.instanceId ?? "");
    const animating = new Map([
      [cardId, "damage" as const],
      [testid.hero("you"), "healthLost" as const],
    ]);

    render(<Board view={withDamage} animating={animating} />);

    const card = screen.getByTestId(cardId);
    expect(card.getAttribute("data-animating")).toBe("damage");
    expect(card.querySelector(".damage-pop")).toHaveTextContent("3");

    const hero = screen.getByTestId(testid.hero("you"));
    expect(hero.getAttribute("data-animating")).toBe("healthLost");
    expect(hero.querySelector(".loss-pop")).toHaveTextContent("5");

    // Nothing pops on an element the runner is not animating.
    expect(screen.getByTestId(testid.hero("opponent")).querySelector(".loss-pop")).toBeNull();
  });

  it("writes the log from view.events without naming a drawn card", () => {
    const view = fullBoardView();
    const logged = withEvents(view, [
      { type: "turnStarted", player: view.you.player, turn: 3 },
      { type: "drawn", player: view.opponent.player, instanceId: "x1", defId: "core-042" },
      { type: "positionSwitched", instanceId: view.you.units[2]?.instanceId ?? "", position: "DEF" },
    ]);
    render(<Board view={logged} />);

    const log = screen.getByTestId(testid.log);
    expect(log.querySelectorAll(".log-line")).toHaveLength(3);
    expect(log).toHaveTextContent("Turn 3: You");
    expect(log).toHaveTextContent("Opponent drew a card");
    expect(log.innerHTML).not.toContain("core-042");
  });
});
