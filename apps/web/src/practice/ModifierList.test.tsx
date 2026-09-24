// R169 in the practice HUD: every live modifier, in full, one tap away (practice/ModifierList.tsx).

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { baseView, fullBoardView, opponentModifiers, yourModifiers } from "../test/fixtures.ts";
import { ModifierList } from "./ModifierList.tsx";
import { practiceTestid } from "./testids.ts";

afterEach(() => {
  cleanup();
});

describe("R169 the HUD's modifier list", () => {
  it("shows nothing while no modifier is live on either side", () => {
    const { container } = render(<ModifierList view={baseView()} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId(practiceTestid.modifiers)).toBeNull();
  });

  it("counts both sides' modifiers and opens every label in full, grouped You and AI", () => {
    render(<ModifierList view={fullBoardView()} />);
    const chip = screen.getByTestId(practiceTestid.modifiers);
    const count = yourModifiers.length + opponentModifiers.length;
    expect(chip).toHaveAttribute("data-count", String(count));
    expect(chip).toHaveAccessibleName(`${String(count)} active modifiers`);
    expect(chip).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId(practiceTestid.modifiersPanel)).toBeNull();

    fireEvent.click(chip);
    const panel = screen.getByTestId(practiceTestid.modifiersPanel);
    expect(chip).toHaveAttribute("aria-expanded", "true");
    for (const modifier of [...yourModifiers, ...opponentModifiers]) {
      expect(panel).toHaveTextContent(modifier.label);
    }
    expect(panel.querySelector('[data-side="you"]')?.textContent).toContain(yourModifiers[0]?.label ?? "");
    expect(panel.querySelector('[data-side="opponent"]')?.textContent).toContain(opponentModifiers[0]?.label ?? "");
  });

  it("closes on Escape, on a tap outside, and on the chip again", () => {
    render(<ModifierList view={fullBoardView()} />);
    const chip = screen.getByTestId(practiceTestid.modifiers);

    fireEvent.click(chip);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(practiceTestid.modifiersPanel)).toBeNull();

    fireEvent.click(chip);
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId(practiceTestid.modifiersPanel)).toBeNull();

    fireEvent.click(chip);
    fireEvent.pointerDown(screen.getByTestId(practiceTestid.modifiersPanel));
    expect(screen.getByTestId(practiceTestid.modifiersPanel), "a tap inside the list keeps it open").toBeInTheDocument();
    fireEvent.click(chip);
    expect(screen.queryByTestId(practiceTestid.modifiersPanel)).toBeNull();
  });
});
