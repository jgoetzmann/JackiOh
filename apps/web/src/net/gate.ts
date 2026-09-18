// SPEC §9.4's gate, as the client renders it.
//
// The gate is the SERVER's: every endpoint but `/api/auth/me` and `/api/codes/*` is declared
// `auth: "active"` and answers 403 `account_pending` to anyone else. This module enforces nothing
// (CLAUDE.md rule 7) — it reads `GET /api/auth/me`, which is the endpoint §9.4 provides precisely
// so "the client knows to show the code screen", and reports what it said. A screen that renders
// on a `pending` account is a UX mistake, not a security hole: the data it would need is already
// refused at the door.
//
// §9.4: "A pending account can log in, verify its email and see the code screen, and nothing
// else." So `/decks`, `/play` and `/match/<id>` send a pending account to `/invite`, and an
// account with no session at all to `/login`.

import { useEffect, useState } from "react";

import { ApiRequestError, getMe, type MeResponse } from "./api.ts";
import { readSession } from "./session.ts";

export type Account =
  /** The `/api/auth/me` round trip has not answered yet. */
  | { kind: "loading" }
  /** No session in storage, or the server refused the token. */
  | { kind: "anonymous" }
  /** The server could not be reached, or answered something unexpected. */
  | { kind: "error"; message: string }
  | { kind: "ready"; token: string; me: MeResponse };

/** `me.profile.status`, hoisted so a screen does not reach through two objects for it. */
export function statusOf(account: Account): "loading" | "anonymous" | "error" | MeResponse["profile"]["status"] {
  return account.kind === "ready" ? account.me.profile.status : account.kind;
}

/**
 * Reads the session, then `/api/auth/me`. One request per mount; the result is the only thing a
 * screen needs to decide whether to render itself or hand over to the gate.
 */
export function useAccount(): Account {
  const [account, setAccount] = useState<Account>({ kind: "loading" });

  useEffect(() => {
    const session = readSession();
    if (session === null) {
      setAccount({ kind: "anonymous" });
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    getMe(session.accessToken)
      .then((me) => {
        if (!cancelled) setAccount({ kind: "ready", token: session.accessToken, me });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        // A token the provider no longer accepts is the same as having none: sign in again.
        if (cause instanceof ApiRequestError && cause.status === 401) {
          setAccount({ kind: "anonymous" });
          return;
        }
        setAccount({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, []);

  return account;
}
