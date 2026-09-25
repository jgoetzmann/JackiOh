// `/decks` — the deck workshop (SPEC §9.4, R250–R256).
//
// This file is the screen's I/O and its half of §9.4's gate; the workshop itself is
// `game/deckbuilder/DeckWorkshop.tsx` and holds no rule either.
//
// THE GATE. §9.4: "A pending account can log in, verify its email and see the code screen, and
// nothing else." `e2e/cypress/e2e/10-invite-gate.cy.ts` asserts that from the browser — visiting
// this route with a pending session must land on `/invite` — and asserts the same route stays put
// once the account is active. The gate is really the server's (every endpoint below is
// `auth: "active"` and answers 403 `account_pending`); this redirect is UX, so the screen does not
// sit on refusals.
//
// THE READS. `GET /api/decks` (the saved decks and trios and the caps they live under; a profile
// that has saved nothing gets empty lists, which open the workshop empty and are not an error),
// `GET /api/catalog` (names and costs — the builder runs before any engine is loaded) and
// `GET /api/collection` (L5's quantities). Only the collection is optional: without it ownership is
// neither claimed nor denied, and the queue still checks it.
//
// THE WRITES are the workshop's store's (sync.ts, R256), through the four functions below. They
// read the token at the moment they send, not when the screen opened: the gate renews an hour-old
// token under an open screen (R194), and a save made after that must carry the new one. For the
// same reason the reads run once per profile, not once per token, so a renewal does not reload
// the workshop under the player's hands.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { CatalogSnapshot, Collection } from "@jackioh/validator";

import DeckWorkshop from "../game/deckbuilder/DeckWorkshop.tsx";
import { collectionFrom } from "../game/deckbuilder/loadout.ts";
import type { DeckSyncApi } from "../game/deckbuilder/sync.ts";
import { DECKBUILDER_ERROR, DECKBUILDER_LOADING } from "../game/deckbuilder/testids.ts";
import {
  deleteDeck,
  deleteTrio,
  getCatalog,
  getCollection,
  getDecks,
  putDeck,
  putTrio,
  type DecksResponse,
} from "../net/api.ts";
import { useAccount } from "../net/gate.ts";
import { navigate, paths } from "../net/navigate.ts";

type Loaded = {
  catalog: CatalogSnapshot;
  collection: Collection | null;
  decks: DecksResponse;
};

type Screen =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; profileId: string; data: Loaded };

function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="app-shell">
      <h1>JackiOh — decks</h1>
      {children}
    </div>
  );
}

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
  const profileId = account.kind === "ready" ? account.me.profile.id : null;
  const blocked = account.kind === "ready" && account.me.needsInviteCode;

  // The token a write sends is the one the gate holds NOW (R194 renews it under an open screen).
  const tokenRef = useRef<string | null>(token);
  useLayoutEffect(() => {
    tokenRef.current = token;
  }, [token]);

  const api = useMemo<DeckSyncApi>(() => {
    const current = (): string => tokenRef.current ?? "";
    return {
      putDeck: (id, input) => putDeck(current(), id, input),
      deleteDeck: (id) => deleteDeck(current(), id),
      putTrio: (id, input) => putTrio(current(), id, input),
      deleteTrio: (id) => deleteTrio(current(), id),
    };
  }, []);

  const hasToken = token !== null;
  useEffect(() => {
    if (!hasToken || profileId === null || blocked) return;
    const readToken = tokenRef.current ?? "";
    let cancelled = false;
    setScreen({ kind: "loading" });

    // The collection is the only optional read: L5 needs it, the rest of the screen does not.
    Promise.all([
      getDecks(readToken),
      getCatalog(),
      getCollection(readToken).then(
        (response) => response,
        () => null,
      ),
    ])
      .then(([decks, catalog, collection]) => {
        if (cancelled) return;
        setScreen({
          kind: "ready",
          profileId,
          data: {
            catalog: { version: catalog.version, cards: catalog.defs },
            collection: collection === null ? null : collectionFrom(collection.entries),
            decks,
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
  }, [hasToken, profileId, blocked]);

  if (account.kind === "error") {
    return (
      <Shell>
        <p className="notice" data-testid={DECKBUILDER_ERROR}>
          {account.message}
        </p>
      </Shell>
    );
  }

  if (account.kind === "loading" || account.kind === "anonymous" || blocked) {
    return (
      <Shell>
        <p data-testid={DECKBUILDER_LOADING}>Loading…</p>
      </Shell>
    );
  }

  if (account.kind === "ready" && account.me.profile.status === "banned") {
    // §9.4 has a `banned` status and no screen for it. Nothing is guessed at: the account is not
    // sent to the code screen (redemption is the pending → active transition, not this) and the
    // reads above are refused at the server anyway.
    return (
      <Shell>
        <p className="notice" data-testid={DECKBUILDER_ERROR}>
          This account cannot edit decks.
        </p>
      </Shell>
    );
  }

  if (screen.kind === "error") {
    return (
      <Shell>
        <p className="notice" data-testid={DECKBUILDER_ERROR}>
          {screen.message}
        </p>
      </Shell>
    );
  }

  if (screen.kind === "loading") {
    return (
      <Shell>
        <p data-testid={DECKBUILDER_LOADING}>Loading…</p>
      </Shell>
    );
  }

  return (
    <DeckWorkshop
      // One store per profile: another account signing in on this device gets its own mirror.
      key={screen.profileId}
      catalog={screen.data.catalog}
      collection={screen.data.collection}
      data={screen.data.decks}
      profileId={screen.profileId}
      api={api}
    />
  );
}
