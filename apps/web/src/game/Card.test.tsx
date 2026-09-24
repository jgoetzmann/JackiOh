// Polish 6, slice B: `Card.tsx` after its internals became card faces (docs/polish/6-cards.md,
// "`Card.tsx`: what survives, and what is new", behaviours B16–B20).
//
// The board is the only honest mount: every prop a `Card` gets here is the prop `Zone`, `Backrow`,
// `Hand` and `Board` really pass it, from `fullBoardView()` (src/test/fixtures.ts, the only
// `PlayerView` source). The view is rendered twice over: with the real catalog in `CatalogContext`,
// as the hotseat and match routes do once `GET /api/catalog` answers, and with none, which is the
// state before it does.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "@jackioh/cards";
import { KEYWORD_KINDS, type BackrowView, type CardView, type PlayerView, type UnitView } from "@jackioh/shared";

import {
  CARD_SETTINGS_DEFAULTS,
  CardBack,
  INSPECT_HOVER,
  INSPECT_SHEET,
  KEYWORD_MARK,
  closeInspect,
  writeCardSettings,
} from "../cards/index.ts";
import Board from "./Board.tsx";
import Card, * as CardModule from "./Card.tsx";
import { CatalogContext, lookupFromDefs } from "./catalog.ts";
import { testid, type AnimatingMap, type BoardProps, type ClickTarget, type Highlight } from "./contract.ts";
import { card, faceUpBackrow, fullBoardView } from "../test/fixtures.ts";

afterEach(() => {
  // `globals: false`: @testing-library/react cannot register its own cleanup.
  cleanup();
  closeInspect();
  vi.useRealTimers();
  writeCardSettings(CARD_SETTINGS_DEFAULTS);
});

/* -------------------------------------------------------------------------------------- helpers */

const lookup = lookupFromDefs(CATALOG);

/** Longer than any inspect delay (hover or long-press), so "nothing opened" is not "not yet". */
const PAST_ANY_INSPECT_DELAY_MS = 2_000;

type FaceUpBackrow = Extract<NonNullable<BackrowView>, { faceDown: false }>;

function renderBoard(view: PlayerView, props: Omit<BoardProps, "view"> = {}, withCatalog = true): HTMLElement {
  const board = <Board view={view} {...props} />;
  const { container } = render(
    withCatalog ? <CatalogContext.Provider value={lookup}>{board}</CatalogContext.Provider> : board,
  );
  return container;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`the fixture is missing ${what}`);
  return value;
}

function yourUnit(view: PlayerView, lane: number): UnitView {
  return must(view.you.units[lane - 1], `your unit in lane ${lane}`);
}

function enemyUnit(view: PlayerView, lane: number): UnitView {
  return must(view.opponent.units[lane - 1], `the opponent's unit in lane ${lane}`);
}

function yourBackrow(view: PlayerView, lane: number): FaceUpBackrow {
  const slot = view.you.backrow[lane - 1];
  if (slot === null || slot === undefined || slot.faceDown) throw new Error(`your backrow lane ${lane} is not face-up`);
  return slot;
}

function handOf(view: PlayerView): CardView[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's hand should be full cards");
  return hand;
}

function nameOf(defId: string): string {
  return must(CATALOG[defId], `catalog entry ${defId}`).name;
}

function cardRoot(instanceId: string): HTMLElement {
  return screen.getByTestId(testid.card(instanceId));
}

function handRoot(instanceId: string): HTMLElement {
  return screen.getByTestId(testid.handCard(instanceId));
}

function inside(root: Element, selector: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(selector);
  if (found === null) throw new Error(`no ${selector} inside ${root.getAttribute("data-testid") ?? root.className}`);
  return found;
}

function faceUpRoots(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-testid^="card-"], [data-testid^="hand-card-"]')];
}

function allUnits(view: PlayerView): UnitView[] {
  return [...view.you.units, ...view.opponent.units].filter((u): u is UnitView => u !== null);
}

function highlightOf(legal: string[], selected: string[] = []): Highlight {
  return { legal: new Set(legal), selected: new Set(selected) };
}

/** The face-down backs on the board: the opponent's hand, and every face-down backrow slot. */
function backs(container: Element): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(".card-back")];
}

/* ----------------------------------------------------------------------------------------- B16 */

