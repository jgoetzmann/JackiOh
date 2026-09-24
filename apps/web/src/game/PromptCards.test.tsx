// Polish 6: the prompt pickers that offer cards (a mulligan, a Discover, a card from hand) draw each
// option as the card's face, with the same hover preview the hand has, instead of a text square.
// The picking itself is Prompt.test.tsx's and is unchanged: the option is still the
// `prompt-option-<key>` button, and a click still picks it.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { PlayerView } from "@jackioh/shared";

import { CARD_SETTINGS_DEFAULTS, INSPECT_HOVER, closeInspect, writeCardSettings } from "../cards/index.ts";
import { HOVER_DELAY_MS } from "../cards/inspect/constants.ts";
import { CatalogContext, lookupFromDefs } from "./catalog.ts";
import Prompt from "./Prompt.tsx";
import { baseView, card, emptySide, pendingFor } from "../test/fixtures.ts";

afterEach(() => {
  act(() => {
    closeInspect();
  });
  cleanup();
  vi.useRealTimers();
  writeCardSettings(CARD_SETTINGS_DEFAULTS);
});

const lookup = lookupFromDefs(CATALOG);

function nameOf(defId: string): string {
  const def = CATALOG[defId];
  if (def === undefined) throw new Error(`the catalog has no ${defId}`);
  return def.name;
}

/** The printed price a face's gem shows for a card with no live cost (a Discover option). */
function costOf(defId: string): string {
  const cost = CATALOG[defId]?.cost;
  return typeof cost === "number" || typeof cost === "string" ? String(cost) : String(cost?.base);
}

function renderPrompt(view: PlayerView, onAction = vi.fn()): void {
  render(
    <CatalogContext.Provider value={lookup}>
      <Prompt view={view} onAction={onAction} />
    </CatalogContext.Provider>,
  );
}

const DISCOVER = ["core-043", "core-055", "core-066"] as const;

function discoverView(): PlayerView {
  return baseView({
    you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-002" })] }),
    opponent: emptySide("p2", { hand: { count: 3 } }),
    pending: pendingFor(
      "discover",
      DISCOVER.map((defId) => ({ key: `mode:${defId}`, label: defId, defId })),
    ),
  });
}

