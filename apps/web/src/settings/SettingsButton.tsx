// The gear that opens the settings dialog (docs/polish/7-mobile-ux.md S8, B23). Two mounts:
// `placement="game"` at the end of the board's control bar, `placement="nav"` at the end of
// `BackLink`'s nav. The panel is portalled to <body> so it sits above the board's own stacking
// contexts, and focus returns to this gear when it closes.

import { useCallback, useRef, useState, type ReactElement } from "react";
import { createPortal } from "react-dom";

import SettingsPanel from "./SettingsPanel.tsx";
import "./settings.css";

export type SettingsButtonProps = { placement: "game" | "nav" };

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
        <span aria-hidden="true">⚙</span>
      </button>
      {open ? createPortal(<SettingsPanel onClose={close} />, document.body) : null}
    </>
  );
}
