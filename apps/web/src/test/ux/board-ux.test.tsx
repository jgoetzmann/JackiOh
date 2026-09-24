// Polish task 7, B25, B26, B27, B33, B43 and B44 (docs/polish/7-mobile-ux.md, Surface S5, S6, S8,
// S11): the board's own UX, rendered through `<Board/>` with a hand-built `Highlight` (and through
// `<Game/>` for B44, whose picker only a play in flight opens).
//
// `glow` is set by hand here, as `highlightFor` would set it, so these tests are about what the
// board does with a highlight and never about how the highlight was derived (that is glow.test.ts).
// Settings are flipped through the store's public `writeSettings`; each test starts from the
// defaults, because storage is cleared and the store's cache forgotten after every test.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Board from "../../game/Board.tsx";
import Game from "../../game/Game.tsx";
import { NO_HIGHLIGHT, type Highlight } from "../../game/contract.ts";
import { hasMovesLeft } from "../../game/glow.ts";
import { __resetSettingsForTests, writeSettings } from "../../settings/index.ts";
import { baseView, card, emptySide, heroPower, pendingFor, unit } from "../fixtures.ts";

afterEach(() => {
  cleanup();
  localStorage.clear();
  __resetSettingsForTests();
});

// ---------------------------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------------------------

/** Three cards in your hand, one unit on your side, a hero power; the opponent holds four cards. */
function boardView(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hero: { health: 30, armor: 0, powers: [heroPower], power: heroPower },
      hand: [
        card({ instanceId: "h1", defId: "core-008" }),
        card({ instanceId: "h2", defId: "core-005" }),
        card({ instanceId: "h3", defId: "core-019" }),
      ],
      units: [unit("p1", { instanceId: "u1" }), null, null, null, null],
    }),
    opponent: emptySide("p2", { hand: { count: 4 } }),
    ...over,
  });
}

function highlight(legal: string[], glow?: string[], selected: string[] = []): Highlight {
  const base = { legal: new Set(legal), selected: new Set(selected) };
  return glow === undefined ? base : { ...base, glow: new Set(glow) };
}

/** A highlight in which a hand card can still be played: `end-turn` does not glow. */
const MOVES_LEFT = highlight(["end-turn", "offer-draw", "concede", "hand-card-h1"], ["hand-card-h1"]);
/** A highlight in which ending the turn is all that is left: `end-turn` glows. */
const NOTHING_LEFT = highlight(["end-turn", "offer-draw", "concede"], ["end-turn"]);

function endTurn(): HTMLElement {
  return screen.getByTestId("end-turn");
}

function slotOf(testid: string): HTMLElement {
  const slot = screen.getByTestId(testid).closest<HTMLElement>(".hand-slot");
  if (slot === null) throw new Error(`${testid} is not inside a .hand-slot`);
  return slot;
}

/** An inline custom property, read from the style object or, failing that, the style attribute. */
function inlineVar(element: HTMLElement, name: string): string {
  const fromStyle = element.style.getPropertyValue(name).trim();
  if (fromStyle !== "") return fromStyle;
  const match = new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(element.getAttribute("style") ?? "");
  return match?.[1]?.trim() ?? "";
}

function setConfirmEndTurn(on: boolean): void {
  act(() => {
    writeSettings({ confirmEndTurn: on });
  });
}

// ---------------------------------------------------------------------------------------------
// B25: confirm end turn
// ---------------------------------------------------------------------------------------------