describe("card options are card faces", () => {
  it("B42 each Discover option draws the full face of its card, named, with art, and no text square", () => {
    renderPrompt(discoverView());
    for (const defId of DISCOVER) {
      const option = screen.getByTestId(`prompt-option-mode:${defId}`);
      const face = option.querySelector(".cf-option > .cf");
      expect(face, defId).not.toBeNull();
      expect(face?.getAttribute("data-layout"), defId).toBe("full");
      expect(face?.querySelector(".card-name")?.textContent, defId).toBe(nameOf(defId));
      expect(face?.querySelector(".cf-art"), defId).not.toBeNull();
      expect(option.querySelector(".prompt-card-name"), defId).toBeNull();
      // The name, then the cost its gem shows (integration: the cost is read out, not only drawn).
      expect(option.getAttribute("aria-label"), defId).toBe(`${nameOf(defId)}, costs ${costOf(defId)}`);
    }
  });

  it("B42 a mulligan's options are the faces of the hand cards they name", () => {
    const view = baseView({
      you: emptySide("p1", {
        hand: [card({ instanceId: "h1", defId: "core-002" }), card({ instanceId: "h2", defId: "core-019" })],
      }),
      opponent: emptySide("p2", { hand: { count: 3 } }),
      pending: pendingFor(
        "mulligan",
        [
          { key: "h1", label: "One", instanceId: "h1" },
          { key: "h2", label: "Two", instanceId: "h2" },
        ],
        { min: 0, max: 2, prompt: "Keep which cards?" },
      ),
    });
    renderPrompt(view);
    const names = ["h1", "h2"].map(
      (key) => screen.getByTestId(`prompt-option-${key}`).querySelector(".cf .card-name")?.textContent,
    );
    expect(names).toEqual([nameOf("core-002"), nameOf("core-019")]);
  });

  // Integration (task 3's review of the mulligan): every card shows its cost, the one the hand
  // shows, opens kept (R9 names the cards kept; Hearthstone keeps the hand until a card is marked),
  // and says what Confirm will do to it.
  it("a mulligan's options show each card's live cost, open kept, and say Keep or Redraw", () => {
    const onAction = vi.fn();
    const view = baseView({
      you: emptySide("p1", {
        hand: [card({ instanceId: "h1", defId: "core-002", cost: 0 }), card({ instanceId: "h2", defId: "core-019", cost: 5 })],
      }),
      opponent: emptySide("p2", { hand: { count: 3 } }),
      pending: pendingFor(
        "mulligan",
        [
          { key: "h1", label: "One", instanceId: "h1" },
          { key: "h2", label: "Two", instanceId: "h2" },
        ],
        { min: 0, max: 2, prompt: "Keep which cards?" },
      ),
    });
    renderPrompt(view, onAction);
    const option = (key: string): HTMLElement => screen.getByTestId(`prompt-option-${key}`);

    expect(option("h1").querySelector(".cost-gem")?.getAttribute("data-cost")).toBe("0");
    expect(option("h2").querySelector(".cost-gem")?.getAttribute("data-cost")).toBe("5");
    expect(option("h2").getAttribute("aria-label")).toBe(`${nameOf("core-019")}, costs 5`);

    for (const key of ["h1", "h2"]) {
      expect(option(key)).toHaveAttribute("aria-pressed", "true");
      expect(option(key)).toHaveAttribute("data-verdict", "keep");
      expect(option(key).querySelector(".prompt-card-verdict")?.textContent).toBe("Keep");
    }

    fireEvent.click(option("h2"));
    expect(option("h2")).toHaveAttribute("aria-pressed", "false");
    expect(option("h2")).toHaveAttribute("data-verdict", "redraw");
    expect(option("h2").querySelector(".prompt-card-verdict")?.textContent).toBe("Redraw");

    fireEvent.click(screen.getByTestId("prompt-submit"));
    expect(onAction).toHaveBeenCalledWith({ type: "mulligan", keep: ["h1"] });
  });

  it("Confirm on an untouched mulligan keeps the whole hand", () => {
    const onAction = vi.fn();
    const view = baseView({
      you: emptySide("p1", {
        hand: [card({ instanceId: "h1", defId: "core-002" }), card({ instanceId: "h2", defId: "core-019" })],
      }),
      opponent: emptySide("p2", { hand: { count: 3 } }),
      pending: pendingFor(
        "mulligan",
        [
          { key: "h1", label: "One", instanceId: "h1" },
          { key: "h2", label: "Two", instanceId: "h2" },
        ],
        { min: 0, max: 2 },
      ),
    });
    renderPrompt(view, onAction);
    fireEvent.click(screen.getByTestId("prompt-submit"));
    expect(onAction).toHaveBeenCalledWith({ type: "mulligan", keep: ["h1", "h2"] });
  });

  it("a Discover has no verdicts: nothing is picked before the player picks", () => {
    renderPrompt(discoverView());
    for (const defId of DISCOVER) {
      const option = screen.getByTestId(`prompt-option-mode:${defId}`);
      expect(option).toHaveAttribute("aria-pressed", "false");
      expect(option).not.toHaveAttribute("data-verdict");
    }
  });

  it("resting a mouse on an option previews the card, and a click still picks it", () => {
    vi.useFakeTimers();
    const onAction = vi.fn();
    renderPrompt(discoverView(), onAction);
    const option = screen.getByTestId("prompt-option-mode:core-055");
    fireEvent.pointerEnter(option, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS);
    });
    expect(screen.getByTestId(INSPECT_HOVER).querySelector(".card-name")?.textContent).toBe(nameOf("core-055"));

    fireEvent.pointerLeave(option, { pointerType: "mouse" });
    fireEvent.click(option);
    expect(onAction).toHaveBeenCalledTimes(1);
  });
});
