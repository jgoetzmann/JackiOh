// Quiet UI ticks (SPEC §10.11): a click on anything pressable, and a hover blip when a mouse moves
// onto a new pressable element. Delegated from one root, so no component has to know about sound.
//
// Hover is mouse only: a touch or pen `pointerover` fires right before the tap's own click, which
// would play two sounds for one touch.

import { UI_HOVER_THROTTLE_MS } from "./constants.ts";
import type { SoundSink } from "./types.ts";

export const UI_CLICK_SELECTOR = 'button:not(:disabled), [role="button"]:not([aria-disabled="true"]), [data-legal="true"]';
export const UI_HOVER_SELECTOR = 'button:not(:disabled), [data-legal="true"]';

function elementOf(target: EventTarget | null): Element | null {
  if (target === null || typeof (target as Partial<Element>).closest !== "function") return null;
  return target as Element;
}

/** "click" → closest(UI_CLICK_SELECTOR) → playSfx("uiClick"). "pointerover" with pointerType "mouse" →
 *  closest(UI_HOVER_SELECTOR) that differs from the last hovered one and is ≥ UI_HOVER_THROTTLE_MS after the
 *  last hover sound → playSfx("uiHover"). Returns the remover. */
export function installUiSounds(
  sink: Pick<SoundSink, "playSfx">,
  host: Document | HTMLElement,
  now: () => number = () => performance.now(),
): () => void {
  let lastHovered: Element | null = null;
  let lastHoverAt: number | null = null;

  const onClick = (event: Event): void => {
    const element = elementOf(event.target);
    if (element === null) return;
    if (element.closest(UI_CLICK_SELECTOR) === null) return;
    sink.playSfx("uiClick");
  };

  const onPointerOver = (event: Event): void => {
    if ((event as Partial<PointerEvent>).pointerType !== "mouse") return;
    const element = elementOf(event.target);
    if (element === null) return;
    const hit = element.closest(UI_HOVER_SELECTOR);
    if (hit === null || hit === lastHovered) return;
    lastHovered = hit;
    const at = now();
    if (lastHoverAt !== null && at - lastHoverAt < UI_HOVER_THROTTLE_MS) return;
    lastHoverAt = at;
    sink.playSfx("uiHover");
  };

  // Capture phase: a component that stops propagation still gets its tick.
  host.addEventListener("click", onClick, { capture: true, passive: true });
  host.addEventListener("pointerover", onPointerOver, { capture: true, passive: true });

  return () => {
    host.removeEventListener("click", onClick, { capture: true });
    host.removeEventListener("pointerover", onPointerOver, { capture: true });
  };
}
