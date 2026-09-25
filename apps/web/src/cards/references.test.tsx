// R279: a name in a card's text that its `refs` link is a reference. Marked everywhere; a control
// where the surface allows one (the collection's detail view, the touch sheet), which shows the
// named card's printed face in a tooltip; and the hover preview lists the named faces beside it.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef } from "@jackioh/shared";

import { REF_TOOLTIP_TESTID } from "./CardRef.tsx";
import { CardFace } from "./CardFace.tsx";
import { REF_HOVER_DELAY_MS } from "./constants.ts";
import { CardDetail } from "./inspect/CardDetail.tsx";
import { closeInspect } from "./inspect/store.ts";
import { INSPECT_DETAIL, INSPECT_HOVER, INSPECT_REFS } from "./inspect/testids.ts";
import { HOVER_DELAY_MS } from "./inspect/constants.ts";
import { useInspectTrigger } from "./inspect/useInspectTrigger.tsx";
import { faceModel, type FaceModel } from "./model.ts";
import { CardDefsProvider, RefsInteractive } from "./refContext.tsx";
import { findRefs } from "./refs.ts";

function def(id: string): CardDef {
  const found = CATALOG[id];
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function face(id: string, radiant: boolean): FaceModel {
  return faceModel({ defId: id, def: def(id), radiant });
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(() => {
  act(() => closeInspect());
  cleanup();
  vi.useRealTimers();
});

describe("R279 the names a text links", () => {
  it("R279 finds each name the refs list, plural included, and which face it points at", () => {
    const refs = [def("core-t-rush"), def("core-095-1"), def("core-095")];
    const text = def("core-095").radiant.text;
    const found = findRefs(text, refs).map((match) => [text.slice(match.start, match.end), match.id, match.radiant]);
    expect(found).toEqual([
      ["Call to Chaos", "core-095", false],
      ["Rush Tokens", "core-t-rush", true],
      ["Chaos Golem", "core-095-1", false],
    ]);
  });

  it("R279 every catalog text's names render as references, marked, with the id they name", () => {
    for (const card of Object.values(CATALOG)) {
      for (const radiant of [false, true]) {
        const text = radiant ? card.radiant.text : card.base.text;
        const expected = findRefs(text, (card.refs ?? []).map(def)).map((match) => match.id);
        const { container, unmount } = render(
          <CardDefsProvider defs={CATALOG}>
            <CardFace face={face(card.id, radiant)} layout="full" />
          </CardDefsProvider>,
        );
        const shown = [...container.querySelectorAll(".cf-ref")].map((ref) => ref.getAttribute("data-ref"));
        expect(shown, `${card.id} radiant=${String(radiant)}`).toEqual(expected);
        // A face on its own is not a control: no tab stop, nothing to open.
        expect(container.querySelector(".cf-ref[tabindex]"), card.id).toBeNull();
        unmount();
      }
    }
  }, 30_000);

  it("R279 with no catalog to read, a name is plain text", () => {
    const { container } = render(<CardFace face={face("core-090", false)} layout="full" />);
    expect(container.querySelector(".cf-ref")).toBeNull();
    expect(container.querySelector(".card-text")).toHaveTextContent("Shuffle a CN-Virus into the opponent's library");
  });
});

describe("R279 a reference that is a control opens the card it names", () => {
  function renderInteractive(id: string, radiant: boolean) {
    return render(
      <CardDefsProvider defs={CATALOG}>
        <RefsInteractive>
          <CardFace face={face(id, radiant)} layout="full" />
        </RefsInteractive>
      </CardDefsProvider>,
    );
  }

  it("R279 keyboard focus opens a tooltip with the named card's face, and the reference is described by it", () => {
    const { container } = renderInteractive("core-090", false);
    const ref = container.querySelector<HTMLElement>('.cf-ref[data-ref="core-090-1"]');
    expect(ref).not.toBeNull();
    expect(ref).toHaveAttribute("tabindex", "0");
    act(() => ref?.focus());
    const tooltip = screen.getByTestId(REF_TOOLTIP_TESTID);
    expect(tooltip).toHaveAttribute("role", "tooltip");
    expect(tooltip).toHaveAttribute("data-ref", "core-090-1");
    expect(tooltip).toHaveAttribute("data-ref-face", "base");
    expect(within(tooltip).getByText("CN-Virus")).toBeInTheDocument();
    expect(ref).toHaveAttribute("aria-describedby", tooltip.id);
    act(() => ref?.blur());
    expect(screen.queryByTestId(REF_TOOLTIP_TESTID)).toBeNull();
    expect(ref).not.toHaveAttribute("aria-describedby");
  });

  it("R279 a name the text calls Radiant opens the Radiant face (#90's Radiant CN-Virus)", () => {
    const { container } = renderInteractive("core-090", true);
    const ref = container.querySelector<HTMLElement>('.cf-ref[data-ref="core-090-1"]');
    expect(ref).toHaveAttribute("data-ref-face", "radiant");
    act(() => ref?.focus());
    const tooltip = screen.getByTestId(REF_TOOLTIP_TESTID);
    expect(tooltip).toHaveAttribute("data-ref-face", "radiant");
    expect(tooltip.querySelector(".cf")).toHaveAttribute("data-radiant-face", "true");
    expect(tooltip.querySelector(".card-text")).toHaveTextContent(def("core-090-1").radiant.text);
  });

  it("R279 a mouse resting on it opens the tooltip after the delay, and leaving closes it", () => {
    vi.useFakeTimers();
    const { container } = renderInteractive("core-041", true);
    const ref = container.querySelector<HTMLElement>('.cf-ref[data-ref="core-055"]');
    expect(ref).not.toBeNull();
    if (ref === null) return;
    fireEvent.pointerEnter(ref, { pointerType: "mouse" });
    expect(screen.queryByTestId(REF_TOOLTIP_TESTID)).toBeNull();
    act(() => vi.advanceTimersByTime(REF_HOVER_DELAY_MS));
    expect(screen.getByTestId(REF_TOOLTIP_TESTID)).toHaveAttribute("data-ref", "core-055");
    fireEvent.pointerLeave(ref, { pointerType: "mouse" });
    expect(screen.queryByTestId(REF_TOOLTIP_TESTID)).toBeNull();
  });

  function maskRef(container: HTMLElement): HTMLElement {
    const ref = container.querySelector<HTMLElement>('.cf-ref[data-ref="core-065-1"]');
    if (ref === null) throw new Error("no Spikey Pillow reference");
    return ref;
  }

  it("R279 a tap opens it and a second tap closes it, the press's focus included, and the tap goes no further", async () => {
    const user = userEvent.setup();
    const outer = vi.fn();
    const { container } = render(
      <div onClick={outer}>
        <CardDefsProvider defs={CATALOG}>
          <RefsInteractive>
            <CardFace face={face("core-065", false)} layout="full" />
          </RefsInteractive>
        </CardDefsProvider>
      </div>,
    );
    const ref = maskRef(container);
    // A real tap: pointerdown, the focus it gives, pointerup, click — the focus opening it must not
    // be undone by the click that ends the same press.
    await user.pointer({ keys: "[TouchA]", target: ref });
    expect(screen.getByTestId(REF_TOOLTIP_TESTID)).toHaveAttribute("data-ref", "core-065-1");
    await user.pointer({ keys: "[TouchA]", target: ref });
    expect(screen.queryByTestId(REF_TOOLTIP_TESTID)).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("R279 a mouse click opens it and leaves it open; a press anywhere else closes it", async () => {
    const user = userEvent.setup();
    const { container } = renderInteractive("core-065", false);
    await user.click(maskRef(container));
    expect(screen.getByTestId(REF_TOOLTIP_TESTID)).toHaveAttribute("data-ref", "core-065-1");
    await user.pointer({ keys: "[MouseLeft]", target: document.body });
    expect(screen.queryByTestId(REF_TOOLTIP_TESTID)).toBeNull();
  });

  it("R279 Escape closes an open tooltip and leaves the detail view open; the next Escape closes the view", () => {
    const onClose = vi.fn();
    render(
      <CardDefsProvider defs={CATALOG}>
        <CardDetail def={def("core-090")} onClose={onClose} />
      </CardDefsProvider>,
    );
    const ref = screen.getByTestId(INSPECT_DETAIL).querySelector<HTMLElement>('.cf-ref[data-ref="core-090-1"]');
    act(() => ref?.focus());
    expect(screen.getByTestId(REF_TOOLTIP_TESTID)).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(REF_TOOLTIP_TESTID)).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("R279 the collection's detail view makes its references controls", () => {
    render(
      <CardDefsProvider defs={CATALOG}>
        <CardDetail def={def("core-090")} onClose={() => undefined} />
      </CardDefsProvider>,
    );
    const detail = screen.getByTestId(INSPECT_DETAIL);
    const refs = [...detail.querySelectorAll(".cf-ref[tabindex]")];
    expect(refs.length).toBeGreaterThanOrEqual(2);
    expect(refs.every((ref) => ref.getAttribute("data-ref") === "core-090-1")).toBe(true);
  });
});

describe("R279 the hover preview lists the named cards beside the face", () => {
  function Trigger({ subject }: { subject: { key: string; face: FaceModel } }) {
    const inspect = useInspectTrigger(subject);
    return (
      <>
        <button type="button" data-testid="trigger" {...inspect.handlers}>
          card
        </button>
        {inspect.overlay}
      </>
    );
  }

  it("R279 resting on a card shows a Mentions column with each named card's face, once", () => {
    vi.useFakeTimers();
    render(
      <CardDefsProvider defs={CATALOG}>
        <Trigger subject={{ key: "refs-95", face: face("core-095", true) }} />
      </CardDefsProvider>,
    );
    fireEvent.pointerEnter(screen.getByTestId("trigger"), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS));
    const preview = screen.getByTestId(INSPECT_HOVER);
    const column = within(preview).getByTestId(INSPECT_REFS);
    const named = [...column.querySelectorAll(".inspect-refs-face")].map((entry) => [
      entry.getAttribute("data-ref"),
      entry.getAttribute("data-ref-face"),
    ]);
    // The card itself ("cast a random Call to Chaos") is left out: the preview already shows it.
    expect(named).toEqual([
      ["core-t-rush", "radiant"],
      ["core-095-1", "base"],
    ]);
    // Inside the preview a reference is only a mark: the preview takes no pointer events.
    expect(preview.querySelector(".cf-ref[tabindex]")).toBeNull();
  });

  it("R279 a card whose text names nothing has no Mentions column", () => {
    vi.useFakeTimers();
    render(
      <CardDefsProvider defs={CATALOG}>
        <Trigger subject={{ key: "refs-44", face: face("core-044", true) }} />
      </CardDefsProvider>,
    );
    fireEvent.pointerEnter(screen.getByTestId("trigger"), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(HOVER_DELAY_MS));
    expect(within(screen.getByTestId(INSPECT_HOVER)).queryByTestId(INSPECT_REFS)).toBeNull();
  });
});
