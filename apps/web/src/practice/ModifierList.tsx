// Every live modifier (R169), in full, one tap from the HUD.
//
// The board draws R169's badges beside each hero, but on a phone the rail beside the portrait
// holds a count and a few shortened labels at most. This is where the rest can be read: a chip
// with the count while any modifier is live on either side, which opens the whole list. It reads
// the same `SideView.modifiers` the board does, so it can show nothing the view does not (§10.8).

import { useEffect, useId, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import type { PlayerView } from "@jackioh/shared";

import { practiceTestid } from "./testids.ts";

type ModifierListProps = { view: PlayerView };

export function ModifierList({ view }: ModifierListProps): ReactElement | null {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLSpanElement>(null);

  const yours = view.you.modifiers ?? [];
  const theirs = view.opponent.modifiers ?? [];
  const count = yours.length + theirs.length;

  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") setOpen(false);
    }
    function onPointer(event: PointerEvent): void {
      if (!(event.target instanceof Node)) return;
      if (root.current?.contains(event.target) === true || panel.current?.contains(event.target) === true) return;
      setOpen(false);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
    };
  }, [open]);

  if (count === 0) return null;

  return (
    <span className="practice-modifiers" ref={root}>
      <button
        type="button"
        className="practice-modifiers__chip"
        data-testid={practiceTestid.modifiers}
        data-count={count}
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={`${String(count)} active ${count === 1 ? "modifier" : "modifiers"}`}
        title="Active modifiers"
        onClick={() => {
          setOpen((was) => !was);
        }}
      >
        <span aria-hidden="true">✦</span> {count}
      </button>
      {/* The HUD clips its contents (a blurred, rounded bar), so the list opens on the page. */}
      {open
        ? createPortal(
        <span
          ref={panel}
          className="practice-modifiers__panel"
          id={panelId}
          data-testid={practiceTestid.modifiersPanel}
          role="group"
          aria-label="Active modifiers"
        >
          {[
            { key: "you", title: "You", list: yours },
            { key: "opponent", title: "AI", list: theirs },
          ].map((side) =>
            side.list.length === 0 ? null : (
              <span key={side.key} className="practice-modifiers__side" data-side={side.key}>
                <span className="practice-modifiers__who">{side.title}</span>
                {side.list.map((modifier) => (
                  <span key={modifier.id} className="practice-modifiers__item" data-modifier-id={modifier.id}>
                    {modifier.label}
                  </span>
                ))}
              </span>
            ),
          )}
        </span>,
            document.body,
          )
        : null}
    </span>
  );
}
