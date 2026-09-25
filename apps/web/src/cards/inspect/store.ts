// The one inspect overlay the page may show (B23), and the plumbing every overlay shares.
//
// Store: one module-level `{ key, mode, anchor }`. Each trigger subscribes through
// useSyncExternalStore with a snapshot that is null unless the open overlay is its own, so opening
// or closing one card's preview re-renders that card and nothing else. A mounted CardDetail
// registers its close callback here too, so `closeInspect()` reaches it and opening any overlay
// closes whatever was open before.

import { useLayoutEffect, useRef } from "react";
import type { MouseEvent as ReactMouseEvent, RefObject, SyntheticEvent } from "react";
import { CLICK_SUPPRESS_MS } from "./constants.ts";
import type { Rect } from "./placement.ts";

type InspectMode = "hover" | "sheet";
type ActiveInspect = { readonly key: string; readonly mode: InspectMode; readonly anchor: Rect };

let active: ActiveInspect | null = null;
let detail: { readonly key: string; readonly close: () => void } | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

export function subscribeInspect(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The open overlay when it belongs to `key`, else null. Stable while nothing changes. */
export function inspectSnapshot(key: string | null): ActiveInspect | null {
  return key !== null && active !== null && active.key === key ? active : null;
}

/** Closes whatever is open, then opens `next`. */
export function openInspect(next: ActiveInspect): void {
  closeInspect();
  active = next;
  emit();
}

/** Closes the open overlay, or only the one for `key`. Task 7's drag layer may call it when a drag starts. */
export function closeInspect(key?: string): void {
  const open = detail;
  if (open !== null && (key === undefined || open.key === key)) {
    detail = null;
    open.close();
  }
  if (active !== null && (key === undefined || active.key === key)) {
    active = null;
    emit();
  }
}

/** Closes `key`'s hover preview and leaves a sheet alone. */
export function closeHoverFor(key: string): void {
  if (active !== null && active.key === key && active.mode === "hover") {
    active = null;
    emit();
  }
}

/** A mounted CardDetail: `closeInspect()` calls `close`. Returns the unregister function. */
export function registerDetail(key: string, close: () => void): () => void {
  const entry = { key, close };
  detail = entry;
  return () => {
    if (detail === entry) detail = null;
  };
}

function stop(event: SyntheticEvent): void {
  event.stopPropagation();
}

/**
 * Spread on every overlay's root. React bubbles portal events through the React tree, so without
 * these a click on Close would reach the Zone's or the Card's onClick (B25).
 */
export const OVERLAY_ROOT_PROPS = {
  onClick: stop,
  onDoubleClick: stop,
  onPointerDown: stop,
  onPointerUp: stop,
  onPointerCancel: stop,
  onMouseDown: stop,
  onMouseUp: stop,
  onKeyDown: stop,
  onKeyUp: stop,
  onContextMenu: stop,
  onDragStart: stop,
  onDragEnter: stop,
  onDragOver: stop,
  onDragLeave: stop,
  onDrop: stop,
  onDragEnd: stop,
} as const;

function restoreFocus(element: HTMLElement | null): void {
  if (element !== null && element.isConnected) element.focus();
}

type ModalOverlay = {
  /** Gives focus back, then calls the caller's onClose. */
  close: () => void;
  /** For the scrim and the Close button. */
  dismissProps: {
    onPointerDown: () => void;
    onClick: (event: ReactMouseEvent<HTMLElement>) => void;
  };
};

/** What Tab can land on inside a dialog. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function tabbablesIn(dialog: Element): HTMLElement[] {
  return [...dialog.querySelectorAll<HTMLElement>(TABBABLE)].filter(
    (element) => !element.hasAttribute("hidden") && element.closest("[hidden], [inert]") === null,
  );
}

/**
 * Keeps Tab inside `dialog`: from the last tabbable (or from anywhere outside) Tab goes to the
 * first, and Shift+Tab from the first (or from outside) goes to the last. Both overlays say
 * `aria-modal="true"`, and they are portalled to the end of <body>, so without this one Tab from
 * Close walks into the page under the scrim (B25).
 */
function trapTab(event: KeyboardEvent, dialog: Element): void {
  const tabbables = tabbablesIn(dialog);
  const first = tabbables[0];
  const last = tabbables[tabbables.length - 1];
  if (first === undefined || last === undefined) {
    event.preventDefault();
    return;
  }
  const active = document.activeElement;
  const outside = active === null || !dialog.contains(active);
  if (event.shiftKey && (outside || active === first)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (outside || active === last)) {
    event.preventDefault();
    first.focus();
  }
}

/**
 * What the sheet and the detail share: focus moves to `focusRef` on open and back to the element
 * that had it on close, Tab stays inside the dialog that holds `focusRef`, Escape closes, and so do
 * the scrim and the Close button.
 *
 * The scrim and Close ignore a pointer click that started before the overlay opened: after a
 * touch long-press some browsers deliver the lifting finger's click to whatever now lies under it,
 * which is the scrim that just appeared. A keyboard click (detail 0), a press that began on the
 * element, or any click once CLICK_SUPPRESS_MS has passed still closes.
 */
export function useModalOverlay(onClose: () => void, focusRef: RefObject<HTMLElement | null>): ModalOverlay {
  const onCloseRef = useRef(onClose);
  const restoreRef = useRef<HTMLElement | null>(null);
  const pressedRef = useRef(false);
  const openedAtRef = useRef(0);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  useLayoutEffect(() => {
    const previous = document.activeElement;
    restoreRef.current = previous instanceof HTMLElement && previous !== document.body ? previous : null;
    openedAtRef.current = Date.now();
    // preventScroll: Close sits at the foot of a dialog that scrolls on a short screen, and
    // focusing it would open the detail scrolled past both faces.
    focusRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Tab") {
        const dialog = focusRef.current?.closest('[role="dialog"]');
        if (dialog !== null && dialog !== undefined) trapTab(event, dialog);
        return;
      }
      if (event.key !== "Escape") return;
      // R279: Escape over an open reference's tooltip closes the tooltip alone (CardRef.tsx).
      const dialog = focusRef.current?.closest('[role="dialog"]') ?? null;
      if (dialog !== null && dialog.querySelector('[data-ref-open="true"]') !== null) return;
      restoreFocus(restoreRef.current);
      onCloseRef.current();
    };
    // Capture, so Escape and Tab are seen before the overlay root stops the event from bubbling.
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      restoreFocus(restoreRef.current);
    };
  }, [focusRef]);

  const close = (): void => {
    restoreFocus(restoreRef.current);
    onCloseRef.current();
  };

  return {
    close,
    dismissProps: {
      onPointerDown: () => {
        pressedRef.current = true;
      },
      onClick: (event) => {
        const deliberate =
          pressedRef.current || event.detail === 0 || Date.now() - openedAtRef.current >= CLICK_SUPPRESS_MS;
        pressedRef.current = false;
        if (deliberate) close();
      },
    },
  };
}
