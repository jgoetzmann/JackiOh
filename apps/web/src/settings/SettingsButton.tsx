// The gear that opens the settings dialog (docs/polish/7-mobile-ux.md S8, B23). Mounts:
// `placement="game"` at the end of the board's control bar, `placement="nav"` at the end of
// `BackLink`'s nav and in the landing's corner, so it is always the top-right control of a screen.
// The panel is portalled to <body> so it sits above the board's own stacking contexts, and focus
// returns to this gear when it closes.
//
// The icon is drawn, not typed: U+2699 in the system font rendered about 8 px wide at the button's
// size and read as a dot (integration QA). The path is a gear of eight teeth with a hub, filled in
// `currentColor` so every skin's button colour applies.

import { useCallback, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import SettingsPanel from "./SettingsPanel.tsx";
import "./settings.css";

export type SettingsButtonProps = { placement: "game" | "nav" };

/** An eight-toothed gear with a hub, on a 24-unit square (even-odd fill cuts the hub out). */
const GEAR_PATH =
  "M19.47 10.14 L22.11 10.64 L22.11 13.36 L19.47 13.86 L18.60 15.97 L20.11 18.19 L18.19 20.11 L15.97 18.60 L13.86 19.47 L13.36 22.11 L10.64 22.11 L10.14 19.47 L8.03 18.60 L5.81 20.11 L3.89 18.19 L5.40 15.97 L4.53 13.86 L1.89 13.36 L1.89 10.64 L4.53 10.14 L5.40 8.03 L3.89 5.81 L5.81 3.89 L8.03 5.40 L10.14 4.53 L10.64 1.89 L13.36 1.89 L13.86 4.53 L15.97 5.40 L18.19 3.89 L20.11 5.81 L18.60 8.03 Z M15.30 12.00 A3.3 3.3 0 1 0 8.70 12.00 A3.3 3.3 0 1 0 15.30 12.00 Z";

export default function SettingsButton({ placement }: SettingsButtonProps): ReactElement {
  const [open, setOpen] = useState(false);
  const gearRef = useRef<HTMLButtonElement>(null);

  // Focus moves before the panel unmounts, so it never falls back to <body> on the way.
  const close = useCallback((): void => {
    setOpen(false);
    gearRef.current?.focus();
  }, []);

  return (
    <>
      <button
        ref={gearRef}
        type="button"
        className={`settings-gear settings-gear--${placement}`}
        data-testid={`settings-open-${placement}`}
        aria-label="Settings"
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Settings"
        onClick={() => {
          setOpen(true);
        }}
      >
        <span aria-hidden="true" className="settings-gear__icon">
          <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">
            <path fillRule="evenodd" fill="currentColor" d={GEAR_PATH} />
          </svg>
        </span>
      </button>
      {open ? createPortal(<SettingsPanel onClose={close} />, document.body) : null}
    </>
  );
}