describe("B25 confirm end turn asks twice only while a move is left", () => {
  it("B25 with the setting on and a card still playable, the first click arms end-turn and sends nothing", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(<Board view={boardView()} highlight={MOVES_LEFT} onControl={onControl} />);

    fireEvent.click(endTurn());

    expect(onControl).not.toHaveBeenCalled();
    expect(endTurn()).toHaveAttribute("data-confirm", "armed");
    expect(endTurn()).toHaveTextContent("Confirm end turn");
  });

  it("B25 the second click on the armed button ends the turn", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(<Board view={boardView()} highlight={MOVES_LEFT} onControl={onControl} />);

    fireEvent.click(endTurn());
    fireEvent.click(endTurn());

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onControl).toHaveBeenCalledWith("end-turn");
  });

  it("B25 a new view disarms it, so the next click arms again rather than ending the turn", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    const { rerender } = render(<Board view={boardView()} highlight={MOVES_LEFT} onControl={onControl} />);
    fireEvent.click(endTurn());
    expect(endTurn()).toHaveAttribute("data-confirm", "armed");

    // The view after some other action: a crystal spent.
    const next = boardView();
    rerender(
      <Board
        view={{ ...next, you: { ...next.you, mana: { current: 3, max: 4 } } }}
        highlight={MOVES_LEFT}
        onControl={onControl}
      />,
    );

    expect(endTurn()).not.toHaveAttribute("data-confirm");
    expect(endTurn()).not.toHaveTextContent("Confirm end turn");
    fireEvent.click(endTurn());
    expect(onControl).not.toHaveBeenCalled();
    expect(endTurn()).toHaveAttribute("data-confirm", "armed");
  });

  it.each([
    ["a unit that can attack", "card-u1"],
    ["the hero power", "power"],
    ["another playable card", "hand-card-h2"],
  ])("B25 %s counts as a move left", (_label, testid) => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(
      <Board
        view={boardView()}
        highlight={highlight(["end-turn", testid], [testid])}
        onControl={onControl}
      />,
    );

    fireEvent.click(endTurn());

    expect(onControl).not.toHaveBeenCalled();
    expect(endTurn()).toHaveAttribute("data-confirm", "armed");
  });

  it("B25 with the setting off (the default), one click ends the turn even with moves left", () => {
    const onControl = vi.fn();
    render(<Board view={boardView()} highlight={MOVES_LEFT} onControl={onControl} />);

    fireEvent.click(endTurn());

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onControl).toHaveBeenCalledWith("end-turn");
    expect(endTurn()).not.toHaveAttribute("data-confirm");
  });

  it("B25 with nothing left but ending the turn, one click ends it even with the setting on", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(<Board view={boardView()} highlight={NOTHING_LEFT} onControl={onControl} />);

    fireEvent.click(endTurn());

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(onControl).toHaveBeenCalledWith("end-turn");
    expect(endTurn()).not.toHaveAttribute("data-confirm");
  });

  it("B25 a highlight with no glow at all is no moves left: one click ends the turn", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(
      <Board view={boardView()} highlight={highlight(["end-turn", "hand-card-h1"])} onControl={onControl} />,
    );

    fireEvent.click(endTurn());

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(endTurn()).not.toHaveAttribute("data-confirm");
  });

  it("B25 a glowing zone or hero is not a move left: one click ends the turn", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(
      <Board
        view={boardView()}
        highlight={highlight(["end-turn", "zone-you-units-2", "hero-opponent"], ["zone-you-units-2", "hero-opponent"])}
        onControl={onControl}
      />,
    );

    fireEvent.click(endTurn());

    expect(onControl).toHaveBeenCalledTimes(1);
    expect(endTurn()).not.toHaveAttribute("data-confirm");
  });

  it("B25 an end-turn the engine did not list never arms and never fires", () => {
    setConfirmEndTurn(true);
    const onControl = vi.fn();
    render(
      <Board view={boardView()} highlight={highlight(["hand-card-h1"], ["hand-card-h1"])} onControl={onControl} />,
    );

    fireEvent.click(endTurn());
    fireEvent.click(endTurn());

    expect(onControl).not.toHaveBeenCalled();
    expect(endTurn()).not.toHaveAttribute("data-confirm");
  });

  it.each<[string, Highlight | undefined]>([
    ["no highlight at all", undefined],
    ["NO_HIGHLIGHT", NO_HIGHLIGHT],
    ["a legal hand card that does not glow", highlight(["hand-card-h1"])],
    ["an empty glow", highlight([], [])],
    ["a glowing end-turn", NOTHING_LEFT],
    ["a glowing zone", highlight(["zone-you-units-1"], ["zone-you-units-1"])],
    ["a glowing hero", highlight(["hero-opponent"], ["hero-opponent"])],
    ["a glowing offer-draw", highlight(["offer-draw"], ["offer-draw"])],
  ])("B25 hasMovesLeft is false for %s", (_label, given) => {
    expect(hasMovesLeft(given)).toBe(false);
  });

  it.each<[string, string]>([
    ["a glowing hand card", "hand-card-h1"],
    ["a glowing card on the field", "card-u1"],
    ["the glowing power", "power"],
  ])("B25 hasMovesLeft is true for %s", (_label, testid) => {
    expect(hasMovesLeft(highlight([testid], [testid]))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// B26: the hand fan and tap-to-lift
// ---------------------------------------------------------------------------------------------

describe("B26 each hand card sits in a slot and a tap lifts it", () => {
  it("B26 each of your hand cards sits in its own .hand-slot, in hand order, with --i its index inside a fan of --n", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    const hand = screen.getByTestId("hand-you");
    const slots = [...hand.querySelectorAll<HTMLElement>(".hand-slot")];
    expect(slots).toHaveLength(3);
    slots.forEach((slot, index) => {
      const cards = slot.querySelectorAll('[data-testid^="hand-card-"]');
      expect(cards).toHaveLength(1);
      expect(cards[0]).toHaveAttribute("data-testid", `hand-card-h${index + 1}`);
      expect(inlineVar(slot, "--i")).toBe(String(index));
      // Nothing is lifted until something lifts it: the attribute is absent, never "false".
      expect(slot).not.toHaveAttribute("data-lifted");
    });

    const fan = hand.querySelector<HTMLElement>(".hand-cards");
    expect(fan).not.toBeNull();
    if (fan !== null) expect(inlineVar(fan, "--n")).toBe("3");
    expect(hand).toHaveAttribute("data-count", "3");
    expect(screen.getByTestId("hand-opponent")).toHaveAttribute("data-count", "4");
  });

  it("B26 a click lifts a hand card even when it is not legal, and fires nothing", () => {
    const onClick = vi.fn();
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} onClick={onClick} />);

    fireEvent.click(screen.getByTestId("hand-card-h2"));

    expect(slotOf("hand-card-h2")).toHaveAttribute("data-lifted", "true");
    expect(slotOf("hand-card-h1")).not.toHaveAttribute("data-lifted");
    expect(onClick).not.toHaveBeenCalled();
  });

  it("B26 a second click lowers it", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);
    const target = screen.getByTestId("hand-card-h2");

    fireEvent.click(target);
    fireEvent.click(target);

    expect(slotOf("hand-card-h2")).not.toHaveAttribute("data-lifted");
  });

  it("B26 a real tap on the lifted card (pointerdown, then click) lowers it: its own pointerdown is not outside the hand", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);
    const target = screen.getByTestId("hand-card-h2");
    fireEvent.pointerDown(target);
    fireEvent.click(target);
    expect(slotOf("hand-card-h2")).toHaveAttribute("data-lifted", "true");

    fireEvent.pointerDown(target);
    expect(slotOf("hand-card-h2")).toHaveAttribute("data-lifted", "true");
    fireEvent.click(target);

    expect(slotOf("hand-card-h2")).not.toHaveAttribute("data-lifted");
  });

  it("B26 a pointerdown outside the hand lowers it", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);
    fireEvent.click(screen.getByTestId("hand-card-h3"));
    expect(slotOf("hand-card-h3")).toHaveAttribute("data-lifted", "true");

    fireEvent.pointerDown(screen.getByTestId("zone-you-units-2"));

    expect(slotOf("hand-card-h3")).not.toHaveAttribute("data-lifted");
  });

  it("B26 the selected hand card is lifted without a click", () => {
    const selected = highlight(["hand-card-h2"], ["hand-card-h2"], ["hand-card-h2"]);
    render(<Board view={boardView()} highlight={selected} />);

    expect(slotOf("hand-card-h2")).toHaveAttribute("data-lifted", "true");
    expect(slotOf("hand-card-h1")).not.toHaveAttribute("data-lifted");
  });

  it("B26 the selected hand card stays lifted through a pointerdown outside the hand and a click on it", () => {
    const onClick = vi.fn();
    const selected = highlight(["hand-card-h2"], ["hand-card-h2"], ["hand-card-h2"]);
    render(<Board view={boardView()} highlight={selected} onClick={onClick} />);

    fireEvent.pointerDown(screen.getByTestId("zone-you-units-2"));
    expect(slotOf("hand-card-h2")).toHaveAttribute("data-lifted", "true");

    fireEvent.click(screen.getByTestId("hand-card-h2"));
    fireEvent.click(screen.getByTestId("hand-card-h2"));

    // The board reports the clicks; while the highlight still says selected, the card stays up.
    expect(onClick).toHaveBeenCalledTimes(2);
    expect(slotOf("hand-card-h2")).toHaveAttribute("data-lifted", "true");
  });

  it("B26 the opponent's hand never lifts", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);
    const opponent = screen.getByTestId("hand-opponent");
    const backs = [...opponent.querySelectorAll<HTMLElement>('[data-face-down="true"]')];
    expect(backs).toHaveLength(4);

    for (const back of backs) fireEvent.click(back);

    expect(opponent.querySelectorAll("[data-lifted]")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// B27: settings reflected on the board
// ---------------------------------------------------------------------------------------------

describe("B27 the board reflects drag to play and hover previews, live", () => {
  it("B27 by default the board says data-drag=on and your hand says data-hover-preview=on", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    expect(screen.getByTestId("board")).toHaveAttribute("data-drag", "on");
    expect(screen.getByTestId("hand-you")).toHaveAttribute("data-hover-preview", "on");
  });

  it("B27 with drag to play off before render, the board says data-drag=off", () => {
    writeSettings({ dragToPlay: false });
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    expect(screen.getByTestId("board")).toHaveAttribute("data-drag", "off");
  });

  it("B27 with hover previews off before render, your hand says data-hover-preview=off", () => {
    writeSettings({ hoverPreviews: false });
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    expect(screen.getByTestId("hand-you")).toHaveAttribute("data-hover-preview", "off");
  });

  it("B27 data-drag follows the setting while the board is mounted", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    act(() => {
      writeSettings({ dragToPlay: false });
    });
    expect(screen.getByTestId("board")).toHaveAttribute("data-drag", "off");

    act(() => {
      writeSettings({ dragToPlay: true });
    });
    expect(screen.getByTestId("board")).toHaveAttribute("data-drag", "on");
  });

  it("B27 data-hover-preview follows the setting while the board is mounted", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    act(() => {
      writeSettings({ hoverPreviews: false });
    });
    expect(screen.getByTestId("hand-you")).toHaveAttribute("data-hover-preview", "off");

    act(() => {
      writeSettings({ hoverPreviews: true });
    });
    expect(screen.getByTestId("hand-you")).toHaveAttribute("data-hover-preview", "on");
  });

  it("B27 changing one setting leaves the other attribute alone", () => {
    render(<Board view={boardView()} highlight={NO_HIGHLIGHT} />);

    act(() => {
      writeSettings({ dragToPlay: false });
    });

    expect(screen.getByTestId("hand-you")).toHaveAttribute("data-hover-preview", "on");
  });
});

