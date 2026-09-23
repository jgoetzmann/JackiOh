// The one piece of chrome every inner screen shares: a way back.
//
// NO SPEC DRIVES THIS. It exists because there wasn't one: `/decks`, `/play`, `/invite` and
// `/match/<id>` are real URLs a player can land on directly (main.tsx routes on the pathname), and
// none of them offered any way to leave except the browser's own Back button — which does not
// exist on a screen opened from a link, and is not obvious on a phone.

import type { ReactElement } from "react";

import { navigate, paths } from "../net/navigate.ts";
import { SettingsButton } from "../settings/index.ts";

export const navTestid = {
  back: "nav-back",
  account: "nav-account",
} as const;

export type BackLinkProps = {
  /** Where "back" goes. Defaults to the landing page, which every screen can reach. */
  to?: string;
  label?: string;
};

/**
 * `navigate`, not `history.back()`: a player who opened this URL directly has no history entry to
 * go back to, and would either sit still or leave the site entirely.
 */
export function BackLink({ to = paths.landing, label = "← Back" }: BackLinkProps): ReactElement {
  return (
    <nav className="row screen-nav">
      <button
        type="button"
        className="link-button"
        data-testid={navTestid.back}
        onClick={() => {
          navigate(to);
        }}
      >
        {label}
      </button>
      <SettingsButton placement="nav" />
    </nav>
  );
}
