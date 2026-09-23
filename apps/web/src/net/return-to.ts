// Where a signed-out player was going, so a sign-in can take them there.
//
// "Play online" while signed out goes through the gate to `/login`, and a sign-in used to land on
// `/decks` whatever the player had pressed. So the gate remembers which screen sent the player to
// sign in, and the sign-in goes back there. It is kept in `sessionStorage` (this tab, this visit)
// and it is never a URL: only one of the fixed gated `paths` values below is ever written or read
// back, so nothing typed, linked or planted can choose where a sign-in lands (B35).

import { paths } from "./navigate.ts";

export const RETURN_TO_STORAGE_KEY = "jackioh.auth.returnTo";

/** The gated screens a sign-in may go back to. A match is left out: its id is data from a URL. */
const RETURN_TARGETS: readonly string[] = [paths.decks, paths.play, paths.invite, paths.account];

/** The allowed path equal to `path`, or null. */
function returnTarget(path: string | null): string | null {
  if (path === null) return null;
  return RETURN_TARGETS.find((target) => target === path) ?? null;
}

/** The gate sent the player from `path` to sign in; remembered only when it is a fixed gated path. */
export function rememberReturnTo(path: string): void {
  if (typeof window === "undefined") return;
  const target = returnTarget(path);
  try {
    if (target === null) window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
    else window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, target);
  } catch {
    // Blocked storage: a sign-in lands on the default screen, as it always did.
  }
}

/** Where a sign-in goes back to, read once and forgotten: an allowed path, or null. */
export function takeReturnTo(): string | null {
  if (typeof window === "undefined") return null;
  let raw: string | null;
  try {
    raw = window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY);
    window.sessionStorage.removeItem(RETURN_TO_STORAGE_KEY);
  } catch {
    return null;
  }
  return returnTarget(raw);
}
