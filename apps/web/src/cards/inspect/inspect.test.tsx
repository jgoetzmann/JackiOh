// Polish 6, slice C: inspecting a card (docs/polish/6-cards.md, B22–B26).
//
// Hover opens a preview after HOVER_DELAY_MS, a touch long-press opens a sheet after LONG_PRESS_MS,
// and every overlay is a portal into document.body that swallows the events inside it. These tests
// drive both a bare `useInspectTrigger` and the real `Board`, with fake timers, and they query the
// overlays through `screen` because a portal is not inside the render container.
//
// Written from the design doc's Behaviors and Surface. Nothing here reads the implementation.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useState, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef, PlayerView, UnitView } from "@jackioh/shared";

import Board from "../../game/Board.tsx";
import { CatalogContext, lookupFromDefs } from "../../game/catalog.ts";
import { testid, type ClickTarget, type Highlight } from "../../game/contract.ts";
import { fullBoardView } from "../../test/fixtures.ts";
import { GLOSSARY, type GlossaryTermId } from "../glossary.ts";
import { faceModel, type FaceModel } from "../model.ts";
import { glossaryFor } from "../rules.ts";
import { CARD_SETTINGS_DEFAULTS, writeCardSettings } from "../settings.ts";
import { CLICK_SUPPRESS_MS, HOVER_DELAY_MS, LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "./constants.ts";
import { CardDetail, closeInspect, useInspectTrigger, type InspectOptions, type InspectSubject } from "./index.ts";
import {
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE,
  INSPECT_GLOSSARY,
  INSPECT_HOVER,
  INSPECT_SCRIM,
  INSPECT_SHEET,
} from "./testids.ts";

// ---------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------

type PointerKind = "mouse" | "pen" | "touch";

/** Where a press starts; moves are measured from here. */
const START_X = 100;
const START_Y = 100;

/**
 * jsdom 30 ships `PointerEvent`, but if the window a node lives in ever lacks it, testing-library
 * falls back to a plain `Event` and drops `pointerType`, which would make every touch look like a
 * mouse. This installs a `MouseEvent` subclass that keeps it, only when the probe shows it is lost.
 */
function ensurePointerEvent(): void {
  const win = document.defaultView;
  if (win === null) return;
  const probe = typeof win.PointerEvent === "function" ? new win.PointerEvent("pointerdown", { pointerType: "touch" }) : null;
  if (probe !== null && probe.pointerType === "touch") return;

  class TestPointerEvent extends win.MouseEvent {
    readonly pointerType: string;
    readonly pointerId: number;
    readonly isPrimary: boolean;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerType = init.pointerType ?? "";
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
    }
  }
  for (const target of [win, globalThis]) {
    Object.defineProperty(target, "PointerEvent", { value: TestPointerEvent, configurable: true, writable: true });
  }
}

function pointerInit(pointerType: PointerKind | undefined, x: number = START_X, y: number = START_Y): PointerEventInit {
  const base: PointerEventInit = { clientX: x, clientY: y, pointerId: 1, isPrimary: true, button: 0 };
  return pointerType === undefined ? base : { ...base, pointerType };
}

function enter(element: Element, pointerType?: PointerKind): void {
  fireEvent.pointerEnter(element, pointerInit(pointerType));
}

function leave(element: Element, pointerType: PointerKind = "mouse"): void {
  fireEvent.pointerLeave(element, pointerInit(pointerType));
}

function press(element: Element, pointerType: PointerKind, x: number = START_X, y: number = START_Y): void {
  fireEvent.pointerDown(element, pointerInit(pointerType, x, y));
}

function move(element: Element, pointerType: PointerKind, x: number, y: number): void {
  fireEvent.pointerMove(element, pointerInit(pointerType, x, y));
}

function lift(element: Element, pointerType: PointerKind, x: number = START_X, y: number = START_Y): void {
  fireEvent.pointerUp(element, pointerInit(pointerType, x, y));
}

/**
 * A `contextmenu` as Chrome sends it: a PointerEvent carrying the pointer that asked for it.
 * Returns false when something called `preventDefault` (the native menu is suppressed).
 */
function contextMenu(element: Element, pointerType: PointerKind): boolean {
  const win = document.defaultView;
  if (win === null) throw new Error("jsdom has a window");
  const event = new win.PointerEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    pointerType,
    button: 2,
    clientX: START_X,
    clientY: START_Y,
  });
  return fireEvent(element, event);
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** A touch held long enough to fire, then lifted where it started. */
function longPress(element: Element): void {
  press(element, "touch");
  advance(LONG_PRESS_MS);
  lift(element, "touch");
}

/** A mouse resting long enough to open the preview. */
function hover(element: Element): void {
  enter(element, "mouse");
  advance(HOVER_DELAY_MS);
}

