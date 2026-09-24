// Hover and long-press inspect for one card (B22–B24). The caller spreads `handlers` on the card's
// root and renders `overlay` as a sibling of that root, never inside it, so the root's own
// onClickCapture never sees a click inside the overlay.
//
// Hover: a mouse or pen pointer (or one with no pointerType, treated as a mouse) resting for
// HOVER_DELAY_MS opens the preview, unless `options.hover` is false or the hoverPreviews setting is
// off. pointerleave, any pointerdown, Escape, a window blur, any scroll, or the page going hidden
// closes it.
//
// Long-press: a touch held for LONG_PRESS_MS without moving more than LONG_PRESS_SLOP_PX opens the
// sheet, or calls `onLongPress`. Moving past the slop, lifting or a pointercancel first cancels it.
// After it fires, the next click on the trigger is swallowed so the press does not also play or
// pick the card; that disarms on the next pointerdown or after CLICK_SUPPRESS_MS. The native
// context menu is prevented while a touch press is pending or has fired, and a mouse right-click
// calls `options.onContextMenu` when one is given.

import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactElement } from "react";
import type { FaceModel } from "../model.ts";
import { readCardSettings, useCardSettings } from "../settings.ts";
// The settings panel's "Hover previews" switch (task 7) is the player's handle on this preview: it
// opens only while both that switch and this module's own `hoverPreviews` allow it.
import { readSettings as readPanelSettings, useSetting as usePanelSetting } from "../../settings/store.ts";
import { CLICK_SUPPRESS_MS, HOVER_DELAY_MS, LONG_PRESS_MS, LONG_PRESS_SLOP_PX } from "./constants.ts";
import { HoverPreview } from "./HoverPreview.tsx";
import { InspectSheet } from "./InspectSheet.tsx";
import type { PreviewPrefer, Rect } from "./placement.ts";
import { closeHoverFor, closeInspect, inspectSnapshot, openInspect, subscribeInspect } from "./store.ts";
import "./inspect.css";

export type InspectSubject = { key: string; face: FaceModel };

export type InspectOptions = {
  /** Default true: a mouse or pen hover opens the preview (also gated by settings.hoverPreviews). */
  hover?: boolean;
  /** Default true: a touch long-press opens the sheet, or calls onLongPress when given. */
  longPress?: boolean;
  onLongPress?: () => void;
  /** When given, a mouse right-click calls it and prevents the native menu. The deck builder only;
      the board leaves right-click to task 7's drag cancel. */
  onContextMenu?: () => void;
  /** Which side of the card the hover preview tries first; "beside" (B27's order) by default. */
  prefer?: PreviewPrefer;
};

export type InspectHandlers = {
  onPointerEnter: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onClickCapture: (event: ReactMouseEvent<HTMLElement>) => void;
};

export type InspectBindings = { handlers: InspectHandlers; overlay: ReactElement | null; open: "hover" | "sheet" | null };

type Timer = ReturnType<typeof setTimeout>;

/** Where a touch press started. */
type Press = { x: number; y: number; pointerId: number };

/** idle; pending: a touch is down and its timer runs; fired: the long-press happened. */
type PressState = "idle" | "pending" | "fired";

function noop(): void {}

const NO_OPTIONS: InspectOptions = {};

const NOOP_HANDLERS: InspectHandlers = {
  onPointerEnter: noop,
  onPointerLeave: noop,
  onPointerDown: noop,
  onPointerMove: noop,
  onPointerUp: noop,
  onPointerCancel: noop,
  onContextMenu: noop,
  onClickCapture: noop,
};

/** Both switches that govern the hover preview, read now (handlers and timers outlive a render). */
function hoverAllowed(): boolean {
  return readCardSettings().hoverPreviews && readPanelSettings().hoverPreviews;
}

/** Mouse, pen, or an event with no pointerType at all. */
function hoverPointer(pointerType: string | undefined): boolean {
  return pointerType === undefined || pointerType === "" || pointerType === "mouse" || pointerType === "pen";
}

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

