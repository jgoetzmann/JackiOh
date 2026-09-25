// `/dev/hotseat?seed=42&a=<deckId>&b=<deckId>` (BUILD M5-T3).
//
// The dev route runs `reduce` in the browser with a seed and two deck lists from the URL, renders
// `viewFor` for whichever seat holds the device, hands the device over on a button press, and
// exposes `window.__jackioh` for Cypress outside production builds.
//
// It computes no view of its own. A local `viewFor` would mean the client deciding what a player
// may see, which is exactly the hidden-information leak CLAUDE.md rule 7 and SPEC §10.8 forbid —
// so when the engine cannot be loaded this route renders the reason and stops. That panel is the
// honest state of the world today: `packages/engine/src/index.ts` re-exports six modules that do
// not exist yet, `viewFor` among them, so `loadEnginePort()` rejects with `EngineUnavailableError`
// until M3 lands. Nothing here stubs a fake engine to hide it.

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { Action, ActionBody, CardDefs, PlayerId, PlayerView } from "@jackioh/shared";
import type { Handicap } from "@jackioh/engine/config";

import Game from "../../game/Game.tsx";
import { CatalogContext, lookupFromDefs } from "../../game/catalog.ts";
import { testid } from "../../game/contract.ts";
import { DECK_SIZE, DEFAULT_DECK_ID, DECK_IDS, resolveDecks } from "../../game/decks.ts";
import { EngineUnavailableError, loadEnginePort } from "../../game/engine.ts";
import type { EnginePort, EngineState } from "../../game/engine.ts";
import { SEATS, createHotseat, otherSeat } from "../../game/hotseat.ts";
import type { DispatchResult, HotseatSession } from "../../game/hotseat.ts";
import { navigate, paths } from "../../net/navigate.ts";
import { navTestid } from "../nav.tsx";

/** BUILD M5-T3: the dev handle exists only outside a production build. */
const DEV_ONLY = import.meta.env.MODE !== "production";

/** BUILD's own example URL uses seed 42. */
export const DEFAULT_SEED = "42";

/** ASSUMPTION A1 in `e2e/support/commands.ts`: where `cy.seedGame` parks its fixture decks. */
export const E2E_DECKS_KEY = "jackioh.e2e.decks";

/** R180: each seat's handicap, as `createGame` takes them. Empty when the game is SPEC's own. */
export type SeatHandicaps = Partial<Record<PlayerId, Handicap>>;

// ---------------------------------------------------------------------------------------------
// the dev handle (BUILD M5-T3, consumed by e2e/support/commands.ts)
// ---------------------------------------------------------------------------------------------

/** An action from Cypress, which names the seat it is acting as (`ActionInput`). */
type DevAction = ActionBody & { playerId?: PlayerId };

export type HotseatDevHandle = {
  /** The raw `GameState`. Hidden information: for the test harness and the replay hash only. */
  readonly state: EngineState;
  readonly seed: string;
  readonly seat: PlayerId;
  readonly log: readonly Action[];
  readonly decks: [string[], string[]];
  /**
   * The handicaps the game was created with (R180), `{}` for none: with the seed, the decks and the
   * log, what `replay.fold` needs to reach this game's hash (`cy.replayCheck` passes them on).
   */
  readonly handicaps: SeatHandicaps;
  /**
   * Dispatch as a seat. A hotseat device can be handed to either player, so a `playerId` that is
   * not the seat holding it switches the seat first rather than forging an action for someone
   * else — `reduce` still refuses anything illegal (SPEC §9.3).
   */
  dispatch: (action: DevAction) => DispatchResult;
  view: () => PlayerView;
  legal: () => ActionBody[];
  hash: () => string;
  setSeat: (seat: PlayerId) => void;
};

declare global {
  interface Window {
    /** BUILD M5-T3. */
    __jackioh?: HotseatDevHandle;
    /**
     * ASSUMPTION A1: fixture decks handed to the E2E build of this route, and each seat's handicap
     * when a fixture carries one (R180; `readInjectedHandicaps`).
     */
    __jackiohE2E?: { seed?: string; decks?: Record<string, string[]>; handicaps?: Partial<Record<PlayerId, unknown>> };
  }
}

