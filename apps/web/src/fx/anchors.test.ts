// docs/polish/1-animations.md S8: `anchors.ts`, where an effect plays and how the shake reaches the
// board (the board half of B35). Until now only the Cypress component spec drove these, and
// `pnpm test` never runs it.
//
// jsdom lays nothing out, so every element reports a 0×0 rect. Each test gives the elements it
// needs a rect of its own; an element left alone is exactly the "not laid out" case S8 names.

import { afterEach, describe, expect, it } from "vitest";

import { boardShakeSink, pointIn, resolveAnchor } from "./anchors.ts";
import type { FxBox } from "./types.ts";

afterEach(() => {
  document.body.innerHTML = "";
});

/** Gives `el` a viewport rect, the way layout would. */
function place(el: Element, box: FxBox): void {
  const rect = {
    x: box.x,
    y: box.y,
    left: box.x,
    top: box.y,
    width: box.width,
    height: box.height,
    right: box.x + box.width,
    bottom: box.y + box.height,
    toJSON: () => ({}),
  };
  el.getBoundingClientRect = () => rect as DOMRect;
}

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html;
  document.body.appendChild(root);
  return root;
}

function byTestid(testid: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (el === null) throw new Error(`no ${testid}`);
  return el;
}

const CARD: FxBox = { x: 300, y: 200, width: 90, height: 126 };

describe("S8 resolveAnchor", () => {
  it("S8 a testid anchor resolves to its element's viewport rect", () => {
    mount('<div data-testid="card-u1"></div>');
    place(byTestid("card-u1"), CARD);

    expect(resolveAnchor({ kind: "testid", testid: "card-u1" })).toEqual(CARD);
  });

  it("S8 a testid anchor's `at` point does not change the box it resolves to", () => {
    mount('<div data-testid="zone-you-units-3"></div>');
    place(byTestid("zone-you-units-3"), CARD);

    expect(resolveAnchor({ kind: "testid", testid: "zone-you-units-3", at: { x: 0.5, y: 1 } })).toEqual(CARD);
  });

  it("S8 a testid that is not rendered resolves to null", () => {
    mount('<div data-testid="card-u1"></div>');
    place(byTestid("card-u1"), CARD);

    expect(resolveAnchor({ kind: "testid", testid: "card-u2" })).toBeNull();
  });

  it("S8 an element with a 0×0 rect (not laid out) resolves to null", () => {
    mount('<div data-testid="card-u1"></div>');

    expect(byTestid("card-u1").getBoundingClientRect().width).toBe(0);
    expect(resolveAnchor({ kind: "testid", testid: "card-u1" })).toBeNull();
  });

  it("S8 a crystal anchor resolves to the index-th .mana-crystal in mana-<side>", () => {
    mount(
      '<div data-testid="mana-you"><span class="mana-crystal"></span><span class="mana-crystal"></span><span class="mana-crystal"></span></div>' +
        '<div data-testid="mana-opponent"><span class="mana-crystal"></span><span class="mana-crystal"></span></div>',
    );
    const tray = byTestid("mana-you");
    place(tray, { x: 10, y: 600, width: 200, height: 24 });
    const crystals = tray.querySelectorAll(".mana-crystal");
    crystals.forEach((crystal, i) => place(crystal, { x: 10 + 22 * i, y: 602, width: 20, height: 20 }));
    const enemy = byTestid("mana-opponent");
    place(enemy, { x: 10, y: 40, width: 200, height: 24 });
    enemy.querySelectorAll(".mana-crystal").forEach((crystal, i) => place(crystal, { x: 10 + 22 * i, y: 42, width: 20, height: 20 }));

    expect(resolveAnchor({ kind: "crystal", side: "you", index: 0 })).toEqual({ x: 10, y: 602, width: 20, height: 20 });
    expect(resolveAnchor({ kind: "crystal", side: "you", index: 2 })).toEqual({ x: 54, y: 602, width: 20, height: 20 });
    expect(resolveAnchor({ kind: "crystal", side: "opponent", index: 1 })).toEqual({ x: 32, y: 42, width: 20, height: 20 });
  });

  it("S8 a crystal index past the tray's crystals falls back to the tray's box", () => {
    mount('<div data-testid="mana-you"><span class="mana-crystal"></span></div>');
    const tray = byTestid("mana-you");
    place(tray, { x: 10, y: 600, width: 200, height: 24 });
    place(tray.querySelector(".mana-crystal")!, { x: 10, y: 602, width: 20, height: 20 });

    expect(resolveAnchor({ kind: "crystal", side: "you", index: 7 })).toEqual({ x: 10, y: 600, width: 200, height: 24 });
  });

  it("S8 a crystal that is not laid out falls back to the tray's box", () => {
    mount('<div data-testid="mana-you"><span class="mana-crystal"></span></div>');
    place(byTestid("mana-you"), { x: 10, y: 600, width: 200, height: 24 });

    expect(resolveAnchor({ kind: "crystal", side: "you", index: 0 })).toEqual({ x: 10, y: 600, width: 200, height: 24 });
  });

  it("S8 a crystal anchor with no tray, or a tray that is not laid out, resolves to null", () => {
    expect(resolveAnchor({ kind: "crystal", side: "you", index: 0 })).toBeNull();

    mount('<div data-testid="mana-you"><span class="mana-crystal"></span></div>');
    expect(resolveAnchor({ kind: "crystal", side: "you", index: 0 })).toBeNull();
  });

  it("S8 a viewport anchor is a zero-size box at (innerWidth·x, innerHeight·y)", () => {
    const win = { innerWidth: 1000, innerHeight: 800 } as Window;

    expect(resolveAnchor({ kind: "viewport", at: { x: 0.5, y: 0.45 } }, document, win)).toEqual({
      x: 500,
      y: 360,
      width: 0,
      height: 0,
    });
    expect(resolveAnchor({ kind: "viewport", at: { x: 0, y: 1 } }, document, win)).toEqual({ x: 0, y: 800, width: 0, height: 0 });
  });

  it("S8 a viewport anchor reads the page's own window by default", () => {
    expect(resolveAnchor({ kind: "viewport", at: { x: 0.25, y: 0.5 } })).toEqual({
      x: window.innerWidth * 0.25,
      y: window.innerHeight * 0.5,
      width: 0,
      height: 0,
    });
  });

  it("S8 anchors resolve against the document they are given", () => {
    const other = document.implementation.createHTMLDocument("other");
    const el = other.createElement("div");
    el.setAttribute("data-testid", "hero-opponent");
    other.body.appendChild(el);
    place(el, { x: 600, y: 20, width: 120, height: 120 });

    expect(resolveAnchor({ kind: "testid", testid: "hero-opponent" })).toBeNull();
    expect(resolveAnchor({ kind: "testid", testid: "hero-opponent" }, other)).toEqual({ x: 600, y: 20, width: 120, height: 120 });
  });
});