export function useInspectTrigger(subject: InspectSubject | null, options?: InspectOptions): InspectBindings {
  const key = subject === null ? null : subject.key;
  const settings = useCardSettings();
  const active = useSyncExternalStore(subscribeInspect, () => inspectSnapshot(key));

  // The latest props, for handlers and timers that outlive the render that made them.
  const live = useRef({ subject, options: options ?? NO_OPTIONS });
  useLayoutEffect(() => {
    live.current = { subject, options: options ?? NO_OPTIONS };
  });

  const timers = useRef<{ hover: Timer | null; press: Timer | null; suppress: Timer | null }>({
    hover: null,
    press: null,
    suppress: null,
  });
  const press = useRef<Press | null>(null);
  const pressState = useRef<PressState>("idle");
  const suppressClick = useRef(false);

  const handlers = useMemo<InspectHandlers>(() => {
    const t = timers.current;

    const clearHoverTimer = (): void => {
      if (t.hover !== null) clearTimeout(t.hover);
      t.hover = null;
    };
    const clearPress = (): void => {
      if (t.press !== null) clearTimeout(t.press);
      t.press = null;
      press.current = null;
      if (pressState.current === "pending") pressState.current = "idle";
    };
    const disarmSuppressor = (): void => {
      if (t.suppress !== null) clearTimeout(t.suppress);
      t.suppress = null;
      suppressClick.current = false;
      if (pressState.current === "fired") pressState.current = "idle";
    };
    const armSuppressor = (): void => {
      if (t.suppress !== null) clearTimeout(t.suppress);
      suppressClick.current = true;
      t.suppress = setTimeout(disarmSuppressor, CLICK_SUPPRESS_MS);
    };

    return {
      onPointerEnter: (event) => {
        const { subject: current, options: opts } = live.current;
        if (current === null || opts.hover === false || !hoverAllowed()) return;
        if (!hoverPointer(event.pointerType)) return;
        clearHoverTimer();
        const element = event.currentTarget;
        const hoverKey = current.key;
        t.hover = setTimeout(() => {
          t.hover = null;
          const now = live.current;
          if (now.subject === null || now.subject.key !== hoverKey) return;
          if (now.options.hover === false || !hoverAllowed() || !element.isConnected) return;
          openInspect({ key: hoverKey, mode: "hover", anchor: rectOf(element) });
        }, HOVER_DELAY_MS);
      },

      onPointerLeave: () => {
        clearHoverTimer();
        const current = live.current.subject;
        if (current !== null) closeHoverFor(current.key);
      },

      onPointerDown: (event) => {
        clearHoverTimer();
        const { subject: current, options: opts } = live.current;
        if (current === null) return;
        closeHoverFor(current.key);
        disarmSuppressor();
        clearPress();
        if (event.pointerType !== "touch" || opts.longPress === false) return;
        const element = event.currentTarget;
        const pressKey = current.key;
        press.current = { x: event.clientX, y: event.clientY, pointerId: event.pointerId };
        pressState.current = "pending";
        t.press = setTimeout(() => {
          t.press = null;
          press.current = null;
          const now = live.current;
          if (now.subject === null || now.subject.key !== pressKey || !element.isConnected) {
            pressState.current = "idle";
            return;
          }
          pressState.current = "fired";
          armSuppressor();
          const onLongPress = now.options.onLongPress;
          if (onLongPress !== undefined) onLongPress();
          else openInspect({ key: pressKey, mode: "sheet", anchor: rectOf(element) });
        }, LONG_PRESS_MS);
      },

      onPointerMove: (event) => {
        const start = press.current;
        if (start === null) return;
        if (event.pointerId !== start.pointerId) return;
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) clearPress();
      },

      onPointerUp: () => {
        if (pressState.current === "pending") clearPress();
        // The finger has just lifted from a long-press: its click is on the way, so the swallow
        // window runs from here.
        else if (pressState.current === "fired" && suppressClick.current) armSuppressor();
      },

      onPointerCancel: () => {
        clearPress();
        clearHoverTimer();
      },

      onContextMenu: (event) => {
        // Newer browsers send contextmenu as a PointerEvent that names the pointer.
        const native: Event = event.nativeEvent;
        const nativeType = "pointerType" in native ? (native as PointerEvent).pointerType : undefined;
        if (pressState.current !== "idle" || nativeType === "touch") {
          event.preventDefault();
          return;
        }
        const { subject: current, options: opts } = live.current;
        if (current === null || opts.onContextMenu === undefined) return;
        event.preventDefault();
        clearHoverTimer();
        closeHoverFor(current.key);
        opts.onContextMenu();
      },

      onClickCapture: (event) => {
        if (!suppressClick.current) return;
        event.preventDefault();
        event.stopPropagation();
        disarmSuppressor();
      },
    };
  }, []);

  // Timers never outlive the card.
  useEffect(() => {
    const t = timers.current;
    return () => {
      if (t.hover !== null) clearTimeout(t.hover);
      if (t.press !== null) clearTimeout(t.press);
      if (t.suppress !== null) clearTimeout(t.suppress);
      t.hover = null;
      t.press = null;
      t.suppress = null;
      press.current = null;
      pressState.current = "idle";
      suppressClick.current = false;
    };
  }, []);

  // A card that unmounts, or changes key, takes its overlay with it.
  useEffect(() => {
    if (key === null) return;
    return () => closeInspect(key);
  }, [key]);

  const mode = active === null ? null : active.mode;
  const panelHover = usePanelSetting("hoverPreviews");
  const hoverPreviews = settings.hoverPreviews && panelHover;

  // While the preview is open, the page closes it: Escape, any pointerdown, a window blur, any
  // scroll (capturing, so a scrolled zone counts), or the tab going hidden. Turning hover previews
  // off closes it too.
  useEffect(() => {
    if (key === null || mode !== "hover") return;
    if (!hoverPreviews) {
      closeHoverFor(key);
      return;
    }
    const close = (): void => closeHoverFor(key);
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, mode, hoverPreviews]);

  let overlay: ReactElement | null = null;
  if (subject !== null && active !== null) {
    const closeKey = subject.key;
    overlay =
      active.mode === "hover" ? (
        <HoverPreview face={subject.face} anchor={active.anchor} prefer={options?.prefer} />
      ) : (
        <InspectSheet face={subject.face} onClose={() => closeInspect(closeKey)} />
      );
  }

  return { handlers: subject === null ? NOOP_HANDLERS : handlers, overlay, open: mode };
}