/** A real mouse click: every event a browser fires for one, in order. */
function realClick(element: Element): void {
  fireEvent.pointerDown(element, pointerInit("mouse"));
  fireEvent.mouseDown(element);
  fireEvent.pointerUp(element, pointerInit("mouse"));
  fireEvent.mouseUp(element);
  fireEvent.click(element);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function defOf(id: string): CardDef {
  return must(CATALOG[id], `${id} in the catalog`);
}

function faceOf(id: string, radiant = false): FaceModel {
  return faceModel({ defId: id, def: defOf(id), radiant });
}

function subjectOf(key: string, id: string): InspectSubject {
  return { key, face: faceOf(id) };
}

/** Which inspect overlays are in the document right now, one entry per element. */
function openOverlays(): string[] {
  return [INSPECT_HOVER, INSPECT_SHEET, INSPECT_DETAIL].flatMap((id) => screen.queryAllByTestId(id).map(() => id));
}

function faceIn(overlay: HTMLElement): HTMLElement {
  return must(overlay.querySelector<HTMLElement>(".cf"), "a CardFace inside the overlay");
}

function nameIn(overlay: HTMLElement): string {
  return must(faceIn(overlay).querySelector(".card-name"), "a .card-name in the overlay's face").textContent ?? "";
}

function glossaryTerms(root: HTMLElement): (string | null)[] {
  const list = within(root).getByTestId(INSPECT_GLOSSARY);
  return Array.from(list.querySelectorAll("li")).map((li) => li.getAttribute("data-glossary-term"));
}

type TriggerProps = {
  id: string;
  subject: InspectSubject | null;
  options?: InspectOptions;
  onClick?: () => void;
};

/** The bare trigger: exactly what a card does with the hook, and nothing else. */
function Trigger({ id, subject, options, onClick }: TriggerProps): ReactElement {
  const inspect = useInspectTrigger(subject, options);
  return (
    <>
      <div data-testid={id} {...inspect.handlers} onClick={onClick}>
        {subject === null ? "face-down" : subject.face.name}
      </div>
      {inspect.overlay}
      <output data-testid={`${id}-open`}>{inspect.open ?? "none"}</output>
    </>
  );
}

/** A page to put triggers on: a scrollable region and a focusable control outside the card. */
function Scene({ children }: { children: ReactNode }): ReactElement {
  return (
    <div data-testid="scroller">
      {children}
      <button type="button" data-testid="outside">
        outside
      </button>
    </div>
  );
}

const FENCED = ["click", "pointerdown", "pointerup", "mousedown", "keydown", "contextmenu", "dragstart", "dragover", "drop"] as const;
type Fenced = (typeof FENCED)[number];
type FenceSpies = Record<Fenced, Mock<() => void>>;

function fenceSpies(): FenceSpies {
  return {
    click: vi.fn<() => void>(),
    pointerdown: vi.fn<() => void>(),
    pointerup: vi.fn<() => void>(),
    mousedown: vi.fn<() => void>(),
    keydown: vi.fn<() => void>(),
    contextmenu: vi.fn<() => void>(),
    dragstart: vi.fn<() => void>(),
    dragover: vi.fn<() => void>(),
    drop: vi.fn<() => void>(),
  };
}

/**
 * An ancestor with a handler for every event B25 lists. React bubbles a portal's events through
 * the React tree, so an overlay rendered inside this reaches these handlers unless it stops them.
 */
function Fence({ spies, children }: { spies: FenceSpies; children: ReactNode }): ReactElement {
  return (
    <div
      data-testid="fence"
      onClick={spies.click}
      onPointerDown={spies.pointerdown}
      onPointerUp={spies.pointerup}
      onMouseDown={spies.mousedown}
      onKeyDown={spies.keydown}
      onContextMenu={spies.contextmenu}
      onDragStart={spies.dragstart}
      onDragOver={spies.dragover}
      onDrop={spies.drop}
    >
      {children}
      <span data-testid="fence-control">control</span>
    </div>
  );
}

function clearSpies(spies: FenceSpies): void {
  for (const name of FENCED) spies[name].mockClear();
}

/** Every event B25 names, fired on one element inside an overlay. */
function fireEverything(target: Element): void {
  fireEvent.click(target);
  fireEvent.pointerDown(target, pointerInit("mouse"));
  fireEvent.pointerUp(target, pointerInit("mouse"));
  fireEvent.mouseDown(target);
  fireEvent.keyDown(target, { key: "Enter" });
  fireEvent.contextMenu(target);
  fireEvent.dragStart(target);
  fireEvent.dragOver(target);
  fireEvent.drop(target);
}

function expectFenceUntouched(spies: FenceSpies): void {
  for (const name of FENCED) {
    expect(spies[name], `${name} inside the overlay reached an ancestor handler`).not.toHaveBeenCalled();
  }
}

function renderBoard(view: PlayerView, legal: string[] = [], onClick?: (target: ClickTarget) => void): void {
  const highlight: Highlight = { legal: new Set(legal), selected: new Set() };
  render(
    <CatalogContext.Provider value={lookupFromDefs(CATALOG)}>
      <Board view={view} highlight={highlight} onClick={onClick} />
    </CatalogContext.Provider>,
  );
}

function yourUnit(view: PlayerView, index: number): UnitView {
  return must(view.you.units[index], `fullBoardView().you.units[${String(index)}]`);
}

beforeAll(() => {
  ensurePointerEvent();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  // The inspect store is module-level: close whatever a test left open before the next one mounts.
  act(() => {
    closeInspect();
  });
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
  writeCardSettings(CARD_SETTINGS_DEFAULTS);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// B22: hover
// ---------------------------------------------------------------------------------------------

describe("hover preview (B22)", () => {
  it("B22 a mouse resting HOVER_DELAY_MS opens inspect-hover in document.body, and not a moment sooner", () => {
    const { container } = render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b22-a", "core-043")} />
      </Scene>,
    );
    const trigger = screen.getByTestId("a");

    enter(trigger, "mouse");
    advance(HOVER_DELAY_MS - 1);
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();

    advance(1);
    const preview = screen.getByTestId(INSPECT_HOVER);
    expect(document.body.contains(preview)).toBe(true);
    expect(container.contains(preview), "a portal, not a child of the card").toBe(false);
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(within(preview).getByTestId(INSPECT_FACE)).toBeInTheDocument();
    expect(nameIn(preview)).toBe(defOf("core-043").name);
    expect(screen.getByTestId("a-open")).toHaveTextContent("hover");
  });

  it("B22 a pen resting on the card opens the preview too", () => {
    render(<Trigger id="a" subject={subjectOf("b22-pen", "core-043")} />);
    enter(screen.getByTestId("a"), "pen");
    advance(HOVER_DELAY_MS);
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
  });

  it("B22 a pointerenter with no pointerType counts as a mouse", () => {
    render(<Trigger id="a" subject={subjectOf("b22-none", "core-043")} />);
    enter(screen.getByTestId("a"));
    advance(HOVER_DELAY_MS);
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
  });

  it("B22 leaving before HOVER_DELAY_MS opens nothing, then or later", () => {
    render(<Trigger id="a" subject={subjectOf("b22-early", "core-043")} />);
    const trigger = screen.getByTestId("a");
    enter(trigger, "mouse");
    advance(HOVER_DELAY_MS - 1);
    leave(trigger, "mouse");
    advance(HOVER_DELAY_MS * 2);
    expect(openOverlays()).toEqual([]);
    expect(screen.getByTestId("a-open")).toHaveTextContent("none");
  });

  it("B22 leaving after the preview opened closes it", () => {
    render(<Trigger id="a" subject={subjectOf("b22-late", "core-043")} />);
    const trigger = screen.getByTestId("a");
    hover(trigger);
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
    leave(trigger, "mouse");
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("B22 a touch pointer never opens the preview", () => {
    render(<Trigger id="a" subject={subjectOf("b22-touch", "core-043")} />);
    enter(screen.getByTestId("a"), "touch");
    advance(HOVER_DELAY_MS * 3);
    expect(openOverlays()).toEqual([]);
  });

  it("B22 no pointer opens the preview while hoverPreviews is false", () => {
    act(() => {
      writeCardSettings({ hoverPreviews: false });
    });
    render(<Trigger id="a" subject={subjectOf("b22-off", "core-043")} />);
    const trigger = screen.getByTestId("a");
    for (const kind of ["mouse", "pen"] as const) {
      enter(trigger, kind);
      advance(HOVER_DELAY_MS * 2);
      expect(screen.queryByTestId(INSPECT_HOVER), `${kind} with hoverPreviews off`).toBeNull();
      leave(trigger, kind);
    }
  });

  it("B22 a null subject (a face-down card) opens neither a preview nor a sheet", () => {
    render(<Trigger id="a" subject={null} />);
    const trigger = screen.getByTestId("a");
    hover(trigger);
    leave(trigger);
    longPress(trigger);
    advance(LONG_PRESS_MS);
    expect(openOverlays()).toEqual([]);
    expect(screen.getByTestId("a-open")).toHaveTextContent("none");
  });

  it("B22 resting on or long-pressing a face-down card on the board opens nothing", () => {
    const view = fullBoardView();
    expect(view.you.backrow[2], "the fixture's third backrow slot is face-down").toEqual({ faceDown: true });
    renderBoard(view);
    const zone = screen.getByTestId(testid.zone("you", "backrow", 3));
    const back = must(zone.querySelector(".card-back"), "a card back in the face-down zone");
    const opponentBack = must(screen.getByTestId("hand-opponent").querySelector(".card-back"), "a back in the opponent's hand");

    for (const target of [back, opponentBack]) {
      hover(target);
      leave(target);
      longPress(target);
    }
    advance(LONG_PRESS_MS);
    expect(openOverlays()).toEqual([]);
  });

  it("B22 hovering a board unit shows its CardFace with live cost and stats, and its glossary", () => {
    const view = fullBoardView();
    const unit = yourUnit(view, 0);
    const def = defOf(unit.defId);
    // The fixture's premise, so a catalog edit fails here and not as a mystery below.
    expect(typeof def.cost === "number" && def.cost < unit.cost, "live cost above the printed one").toBe(true);
    expect((def.base.attack ?? 0) < unit.attack, "live attack above the printed one").toBe(true);
    expect(unit.health < unit.maxHealth, "the unit is damaged").toBe(true);
    expect(def.base.text.startsWith("Cry:"), "the base text opens with Cry:").toBe(true);
    expect(unit.keywords.map((k) => k.kind)).toEqual(["Taunt"]);

    renderBoard(view);
    hover(screen.getByTestId(testid.card(unit.instanceId)));

    const preview = screen.getByTestId(INSPECT_HOVER);
    const face = faceIn(within(preview).getByTestId(INSPECT_FACE));
    expect(face.querySelector(".card-name")).toHaveTextContent(def.name);
    expect(face.querySelector(".cost-gem")).toHaveAttribute("data-cost", String(unit.cost));
    expect(face.querySelector(".cost-gem")).toHaveAttribute("data-tone", "up");
    expect(face.querySelector(".cf-atk")).toHaveAttribute("data-face-attack", String(unit.attack));
    expect(face.querySelector(".cf-atk")).toHaveAttribute("data-tone", "buffed");
    expect(face.querySelector(".cf-hp")).toHaveAttribute("data-face-health", String(unit.health));
    expect(face.querySelector(".cf-hp")).toHaveAttribute("data-tone", "damaged");
    expect(glossaryTerms(preview)).toEqual(["Cry", "Taunt"]);
  });

  it("B22 hovering a hand card shows the cost it has now, not the printed one", () => {
    const view = fullBoardView();
    const hand = Array.isArray(view.you.hand) ? view.you.hand : [];
    const card = must(hand[0], "fullBoardView().you.hand[0]");
    const def = defOf(card.defId);
    expect(typeof def.cost === "number" && def.cost > card.cost, "the fixture's hand card is discounted").toBe(true);

    renderBoard(view);
    hover(screen.getByTestId(testid.handCard(card.instanceId)));

    const face = faceIn(within(screen.getByTestId(INSPECT_HOVER)).getByTestId(INSPECT_FACE));
    expect(face.querySelector(".card-name")).toHaveTextContent(def.name);
    expect(face.querySelector(".cost-gem")).toHaveAttribute("data-cost", String(card.cost));
    expect(face.querySelector(".cost-gem")).toHaveAttribute("data-tone", "down");
  });
});

// ---------------------------------------------------------------------------------------------
// B23: what closes the preview, and one overlay at a time
// ---------------------------------------------------------------------------------------------

describe("closing the preview, and one overlay at a time (B23)", () => {
  function openPreview(key: string): HTMLElement {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf(key, "core-043")} />
      </Scene>,
    );
    const trigger = screen.getByTestId("a");
    hover(trigger);
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
    return trigger;
  }

  it("B23 a pointerdown on the trigger closes the preview", () => {
    const trigger = openPreview("b23-down");
    press(trigger, "mouse");
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("B23 a pointerdown before the delay cancels the pending preview", () => {
    render(<Trigger id="a" subject={subjectOf("b23-cancel", "core-043")} />);
    const trigger = screen.getByTestId("a");
    enter(trigger, "mouse");
    advance(HOVER_DELAY_MS - 1);
    press(trigger, "mouse");
    advance(HOVER_DELAY_MS * 2);
    expect(openOverlays()).toEqual([]);
  });

  it("B23 Escape closes the preview", () => {
    openPreview("b23-escape");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("B23 a window blur closes the preview", () => {
    openPreview("b23-blur");
    fireEvent.blur(window);
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("B23 a scroll anywhere in the page closes the preview (the listener captures)", () => {
    openPreview("b23-scroll");
    // `scroll` does not bubble: only a capturing listener sees one fired on an inner region.
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
  });

  it("B23 the page turning hidden closes the preview", () => {
    openPreview("b23-hidden");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
    try {
      fireEvent(document, new Event("visibilitychange"));
      expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();
    } finally {
      Reflect.deleteProperty(document, "visibilityState");
      Reflect.deleteProperty(document, "hidden");
    }
  });

  it("B23 hovering a second card replaces the first preview: one inspect-hover, the second card's", () => {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b23-first", "core-043")} />
        <Trigger id="b" subject={subjectOf("b23-second", "core-002")} />
      </Scene>,
    );
    hover(screen.getByTestId("a"));
    expect(nameIn(screen.getByTestId(INSPECT_HOVER))).toBe(defOf("core-043").name);

    // No pointerleave on the first: the store, not the leave, has to keep it to one.
    hover(screen.getByTestId("b"));
    expect(openOverlays()).toEqual([INSPECT_HOVER]);
    expect(nameIn(screen.getByTestId(INSPECT_HOVER))).toBe(defOf("core-002").name);
  });

  it("B23 a long-press sheet closes an open preview", () => {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b23-hover-a", "core-043")} />
        <Trigger id="b" subject={subjectOf("b23-sheet-b", "core-002")} />
      </Scene>,
    );
    hover(screen.getByTestId("a"));
    longPress(screen.getByTestId("b"));
    expect(openOverlays()).toEqual([INSPECT_SHEET]);
    expect(screen.getByTestId(INSPECT_SHEET)).toHaveAttribute("aria-label", defOf("core-002").name);
  });

  it("B23 opening CardDetail closes an open sheet", () => {
    const subject = subjectOf("b23-sheet", "core-043");
    const { rerender } = render(
      <Scene>
        <Trigger id="a" subject={subject} />
      </Scene>,
    );
    longPress(screen.getByTestId("a"));
    expect(openOverlays()).toEqual([INSPECT_SHEET]);

    rerender(
      <Scene>
        <Trigger id="a" subject={subject} />
        <CardDetail def={defOf("core-002")} onClose={() => undefined} />
      </Scene>,
    );
    expect(openOverlays()).toEqual([INSPECT_DETAIL]);
  });

  it("B23 opening CardDetail closes an open preview", () => {
    const subject = subjectOf("b23-hover", "core-043");
    const { rerender } = render(
      <Scene>
        <Trigger id="a" subject={subject} />
      </Scene>,
    );
    hover(screen.getByTestId("a"));
    rerender(
      <Scene>
        <Trigger id="a" subject={subject} />
        <CardDetail def={defOf("core-002")} onClose={() => undefined} />
      </Scene>,
    );
    expect(openOverlays()).toEqual([INSPECT_DETAIL]);
  });

  it("B23 a long-press on a second card replaces the first card's sheet: one inspect-sheet, the second card's", () => {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b23-sheet-first", "core-043")} />
        <Trigger id="b" subject={subjectOf("b23-sheet-second", "core-002")} />
      </Scene>,
    );
    longPress(screen.getByTestId("a"));
    expect(screen.getByTestId(INSPECT_SHEET)).toHaveAttribute("aria-label", defOf("core-043").name);

    longPress(screen.getByTestId("b"));
    expect(openOverlays()).toEqual([INSPECT_SHEET]);
    expect(screen.getByTestId(INSPECT_SHEET)).toHaveAttribute("aria-label", defOf("core-002").name);
    expect(screen.getByTestId("a-open")).toHaveTextContent("none");
    expect(screen.getByTestId("b-open")).toHaveTextContent("sheet");
  });

  /** A caller that owns its CardDetail the way the deck builder does: open until onClose. */
  function DetailHost({ id, onClose }: { id: string; onClose: () => void }): ReactElement | null {
    const [open, setOpen] = useState(true);
    if (!open) return null;
    return (
      <CardDetail
        def={defOf(id)}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
      />
    );
  }

  it("B23 a hover preview opening closes an open CardDetail", () => {
    const onClose = vi.fn<() => void>();
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b23-detail-then-hover", "core-043")} />
        <DetailHost id="core-002" onClose={onClose} />
      </Scene>,
    );
    expect(openOverlays()).toEqual([INSPECT_DETAIL]);

    hover(screen.getByTestId("a"));
    expect(onClose).toHaveBeenCalled();
    expect(openOverlays()).toEqual([INSPECT_HOVER]);
    expect(nameIn(screen.getByTestId(INSPECT_HOVER))).toBe(defOf("core-043").name);
  });

  it("B23 a long-press sheet opening closes an open CardDetail", () => {
    const onClose = vi.fn<() => void>();
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b23-detail-then-sheet", "core-043")} />
        <DetailHost id="core-002" onClose={onClose} />
      </Scene>,
    );
    expect(openOverlays()).toEqual([INSPECT_DETAIL]);

    longPress(screen.getByTestId("a"));
    expect(onClose).toHaveBeenCalled();
    expect(openOverlays()).toEqual([INSPECT_SHEET]);
    expect(screen.getByTestId(INSPECT_SHEET)).toHaveAttribute("aria-label", defOf("core-043").name);
  });

  it("B23 closeInspect(key) closes only that card's overlay, and closeInspect() closes any", () => {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b23-key-a", "core-043")} />
      </Scene>,
    );
    hover(screen.getByTestId("a"));

    act(() => {
      closeInspect("b23-some-other-card");
    });
    expect(screen.getByTestId(INSPECT_HOVER), "another key leaves it open").toBeInTheDocument();

    act(() => {
      closeInspect("b23-key-a");
    });
    expect(screen.queryByTestId(INSPECT_HOVER)).toBeNull();

    leave(screen.getByTestId("a"));
    hover(screen.getByTestId("a"));
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
    act(() => {
      closeInspect();
    });
    expect(openOverlays()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B24: long-press
// ---------------------------------------------------------------------------------------------

describe("long-press (B24)", () => {
  it("B24 a touch held LONG_PRESS_MS opens inspect-sheet as a modal dialog named for the card, focused on inspect-close", () => {
    const { container } = render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b24-open", "core-043")} />
      </Scene>,
    );
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    advance(LONG_PRESS_MS - 1);
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();

    advance(1);
    const sheet = screen.getByTestId(INSPECT_SHEET);
    expect(container.contains(sheet), "a portal into document.body").toBe(false);
    expect(document.body.contains(sheet)).toBe(true);
    expect(sheet).toHaveAttribute("role", "dialog");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveAttribute("aria-label", defOf("core-043").name);
    expect(screen.getByTestId(INSPECT_CLOSE)).toHaveFocus();
    expect(nameIn(sheet)).toBe(defOf("core-043").name);
    expect(screen.getByTestId("a-open")).toHaveTextContent("sheet");
  });

  it("B24 with onLongPress the long-press calls it once instead of opening the sheet", () => {
    const onLongPress = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-callback", "core-043")} options={{ onLongPress }} />);
    longPress(screen.getByTestId("a"));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    expect(openOverlays()).toEqual([]);
  });

  it("B24 a touch that moves more than LONG_PRESS_SLOP_PX cancels the long-press", () => {
    render(<Trigger id="a" subject={subjectOf("b24-slop-over", "core-043")} />);
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    move(trigger, "touch", START_X, START_Y + LONG_PRESS_SLOP_PX + 1);
    advance(LONG_PRESS_MS * 2);
    expect(openOverlays()).toEqual([]);
  });

  it("B24 moving out past the slop and back again does not revive the long-press", () => {
    render(<Trigger id="a" subject={subjectOf("b24-slop-back", "core-043")} />);
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    move(trigger, "touch", START_X + LONG_PRESS_SLOP_PX + 5, START_Y);
    move(trigger, "touch", START_X, START_Y);
    advance(LONG_PRESS_MS * 2);
    expect(openOverlays()).toEqual([]);
  });

  it("B24 a move of exactly LONG_PRESS_SLOP_PX does not cancel it", () => {
    render(<Trigger id="a" subject={subjectOf("b24-slop-edge", "core-043")} />);
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    move(trigger, "touch", START_X + LONG_PRESS_SLOP_PX, START_Y);
    advance(LONG_PRESS_MS);
    expect(screen.getByTestId(INSPECT_SHEET)).toBeInTheDocument();
  });

  it("B24 lifting before LONG_PRESS_MS cancels the long-press, and the tap's click still goes through", () => {
    const onClick = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-tap", "core-043")} onClick={onClick} />);
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    advance(LONG_PRESS_MS - 1);
    lift(trigger, "touch");
    advance(LONG_PRESS_MS * 2);
    expect(openOverlays()).toEqual([]);
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("B24 a pointercancel cancels the long-press", () => {
    render(<Trigger id="a" subject={subjectOf("b24-cancel", "core-043")} />);
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    fireEvent.pointerCancel(trigger, pointerInit("touch"));
    advance(LONG_PRESS_MS * 2);
    expect(openOverlays()).toEqual([]);
  });

  it("B24 a mouse or pen press held LONG_PRESS_MS opens no sheet", () => {
    const onLongPress = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-mouse", "core-043")} options={{ onLongPress }} />);
    const trigger = screen.getByTestId("a");
    for (const kind of ["mouse", "pen"] as const) {
      press(trigger, kind);
      advance(LONG_PRESS_MS * 2);
      lift(trigger, kind);
    }
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("B24 the click after a long-press on a board card is swallowed, so the Board's onClick is not called", () => {
    const view = fullBoardView();
    const unit = yourUnit(view, 0);
    const id = testid.card(unit.instanceId);
    const onClick = vi.fn<(target: ClickTarget) => void>();
    renderBoard(view, [id], onClick);

    const card = screen.getByTestId(id);
    longPress(card);
    expect(screen.getByTestId(INSPECT_SHEET)).toBeInTheDocument();
    fireEvent.click(card);
    expect(onClick).not.toHaveBeenCalled();
  });

  it("B24 a board card clicked with no long-press still reaches the Board's onClick", () => {
    const view = fullBoardView();
    const unit = yourUnit(view, 0);
    const id = testid.card(unit.instanceId);
    const onClick = vi.fn<(target: ClickTarget) => void>();
    renderBoard(view, [id], onClick);

    realClick(screen.getByTestId(id));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith({ on: "unit", instanceId: unit.instanceId, side: "you", lane: 1 });
  });

  it("B24 the suppressor swallows the next click only", () => {
    const onClick = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-once", "core-043")} options={{ onLongPress: () => undefined }} onClick={onClick} />);
    const trigger = screen.getByTestId("a");
    longPress(trigger);
    fireEvent.click(trigger);
    expect(onClick, "the click the long-press ended in").not.toHaveBeenCalled();
    fireEvent.click(trigger);
    expect(onClick, "the one after it").toHaveBeenCalledTimes(1);
  });

  it("B24 the suppressor disarms after CLICK_SUPPRESS_MS", () => {
    const onClick = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-expire", "core-043")} options={{ onLongPress: () => undefined }} onClick={onClick} />);
    const trigger = screen.getByTestId("a");
    longPress(trigger);
    advance(CLICK_SUPPRESS_MS);
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("B24 the suppressor disarms on the next pointerdown", () => {
    const onClick = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-rearm", "core-043")} options={{ onLongPress: () => undefined }} onClick={onClick} />);
    const trigger = screen.getByTestId("a");
    longPress(trigger);
    // A fresh tap: down and straight back up, well inside CLICK_SUPPRESS_MS.
    press(trigger, "touch");
    lift(trigger, "touch");
    fireEvent.click(trigger);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("B24 contextmenu is prevented while a touch press is pending and after it has fired", () => {
    render(<Trigger id="a" subject={subjectOf("b24-menu", "core-043")} options={{ onLongPress: () => undefined }} />);
    const trigger = screen.getByTestId("a");
    press(trigger, "touch");
    expect(contextMenu(trigger, "touch"), "pending").toBe(false);
    advance(LONG_PRESS_MS);
    expect(contextMenu(trigger, "touch"), "fired").toBe(false);
    lift(trigger, "touch");
  });

  it("B24 a mouse right-click on a trigger without onContextMenu is left alone and opens nothing", () => {
    render(<Trigger id="a" subject={subjectOf("b24-right", "core-043")} />);
    expect(contextMenu(screen.getByTestId("a"), "mouse"), "the native menu is not prevented").toBe(true);
    advance(LONG_PRESS_MS * 2);
    expect(openOverlays()).toEqual([]);
  });

  it("B38 (hook) a mouse right-click with onContextMenu calls it and prevents the native menu", () => {
    const onContextMenu = vi.fn<() => void>();
    render(<Trigger id="a" subject={subjectOf("b24-right-db", "core-043")} options={{ onContextMenu }} />);
    expect(contextMenu(screen.getByTestId("a"), "mouse")).toBe(false);
    expect(onContextMenu).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// B25: closing the sheet and the detail, focus, and events that must not escape an overlay
// ---------------------------------------------------------------------------------------------

describe("closing the sheet and the detail (B25)", () => {
  function openSheet(key: string): HTMLElement {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf(key, "core-043")} />
      </Scene>,
    );
    const outside = screen.getByTestId("outside");
    outside.focus();
    expect(outside).toHaveFocus();
    longPress(screen.getByTestId("a"));
    expect(screen.getByTestId(INSPECT_SHEET)).toBeInTheDocument();
    return outside;
  }

  it("B25 inspect-close closes the sheet and gives focus back", () => {
    const outside = openSheet("b25-close");
    realClick(screen.getByTestId(INSPECT_CLOSE));
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(outside).toHaveFocus();
  });

  it("B25 inspect-scrim closes the sheet and gives focus back", () => {
    const outside = openSheet("b25-scrim");
    realClick(screen.getByTestId(INSPECT_SCRIM));
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(outside).toHaveFocus();
  });

  it("B25 Escape closes the sheet and gives focus back", () => {
    const outside = openSheet("b25-escape");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(outside).toHaveFocus();
  });

  for (const path of ["inspect-close", "inspect-scrim", "Escape"] as const) {
    it(`B25 CardDetail asks to close on ${path}`, () => {
      const onClose = vi.fn<() => void>();
      render(<CardDetail def={defOf("core-043")} onClose={onClose} />);
      expect(screen.getByTestId(INSPECT_DETAIL)).toBeInTheDocument();
      if (path === "inspect-close") realClick(screen.getByTestId(INSPECT_CLOSE));
      if (path === "inspect-scrim") realClick(screen.getByTestId(INSPECT_SCRIM));
      if (path === "Escape") fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      // The caller owns the open state, so the detail stays mounted here; how many of a real
      // click's events it answers is not specified, only that it asks to close.
      expect(onClose).toHaveBeenCalled();
    });
  }

  it("B25 closing CardDetail gives focus back to the element that had it", () => {
    function DetailHost(): ReactElement {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button type="button" data-testid="opener" onClick={() => setOpen(true)}>
            open
          </button>
          {open && <CardDetail def={defOf("core-043")} onClose={() => setOpen(false)} />}
        </>
      );
    }
    render(<DetailHost />);
    const opener = screen.getByTestId("opener");
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByTestId(INSPECT_DETAIL)).toBeInTheDocument();

    realClick(screen.getByTestId(INSPECT_CLOSE));
    expect(screen.queryByTestId(INSPECT_DETAIL)).toBeNull();
    expect(opener).toHaveFocus();
  });
});

describe("Tab stays inside a modal overlay (B25)", () => {
  function tabFrom(element: Element, shift = false): boolean {
    // fireEvent returns false when a handler called preventDefault.
    return fireEvent.keyDown(element, { key: "Tab", shiftKey: shift });
  }

  it("B25 Tab from Close, the last control of the detail, goes to its first control, never to the page behind", () => {
    render(
      <>
        <button type="button" data-testid="behind">
          behind
        </button>
        <CardDetail
          def={defOf("core-043")}
          onClose={() => undefined}
          actions={
            <button type="button" data-testid="detail-action">
              Add
            </button>
          }
        />
      </>,
    );
    const close = screen.getByTestId(INSPECT_CLOSE);
    const action = screen.getByTestId("detail-action");
    expect(close).toHaveFocus();

    expect(tabFrom(close)).toBe(false);
    expect(action).toHaveFocus();
    expect(screen.getByTestId(INSPECT_DETAIL).contains(document.activeElement)).toBe(true);

    // Shift+Tab from the first control wraps to the last.
    expect(tabFrom(action, true)).toBe(false);
    expect(close).toHaveFocus();

    // A Tab between two controls inside is left to the browser.
    close.blur();
    action.focus();
    expect(tabFrom(action)).toBe(true);
  });

  it("B25 focus that has escaped the dialog is pulled back in by the next Tab", () => {
    render(
      <>
        <button type="button" data-testid="behind">
          behind
        </button>
        <CardDetail def={defOf("core-043")} onClose={() => undefined} />
      </>,
    );
    const behind = screen.getByTestId("behind");
    behind.focus();
    expect(tabFrom(behind)).toBe(false);
    expect(screen.getByTestId(INSPECT_DETAIL).contains(document.activeElement)).toBe(true);
  });

  it("B25 the touch sheet traps Tab too: Close is its only control, so Tab keeps it", () => {
    render(
      <Scene>
        <Trigger id="a" subject={subjectOf("b25-trap-sheet", "core-043")} />
      </Scene>,
    );
    longPress(screen.getByTestId("a"));
    const close = screen.getByTestId(INSPECT_CLOSE);
    expect(close).toHaveFocus();
    expect(tabFrom(close)).toBe(false);
    expect(close).toHaveFocus();
    expect(tabFrom(close, true)).toBe(false);
    expect(close).toHaveFocus();
  });
});

describe("events inside an overlay stay inside it (B25)", () => {
  it("B25 the fence itself catches an event that nothing stops (the control)", () => {
    const spies = fenceSpies();
    render(
      <Fence spies={spies}>
        <Trigger id="a" subject={subjectOf("b25-control", "core-043")} />
      </Fence>,
    );
    fireEvent.click(screen.getByTestId("fence-control"));
    expect(spies.click).toHaveBeenCalledTimes(1);
  });

  it("B25 no event inside the hover preview reaches an ancestor's handler", () => {
    const spies = fenceSpies();
    render(
      <Fence spies={spies}>
        <Trigger id="a" subject={subjectOf("b25-hover", "core-043")} />
      </Fence>,
    );
    hover(screen.getByTestId("a"));
    const preview = screen.getByTestId(INSPECT_HOVER);
    clearSpies(spies);
    fireEverything(faceIn(preview));
    expectFenceUntouched(spies);
  });

  it("B25 no event inside the sheet reaches an ancestor's handler", () => {
    const spies = fenceSpies();
    render(
      <Fence spies={spies}>
        <Trigger id="a" subject={subjectOf("b25-sheet", "core-043")} />
      </Fence>,
    );
    longPress(screen.getByTestId("a"));
    const sheet = screen.getByTestId(INSPECT_SHEET);
    clearSpies(spies);
    fireEverything(faceIn(sheet));
    fireEvent.keyDown(screen.getByTestId(INSPECT_CLOSE), { key: "Enter" });
    realClick(screen.getByTestId(INSPECT_CLOSE));
    expectFenceUntouched(spies);
  });

  it("B25 no event inside CardDetail reaches an ancestor's handler", () => {
    const spies = fenceSpies();
    render(
      <Fence spies={spies}>
        <CardDetail def={defOf("core-043")} onClose={() => undefined} />
      </Fence>,
    );
    const detail = screen.getByTestId(INSPECT_DETAIL);
    fireEverything(faceIn(detail));
    fireEvent.keyDown(screen.getByTestId(INSPECT_CLOSE), { key: "Enter" });
    realClick(screen.getByTestId(INSPECT_CLOSE));
    realClick(screen.getByTestId(INSPECT_SCRIM));
    expectFenceUntouched(spies);
  });

  it("B25 clicks and keys inside a board card's sheet never reach the Board's onClick", () => {
    const view = fullBoardView();
    const unit = yourUnit(view, 0);
    const cardId = testid.card(unit.instanceId);
    // The zone is legal too, so anything that bubbled out of the portal into `Zone` would report.
    const zoneId = testid.zone("you", "units", 1);
    const onClick = vi.fn<(target: ClickTarget) => void>();
    renderBoard(view, [cardId, zoneId], onClick);

    longPress(screen.getByTestId(cardId));
    const sheet = screen.getByTestId(INSPECT_SHEET);
    realClick(faceIn(sheet));
    fireEvent.keyDown(faceIn(sheet), { key: "Enter" });
    fireEvent.keyDown(screen.getByTestId(INSPECT_CLOSE), { key: " " });
    realClick(screen.getByTestId(INSPECT_CLOSE));
    expect(screen.queryByTestId(INSPECT_SHEET)).toBeNull();
    expect(onClick).not.toHaveBeenCalled();

    // The control: once the suppressor has run out, the same card reports a click as before.
    advance(CLICK_SUPPRESS_MS);
    fireEvent.click(screen.getByTestId(cardId));
    expect(onClick).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// B26: the glossary
// ---------------------------------------------------------------------------------------------

describe("the glossary (B26)", () => {
  /**
   * A face built to make the order visible. Its text: Death, then Cry, then Lifesteal and Cry again
   * (already listed). Keywords: Taunt (new), Lifesteal (already listed), Rush (new).
   */
  const ORDERED_FACE: FaceModel = {
    defId: "glossary-order-probe",
    known: true,
    name: "Glossary Order Probe",
    type: "Unit",
    tags: [],
    rarity: "Common",
    index: "0",
    set: "Core",
    radiant: true,
    cost: { text: "1", value: "1", tone: "base", alt: null },
    stats: { attack: 1, health: 1, maxHealth: 1, attackTone: "base", healthTone: "base" },
    text: { full: "Death: deal 2. Cry: draw 1. Lifesteal. Cry: again", marks: [] },
    refs: [],
    values: [],
    keywords: [{ kind: "Taunt" }, { kind: "Lifesteal" }, { kind: "Rush" }],
    inPlay: false,
    vanilla: false,
    gained: [],
    printed: null,
  };
  const ORDER: GlossaryTermId[] = ["Death", "Cry", "Lifesteal", "Taunt", "Rush"];

  const BARE_FACE: FaceModel = {
    ...ORDERED_FACE,
    defId: "glossary-empty-probe",
    name: "Glossary Empty Probe",
    radiant: false,
    text: { full: "", marks: [] },
    keywords: [],
  };

  it("B26 lists the text's terms in order, then keywords not yet listed, each with its label and rule", () => {
    expect(glossaryFor(ORDERED_FACE).map((entry) => entry.id), "glossaryFor agrees with the order B26 states").toEqual(ORDER);

    render(<Trigger id="a" subject={{ key: "b26-order", face: ORDERED_FACE }} />);
    hover(screen.getByTestId("a"));
    const preview = screen.getByTestId(INSPECT_HOVER);
    expect(glossaryTerms(preview)).toEqual(ORDER);

    const items = Array.from(within(preview).getByTestId(INSPECT_GLOSSARY).querySelectorAll("li"));
    for (const [i, id] of ORDER.entries()) {
      const item = must(items[i], `glossary item ${String(i)}`);
      expect(item.querySelector("strong"), `${id}'s label`).toHaveTextContent(GLOSSARY[id].label);
      expect(item, `${id}'s rule`).toHaveTextContent(GLOSSARY[id].rule);
    }
  });

  it("B26 the sheet carries the same glossary, in the same order", () => {
    render(<Trigger id="a" subject={{ key: "b26-sheet", face: ORDERED_FACE }} />);
    longPress(screen.getByTestId("a"));
    expect(glossaryTerms(screen.getByTestId(INSPECT_SHEET))).toEqual(ORDER);
  });

  it("B26 a real card's glossary is glossaryFor its face", () => {
    const face = faceOf("core-003", true);
    const expected = glossaryFor(face).map((entry) => entry.id);
    expect(expected.length, "core-003's radiant face names several terms").toBeGreaterThan(1);

    render(<Trigger id="a" subject={{ key: "b26-real", face }} />);
    hover(screen.getByTestId("a"));
    expect(glossaryTerms(screen.getByTestId(INSPECT_HOVER))).toEqual(expected);
  });

  it("B26 a base face's glossary leaves out a keyword only the radiant face has", () => {
    const def = defOf("core-011");
    expect(def.radiant.keywords.map((k) => k.kind)).toContain("Charge");
    render(<Trigger id="a" subject={{ key: "b26-base", face: faceOf("core-011") }} />);
    hover(screen.getByTestId("a"));
    const terms = glossaryTerms(screen.getByTestId(INSPECT_HOVER));
    expect(terms).toEqual(["Rush", "First Strike"]);
    expect(terms).not.toContain("Charge");
  });

  // SPEC §8: a radiant cell that lists keywords without "Plus" is the radiant form's complete list,
  // so a keyword only the base form has is neither printed on the radiant face nor explained by it.
  it("B26 a radiant face's glossary follows what it prints, never a base keyword its cell replaced (core-056, core-025)", () => {
    const jilliax = glossaryFor(faceOf("core-056", true)).map((entry) => entry.id);
    expect(jilliax).toEqual(["Charge", "Taunt", "Lifesteal", "Indestructible"]);
    expect(jilliax).not.toContain("Rush");
    expect(jilliax).not.toContain("Divine Shield");
    expect(glossaryFor(faceOf("core-025", true)).map((entry) => entry.id)).toEqual(["Indestructible"]);

    render(<Trigger id="a" subject={{ key: "b26-radiant", face: faceOf("core-056", true) }} />);
    hover(screen.getByTestId("a"));
    expect(glossaryTerms(screen.getByTestId(INSPECT_HOVER))).toEqual(jilliax);
  });

  it("B26 a keyword the text already names is listed once", () => {
    const def = defOf("core-003");
    expect(def.base.text).toBe("Taunt, Divine Shield, Reborn");
    render(<Trigger id="a" subject={{ key: "b26-once", face: faceOf("core-003") }} />);
    hover(screen.getByTestId("a"));
    expect(glossaryTerms(screen.getByTestId(INSPECT_HOVER))).toEqual(["Taunt", "Divine Shield", "Reborn"]);
  });

  it("B26 a face with no terms and no keywords renders no inspect-glossary at all", () => {
    expect(glossaryFor(BARE_FACE)).toEqual([]);
    render(<Trigger id="a" subject={{ key: "b26-empty", face: BARE_FACE }} />);
    hover(screen.getByTestId("a"));
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
    expect(screen.queryByTestId(INSPECT_GLOSSARY)).toBeNull();
  });
});