describe("S8 a hand anchor is where the hand's cards are", () => {
  // Review: the strip runs the whole board width while the cards sit at its left, so a drawn card's
  // ghost landed in the middle of empty table (x 640 at 1280x720, with the last card at 284-343).
  const STRIP: FxBox = { x: 20, y: 637, width: 1240, height: 89 };

  function hand(testid: string, cards: FxBox[]): HTMLElement {
    const html = cards.map(() => '<div class="card"></div>').join("");
    mount(`<div data-testid="${testid}"><span class="pile"></span><div class="hand-cards">${html}</div></div>`);
    const strip = byTestid(testid);
    place(strip, STRIP);
    strip.querySelectorAll(".card").forEach((card, index) => place(card, cards[index]!));
    return strip;
  }

  it("S8 a hand resolves to its cards plus the slot the next card takes, not the whole strip (B53)", () => {
    hand("hand-you", [
      { x: 110, y: 640, width: 60, height: 82 },
      { x: 176, y: 640, width: 60, height: 82 },
      { x: 242, y: 640, width: 60, height: 82 },
    ]);
    // Cards from 110 to 302, and one step of 66 more for the card that is coming.
    expect(resolveAnchor({ kind: "testid", testid: "hand-you" })).toEqual({ x: 110, y: 640, width: 258, height: 82 });
    const centre = pointIn(resolveAnchor({ kind: "testid", testid: "hand-you" })!);
    expect(centre.x).toBeLessThan(STRIP.x + STRIP.width / 2);
  });

  it("S8 the opponent's hand of backs resolves the same way, and one card steps by its own width", () => {
    hand("hand-opponent", [{ x: 90, y: 10, width: 50, height: 70 }]);
    expect(resolveAnchor({ kind: "testid", testid: "hand-opponent" })).toEqual({ x: 90, y: 10, width: 100, height: 70 });
  });

  it("S8 the next card's slot never runs past the strip, and an empty hand is the strip", () => {
    hand("hand-you", [
      { x: 1100, y: 640, width: 60, height: 82 },
      { x: 1190, y: 640, width: 60, height: 82 },
    ]);
    expect(resolveAnchor({ kind: "testid", testid: "hand-you" })).toEqual({ x: 1100, y: 640, width: 160, height: 82 });
    document.body.innerHTML = "";
    hand("hand-opponent", []);
    expect(resolveAnchor({ kind: "testid", testid: "hand-opponent" })).toEqual(STRIP);
  });

  it("S8 a hand strip that is not laid out still resolves to null", () => {
    mount('<div data-testid="hand-you"><div class="card"></div></div>');
    expect(resolveAnchor({ kind: "testid", testid: "hand-you" })).toBeNull();
  });
});