describe("B16: a face-down card is a back and nothing else", () => {
  it("B16 a face-down backrow card is one .card.card-back with no text, def id, testid or name", () => {
    const container = renderBoard(fullBoardView());
    const zone = screen.getByTestId(testid.zone("opponent", "backrow", 1));
    const found = zone.querySelectorAll(".card");
    expect(found).toHaveLength(1);
    const back = found[0] as HTMLElement;
    expect(back.classList.contains("card-back")).toBe(true);
    expect(back.textContent).toBe("");
    expect(back.hasAttribute("data-def-id")).toBe(false);
    expect(back.hasAttribute("data-testid")).toBe(false);
    expect(back.querySelector(".card-name")).toBeNull();
    expect(back.querySelectorAll("[data-def-id], [data-testid]")).toHaveLength(0);
    expect(zone.innerHTML).not.toMatch(/core-\d+/);
    expect(backs(container).length).toBeGreaterThan(0);
  });

  it("B16 every back on the board (hand and backrow, both seats) carries data-face-down and a label, and nothing that names a card", () => {
    const view = fullBoardView();
    const container = renderBoard(view);
    const all = backs(container);
    // 6 opponent hand backs, 2 face-down backrow cards of yours, 4 of the opponent's.
    expect(all).toHaveLength(12);
    const names = Object.values(CATALOG).map((def) => def.name);
    for (const back of all) {
      expect(back.classList.contains("card")).toBe(true);
      expect(back.textContent).toBe("");
      expect(back.getAttribute("data-face-down")).toBe("true");
      const label = back.getAttribute("aria-label") ?? "";
      expect(label.trim()).not.toBe("");
      expect(label).not.toMatch(/core-\d+/);
      for (const name of names) expect(label.includes(name), `a back's label names ${name}`).toBe(false);
      expect(back.hasAttribute("data-def-id")).toBe(false);
      expect(back.hasAttribute("data-rarity")).toBe(false);
      expect(back.hasAttribute("data-card-type")).toBe(false);
      expect(back.querySelector(".card-name, .card-text, .cf-art, .cost-gem")).toBeNull();
      expect(back.innerHTML).not.toMatch(/core-\d+/);
    }
  });

  it("B16 a back is none of the three face forms", () => {
    const container = renderBoard(fullBoardView());
    for (const back of backs(container)) {
      expect(["minion", "full", "compact"]).not.toContain(back.getAttribute("data-face"));
      expect(back.querySelector(".cf")).toBeNull();
    }
  });

  it("B16 a back has no title even while hover previews are off", () => {
    writeCardSettings({ hoverPreviews: false });
    const container = renderBoard(fullBoardView());
    for (const back of backs(container)) expect(back.hasAttribute("title")).toBe(false);
  });

  it("B16 hovering or long-pressing a back opens nothing, while the same gestures on a face-up card do", () => {
    vi.useFakeTimers();
    const view = fullBoardView();
    const container = renderBoard(view);

    for (const back of backs(container)) {
      fireEvent.pointerEnter(back, { pointerType: "mouse" });
      act(() => {
        vi.advanceTimersByTime(PAST_ANY_INSPECT_DELAY_MS);
      });
      fireEvent.pointerLeave(back, { pointerType: "mouse" });

      fireEvent.pointerDown(back, { pointerType: "touch", clientX: 10, clientY: 10 });
      act(() => {
        vi.advanceTimersByTime(PAST_ANY_INSPECT_DELAY_MS);
      });
      fireEvent.pointerUp(back, { pointerType: "touch", clientX: 10, clientY: 10 });
    }
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(document.querySelectorAll('[data-testid^="inspect-"]')).toHaveLength(0);

    // The control: the very same gestures on a face-up card do open, so the silence above is the
    // back's and not a gesture that never reached anything.
    const bigot = handRoot(must(handOf(view)[0], "a hand card").instanceId);
    fireEvent.pointerEnter(bigot, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(PAST_ANY_INSPECT_DELAY_MS);
    });
    const preview = screen.getByTestId(INSPECT_HOVER);
    // The overlay is a sibling of the root (a portal), never inside it.
    expect(bigot.contains(preview)).toBe(false);
    fireEvent.pointerLeave(bigot, { pointerType: "mouse" });
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();

    fireEvent.pointerDown(bigot, { pointerType: "touch", clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(PAST_ANY_INSPECT_DELAY_MS);
    });
    expect(screen.getByTestId(INSPECT_SHEET)).toBeInTheDocument();
  });

  it("B16 CardBack alone is span.cf-back plus span.card-back-mark, with no text, no <text> or <title>", () => {
    const { container } = render(<CardBack />);
    expect(container.querySelector("span.cf-back")).not.toBeNull();
    expect(container.querySelector("span.card-back-mark")).not.toBeNull();
    expect(container.textContent).toBe("");
    expect(container.querySelectorAll("text, title")).toHaveLength(0);
    for (const svg of container.querySelectorAll("svg")) expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(container.innerHTML).not.toMatch(/core-\d+|data-def-id|data-testid/);
  });
});

/* ----------------------------------------------------------------------------------------- B17 */

