// The one piece of chrome every inner screen shares: a way back.
//
// NO SPEC DRIVES THIS. It exists because there wasn't one: `/decks`, `/play`, `/invite` and
// `/match/<id>` are real URLs a player can land on directly (main.tsx routes on the pathname), and
// none of them offered any way to leave except the browser's own Back button — which does not
// exist on a screen opened from a link, and is not obvious on a phone.

import type { MouseEvent, ReactElement } from "react";

import { navigate, paths } from "../net/navigate.ts";

export const navTestid = {
  back: "nav-back",
  account: "nav-account",
} as const;

export type BackLinkProps = {
  /** Where "back" goes. Defaults to the landing page, which every screen can reach. */
  to?: string;
  label?: string;
  /** Runs before the move: a screen that holds something it must let go of when left. */
  onLeave?: () => void;
  /**
   * Replaces the move: the screen decides what a press does (the reset screen asks before it
   * spends a one-time link). Without it, a press runs `onLeave` and goes to `to`.
   */
  onPress?: () => void;
};

/**
 * `navigate`, not `history.back()`: a player who opened this URL directly has no history entry to
 * go back to, and would either sit still or leave the site entirely.
 */
export function BackLink({ to = paths.landing, label = "← Back", onLeave, onPress }: BackLinkProps): ReactElement {
  return (
    <nav className="row screen-nav">
      <button
        type="button"
        className="link-button"
        data-testid={navTestid.back}
        onClick={() => {
          if (onPress !== undefined) {
            onPress();
            return;
          }
          onLeave?.();
          navigate(to);
        }}
      >
        {label}
      </button>
    </nav>
  );
}

/**
 * The click handler for an `<a href={to}>` that should move in place instead of reloading the page.
 *
 * Only a plain left click is taken over. A middle click, a modified click (new tab, new window,
 * download) or a click something else already handled keeps the browser's own behaviour, which is
 * why these links are anchors with a real `href` and not buttons.
 */
export function followInApp(to: string): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.defaultPrevented) return;
    if (event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
}
