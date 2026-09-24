// The game log's wording for events the view redacted (SPEC §10.10, R97, R177). The log is built
// from the event payload alone, so a redacted payload must not read as a real statement.

import { CATALOG } from "@jackioh/cards";
import type { GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { INSPECT_CLOSE, INSPECT_HOVER, INSPECT_SHEET, closeInspect } from "../cards/index.ts";
import { HOVER_DELAY_MS } from "../cards/inspect/index.ts";
import Log, { LOG_CARD_TESTID } from "./Log.tsx";
import { CatalogContext, lookupFromDefs } from "./catalog.ts";
import { testid } from "./contract.ts";
import { baseView, fullBoardView, withEvents } from "../test/fixtures.ts";

afterEach(() => {
  cleanup();
  closeInspect();
  vi.useRealTimers();
});

describe("Log: redacted events", () => {
  it("R177 says a hidden card was buffed rather than '+0/+0', and names a public buff in full", () => {
    const view = fullBoardView();
    const mine = view.you.units.find((unit) => unit !== null)?.instanceId ?? "";
    const logged = withEvents(view, [
      { type: "buffed", instanceId: "hidden", attack: 0, health: 0 },
      { type: "buffed", instanceId: mine, attack: 2, health: 1 },
    ]);

    render(<Log view={logged} />);

    const lines = [...screen.getByTestId(testid.log).querySelectorAll(".log-line")].map((li) => li.textContent);
    expect(lines[0]).toBe("A hidden card was buffed");
    expect(lines[1]).toMatch(/gained \+2\/\+1$/);
    expect(lines.join("\n")).not.toContain("+0/+0");
  });
});

describe("Log: a line never prints an id or the sentinel (integration QA)", () => {
  function lines(): string[] {
    return [...screen.getByTestId(testid.log).querySelectorAll(".log-line")].map((li) => li.textContent ?? "");
  }

  it("R154 an opponent's trap the viewer may not read fires as a face-down trap, not as 'hidden'", () => {
    const view = fullBoardView();
    render(
      <Log
        view={withEvents(view, [
          { type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 2 },
        ])}
      />,
    );
    expect(lines()).toEqual(["The opponent's face-down trap fired"]);
  });

  it("names a unit that has left the board from the window's own public events, and never prints its id", () => {
    const view = fullBoardView();
    render(
      <Log
        view={withEvents(view, [
          { type: "summoned", player: "p2", instanceId: "c46", defId: "core-002", row: "units", lane: 1 },
          { type: "attackDeclared", attackerId: "c46", targetId: "hero-p1", forced: false },
          { type: "damage", sourceId: "c46", targetId: "c46", amount: 12, combat: true },
          { type: "attackDeclared", attackerId: "c99", targetId: "c98", forced: false },
        ])}
      />,
    );
    const text = lines();
    expect(text[1]).toBe("core-002 attacked your hero");
    expect(text[2]).toBe("core-002 took 12 damage in combat");
    // Nothing public ever named c99 or c98: they read as units, not as ids.
    expect(text[3]).toBe("A unit attacked a unit");
    expect(text.join("\n")).not.toMatch(/\bc\d+\b/);
  });

  it("says mana and summons in words, prints a modifier's label, and leaves out 'finished resolving'", () => {
    const view = fullBoardView();
    const modifier = view.you.modifiers[0];
    render(
      <Log
        view={withEvents(view, [
          { type: "manaChanged", player: "p1", current: 2, max: 2 },
          { type: "summoned", player: "p1", instanceId: "x1", defId: "core-015", row: "units", lane: 1 },
          { type: "cardResolved", instanceId: "x1", defId: "core-015" } as never,
          { type: "modifierChanged", player: "p1", modifierId: modifier?.id ?? "", added: true } as never,
          { type: "modifierChanged", player: "p2", modifierId: "m-gone", added: false } as never,
        ])}
      />,
    );
    const text = lines();
    expect(text[0]).toBe("You have 2/2 mana");
    expect(text[1]).toBe("core-015 entered your lane 1");
    expect(text).toHaveLength(4);
    expect(text[2]).toBe(`You gained "${modifier?.label ?? ""}"`);
    expect(text[3]).toBe("Opponent lost an effect");
  });

  it("ends the game in words", () => {
    render(<Log view={withEvents(fullBoardView(), [{ type: "gameOver", winner: "p2", reason: "concede" }])} />);
    expect(lines()).toEqual(["Opponent won. You conceded."]);
  });
});

describe("Log: a line about a card opens that card", () => {
  const lookup = lookupFromDefs(CATALOG);
  const nameOf = (defId: string): string => CATALOG[defId]?.name ?? defId;

  function renderLog(view: PlayerView): void {
    render(
      <CatalogContext.Provider value={lookup}>
        <Log view={view} />
      </CatalogContext.Provider>,
    );
  }

  function cardLines(): HTMLElement[] {
    return within(screen.getByTestId(testid.log)).queryAllByTestId(LOG_CARD_TESTID);
  }

  const PLAY: GameEvent = { type: "cardPlayed", player: "p2", instanceId: "c7", defId: "core-032", costPaid: 2 };

  it("hovering the line with a mouse shows the card's face after the hover delay; leaving hides it", () => {
    vi.useFakeTimers();
    renderLog(withEvents(baseView(), [PLAY]));
    const [line] = cardLines();
    expect(line).toBeDefined();
    if (line === undefined) return;
    expect(line.tagName).toBe("BUTTON");
    expect(line).toHaveAttribute("data-def-id", "core-032");
    expect(line).toHaveTextContent(`Opponent played ${nameOf("core-032")} for 2`);

    fireEvent.pointerEnter(line, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    });
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByTestId(INSPECT_HOVER)).toHaveTextContent(nameOf("core-032"));
    fireEvent.pointerLeave(line, { pointerType: "mouse" });
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("a click (a tap, Enter or Space on the button) opens the card in the sheet; Escape closes it and gives focus back", () => {
    renderLog(withEvents(baseView(), [PLAY]));
    const [line] = cardLines();
    if (line === undefined) throw new Error("no card line");
    line.focus();
    fireEvent.click(line);
    const sheet = screen.getByTestId(INSPECT_SHEET);
    expect(sheet).toHaveAttribute("role", "dialog");
    expect(sheet).toHaveTextContent(nameOf("core-032"));
    expect(screen.getByTestId(INSPECT_CLOSE)).toHaveFocus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(line).toHaveFocus();
  });

  it("R97 a line that names no card opens nothing: the sentinel, a hero, a draw, a mana change", () => {
    renderLog(
      withEvents(baseView(), [
        { type: "cardPlayed", player: "p2", instanceId: "hidden", defId: "hidden", costPaid: 1 },
        { type: "summoned", player: "p2", instanceId: "hidden", defId: "hidden", row: "backrow", lane: 3 },
        { type: "damage", sourceId: null, targetId: "hero-p1", amount: 3, combat: false },
        // Even the viewer's own draw, whose card it may read: the log never names a draw.
        { type: "drawn", player: "p1", instanceId: "c1", defId: "core-011" },
        { type: "manaChanged", player: "p1", current: 2, max: 2 },
        { type: "trapFired", instanceId: "hidden", defId: "hidden", controller: "p2", row: "backrow", lane: 2 },
      ] as GameEvent[]),
    );
    expect(cardLines()).toHaveLength(0);
    expect(screen.getByTestId(testid.log).innerHTML).not.toMatch(/core-\d+/);
  });

  it("names a unit that has left the board from the window's own events, as the line's words do", () => {
    renderLog(
      withEvents(baseView(), [
        { type: "summoned", player: "p2", instanceId: "c46", defId: "core-002", row: "units", lane: 1 },
        { type: "attackDeclared", attackerId: "c46", targetId: "hero-p1", forced: false },
        { type: "attackDeclared", attackerId: "c99", targetId: "c98", forced: false },
      ]),
    );
    const lines = cardLines();
    expect(lines.map((line) => line.getAttribute("data-def-id"))).toEqual(["core-002", "core-002"]);
    // "A unit attacked a unit" names nothing, so it opens nothing.
    expect(screen.getByText("A unit attacked a unit").querySelector(`[data-testid="${LOG_CARD_TESTID}"]`)).toBeNull();
  });

  it("a line about a card on the board opens the face the board shows it with, and a radiantSet the radiant one", () => {
    vi.useFakeTimers();
    const view = fullBoardView();
    const radiantUnit = view.you.units.find((u) => u !== null && u.radiant);
    if (radiantUnit === undefined || radiantUnit === null) throw new Error("the fixture has a radiant unit");
    renderLog(
      withEvents(view, [
        { type: "buffed", instanceId: radiantUnit.instanceId, attack: 1, health: 1 },
        {
          type: "radiantSet",
          instanceId: "c5",
          defId: "core-005",
          zone: { z: "graveyard", player: "p1" },
        } as GameEvent,
      ]),
    );
    const [buffed, radiant] = cardLines();
    if (buffed === undefined || radiant === undefined) throw new Error("two card lines");
    fireEvent.pointerEnter(buffed, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS);
    });
    expect(screen.getByTestId(INSPECT_HOVER).querySelector(".cf")).toHaveAttribute("data-radiant-face", "true");
    fireEvent.pointerLeave(buffed, { pointerType: "mouse" });
    fireEvent.pointerEnter(radiant, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS);
    });
    expect(screen.getByTestId(INSPECT_HOVER)).toHaveTextContent(nameOf("core-005"));
    expect(screen.getByTestId(INSPECT_HOVER).querySelector(".cf")).toHaveAttribute("data-radiant-face", "true");
  });
});