describe("B17: everything Card.tsx rendered before, it still renders", () => {
  it("B17 Card.tsx keeps every export", () => {
    expect(typeof CardModule.default).toBe("function");
    expect(CardModule.default).toBe(Card);
    for (const name of [
      "cx",
      "isLegal",
      "isSelected",
      "legalAttr",
      "encodeTarget",
      "decodeTarget",
      "beginDrag",
      "allowDrop",
      "completeDrop",
      "PopLayer",
    ] as const) {
      expect(typeof CardModule[name], name).toBe("function");
    }
    expect(typeof CardModule.DRAG_MIME).toBe("string");
    expect(CardModule.DRAG_MIME).not.toBe("");

    // The helpers Zone, Backrow and Board already call, with the meaning they rely on.
    expect(CardModule.cx("card", false, "radiant")).toBe("card radiant");
    const lit = highlightOf(["card-u1"], ["card-u1"]);
    expect(CardModule.isLegal(lit, "card-u1")).toBe(true);
    expect(CardModule.isLegal(lit, "card-u2")).toBe(false);
    expect(CardModule.isLegal(undefined, "card-u1")).toBe(false);
    expect(CardModule.isSelected(lit, "card-u1")).toBe(true);
    expect(CardModule.isSelected(lit, "card-u2")).toBe(false);
    expect(CardModule.legalAttr(true)).toBe("true");
    expect(CardModule.legalAttr(false)).toBe("false");
  });

  it("B17 CardProps and Pops are unchanged: a back from { card: null }, and a PopLayer from a Pops", () => {
    const props: CardModule.CardProps = { card: null, className: "card-hand" };
    const { container } = render(<Card {...props} />);
    const back = inside(container, ".card");
    expect(back.classList.contains("card-back")).toBe(true);
    expect(back.classList.contains("card-hand")).toBe(true);
    cleanup();

    const pops: CardModule.Pops = { damage: 3, heal: 2, loss: 5 };
    const layer = render(<CardModule.PopLayer pops={pops} />).container;
    expect(inside(layer, ".pop-layer > .damage-pop")).toHaveTextContent("3");
    expect(inside(layer, ".pop-layer > .heal-pop")).toHaveTextContent("2");
    expect(inside(layer, ".pop-layer > .loss-pop")).toHaveTextContent("5");
  });

  it("B17 the root keeps its classes: card, card-unit or card-spell, radiant, and the caller's className", () => {
    const view = fullBoardView();
    const container = renderBoard(view);

    for (const root of faceUpRoots(container)) {
      const classes = root.classList;
      expect(classes.contains("card"), root.dataset.testid).toBe(true);
      expect(Number(classes.contains("card-unit")) + Number(classes.contains("card-spell")), root.dataset.testid).toBe(1);
    }
    for (const u of allUnits(view)) {
      expect(cardRoot(u.instanceId).classList.contains("card-unit"), u.defId).toBe(true);
      expect(cardRoot(u.instanceId).classList.contains("radiant"), u.defId).toBe(u.radiant);
    }
    for (const c of handOf(view)) {
      expect(handRoot(c.instanceId).classList.contains("card-hand"), c.defId).toBe(true);
      expect(handRoot(c.instanceId).classList.contains("radiant"), c.defId).toBe(c.radiant);
    }
    expect(cardRoot(yourBackrow(view, 1).instanceId).classList.contains("card-backrow")).toBe(true);
    expect(cardRoot(yourBackrow(view, 5).instanceId).classList.contains("radiant")).toBe(true);
  });

  it("B17 the root keeps data-def-id, data-radiant, data-owner, data-controller, data-position and data-can-act", () => {
    const view = fullBoardView();
    renderBoard(view);

    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      expect(root.getAttribute("data-def-id"), u.instanceId).toBe(u.defId);
      expect(root.getAttribute("data-radiant") === "true", u.instanceId).toBe(u.radiant);
      expect(root.getAttribute("data-position"), u.instanceId).toBe(u.position);
      expect(root.hasAttribute("data-owner"), u.instanceId).toBe(true);
      expect(root.hasAttribute("data-controller"), u.instanceId).toBe(true);
    }

    // Different seats read differently; a seat reads the same as owner and as controller.
    const mine = cardRoot(yourUnit(view, 1).instanceId);
    const theirs = cardRoot(enemyUnit(view, 1).instanceId);
    expect(mine.getAttribute("data-owner")).not.toBe(theirs.getAttribute("data-owner"));
    expect(mine.getAttribute("data-owner")).toBe(mine.getAttribute("data-controller"));
    expect(theirs.getAttribute("data-owner")).toBe(theirs.getAttribute("data-controller"));

    // canAct false (lane 5) against canAct true (lane 1).
    const rested = cardRoot(yourUnit(view, 5).instanceId);
    expect(rested.getAttribute("data-can-act")).not.toBe(mine.getAttribute("data-can-act"));
    expect(rested.hasAttribute("data-can-act") || mine.hasAttribute("data-can-act")).toBe(true);

    for (const c of handOf(view)) {
      expect(handRoot(c.instanceId).getAttribute("data-def-id")).toBe(c.defId);
      expect(handRoot(c.instanceId).getAttribute("data-radiant") === "true").toBe(c.radiant);
    }
    const trap = yourBackrow(view, 5);
    expect(cardRoot(trap.instanceId).getAttribute("data-def-id")).toBe(trap.defId);
    expect(cardRoot(trap.instanceId).getAttribute("data-radiant")).toBe("true");
    expect(cardRoot(trap.instanceId).hasAttribute("data-owner")).toBe(true);
    expect(cardRoot(trap.instanceId).hasAttribute("data-controller")).toBe(true);
  });

  it("B17 a DEF card's root carries exactly the rotation as its inline style, and no other root has a style", () => {
    const view = fullBoardView();
    const container = renderBoard(view);
    const defIds = new Set(allUnits(view).filter((u) => u.position === "DEF").map((u) => testid.card(u.instanceId)));
    expect(defIds.size).toBe(2);

    for (const root of faceUpRoots(container)) {
      const id = root.getAttribute("data-testid") ?? "";
      if (defIds.has(id)) {
        expect(root.style.length, id).toBe(1);
        expect(root.style.transform, id).toBe("rotate(90deg) scale(0.72)");
      } else {
        expect(root.getAttribute("style"), id).toBeNull();
      }
    }
    for (const back of backs(container)) expect(back.getAttribute("style")).toBeNull();
  });

  it("B17 data-legal, aria-disabled, tabIndex, draggable, data-selected and data-animating keep their meaning", () => {
    const view = fullBoardView();
    const legal = yourUnit(view, 1);
    const illegal = yourUnit(view, 2);
    const id = testid.card(legal.instanceId);
    const animating: AnimatingMap = new Map([[id, "buffed" as const]]);
    renderBoard(view, { highlight: highlightOf([id], [id]), animating });

    const root = cardRoot(legal.instanceId);
    expect(root.getAttribute("data-legal")).toBe("true");
    expect(root.hasAttribute("aria-disabled")).toBe(false);
    expect(root.getAttribute("tabindex")).toBe("0");
    expect(root.getAttribute("draggable")).toBe("true");
    expect(root.getAttribute("data-selected")).toBe("true");
    expect(root.getAttribute("data-animating")).toBe("buffed");

    const other = cardRoot(illegal.instanceId);
    expect(other.getAttribute("data-legal")).toBe("false");
    expect(other.getAttribute("aria-disabled")).toBe("true");
    expect(other.getAttribute("data-selected")).not.toBe("true");
    expect(other.hasAttribute("data-animating")).toBe(false);
  });

  it("B17 a click or Enter on a legal card (or anywhere inside its face) reports it; an illegal card reports nothing", () => {
    const view = fullBoardView();
    const legal = yourUnit(view, 1);
    const illegal = yourUnit(view, 2);
    const onClick = vi.fn<(target: ClickTarget) => void>();
    renderBoard(view, { highlight: highlightOf([testid.card(legal.instanceId)]), onClick });

    const other = cardRoot(illegal.instanceId);
    fireEvent.click(other);
    fireEvent.keyDown(other, { key: "Enter" });
    fireEvent.click(inside(other, ".card-name"));
    expect(onClick).not.toHaveBeenCalled();

    const root = cardRoot(legal.instanceId);
    const target: ClickTarget = { on: "unit", instanceId: legal.instanceId, side: "you", lane: 1 };
    fireEvent.click(root);
    expect(onClick).toHaveBeenLastCalledWith(target);
    fireEvent.keyDown(root, { key: "Enter" });
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(onClick).toHaveBeenLastCalledWith(target);
    fireEvent.click(inside(root, ".card-name"));
    expect(onClick).toHaveBeenCalledTimes(3);
    expect(onClick).toHaveBeenLastCalledWith(target);
  });

  it("B17 .cost-gem[data-cost] and .card-name survive on every face-up card, minion, compact and full", () => {
    const view = fullBoardView();
    const container = renderBoard(view);
    for (const root of faceUpRoots(container)) {
      const id = root.getAttribute("data-testid") ?? "";
      expect(root.querySelectorAll(".cost-gem[data-cost]"), id).toHaveLength(1);
      expect(root.querySelectorAll(".card-name"), id).toHaveLength(1);
    }
    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      expect(inside(root, ".cost-gem").getAttribute("data-cost"), u.defId).toBe(String(u.cost));
      expect(inside(root, ".card-name").textContent, u.defId).toBe(nameOf(u.defId));
    }
    // Ceaseless Void on the board at 0 against its printed 100: the minion's gem is marked down.
    const voidCard = cardRoot(enemyUnit(view, 5).instanceId);
    expect(inside(voidCard, ".cost-gem").getAttribute("data-tone")).toBe("down");
  });

  it("B17 the minion keeps .stats: .stat-attack[data-attack], .stat-health[data-health][data-max-health] reading health/max", () => {
    const view = fullBoardView();
    renderBoard(view);
    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      const stats = inside(root, ".stats");
      const attack = inside(stats, ".stat.stat-attack");
      expect(attack.getAttribute("data-attack"), u.defId).toBe(String(u.attack));
      expect(attack.textContent, u.defId).toBe(String(u.attack));
      const health = inside(stats, ".stat.stat-health");
      expect(health.getAttribute("data-health"), u.defId).toBe(String(u.health));
      expect(health.getAttribute("data-max-health"), u.defId).toBe(String(u.maxHealth));
      expect(health.textContent, u.defId).toBe(`${u.health}/${u.maxHealth}`);
      expect(inside(health, ".cf-max").textContent, u.defId).toBe(`/${u.maxHealth}`);
    }
  });

  it("B17 .stat-armor[data-armor] only when armor is above 0", () => {
    const view = fullBoardView();
    renderBoard(view);
    for (const u of allUnits(view)) {
      const armor = cardRoot(u.instanceId).querySelector(".stats .stat.stat-armor");
      if (u.armor > 0) {
        expect(armor, u.defId).not.toBeNull();
        expect(armor?.getAttribute("data-armor"), u.defId).toBe(String(u.armor));
      } else {
        expect(armor, u.defId).toBeNull();
      }
    }
  });

  it("B17 one [data-keyword] badge per keyword, with the two-letter mark and its number", () => {
    const view = fullBoardView();
    renderBoard(view);
    const everything = yourUnit(view, 2);
    const root = cardRoot(everything.instanceId);

    for (const keyword of everything.keywords) {
      const badges = root.querySelectorAll<HTMLElement>(`.keywords > [data-keyword="${keyword.kind}"]`);
      expect(badges, keyword.kind).toHaveLength(1);
      const badge = badges[0] as HTMLElement;
      const mark = KEYWORD_MARK[keyword.kind];
      if ("n" in keyword) {
        expect(badge.textContent, keyword.kind).toBe(`${mark} ${keyword.n}`);
        expect(badge.getAttribute("data-n"), keyword.kind).toBe(String(keyword.n));
      } else {
        expect(badge.textContent, keyword.kind).toBe(mark);
        expect(badge.hasAttribute("data-n"), keyword.kind).toBe(false);
      }
      expect((badge.getAttribute("title") ?? "").trim(), keyword.kind).not.toBe("");
    }
    expect(root.querySelectorAll("[data-keyword]")).toHaveLength(KEYWORD_KINDS.length);
  });

  it("B17 a unit with no keywords has no badge, and one with a single keyword has exactly one", () => {
    const view = fullBoardView();
    renderBoard(view);
    expect(cardRoot(yourUnit(view, 5).instanceId).querySelectorAll("[data-keyword]")).toHaveLength(0);
    const taunt = cardRoot(yourUnit(view, 1).instanceId).querySelectorAll("[data-keyword]");
    expect(taunt).toHaveLength(1);
    expect(taunt[0]?.getAttribute("data-keyword")).toBe("Taunt");
  });

  it("B17 .shield-icon[data-icon=shield][aria-label='Divine Shield'] while Divine Shield, and not otherwise", () => {
    const view = fullBoardView();
    renderBoard(view);
    for (const u of allUnits(view)) {
      const shield = cardRoot(u.instanceId).querySelector(".shield-icon");
      if (u.keywords.some((k) => k.kind === "Divine Shield")) {
        expect(shield, u.defId).not.toBeNull();
        expect(shield?.getAttribute("data-icon"), u.defId).toBe("shield");
        expect(shield?.getAttribute("aria-label"), u.defId).toBe("Divine Shield");
      } else {
        expect(shield, u.defId).toBeNull();
      }
    }
  });

  it("B17 counters, the buried badge, the position tag and the switch button survive, outside .cf", () => {
    const view = fullBoardView();
    renderBoard(view);

    const counted = cardRoot(yourUnit(view, 2).instanceId);
    const plague = inside(counted, '.counter.counter-plague[data-counter="plague"]');
    const grade = inside(counted, '.counter.counter-grade[data-counter="grade"]');
    expect(plague).toHaveTextContent("2");
    expect(grade).toHaveTextContent("3");

    const trap = cardRoot(yourBackrow(view, 2).instanceId);
    const trapGrade = inside(trap, '.counter.counter-grade[data-counter="grade"]');
    expect(trapGrade).toHaveTextContent("2");

    const pile = cardRoot(yourUnit(view, 4).instanceId);
    const buried = inside(pile, '.buried-badge[data-buried="3"]');
    expect(buried).toHaveTextContent("3");

    const defUnit = yourUnit(view, 3);
    const def = cardRoot(defUnit.instanceId);
    const tag = inside(def, ".position-tag");

    const switchButton = inside(def, `[data-testid="${testid.switchPosition(defUnit.instanceId)}"]`);
    expect(switchButton.tagName).toBe("BUTTON");
    const first = yourUnit(view, 1);
    expect(inside(cardRoot(first.instanceId), `[data-testid="${testid.switchPosition(first.instanceId)}"]`).tagName).toBe(
      "BUTTON",
    );

    for (const [what, el, root] of [
      ["plague counter", plague, counted],
      ["grade counter", grade, counted],
      ["backrow grade counter", trapGrade, trap],
      ["buried badge", buried, pile],
      ["position tag", tag, def],
      ["switch button", switchButton, def],
    ] as const) {
      expect(el.closest(".cf"), `${what} sits outside .cf`).toBeNull();
      expect(el.closest(".card"), `${what} belongs to its own card`).toBe(root);
    }

    // No badge where the view has none.
    expect(cardRoot(first.instanceId).querySelector(".buried-badge")).toBeNull();
    expect(cardRoot(first.instanceId).querySelector(".counter")).toBeNull();
  });

  it("B17 a damage pop renders in .pop-layer on the card, outside .cf", () => {
    const view = fullBoardView();
    const target = yourUnit(view, 1);
    const id = testid.card(target.instanceId);
    const withDamage: PlayerView = {
      ...view,
      events: [{ type: "damage", sourceId: null, targetId: target.instanceId, amount: 3, combat: true }],
    };
    renderBoard(withDamage, { animating: new Map([[id, "damage" as const]]) });

    const pop = inside(cardRoot(target.instanceId), ".pop-layer > .damage-pop");
    expect(pop).toHaveTextContent("3");
    expect(pop.closest(".cf")).toBeNull();
    expect(cardRoot(yourUnit(view, 2).instanceId).querySelector(".damage-pop")).toBeNull();
  });

  it("B17 with no catalog every face-up card still renders, named by its def id", () => {
    const view = fullBoardView();
    renderBoard(view, {}, false);
    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      expect(inside(root, ".card-name").textContent, u.instanceId).toBe(u.defId);
      expect(inside(root, ".stat-attack").getAttribute("data-attack"), u.instanceId).toBe(String(u.attack));
    }
    for (const c of handOf(view)) {
      expect(inside(handRoot(c.instanceId), ".card-name").textContent).toBe(c.defId);
    }
  });
});