describe("S8 pointIn", () => {
  it("S8 pointIn is the box's centre by default", () => {
    expect(pointIn(CARD)).toEqual({ x: 345, y: 263 });
  });

  it("S8 pointIn places `at` as fractions of the box's width and height", () => {
    expect(pointIn(CARD, { x: 0.5, y: 1 })).toEqual({ x: 345, y: 326 });
    expect(pointIn(CARD, { x: 0, y: 0 })).toEqual({ x: 300, y: 200 });
  });

  it("S8 pointIn of a zero-size viewport box is that point", () => {
    expect(pointIn({ x: 640, y: 324, width: 0, height: 0 })).toEqual({ x: 640, y: 324 });
  });
});

describe("B35 boardShakeSink: the shake reaches the board as CSS translate and rotate", () => {
  const OFFSET = { x: 3.5, y: -2.25, angle: 0.4 };

  it("B35 apply writes translate and rotate on [data-testid=\"board\"]", () => {
    mount('<div data-testid="board"></div>');
    const board = byTestid("board");

    boardShakeSink().apply(OFFSET);

    expect(board.style.getPropertyValue("translate")).not.toBe("");
    expect(parseFloat(board.style.getPropertyValue("translate"))).toBeCloseTo(3.5);
    expect(board.style.getPropertyValue("rotate")).toMatch(/deg$/);
    expect(parseFloat(board.style.getPropertyValue("rotate"))).toBeCloseTo(0.4);
    expect(board.style.getPropertyValue("transform")).toBe("");
  });

  it("B35 clear restores a board that had no inline translate or rotate to none", () => {
    mount('<div data-testid="board"></div>');
    const board = byTestid("board");
    const sink = boardShakeSink();

    sink.apply(OFFSET);
    sink.apply({ x: -1, y: 1, angle: -0.2 });
    sink.clear();

    expect(board.style.getPropertyValue("translate")).toBe("");
    expect(board.style.getPropertyValue("rotate")).toBe("");
  });

  it("B35 clear restores the board's prior inline values, priority included", () => {
    mount('<div data-testid="board"></div>');
    const board = byTestid("board");
    board.style.setProperty("translate", "5px 6px");
    board.style.setProperty("rotate", "2deg", "important");
    const sink = boardShakeSink();

    sink.apply(OFFSET);
    expect(parseFloat(board.style.getPropertyValue("translate"))).toBeCloseTo(3.5);
    sink.clear();

    expect(board.style.getPropertyValue("translate")).toBe("5px 6px");
    expect(board.style.getPropertyPriority("translate")).toBe("");
    expect(board.style.getPropertyValue("rotate")).toBe("2deg");
    expect(board.style.getPropertyPriority("rotate")).toBe("important");
  });

  it("B35 the prior values are the ones from before the first shaking frame, not the shake's own", () => {
    mount('<div data-testid="board"></div>');
    const board = byTestid("board");
    board.style.setProperty("translate", "1px 1px");
    const sink = boardShakeSink();

    for (let i = 0; i < 5; i += 1) sink.apply({ x: i, y: -i, angle: i / 10 });
    sink.clear();

    expect(board.style.getPropertyValue("translate")).toBe("1px 1px");
    expect(board.style.getPropertyValue("rotate")).toBe("");
  });

  it("B35 a board replaced mid-shake gets its own values back, and the new board shakes", () => {
    const root = mount('<div data-testid="board"></div>');
    const first = byTestid("board");
    first.style.setProperty("translate", "4px 0px");
    const sink = boardShakeSink();

    sink.apply(OFFSET);
    first.remove();
    root.innerHTML = '<div data-testid="board"></div>';
    const second = byTestid("board");
    sink.apply(OFFSET);

    expect(first.style.getPropertyValue("translate")).toBe("4px 0px");
    expect(second.style.getPropertyValue("translate")).not.toBe("");

    sink.clear();
    expect(second.style.getPropertyValue("translate")).toBe("");
    expect(second.style.getPropertyValue("rotate")).toBe("");
  });

  it("B35 with no board on the page, apply and clear do nothing and never throw", () => {
    const sink = boardShakeSink();

    expect(() => sink.apply(OFFSET)).not.toThrow();
    expect(() => sink.clear()).not.toThrow();
  });

  it("B35 clear without a shake leaves the board's inline values alone", () => {
    mount('<div data-testid="board"></div>');
    const board = byTestid("board");
    board.style.setProperty("translate", "7px 8px");

    boardShakeSink().clear();

    expect(board.style.getPropertyValue("translate")).toBe("7px 8px");
  });

  it("B35 the sink shakes the board of the document it is given", () => {
    const other = document.implementation.createHTMLDocument("other");
    const board = other.createElement("div");
    board.setAttribute("data-testid", "board");
    other.body.appendChild(board);
    mount('<div data-testid="board"></div>');

    const sink = boardShakeSink(other);
    sink.apply(OFFSET);

    expect(board.style.getPropertyValue("translate")).not.toBe("");
    expect(byTestid("board").style.getPropertyValue("translate")).toBe("");
    sink.clear();
    expect(board.style.getPropertyValue("translate")).toBe("");
  });
});
