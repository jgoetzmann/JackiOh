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

/** "/login?mode=forgot" -> { pathname: "/login", search: "?mode=forgot" }; a bare path has "". */
function splitTarget(path: string): { pathname: string; search: string } {
  const at = path.indexOf("?");
  const rawPath = at === -1 ? path : path.slice(0, at);
  const query = at === -1 ? "" : path.slice(at + 1);
  return {
    pathname: rawPath.replace(/\/+$/, "") || "/",
    search: query.length === 0 ? "" : `?${query}`,
  };
}

/**
 * Moves to `path`, which may carry a query (`loginPath` builds the only ones). A navigation to the
 * page already showing -- same pathname AND same query -- is a no-op, so a guard that re-renders
 * cannot stack history entries.
 */
export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (typeof window === "undefined") return;
  const target = splitTarget(path);
  if (currentPath() === target.pathname && window.location.search === target.search) return;
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
  resetPassword: "/reset-password",
  invite: "/invite",
  decks: "/decks",
  play: "/play",
  account: "/account",
  practice: "/practice",
  hotseat: "/dev/hotseat",
  match: (matchId: string): string => `/match/${matchId}`,
  /** R259: a Best-of-3 series between its games: the score, the picks and the pick clock. */
  series: (seriesId: string): string => `/series/${seriesId}`,
} as const;

/** `/<first>/<id>` -> `<id>`, or null when the path is anything else. */
function idUnder(path: string, first: string): string | null {
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length !== 2 || parts[0] !== first) return null;
  return parts[1] ?? null;
}

/** `/match/<id>` -> `<id>`, or null when this is not a match route. */
export function matchIdOf(path: string): string | null {
  return idUnder(path, "match");
}

/** `/series/<id>` -> `<id>`, or null when this is not a series route. */
export function seriesIdOf(path: string): string | null {
  return idUnder(path, "series");
}

// --- the sign-in screen's two entry states --------------------------------------------------------
//
// `/login` can be opened to say why (the session ended) or to open straight onto the forgot-password
// form (the reset screen's "request a new link"). Those are the ONLY two things ever put in its
// query, each an exact token, so no destination, message or address can travel through a URL into
// the screen (B35, R193). A sign-in always lands on a `paths` value, never on a URL it was given.

export type LoginReason = "expired";
export type LoginEntryMode = "forgot";

/** "/login", "/login?reason=expired" or "/login?mode=forgot". Nothing else is ever put in the query. */
export function loginPath(options: { reason?: LoginReason; mode?: LoginEntryMode } = {}): string {
  const query = new URLSearchParams();
  if (options.reason === "expired") query.set("reason", "expired");
  if (options.mode === "forgot") query.set("mode", "forgot");
  const search = query.toString();
  return search.length === 0 ? paths.login : `${paths.login}?${search}`;
}

function queryValue(search: string, key: string): string | null {
  return new URLSearchParams(search).get(key);
}

/** Exactly "expired", else null. */
export function loginReasonOf(search: string): LoginReason | null {
  return queryValue(search, "reason") === "expired" ? "expired" : null;
}

/** Exactly "forgot", else null. */
export function loginModeOf(search: string): LoginEntryMode | null {
  return queryValue(search, "mode") === "forgot" ? "forgot" : null;
}