/* ----------------------------------------------------------------------------------------- B18 */

describe("B18: Card picks its form from its props", () => {
  it("B18 a unit is the minion form, with an oval CardArt in .cf-portrait", () => {
    const view = fullBoardView();
    renderBoard(view);
    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      expect(root.getAttribute("data-face"), u.defId).toBe("minion");
      const cf = inside(root, ".cf");
      expect(cf.getAttribute("data-layout"), u.defId).toBe("minion");
      inside(cf, ".cf-portrait > .cf-art.cf-art--oval");
      expect(cf.querySelector(".card-text"), u.defId).toBeNull();
    }
  });

  it("B18 a face-up backrow card is the compact form, and .card-type reads the BackrowView.type (no catalog)", () => {
    const view = fullBoardView();
    renderBoard(view, {}, false);
    for (const lane of [1, 2, 5]) {
      const slot = yourBackrow(view, lane);
      const root = cardRoot(slot.instanceId);
      expect(root.getAttribute("data-face"), slot.defId).toBe("compact");
      const cf = inside(root, ".cf");
      expect(cf.getAttribute("data-layout"), slot.defId).toBe("compact");
      expect(inside(cf, ".card-type").textContent, slot.defId).toBe(slot.type);
      expect(cf.querySelector(".card-text"), slot.defId).toBeNull();
      expect(cf.querySelector(".cf-stats"), slot.defId).toBeNull();
      expect(cf.querySelector(".cf-tags"), slot.defId).toBeNull();
    }
  });

  it("B18 a face-up backrow card with the catalog is compact, typed and named from its def", () => {
    const base = fullBoardView();
    const breadAndButter = faceUpBackrow("p1", { defId: "core-018", type: "Field Trap" }) as FaceUpBackrow;
    const view: PlayerView = {
      ...base,
      you: { ...base.you, backrow: [breadAndButter, ...base.you.backrow.slice(1)] },
    };
    renderBoard(view);
    const root = cardRoot(breadAndButter.instanceId);
    expect(root.getAttribute("data-face")).toBe("compact");
    expect(inside(root, ".card-type").textContent).toBe("Field Trap");
    expect(inside(root, ".card-name").textContent).toBe("Bread and Butter");
    expect(root.querySelector(".card-text")).toBeNull();
  });

  it("B18 with the catalog loaded, .card-type still reads the BackrowView.type where the def's type differs", () => {
    const view = fullBoardView();
    const lanes = [1, 2, 5].map((lane) => yourBackrow(view, lane));
    const mismatched = lanes.filter((slot) => must(CATALOG[slot.defId], slot.defId).type !== slot.type);
    // The premise: the fixture files catalog Units and a Field Spell under other backrow types.
    expect(mismatched.map((slot) => slot.defId)).toEqual(["core-020", "core-061", "core-084"]);

    renderBoard(view);
    for (const slot of mismatched) {
      const root = cardRoot(slot.instanceId);
      expect(root.getAttribute("data-face"), slot.defId).toBe("compact");
      expect(root.getAttribute("data-card-type"), slot.defId).toBe(slot.type);
      const cf = inside(root, ".cf");
      expect(cf.getAttribute("data-card-type"), slot.defId).toBe(slot.type);
      expect(inside(cf, ".card-type").textContent, slot.defId).toBe(slot.type);
      // The rest of the face still comes from the def.
      expect(inside(cf, ".card-name").textContent, slot.defId).toBe(nameOf(slot.defId));
    }
  });

  it("B18 a hand card is the full form, with .card-text", () => {
    const view = fullBoardView();
    renderBoard(view);
    const bigot = must(handOf(view)[0], "Bigot in hand");
    const root = handRoot(bigot.instanceId);
    expect(root.getAttribute("data-face")).toBe("full");
    const cf = inside(root, ".cf");
    expect(cf.getAttribute("data-layout")).toBe("full");
    expect(inside(cf, ".card-text").textContent).toContain("Cry:");
    for (const c of handOf(view)) {
      expect(handRoot(c.instanceId).getAttribute("data-face"), c.defId).toBe("full");
      inside(handRoot(c.instanceId), ".card-text");
    }
  });

  it("B18 a card mid-resolution is the full form, with .card-text", () => {
    const base = fullBoardView();
    const flood = card({ defId: "core-017", cost: 3 });
    const view: PlayerView = { ...base, you: { ...base.you, resolving: [flood] } };
    renderBoard(view);
    const root = cardRoot(flood.instanceId);
    expect(screen.getByTestId("resolving-you").contains(root)).toBe(true);
    expect(root.getAttribute("data-face")).toBe("full");
    expect(inside(root, ".card-text").textContent).toContain("Bounce all units on both sides");
  });
});

