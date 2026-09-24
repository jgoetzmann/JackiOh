// The game log's wording for events the view redacted (SPEC §10.10, R97, R177). The log is built
// from the event payload alone, so a redacted payload must not read as a real statement.

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import Log from "./Log.tsx";
import { testid } from "./contract.ts";
import { fullBoardView, withEvents } from "../test/fixtures.ts";

afterEach(cleanup);

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