// ---------------------------------------------------------------------------------------------
// B33: safe areas and the 390 px width scan, read off the stylesheets
// ---------------------------------------------------------------------------------------------

function css(file: "board.css" | "prompt.css"): string {
  return readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "game", file), "utf8");
}

/** A `padding` or `padding-*` declaration whose value uses `env(<inset>)`. */
function padsWith(text: string, inset: string): boolean {
  const declaration = /padding(?:-[a-z-]+)?\s*:([^;}]*)/g;
  for (const match of text.matchAll(declaration)) {
    if (new RegExp(`env\\(\\s*${inset}\\b`).test(match[1] ?? "")) return true;
  }
  return false;
}

describe("B33 the board and the prompt pad for the safe areas, and the board declares no width over 390 px", () => {
  it("B33 board.css pads with env(safe-area-inset-bottom), -left and -right", () => {
    const text = css("board.css");

    expect(padsWith(text, "safe-area-inset-bottom")).toBe(true);
    expect(padsWith(text, "safe-area-inset-left")).toBe(true);
    expect(padsWith(text, "safe-area-inset-right")).toBe(true);
  });

  it("B33 prompt.css pads with env(safe-area-inset-bottom)", () => {
    expect(padsWith(css("prompt.css"), "safe-area-inset-bottom")).toBe(true);
  });

  it("B33 board.css declares no px width or min-width over 390", () => {
    const text = css("board.css");
    // A declaration, not a media feature: `(max-width: 600px)` and `(min-width: 1025px)` are
    // preceded by "(" and are not matched; `max-width` is not a width floor either.
    const widths = [...text.matchAll(/(?:^|[\s;{])((?:min-)?width)\s*:\s*(\d+(?:\.\d+)?)px/g)].map((match) => ({
      property: match[1],
      px: Number(match[2]),
    }));

    expect(text).toContain(".board");
    const tooWide = widths.filter((width) => width.px > 390);
    expect(tooWide).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B43: the log on a phone
// ---------------------------------------------------------------------------------------------

describe("B43 a phone opens the log from the control bar", () => {
  it("B43 log-toggle opens the log over the board (data-log=open) and closes it again", () => {
    render(<Board view={boardView()} highlight={NOTHING_LEFT} />);
    const toggle = screen.getByTestId("log-toggle");
    const board = screen.getByTestId("board");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAccessibleName("Show the game log");
    expect(board).not.toHaveAttribute("data-log");

    fireEvent.click(toggle);
    expect(board).toHaveAttribute("data-log", "open");
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(toggle).toHaveAccessibleName("Hide the game log");

    fireEvent.click(toggle);
    expect(board).not.toHaveAttribute("data-log");
  });

  it("B43 board.css hides the toggle by default, shows it on phones, and shows the log while it is open", () => {
    const text = css("board.css");

    expect(text).toMatch(/\n\.log-toggle\s*\{\s*display:\s*none;/);
    const phones = text.slice(text.indexOf("@media (max-width: 600px), (orientation: landscape) and (max-height: 500px)"));
    expect(phones).toMatch(/\.board \.control-bar \.log-toggle\s*\{[^}]*display:\s*inline-grid/);
    expect(phones).toMatch(/\.board\[data-log="open"\] > \.log\s*\{[^}]*display:\s*block/);
  });
});

// ---------------------------------------------------------------------------------------------
// B44: which route opened a picker, for the phone's slim bar
// ---------------------------------------------------------------------------------------------

describe("B44 the picker says which route opened it", () => {
  it("B44 a play's zone pick is data-prompt-source=play, and an engine prompt is data-prompt-source=engine", () => {
    const legal = [
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 2 } },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 3 } },
      { type: "endTurn" },
    ] as const;
    const { unmount } = render(<Game view={boardView()} legal={[...legal]} onAction={vi.fn()} />);
    fireEvent.click(screen.getByTestId("hand-card-h1"));

    const play = screen.getByTestId("prompt-modal");
    expect(play).toHaveAttribute("data-prompt-kind", "zone");
    expect(play).toHaveAttribute("data-prompt-source", "play");
    unmount();

    const pending = pendingFor("target", [{ key: "hero:p2", label: "Enemy hero", player: "p2" }]);
    render(<Game view={boardView({ pending })} legal={[]} onAction={vi.fn()} />);
    expect(screen.getByTestId("prompt-modal")).toHaveAttribute("data-prompt-source", "engine");
  });

  it("B44 prompt.css makes a play's board pick a slim bar only on a phone held upright with drag to play on", () => {
    const text = css("prompt.css");
    const portrait = text.slice(text.lastIndexOf("@media (max-width: 600px) {"));

    expect(portrait).toContain('.game:has(> .board[data-drag="on"]) .prompt[data-prompt-source="play"]:is(');
    expect(portrait).toMatch(/> :is\(\.prompt-count, \.prompt-zones, \.prompt-list, \.prompt-board-note\) \{\s*display: none;/);
  });
});