/* ----------------------------------------------------------------------------------------- B19 */

describe("B19: what a face-up root adds", () => {
  it("B19 cf-host and cf-host--<form> on every face-up root", () => {
    const base = fullBoardView();
    const view: PlayerView = { ...base, you: { ...base.you, resolving: [card({ defId: "core-017" })] } };
    const container = renderBoard(view);
    for (const root of faceUpRoots(container)) {
      const form = root.getAttribute("data-face") ?? "";
      expect(["minion", "full", "compact"], root.dataset.testid).toContain(form);
      expect(root.classList.contains("cf-host"), root.dataset.testid).toBe(true);
      expect(root.classList.contains(`cf-host--${form}`), root.dataset.testid).toBe(true);
    }
  });

  it("B19 data-rarity when known and data-card-type (the prop type first, then the def's)", () => {
    const view = fullBoardView();
    renderBoard(view);
    const gary = cardRoot(yourUnit(view, 1).instanceId);
    expect(gary.getAttribute("data-rarity")).toBe("Common");
    expect(gary.getAttribute("data-card-type")).toBe("Unit");
    const cube = cardRoot(enemyUnit(view, 3).instanceId);
    expect(cube.getAttribute("data-rarity")).toBe("Epic");

    const curvature = handRoot(must(handOf(view)[3], "Professor Curvature").instanceId);
    expect(curvature.getAttribute("data-rarity")).toBe("Rare");
    expect(curvature.getAttribute("data-card-type")).toBe("Unit");

    // The backrow's `type` prop wins over the def's type on the root.
    for (const lane of [1, 2, 5]) {
      const slot = yourBackrow(view, lane);
      expect(cardRoot(slot.instanceId).getAttribute("data-card-type"), slot.defId).toBe(slot.type);
    }
    expect(cardRoot(yourBackrow(view, 5).instanceId).getAttribute("data-rarity")).toBe("Rare");
  });

  it("B19 with no catalog there is no data-rarity anywhere, but data-card-type is still set", () => {
    const view = fullBoardView();
    const container = renderBoard(view, {}, false);
    for (const root of faceUpRoots(container)) {
      expect(root.hasAttribute("data-rarity"), root.dataset.testid).toBe(false);
      expect((root.getAttribute("data-card-type") ?? "") !== "", root.dataset.testid).toBe(true);
    }
    expect(container.querySelectorAll("[data-rarity]")).toHaveLength(0);
    for (const lane of [1, 2, 5]) {
      const slot = yourBackrow(view, lane);
      expect(cardRoot(slot.instanceId).getAttribute("data-card-type")).toBe(slot.type);
    }
  });

  it("B19 data-field-trap=true on a Field Trap, and on nothing else", () => {
    const view = fullBoardView();
    const container = renderBoard(view);
    const fieldTrap = cardRoot(yourBackrow(view, 2).instanceId);
    expect(yourBackrow(view, 2).type).toBe("Field Trap");
    expect(fieldTrap.getAttribute("data-field-trap")).toBe("true");
    const marked = [...faceUpRoots(container), ...backs(container)].filter((root) => root.hasAttribute("data-field-trap"));
    expect(marked).toEqual([fieldTrap]);
  });

  it("B19 no title on a face-up root while hover previews are on (the default)", () => {
    const container = renderBoard(fullBoardView());
    for (const root of faceUpRoots(container)) expect(root.hasAttribute("title"), root.dataset.testid).toBe(false);
  });

  it("B19 title is the card's name while hover previews are off", () => {
    writeCardSettings({ hoverPreviews: false });
    const view = fullBoardView();
    renderBoard(view);
    for (const c of handOf(view)) expect(handRoot(c.instanceId).getAttribute("title")).toBe(nameOf(c.defId));
    for (const u of allUnits(view)) expect(cardRoot(u.instanceId).getAttribute("title")).toBe(nameOf(u.defId));
    const slot = yourBackrow(view, 1);
    expect(cardRoot(slot.instanceId).getAttribute("title")).toBe(nameOf(slot.defId));
  });

  it("B19 every keyword badge has the classes keyword and keyword-icon", () => {
    const container = renderBoard(fullBoardView());
    const badges = [...container.querySelectorAll("[data-keyword]")];
    expect(badges.length).toBeGreaterThan(KEYWORD_KINDS.length);
    for (const badge of badges) {
      expect(badge.classList.contains("keyword"), badge.getAttribute("data-keyword") ?? "").toBe(true);
      expect(badge.classList.contains("keyword-icon"), badge.getAttribute("data-keyword") ?? "").toBe(true);
    }
  });

  it("B19 no unit draws an asleep or exhausted mark from canAct, which is false for every enemy unit on your turn", () => {
    // canAct is "the controller is active and has an exertion left" (viewFor.ts), and a
    // summoning-sick unit may still switch (§4.1): it says neither "asleep" nor "can attack".
    const view = fullBoardView();
    const container = renderBoard(view);
    const enemy = { ...enemyUnit(view, 1), canAct: false };
    const rested = yourUnit(view, 5);
    expect(rested.canAct).toBe(false);
    for (const u of allUnits(view)) {
      expect(cardRoot(u.instanceId).querySelector(".cf-exhausted"), u.defId).toBeNull();
    }
    expect(container.querySelector(".cf-exhausted, .cf-icon--exhausted")).toBeNull();
    cleanup();
    renderBoard({ ...view, opponent: { ...view.opponent, units: [enemy, ...view.opponent.units.slice(1)] } });
    expect(cardRoot(enemy.instanceId).querySelector(".cf-exhausted")).toBeNull();
    // The state is still on the root for anyone who reads it as state.
    expect(cardRoot(enemy.instanceId).getAttribute("data-can-act")).toBe("false");
  });

  it("B19 keyword chips: Taunt, Divine Shield and plated Armor are drawn as states, the rest as at most three chips", () => {
    const view = fullBoardView();
    renderBoard(view);
    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      const visible = [...root.querySelectorAll<HTMLElement>(".keywords > [data-keyword]:not([data-chip='hidden'])")];
      const more = root.querySelector<HTMLElement>(".keywords > .cf-kw-more");
      const chips = u.keywords.filter(
        (k) => k.kind !== "Taunt" && k.kind !== "Divine Shield" && !(k.kind === "Armor" && u.armor > 0),
      );
      // Every keyword keeps its badge in the DOM (e2e reads [data-keyword]).
      expect(root.querySelectorAll("[data-keyword]"), u.defId).toHaveLength(u.keywords.length);
      if (chips.length <= 3) {
        expect(visible.map((chip) => chip.getAttribute("data-keyword")), u.defId).toEqual(chips.map((k) => k.kind));
        expect(more, u.defId).toBeNull();
      } else {
        expect(visible, u.defId).toHaveLength(2);
        expect(more?.textContent, u.defId).toBe(`+${String(chips.length - 2)}`);
        expect(more?.hasAttribute("data-keyword"), u.defId).toBe(false);
        expect(more?.getAttribute("title"), u.defId).toContain(chips[2]?.kind ?? "");
      }
    }
    // The fixture's lane-2 unit carries every keyword, so the fold is exercised.
    expect(cardRoot(yourUnit(view, 2).instanceId).querySelector(".cf-kw-more")).not.toBeNull();
  });

  it("B19 the .cf of a unit with Taunt has data-taunt=true, and no other unit's does", () => {
    const view = fullBoardView();
    renderBoard(view);
    for (const u of allUnits(view)) {
      const cf = inside(cardRoot(u.instanceId), ".cf");
      if (u.keywords.some((k) => k.kind === "Taunt")) expect(cf.getAttribute("data-taunt"), u.defId).toBe("true");
      else expect(cf.hasAttribute("data-taunt"), u.defId).toBe(false);
    }
  });

  it("B19 minion stat tones compare the view's numbers with the printed face", () => {
    const view = fullBoardView();
    renderBoard(view);
    const tones = (u: UnitView): [string | null, string | null] => {
      const root = cardRoot(u.instanceId);
      return [
        inside(root, ".stat-attack").getAttribute("data-tone"),
        inside(root, ".stat-health").getAttribute("data-tone"),
      ];
    };
    // Gary the Gambler prints 1/1; the view has 2 attack and 1 of 3 health.
    expect(tones(yourUnit(view, 1))).toEqual(["buffed", "damaged"]);
    // Mr. Vanilla prints 3/3; the view has 4/4.
    expect(tones(enemyUnit(view, 1))).toEqual(["buffed", "buffed"]);
    // Radiant Carnivorous Cube prints 8/12 radiant; the view has 6 attack and 2 of 2.
    expect(tones(enemyUnit(view, 3))).toEqual(["reduced", "reduced"]);
    // Ceaseless Void prints 10/10; the view has 10/10.
    expect(tones(enemyUnit(view, 5))).toEqual(["base", "base"]);
  });

  it("B19 with no catalog every minion's tones are base", () => {
    const view = fullBoardView();
    renderBoard(view, {}, false);
    for (const u of allUnits(view)) {
      const root = cardRoot(u.instanceId);
      expect(inside(root, ".stat-attack").getAttribute("data-tone"), u.defId).toBe("base");
      const health = inside(root, ".stat-health").getAttribute("data-tone");
      // Damage is visible without a catalog: health below max is still "damaged" or plain "base".
      expect(["base", "damaged"], u.defId).toContain(health);
    }
  });
});

