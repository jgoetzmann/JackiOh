// Routing, such as it is.
//
// `main.tsx` is a pathname switch rather than a router dependency (M5 shipped one route). The
// screens M6 adds still have to move between each other — §9.4's gate sends a pending account to
// the code screen, and a room claim sends both players to `/match/<id>` — so this module is the
// one place that changes the URL and the one place a component subscribes to it.
//
// `history.pushState` / `replaceState` do not fire `popstate`, so `navigate` dispatches its own
// event and `usePathname` listens for both. The pathname is what `cy.location("pathname")` reads
// in specs 09 and 10, so a guard redirect must really move the URL, not merely swap a component.

import { useSyncExternalStore } from "react";

/** Fired after every `navigate`. Private to this module; `usePathname` is the public half. */
const NAVIGATED = "jackioh:navigated";

export function currentPath(): string {
  if (typeof window === "undefined") return "/";
  return window.location.pathname.replace(/\/+$/, "") || "/";
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  if (currentPath() === path.replace(/\/+$/, "")) return;
  if (options.replace === true) {
    window.history.replaceState(null, "", path);
  } else {
    window.history.pushState(null, "", path);
  }
  window.dispatchEvent(new Event(NAVIGATED));
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  window.addEventListener(NAVIGATED, onChange);
  return () => {
    window.removeEventListener("popstate", onChange);
    window.removeEventListener(NAVIGATED, onChange);
  };
}

/** The current pathname, re-rendering the caller whenever it changes. */
export function usePathname(): string {
  return useSyncExternalStore(subscribe, currentPath, currentPath);
}

/** Every route the client serves. One table, so no screen spells a path twice. */
export const paths = {
  landing: "/",
  login: "/login",
  invite: "/invite",
  decks: "/decks",
  play: "/play",
  hotseat: "/dev/hotseat",
  match: (matchId: string): string => `/match/${matchId}`,
} as const;

/** `/match/<id>` -> `<id>`, or null when this is not a match route. */
export function matchIdOf(path: string): string | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2 || parts[0] !== "match") return null;
  return parts[1] ?? null;
}