// ---------------------------------------------------------------------------------------------
// URL and E2E deck injection
// ---------------------------------------------------------------------------------------------

export type HotseatParams = { seed: string; a: string; b: string };

function param(params: URLSearchParams, key: string, fallback: string): string {
  const value = params.get(key);
  return value === null || value === "" ? fallback : value;
}

export function readParams(search: string): HotseatParams {
  const params = new URLSearchParams(search);
  return {
    seed: param(params, "seed", DEFAULT_SEED),
    a: param(params, "a", DEFAULT_DECK_ID),
    b: param(params, "b", DEFAULT_DECK_ID),
  };
}

/**
 * The E2E injection as it arrived: `window.__jackiohE2E`, or the localStorage copy that survives a
 * reload. Nothing at all in a production build. Unread and unchecked: the two readers below take
 * what they can use out of it.
 */
function readInjection(): unknown {
  if (!DEV_ONLY || typeof window === "undefined") return undefined;

  const raw: unknown = window.__jackiohE2E;
  if (raw !== undefined && raw !== null) return raw;
  try {
    const stored = window.localStorage.getItem(E2E_DECKS_KEY);
    return stored === null ? undefined : JSON.parse(stored);
  } catch {
    // A private window, blocked site data, or malformed JSON: there is simply no injection.
    return undefined;
  }
}

/**
 * The E2E deck injection, from `window.__jackiohE2E` or the localStorage copy that survives a
 * reload. External, untrusted input: anything that is not a list of strings is dropped, and the
 * ids that remain are still checked against the catalog by `resolveDeck`.
 */