/* ----------------------------------------------------------------------------------------- B20 */

describe("B20: one .card per card, and the name lookups still land", () => {
  it("B20 no element inside a card carries the card class token", () => {
    const base = fullBoardView();
    const view: PlayerView = { ...base, you: { ...base.you, resolving: [card({ defId: "core-017" })] } };
    const container = renderBoard(view);
    for (const root of container.querySelectorAll(".card")) {
      expect(root.querySelectorAll(".card"), root.getAttribute("data-testid") ?? "a back").toHaveLength(0);
    }
  });

  it("B20 the fixture board holds 20 field cards, and the stacked pile's zone holds one", () => {
    const container = renderBoard(fullBoardView());
    expect(container.querySelectorAll(".field .card")).toHaveLength(20);
    expect(screen.getByTestId(testid.zone("you", "units", 4)).querySelectorAll(".card")).toHaveLength(1);
    for (const side of ["you", "opponent"] as const) {
      for (const row of ["units", "backrow"] as const) {
        for (const lane of [1, 2, 3, 4, 5]) {
          expect(screen.getByTestId(testid.zone(side, row, lane)).querySelectorAll(".card"), `${side} ${row} ${lane}`).toHaveLength(1);
        }
      }
    }
  });

  it("B20 every card- and hand-card- testid is a card root, and there are exactly as many as face-up cards", () => {
    const view = fullBoardView();
    const container = renderBoard(view);
    const field = [...container.querySelectorAll<HTMLElement>('[data-testid^="card-"]')];
    const hand = [...container.querySelectorAll<HTMLElement>('[data-testid^="hand-card-"]')];
    // 10 units, plus 4 face-up backrow cards (three of yours, one of the opponent's).
    expect(field).toHaveLength(14);
    expect(hand).toHaveLength(handOf(view).length);
    for (const root of [...field, ...hand]) {
      expect(root.classList.contains("card"), root.dataset.testid).toBe(true);
      expect(root.querySelectorAll('[data-testid^="card-"], [data-testid^="hand-card-"]'), root.dataset.testid).toHaveLength(0);
    }
  });

  it("B20 cy.fieldCardByName and cy.handCardByName, emulated, resolve to the named card", () => {
    const view = fullBoardView();
    const container = renderBoard(view);

    // support/commands.ts: get the prefixed roots, `.contains(name)`, `.closest(prefix)`. The first
    // root in document order whose text holds the name is the one Cypress would land on.
    const resolve = (prefix: string, name: string): Element | undefined =>
      [...container.querySelectorAll(`[data-testid^="${prefix}"]`)].find((root) => (root.textContent ?? "").includes(name));

    const fieldCards: { instanceId: string; defId: string }[] = [
      ...allUnits(view),
      ...[...view.you.backrow, ...view.opponent.backrow].filter(
        (slot): slot is FaceUpBackrow => slot !== null && !slot.faceDown,
      ),
    ];
    for (const c of fieldCards) {
      expect(resolve("card-", nameOf(c.defId)), nameOf(c.defId)).toBe(cardRoot(c.instanceId));
    }
    for (const c of handOf(view)) {
      expect(resolve("hand-card-", nameOf(c.defId)), nameOf(c.defId)).toBe(handRoot(c.instanceId));
    }
  });
});
