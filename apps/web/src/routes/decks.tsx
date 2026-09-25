// `/decks` — the loadout editor (BUILD M6-T3, SPEC §9.4 L1–L6).
//
// This file is the screen's I/O and its half of §9.4's gate; the editor itself is
// `game/deckbuilder/Deckbuilder.tsx` and holds no rule either.
//
// THE GATE. §9.4: "A pending account can log in, verify its email and see the code screen, and
// nothing else." `e2e/cypress/e2e/10-invite-gate.cy.ts` asserts that from the browser — visiting
// this route with a pending session must land on `/invite` — and asserts the same route stays put
// once the account is active. The gate is really the server's (every endpoint below is
// `auth: "active"` and answers 403 `account_pending`); this redirect is UX, so the screen does not
// sit on four refusals.
//
// THE READS. `GET /api/loadout` (§9.4's saved decks; `loadout: null` for a profile that has never
// saved, which opens empty and is not an error), `GET /api/catalog` (names and costs — the
// deckbuilder runs before any engine is loaded) and `GET /api/collection` (L5's quantities). Only
// the collection is optional: without it the client verdict is skipped rather than guessed, and
// `PUT /api/loadout` still refuses an illegal save.
//
// THE MESSAGES. A 422 `loadout_invalid` carries the validator's issues in `details` "exactly as
// the validator reported it" (§9.4). They are handed to the editor unchanged — no renumbering, no
// recomposed sentence — and any other refusal shows `error.message` as the server wrote it.

import { useCallback, useEffect, useState } from "react";

import type { CatalogSnapshot, Collection, LoadoutError, LoadoutRule } from "@jackioh/validator";

import { CardDefsProvider } from "../cards/index.ts";
import Deckbuilder, { type SaveOutcome } from "../game/deckbuilder/Deckbuilder.tsx";
import { collectionFrom } from "../game/deckbuilder/loadout.ts";
import { DECKBUILDER_ERROR, DECKBUILDER_LOADING } from "../game/deckbuilder/testids.ts";
import {
  ApiRequestError,
  getCatalog,
  getCollection,
  getLoadout,
  putLoadout,
} from "../net/api.ts";
import { useAccount } from "../net/gate.ts";
import { navigate, paths } from "../net/navigate.ts";

/** `apps/server/src/api/http.ts`'s code for a loadout the validator refused (§9.4). */
const LOADOUT_INVALID = "loadout_invalid";

const LOADOUT_RULES: readonly string[] = ["L1", "L2", "L3", "L4", "L5", "L6"];

/**
 * `error.details` from a 422, read back into the validator's own type. Nothing is reworded: the
 * `message` is taken verbatim and the `rule` is taken as the server sent it. If the payload is not
 * the shape §9.4 describes, no issue is claimed and the error's own message is shown instead —
 * inventing a sentence to cover the gap is exactly what must not happen here.
 */
export function loadoutIssuesFrom(details: unknown): readonly LoadoutError[] {
  if (!Array.isArray(details) || details.length === 0) return [];
  const issues: LoadoutError[] = [];
  for (const entry of details as unknown[]) {
    if (typeof entry !== "object" || entry === null) return [];
    const rule = (entry as { rule?: unknown }).rule;
    const message = (entry as { message?: unknown }).message;
    if (typeof rule !== "string" || !LOADOUT_RULES.includes(rule)) return [];
    if (typeof message !== "string") return [];
    const issue: LoadoutError = { rule: rule as LoadoutRule, message };
    const deck = (entry as { deck?: unknown }).deck;
    if (typeof deck === "number") issue.deck = deck;
    const cardId = (entry as { cardId?: unknown }).cardId;
    if (typeof cardId === "string") issue.cardId = cardId;
    issues.push(issue);
  }
  return issues;
}

/** Every refusal, as the editor shows it. The server's words, never this file's. */
export function saveOutcomeFrom(cause: unknown): SaveOutcome {
  if (cause instanceof ApiRequestError) {
    return {
      ok: false,
      message: cause.message,
      issues: cause.code === LOADOUT_INVALID ? loadoutIssuesFrom(cause.details) : [],
    };
  }
  return {
    ok: false,
    message: cause instanceof Error ? cause.message : String(cause),
    issues: [],
  };
}