export function readInjectedDecks(): Record<string, string[]> | undefined {
  const raw = readInjection();
  if (typeof raw !== "object" || raw === null) return undefined;

  const decks = (raw as { decks?: unknown }).decks;
  if (typeof decks !== "object" || decks === null) return undefined;

  const out: Record<string, string[]> = {};
  for (const [id, cards] of Object.entries(decks as Record<string, unknown>)) {
    if (Array.isArray(cards) && cards.every((card) => typeof card === "string")) {
      out[id] = [...(cards as string[])];
    }
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * One seat's injected handicap, if it has the SHAPE of one (R180): an object whose five fields are
 * numbers, and whose `heroHealth` (R290) is a number when present. Only the shape is judged here:
 * whether the numbers are legal (non-negative integers, a deck size a library can hold) is the
 * engine's call (`validateHandicap`, R184), and `createGame`'s refusal reaches the screen as a bad
 * deck's does. The copy carries those fields and nothing else, so no stray key reaches the engine.
 */
function handicapShape(raw: unknown): Handicap | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const { deckSize, manaBonus, manaCap, extraOpeningCards, extraDrawsPerTurn, heroHealth } = raw as Record<
    string,
    unknown
  >;
  if (
    typeof deckSize !== "number" ||
    typeof manaBonus !== "number" ||
    typeof manaCap !== "number" ||
    typeof extraOpeningCards !== "number" ||
    typeof extraDrawsPerTurn !== "number"
  ) {
    return undefined;
  }
  if (heroHealth !== undefined && typeof heroHealth !== "number") return undefined;
  return {
    deckSize,
    manaBonus,
    manaCap,
    extraOpeningCards,
    extraDrawsPerTurn,
    ...(heroHealth === undefined ? {} : { heroHealth }),
  };
}

/**
 * The E2E injection's per-seat handicaps (R180): `cy.seedGame` passes fixture A's `handicap` as
 * p1's and fixture B's as p2's, which is the only way a browser reaches R315's fatigue or R80's full
 * library in a few turns. Development builds only, like the deck injection it travels with, and
 * external input like it: a seat whose handicap is not shaped like one is dropped, and `undefined`
 * means no seat has one, so the game is created exactly as it was before handicaps could be injected.
 */
export function readInjectedHandicaps(): SeatHandicaps | undefined {
  const raw = readInjection();
  if (typeof raw !== "object" || raw === null) return undefined;
  const handicaps = (raw as { handicaps?: unknown }).handicaps;
  if (typeof handicaps !== "object" || handicaps === null) return undefined;

  const out: SeatHandicaps = {};
  for (const seat of SEATS) {
    const handicap = handicapShape((handicaps as Record<string, unknown>)[seat]);
    if (handicap !== undefined) out[seat] = handicap;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

// ---------------------------------------------------------------------------------------------
// startup
// ---------------------------------------------------------------------------------------------

type Status =
  | { kind: "loading" }
  | { kind: "no-engine"; missing: readonly string[]; message: string }
  | { kind: "no-game"; message: string }
  /**
   * `decks` and `handicaps` are kept for the dev handle: spec 01 replays the decks with the log
   * (ASSUMPTION A2), and a handicapped game (spec 25) needs its handicaps too.
   */
  | {
      kind: "ready";
      session: HotseatSession;
      defs: CardDefs | null;
      decks: [string[], string[]];
      handicaps: SeatHandicaps;
    };

function catalogOf(port: EnginePort): CardDefs | null {
  if (port.catalog === undefined) return null;
  try {
    return port.catalog();
  } catch {
    // `registeredCatalog()` throws when no catalog has been registered (M4-T2 has not landed).
    return null;
  }
}

function startSession(port: EnginePort, params: HotseatParams): Status {
  const defs = catalogOf(port);
  const handicaps = readInjectedHandicaps();
  // R184: a handicapped seat's deck holds its handicap's size, so the readable pre-check agrees.
  const sizes: [number, number] = [handicaps?.p1?.deckSize ?? DECK_SIZE, handicaps?.p2?.deckSize ?? DECK_SIZE];
  const resolved = resolveDecks(params.a, params.b, defs ?? {}, readInjectedDecks(), sizes);
  if ("error" in resolved) return { kind: "no-game", message: resolved.error };

  try {
    const session = createHotseat({
      seed: params.seed,
      decks: resolved.decks,
      engine: port,
      ...(defs === null ? {} : { catalog: defs }),
      ...(handicaps === undefined ? {} : { handicaps }),
    });
    return { kind: "ready", session, defs, decks: resolved.decks, handicaps: handicaps ?? {} };
  } catch (cause) {
    // `createGame` throws on an illegal deck (§2.6) or handicap (R184) — the engine's ruling,
    // printed as given.
    return { kind: "no-game", message: cause instanceof Error ? cause.message : String(cause) };
  }
}

// ---------------------------------------------------------------------------------------------
// panels
// ---------------------------------------------------------------------------------------------

function EnginePanel({ missing, message }: { missing: readonly string[]; message: string }) {
  return (
    <div className="app-shell">
      <h1>JackiOh — hotseat</h1>
      <p className="notice">
        The client is waiting on M3. It renders <code>viewFor</code> and nothing else (SPEC §10.8),
        so it cannot start a game until <code>@jackioh/engine</code> exports it.
        {missing.length > 0 ? (
          <>
            {" "}
            Missing: <code>{missing.join(", ")}</code>.
          </>
        ) : null}
      </p>
      <p className="notice">
        <code>{message}</code>
      </p>
    </div>
  );
}

function GamePanel({ message, params }: { message: string; params: HotseatParams }) {
  return (
    <div className="app-shell">
      <h1>JackiOh — hotseat</h1>
      <p className="notice">
        No game for <code>?seed={params.seed}&amp;a={params.a}&amp;b={params.b}</code>: {message}
      </p>
      <p className="notice">
        Dev decks: <code>{DECK_IDS.join(", ")}</code>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// the loop
// ---------------------------------------------------------------------------------------------

/**
 * Re-render on every session notification. The session is external mutable state, so the version
 * counter — not the view object, which is rebuilt on each `viewFor` call — is the snapshot.
 */
function useSessionVersion(session: HotseatSession): void {
  const store = useMemo(() => {
    let version = 0;
    return {
      subscribe: (onChange: () => void) =>
        session.subscribe(() => {
          version += 1;
          onChange();
        }),
      snapshot: () => version,
    };
  }, [session]);
  useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
}

function Hotseat({
  session,
  defs,
  decks,
  handicaps,
}: {
  session: HotseatSession;
  defs: CardDefs | null;
  decks: [string[], string[]];
  handicaps: SeatHandicaps;
}) {
  useSessionVersion(session);
  const [error, setError] = useState<string | null>(null);

  const dispatch = useCallback(
    (body: ActionBody): DispatchResult => {
      const result = session.dispatch(body);
      setError(result.error ?? null);
      return result;
    },
    [session],
  );

  /** Handing the device over drops the previous seat's refusal: it was never this player's. */
  const switchTo = useCallback(
    (seat: PlayerId) => {
      setError(null);
      session.setSeat(seat);
    },
    [session],
  );

  // BUILD M5-T3: `{ state, dispatch, seed }` is the contract; the rest is what Cypress needs to
  // drive two seats and check the replay hash (ASSUMPTION A2 in e2e/support/types.ts). Getters,
  // not values, so a spec that re-reads `handle.state` sees the current state and not the one
  // that existed when this effect ran.
  useEffect(() => {
    if (!DEV_ONLY) return;
    const handle: HotseatDevHandle = {
      get state() {
        return session.state();
      },
      get seed() {
        return session.seed;
      },
      get seat() {
        return session.seat;
      },
      get log() {
        return session.log();
      },
      get decks() {
        return decks;
      },
      get handicaps() {
        return handicaps;
      },
      dispatch: (action: DevAction) => {
        // `createHotseat` re-stamps `playerId` with the seat, so the extra key is overwritten.
        if (action.playerId !== undefined) switchTo(action.playerId);
        return dispatch(action);
      },
      view: () => session.view(),
      legal: () => session.legal(),
      hash: () => session.hash(),
      setSeat: switchTo,
    };
    window.__jackioh = handle;
    return () => {
      if (window.__jackioh === handle) delete window.__jackioh;
    };
  }, [session, dispatch, switchTo, decks, handicaps]);

  const view = session.view();
  const legal = session.legal();
  const next = otherSeat(session.seat);
  const lookup = useMemo(() => (defs === null ? null : lookupFromDefs(defs)), [defs]);

  // A finished game's ways on (Result.tsx): the same seed and decks again, or back to the start.
  const resultActions = (
    <>
      <button type="button" data-testid="result-play-again" onClick={() => window.location.reload()}>
        Play again
      </button>
      <button type="button" data-testid="result-back" onClick={() => navigate(paths.landing)}>
        Back
      </button>
    </>
  );
  const game = <Game view={view} legal={legal} onAction={dispatch} error={error} resultActions={resultActions} />;

  return (
    <div className="app-shell app-shell--wide">
      <header className="hotseat-bar">
        {/* A way out, as every other screen has (nav.tsx); the board's own gear holds the settings. */}
        <button type="button" className="link-button" data-testid={navTestid.back} onClick={() => navigate(paths.landing)}>
          ← Back
        </button>
        <span>
          seed <code>{session.seed}</code> · seat <code>{session.seat}</code> · turn {view.turn} ·
          active <code>{view.active}</code>
        </span>
        <button type="button" data-testid={testid.seatSwitch} onClick={() => switchTo(next)}>
          Hand over to {next}
        </button>
      </header>
      {lookup === null ? game : <CatalogContext.Provider value={lookup}>{game}</CatalogContext.Provider>}
    </div>
  );
}

export function HotseatRoute() {
  const params = useMemo(() => readParams(window.location.search), []);
  const [status, setStatus] = useState<Status>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    loadEnginePort()
      .then((port) => {
        if (!cancelled) setStatus(startSession(port, params));
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        const error = cause instanceof EngineUnavailableError ? cause : null;
        setStatus({
          kind: "no-engine",
          missing: error?.missing ?? [],
          message: cause instanceof Error ? cause.message : String(cause),
        });
      });
    return () => {
      cancelled = true;
    };
  }, [params]);

  if (status.kind === "loading") {
    return (
      <div className="app-shell">
        <h1>JackiOh — hotseat</h1>
        <p className="notice">Loading the engine…</p>
      </div>
    );
  }
  if (status.kind === "no-engine") {
    return <EnginePanel missing={status.missing} message={status.message} />;
  }
  if (status.kind === "no-game") {
    return <GamePanel message={status.message} params={params} />;
  }

  return <Hotseat session={status.session} defs={status.defs} decks={status.decks} handicaps={status.handicaps} />;
}

export default HotseatRoute;
