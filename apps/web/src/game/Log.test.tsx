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