type Loaded = {
  catalog: CatalogSnapshot;
  collection: Collection | null;
  decks: readonly (readonly string[])[] | null;
  /** The version the save is stamped with (§9.4: stale versions are refused at save). */
  catalogVersion: string;
};

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; token: string; data: Loaded };

export default function DecksRoute() {
  const account = useAccount();
  const [screen, setScreen] = useState<Screen>({ kind: "loading" });

  // §9.4's gate, as a redirect. `navigate` really moves the URL, which is what
  // `cy.location("pathname")` reads in specs 09 and 10.
  useEffect(() => {
    if (account.kind === "anonymous") navigate(paths.login, { replace: true });
    else if (account.kind === "ready" && account.me.needsInviteCode) {
      navigate(paths.invite, { replace: true });
    }
  }, [account]);

  const token = account.kind === "ready" ? account.token : null;
  const blocked = account.kind === "ready" && account.me.needsInviteCode;

  useEffect(() => {
    if (token === null || blocked) return;
    let cancelled = false;

    // The collection is the only optional read: L5 needs it, the rest of the screen does not.
    Promise.all([
      getLoadout(token),
      getCatalog(),
      getCollection(token).then(
        (response) => response,
        () => null,
      ),
    ])
      .then(([loadout, catalog, collection]) => {
        if (cancelled) return;
        setScreen({
          kind: "ready",
          token,
          data: {
            catalog: { version: catalog.version, cards: catalog.defs },
            collection: collection === null ? null : collectionFrom(collection.entries),
            decks: loadout.loadout?.decks ?? null,
            catalogVersion: loadout.catalogVersion,
          },
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setScreen({
          kind: "error",
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [token, blocked]);

  const save = useCallback(
    async (decks: readonly (readonly string[])[]): Promise<SaveOutcome> => {
      if (screen.kind !== "ready") return { ok: false, message: "", issues: [] };
      try {
        await putLoadout(screen.token, screen.data.catalogVersion, decks);
        return { ok: true };
      } catch (cause: unknown) {
        return saveOutcomeFrom(cause);
      }
    },
    [screen],
  );

  if (account.kind === "error") {
    return (
      <div className="app-shell">
        <h1>JackiOh — decks</h1>
        <p className="notice" data-testid={DECKBUILDER_ERROR}>
          {account.message}
        </p>
      </div>
    );
  }

  if (account.kind === "loading" || account.kind === "anonymous" || blocked) {
    return (
      <div className="app-shell">
        <h1>JackiOh — decks</h1>
        <p data-testid={DECKBUILDER_LOADING}>Loading…</p>
      </div>
    );
  }

  if (account.kind === "ready" && account.me.profile.status === "banned") {
    // §9.4 has a `banned` status and no screen for it. Nothing is guessed at: the account is not
    // sent to the code screen (redemption is the pending → active transition, not this) and the
    // reads below are refused at the server anyway.
    return (
      <div className="app-shell">
        <h1>JackiOh — decks</h1>
        <p className="notice" data-testid={DECKBUILDER_ERROR}>
          This account cannot edit a loadout.
        </p>
      </div>
    );
  }

  if (screen.kind === "error") {
    return (
      <div className="app-shell">
        <h1>JackiOh — decks</h1>
        <p className="notice" data-testid={DECKBUILDER_ERROR}>
          {screen.message}
        </p>
      </div>
    );
  }

  if (screen.kind === "loading") {
    return (
      <div className="app-shell">
        <h1>JackiOh — decks</h1>
        <p data-testid={DECKBUILDER_LOADING}>Loading…</p>
      </div>
    );
  }

  // R279: a reference in a card's text shows the card the catalog names.
  return (
    <CardDefsProvider defs={screen.data.catalog.cards}>
      <Deckbuilder
        catalog={screen.data.catalog}
        collection={screen.data.collection}
        initialDecks={screen.data.decks}
        save={save}
      />
    </CardDefsProvider>
  );
}
