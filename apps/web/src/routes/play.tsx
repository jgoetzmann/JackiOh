// `/play` — the lobby: pick a mode and a deck or trio, then queue or use a room code (SPEC §9.5,
// R257, R258, R264).
//
// IT ENFORCES NOTHING (CLAUDE.md rule 7). The three modes, what each needs and whether a choice may
// be queued are the server's: `POST /api/queue` and the room routes freeze the choice and run the
// shared validator on it (R253), and this screen relays what they said. The lobby does run the same
// validator (`validateDeck` for Best of 1, `validateTrio` for Best of 3) over the same collection,
// but only to say "Ready" or why not before the player presses anything. It never blocks a button:
// a verdict here is UX, and a 422 `loadout_invalid` from the server shows the validator's sentences
// exactly as the server relayed them.
//
// WAITING. Only one side's HTTP response ever carries the match or series it made: the room's host
// and a queued player whose ticket the sweeper paired are told nothing. `GET /api/auth/me` answers
// `currentMatchId` (§9.5) and `currentSeriesId` (R259), so the lobby reads its own state: once on
// every mount (a reload after being paired must not strand the player) and every
// `SERIES_POLL_SECONDS` while it is actually waiting. A running game goes to the board; a series
// between games goes to the series screen, where the next deck is picked.

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";

import { DECK_SIZE } from "@jackioh/engine/config";
import {
  validateDeck,
  validateTrio,
  type CatalogSnapshot,
  type Collection,
  type LoadoutDeck,
  type LoadoutResult,
} from "@jackioh/validator";

import { SERIES_POLL_SECONDS, SERIES_WINS_NEEDED } from "../../../server/src/config.ts";
import {
  ApiRequestError,
  createRoom,
  dequeue,
  enqueue,
  getCatalog,
  getCollection,
  getDecks,
  getMe,
  getPopulation,
  joinRoom,
  roomModeOf,
  type ModeChoice,
  type PopulationResponse,
  type QueueMode,
  type SavedDeck,
  type SavedTrio,
} from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import { BackLink, followInApp } from "./nav.tsx";
import "./lobby.css";

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

/** Chrome this screen invented; `e2e/support/testids.ts` mirrors the strings. */
export const playTestid = {
  queue: "play-queue",
  leaveQueue: "play-leave-queue",
  createRoom: "play-create-room",
  roomCode: "play-room-code",
  /** The created room's mode (`data-mode`), next to its code (R264). */
  roomMode: "play-room-mode",
  joinForm: "play-join-form",
  joinInput: "play-join-code",
  joinSubmit: "play-join-submit",
  status: "play-status",
  error: "play-error",
  /** The way to `/practice` from here, until the landing page carries its own (polish task 5). */
  practice: "play-practice",
  /** The three mode radios (R257). */
  modeBo1: "play-mode-bo1",
  modeBo3: "play-mode-bo3",
  modeRandom: "play-mode-random",
  /** Best of 1's deck `<select>`, and Best of 3's trio `<select>`. */
  deckSelect: "play-deck-select",
  trioSelect: "play-trio-select",
  /** The client's verdict on the choice (`data-ready`): UX only, the server's is law (R253). */
  verdict: "play-choice-verdict",
  /** The queue's population per mode (`data-bo1`, `data-bo3`, `data-random`). */
  population: "play-population",
  /** The way to `/decks` when there is no deck (Best of 1) or no trio (Best of 3) to pick. */
  decksLink: "play-decks-link",
  /** The way to the series a refusal said the player is still in. */
  seriesLink: "play-series-link",
} as const;

export const QUEUE_MODES: readonly QueueMode[] = ["bo1", "bo3", "random"];

const MODE_TESTID: Readonly<Record<QueueMode, string>> = {
  bo1: playTestid.modeBo1,
  bo3: playTestid.modeBo3,
  random: playTestid.modeRandom,
};

/** A mode radio's testid. */
export function playModeTestid(mode: QueueMode): string {
  return MODE_TESTID[mode];
}

/**
 * What each mode is called on every screen (the lobby, the room code, the series screen). The trio
 * mode keeps its wire name `bo3` and is called Conquest since R330.
 */
export const MODE_LABEL: Readonly<Record<QueueMode, string>> = {
  bo1: "Best of 1",
  bo3: "Conquest",
  random: "All Random",
};

/** One line under each mode: what the player is signing up for (R257–R259). */
export const MODE_HINT: Readonly<Record<QueueMode, string>> = {
  bo1: "One game with one of your decks.",
  bo3:
    `Win a game with each of your trio's ${String(SERIES_WINS_NEEDED)} decks; a deck that wins is locked. ` +
    "Both players pick a deck before each game, hidden until both have picked.",
  random: "Both players get a fresh random deck, dealt with a sensible mana curve.",
};

/** Where the lobby remembers the last mode, deck and trio (a convenience; see `readStoredChoice`). */
export const PLAY_CHOICE_KEY = "jackioh.play.choice";

/** `apps/server/src/api/http.ts`'s code for a choice the validator refused (R253). */
const LOADOUT_INVALID = "loadout_invalid";

// ---------------------------------------------------------------------------------------------
// the remembered choice
// ---------------------------------------------------------------------------------------------

type StoredChoice = { mode?: QueueMode; deckId?: string; trioId?: string };

function isQueueMode(value: unknown): value is QueueMode {
  return value === "bo1" || value === "bo3" || value === "random";
}

/** The last choice this device made; `{}` in a private window, with blocked storage or bad JSON. */
function readStoredChoice(): StoredChoice {
  try {
    const raw = window.localStorage.getItem(PLAY_CHOICE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    const { mode, deckId, trioId } = parsed as { mode?: unknown; deckId?: unknown; trioId?: unknown };
    return {
      ...(isQueueMode(mode) ? { mode } : {}),
      ...(typeof deckId === "string" ? { deckId } : {}),
      ...(typeof trioId === "string" ? { trioId } : {}),
    };
  } catch {
    return {};
  }
}

function writeStoredChoice(choice: StoredChoice): void {
  try {
    window.localStorage.setItem(PLAY_CHOICE_KEY, JSON.stringify(choice));
  } catch {
    // Remembering the choice is a convenience; a refusal costs nothing.
  }
}

// ---------------------------------------------------------------------------------------------
// the lobby's reads
// ---------------------------------------------------------------------------------------------

type LobbyData = {
  decks: readonly SavedDeck[];
  trios: readonly SavedTrio[];
  /** Null when `/api/catalog` could not be read: the verdict is skipped, never guessed. */
  catalog: CatalogSnapshot | null;
  /** Null when `/api/collection` could not be read: likewise (L5 needs it). */
  collection: Collection | null;
};

type LobbyLoad = { kind: "loading" } | { kind: "ready"; data: LobbyData } | { kind: "failed"; message: string };

function collectionOf(entries: readonly { cardId: string; quantity: number }[]): Collection {
  const owned: Record<string, number> = {};
  for (const entry of entries) owned[entry.cardId] = entry.quantity;
  return owned;
}

/** A call that may throw synchronously (or return nothing, in a test), as a promise. */
function attempt<T>(call: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(call);
}

/**
 * `GET /api/decks` (the choices), `GET /api/catalog` and `GET /api/collection` (the verdict's
 * inputs). Only the decks are needed to queue; the other two only feed the verdict.
 */
function useLobbyData(token: string): LobbyLoad {
  const [load, setLoad] = useState<LobbyLoad>({ kind: "loading" });
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      attempt(() => getDecks(token)),
      attempt(() => getCatalog())
        .then((catalog): CatalogSnapshot | null => ({ version: catalog.version, cards: catalog.defs }))
        .catch(() => null),
      attempt(() => getCollection(token))
        .then((collection): Collection | null => collectionOf(collection.entries))
        .catch(() => null),
    ]).then(
      ([decks, catalog, collection]) => {
        if (cancelled) return;
        setLoad({ kind: "ready", data: { decks: decks.decks, trios: decks.trios, catalog, collection } });
      },
      (cause: unknown) => {
        if (!cancelled) setLoad({ kind: "failed", message: messageOf(cause) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [token]);
  return load;
}

/** The remembered deck if it is still saved, else the first complete deck, else the first deck. */
export function defaultDeck(decks: readonly SavedDeck[], remembered: string | null): SavedDeck | null {
  return (
    decks.find((deck) => deck.id === remembered) ??
    decks.find((deck) => deck.cards.length === DECK_SIZE) ??
    decks[0] ??
    null
  );
}

/** The remembered trio if it is still saved, else the first trio with three decks, else the first. */
export function defaultTrio(trios: readonly SavedTrio[], remembered: string | null): SavedTrio | null {
  return (
    trios.find((trio) => trio.id === remembered) ??
    trios.find((trio) => trio.deckIds.every((id) => id !== null)) ??
    trios[0] ??
    null
  );
}

/** The choice as the queue and the room routes take it; null when the mode needs a pick there isn't. */
export function choiceFor(mode: QueueMode, deck: SavedDeck | null, trio: SavedTrio | null): ModeChoice | null {
  switch (mode) {
    case "random":
      return { mode: "random" };
    case "bo1":
      return deck === null ? null : { mode: "bo1", deckId: deck.id };
    case "bo3":
      return trio === null ? null : { mode: "bo3", trioId: trio.id };
  }
}

/**
 * The client's verdict on a choice, from the shared validator (R253): null when there is nothing to
 * judge or an input is missing. The deck's own names go in, so a message reads as the server's will.
 */
export function verdictFor(
  mode: QueueMode,
  deck: SavedDeck | null,
  trio: SavedTrio | null,
  data: LobbyData,
): LoadoutResult | null {
  const { catalog, collection } = data;
  if (catalog === null || collection === null) return null;
  if (mode === "bo1") {
    if (deck === null) return null;
    return validateDeck({ deck: { name: deck.name, cards: deck.cards }, catalog, collection });
  }
  if (mode === "bo3") {
    if (trio === null) return null;
    // An empty slot is simply absent, which is L1's "this one has 2" (R253).
    const decks: LoadoutDeck[] = [];
    for (const id of trio.deckIds) {
      const deck = id === null ? undefined : data.decks.find((saved) => saved.id === id);
      if (deck !== undefined) decks.push({ name: deck.name, cards: deck.cards });
    }
    return validateTrio({ decks, catalog, collection });
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------------------------

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

type LobbyError = {
  message: string;
  /** A 422 `loadout_invalid`'s issues, each the validator's sentence as the server relayed it. */
  issues: readonly string[];
  /** A refusal that names the series the player is still in (`already_in_match`, R259). */
  seriesId: string | null;
};

/** `details` of a 422, read back as the validator's sentences; nothing is reworded or invented. */
export function issueMessagesOf(details: unknown): string[] {
  if (!Array.isArray(details)) return [];
  const messages: string[] = [];
  for (const entry of details as unknown[]) {
    if (typeof entry !== "object" || entry === null) return [];
    const message = (entry as { message?: unknown }).message;
    if (typeof message !== "string") return [];
    messages.push(message);
  }
  return messages;
}

function seriesIdOfError(cause: unknown): string | null {
  if (!(cause instanceof ApiRequestError)) return null;
  const details = cause.details;
  if (typeof details !== "object" || details === null) return null;
  const seriesId = (details as { seriesId?: unknown }).seriesId;
  return typeof seriesId === "string" && seriesId.length > 0 ? seriesId : null;
}

function errorOf(cause: unknown): LobbyError {
  return {
    message: messageOf(cause),
    issues:
      cause instanceof ApiRequestError && cause.code === LOADOUT_INVALID ? issueMessagesOf(cause.details) : [],
    seriesId: seriesIdOfError(cause),
  };
}

/** R264: what a joiner is told when the room plays another mode than the one they chose. */
export function roomModeMessage(mode: QueueMode): string {
  if (mode === "random") return `This room plays ${MODE_LABEL[mode]}: join again.`;
  return `This room plays ${MODE_LABEL[mode]}: pick a ${mode === "bo3" ? "trio" : "deck"} and join again.`;
}

// ---------------------------------------------------------------------------------------------
// the wait
// ---------------------------------------------------------------------------------------------

/**
 * Reads `/api/auth/me` once on every mount, and every `SERIES_POLL_SECONDS` while `waiting`, and
 * goes wherever the profile already is: the board (`currentMatchId`) or, between the games of a
 * series, the series screen (`currentSeriesId`). `onTick` runs with every poll (the population).
 * A failed read is ignored: the player cannot act on it, and the next tick retries.
 */
function useLobbyWatch(token: string, waiting: boolean, onTick: () => void): void {
  // Survives a re-render so a slow response cannot navigate twice.
  const navigated = useRef(false);
  const tick = useRef(onTick);
  tick.current = onTick;

  useEffect(() => {
    let cancelled = false;

    const check = (): void => {
      attempt(() => getMe(token))
        .then((me) => {
          if (cancelled || navigated.current) return;
          const matchId = me.currentMatchId;
          const seriesId = me.currentSeriesId;
          if (typeof matchId === "string" && matchId.length > 0) {
            navigated.current = true;
            navigate(paths.match(matchId));
          } else if (typeof seriesId === "string" && seriesId.length > 0) {
            navigated.current = true;
            navigate(paths.series(seriesId));
          }
        })
        .catch(() => undefined);
    };

    // ONE CHECK ON EVERY MOUNT, waiting or not: a player who reloads /play after being paired
    // loses `waiting` with the page, and would otherwise sit here while their opponent plays.
    check();
    if (!waiting) {
      return () => {
        cancelled = true;
      };
    }
    const handle = setInterval(() => {
      check();
      tick.current();
    }, SERIES_POLL_SECONDS * MS_PER_SECOND);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [token, waiting]);
}

// ---------------------------------------------------------------------------------------------
// pieces
// ---------------------------------------------------------------------------------------------

function DecksLink({ children }: { children: string }): ReactElement {
  return (
    <a href={paths.decks} data-testid={playTestid.decksLink} onClick={followInApp(paths.decks)}>
      {children}
    </a>
  );
}

function Verdict({ result }: { result: LoadoutResult | null }): ReactElement | null {
  if (result === null) return null;
  if (result.ok) {
    return (
      <p className="lobby-verdict" data-testid={playTestid.verdict} data-ready="true">
        Ready
      </p>
    );
  }
  return (
    <div className="lobby-verdict" data-testid={playTestid.verdict} data-ready="false">
      <p className="lobby-verdict__lead">Not ready yet. The server checks again when you queue:</p>
      <ul>
        {result.errors.map((error, index) => (
          // The same message can repeat for two cards; the index keeps the keys apart.
          <li key={`${String(index)}-${error.message}`}>{error.message}</li>
        ))}
      </ul>
    </div>
  );
}

function Population({ population }: { population: PopulationResponse | null }): ReactElement | null {
  if (population === null) return null;
  const byMode = population.byMode;
  if (byMode === undefined) {
    return (
      <p className="lobby-population" data-testid={playTestid.population}>
        {String(population.population)} waiting in the queue now.
      </p>
    );
  }
  return (
    <p
      className="lobby-population"
      data-testid={playTestid.population}
      data-bo1={byMode.bo1}
      data-bo3={byMode.bo3}
      data-random={byMode.random}
    >
      Waiting now:{" "}
      {QUEUE_MODES.map((mode, index) => (
        <span key={mode}>
          {index > 0 ? " · " : null}
          {MODE_LABEL[mode]} {String(byMode[mode])}
        </span>
      ))}
    </p>
  );
}

// ---------------------------------------------------------------------------------------------
// the route
// ---------------------------------------------------------------------------------------------

export type PlayRouteProps = { token: string };

type Room = { code: string; mode: QueueMode };

export default function PlayRoute({ token }: PlayRouteProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<LobbyError | null>(null);
  const [room, setRoom] = useState<Room | null>(null);
  const [joinCode, setJoinCode] = useState("");
  /** True while this screen is waiting to be paired: queued, or hosting an unclaimed room. */
  const [waiting, setWaiting] = useState(false);
  const [population, setPopulation] = useState<PopulationResponse | null>(null);

  const stored = useMemo(readStoredChoice, []);
  const [mode, setMode] = useState<QueueMode>(stored.mode ?? "bo1");
  const [deckId, setDeckId] = useState<string | null>(stored.deckId ?? null);
  const [trioId, setTrioId] = useState<string | null>(stored.trioId ?? null);

  const lobby = useLobbyData(token);
  const data = lobby.kind === "ready" ? lobby.data : null;
  const deck = data === null ? null : defaultDeck(data.decks, deckId);
  const trio = data === null ? null : defaultTrio(data.trios, trioId);
  const choice = choiceFor(mode, deck, trio);
  const verdict = data === null ? null : verdictFor(mode, deck, trio, data);

  // A failed read keeps the last count (or none): it is information, never a blocker.
  const refreshPopulation = useCallback((): void => {
    attempt(() => getPopulation(token)).then(setPopulation, () => undefined);
  }, [token]);
  useLobbyWatch(token, waiting, refreshPopulation);
  // The population once on arrival; the wait refreshes it with every poll.
  useEffect(() => {
    refreshPopulation();
  }, [refreshPopulation]);

  // Remembered once the decks are known, so a stale id is replaced by what is really shown.
  const deckShown = deck?.id;
  const trioShown = trio?.id;
  useEffect(() => {
    if (data === null) return;
    writeStoredChoice({
      mode,
      ...(deckShown === undefined ? {} : { deckId: deckShown }),
      ...(trioShown === undefined ? {} : { trioId: trioShown }),
    });
  }, [data, mode, deckShown, trioShown]);

  function run(work: () => Promise<void>): void {
    if (busy) return;
    setBusy(true);
    setError(null);
    work()
      .catch((cause: unknown) => {
        setError(errorOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  /** Where a paired answer goes: the board, or the series screen to pick game 1's deck. */
  function follow(answer: { matchId: string | null; seriesId: string | null }): boolean {
    if (typeof answer.matchId === "string" && answer.matchId.length > 0) {
      navigate(paths.match(answer.matchId));
      return true;
    }
    if (typeof answer.seriesId === "string" && answer.seriesId.length > 0) {
      navigate(paths.series(answer.seriesId));
      return true;
    }
    return false;
  }

  function onEnqueue(): void {
    if (choice === null) return;
    const chosen = choice;
    run(async () => {
      const result = await enqueue(token, chosen);
      if (follow(result)) return;
      setWaiting(true);
      refreshPopulation();
      setStatus(
        `In the ${MODE_LABEL[chosen.mode]} queue · ${String(result.population)} waiting. ` +
          "You will be taken to the game as soon as someone is found.",
      );
    });
  }

  function onLeaveQueue(): void {
    run(async () => {
      await dequeue(token);
      setWaiting(false);
      setStatus("Left the queue.");
    });
  }

  function onCreateRoom(): void {
    if (choice === null) return;
    const chosen = choice;
    run(async () => {
      const created = await createRoom(token, chosen);
      setRoom({ code: created.code, mode: created.mode });
      setWaiting(true);
      setStatus("Give your opponent this code. You will be taken to the game when they join.");
    });
  }

  function onJoin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (choice === null) return;
    const chosen = choice;
    run(async () => {
      try {
        // R104 normalises input to upper case server-side; sending it that way keeps a typed code
        // and a pasted one identical on the wire.
        const joined = await joinRoom(token, joinCode.trim().toUpperCase(), chosen);
        follow(joined);
      } catch (cause: unknown) {
        // R264: the room plays another mode. Switch to it and say what to pick; the code stays.
        const roomMode = roomModeOf(cause);
        if (roomMode === null) throw cause;
        setMode(roomMode);
        setError({ message: roomModeMessage(roomMode), issues: [], seriesId: null });
      }
    });
  }

  const noChoice = choice === null;

  return (
    <div className="app-shell lobby">
      <BackLink />
      <h1>JackiOh — play</h1>

      <section className="form-card lobby-card">
        <h2>How do you want to play?</h2>
        <fieldset className="lobby-modes">
          <legend className="lobby-modes__legend">Mode</legend>
          {QUEUE_MODES.map((option) => (
            <label key={option} className="lobby-mode" data-selected={option === mode ? "true" : "false"}>
              <input
                type="radio"
                name="play-mode"
                value={option}
                checked={option === mode}
                data-testid={playModeTestid(option)}
                onChange={() => {
                  setMode(option);
                }}
              />
              <span className="lobby-mode__text">
                <span className="lobby-mode__name">{MODE_LABEL[option]}</span>
                <span className="lobby-mode__hint">{MODE_HINT[option]}</span>
              </span>
            </label>
          ))}
        </fieldset>

        {lobby.kind === "loading" && mode !== "random" ? (
          <p className="lobby-note" role="status">
            Loading your decks…
          </p>
        ) : null}
        {lobby.kind === "failed" && mode !== "random" ? (
          <p className="notice" role="alert">
            Your decks could not be loaded: {lobby.message}
          </p>
        ) : null}

        {data !== null && mode === "bo1" ? (
          data.decks.length === 0 ? (
            <p className="lobby-note">
              You have no saved decks yet. <DecksLink>Build one in Decks</DecksLink>.
            </p>
          ) : (
            <>
              <label htmlFor="play-deck">Your deck</label>
              <select
                id="play-deck"
                className="lobby-select"
                data-testid={playTestid.deckSelect}
                value={deck?.id ?? ""}
                onChange={(event) => {
                  setDeckId(event.target.value);
                }}
              >
                {data.decks.map((saved) => (
                  <option key={saved.id} value={saved.id}>
                    {saved.name}
                  </option>
                ))}
              </select>
            </>
          )
        ) : null}

        {data !== null && mode === "bo3" ? (
          data.trios.length === 0 ? (
            <p className="lobby-note">
              You have no saved trios yet. <DecksLink>Build one in Decks</DecksLink>.
            </p>
          ) : (
            <>
              <label htmlFor="play-trio">Your trio</label>
              <select
                id="play-trio"
                className="lobby-select"
                data-testid={playTestid.trioSelect}
                value={trio?.id ?? ""}
                onChange={(event) => {
                  setTrioId(event.target.value);
                }}
              >
                {data.trios.map((saved) => (
                  <option key={saved.id} value={saved.id}>
                    {saved.name}
                  </option>
                ))}
              </select>
            </>
          )
        ) : null}

        {mode === "random" ? (
          <p className="lobby-note">No deck needed: the server deals both of you one when the game starts.</p>
        ) : null}

        <Verdict result={verdict} />
        <Population population={population} />
      </section>

      <section className="form-card lobby-card">
        <h2>Find a match</h2>
        <div className="row">
          <button
            type="button"
            className="button-primary"
            data-testid={playTestid.queue}
            disabled={busy || noChoice}
            onClick={onEnqueue}
          >
            Find a match
          </button>
          <button type="button" data-testid={playTestid.leaveQueue} disabled={busy} onClick={onLeaveQueue}>
            Leave the queue
          </button>
        </div>
      </section>

      <section className="form-card lobby-card">
        <h2>Room code</h2>
        <p className="lobby-note">A room plays the mode it was made with; the joiner picks for the same mode.</p>
        <div className="row">
          <button
            type="button"
            data-testid={playTestid.createRoom}
            disabled={busy || noChoice}
            onClick={onCreateRoom}
          >
            Create a room
          </button>
          {room === null ? null : (
            <>
              <code data-testid={playTestid.roomCode}>{room.code}</code>
              <span className="lobby-room-mode" data-testid={playTestid.roomMode} data-mode={room.mode}>
                {MODE_LABEL[room.mode]}
              </span>
            </>
          )}
        </div>

        <form className="row" data-testid={playTestid.joinForm} onSubmit={onJoin}>
          <label htmlFor="play-join-code">Join a room</label>
          <input
            id="play-join-code"
            data-testid={playTestid.joinInput}
            value={joinCode}
            autoComplete="off"
            onChange={(event) => {
              setJoinCode(event.target.value);
            }}
          />
          <button type="submit" data-testid={playTestid.joinSubmit} disabled={busy || noChoice}>
            Join
          </button>
        </form>
      </section>

      <section className="form-card lobby-card">
        <h2>Practice</h2>
        <p>A game against the AI, right here in your browser: no queue, no rating, three difficulties.</p>
        <a href={paths.practice} data-testid={playTestid.practice}>
          Practice against the AI →
        </a>
      </section>

      {status !== null ? (
        <p className="notice" data-testid={playTestid.status} role="status">
          {status}
        </p>
      ) : null}
      {error !== null ? (
        <div className="notice" data-testid={playTestid.error} role="alert">
          {error.issues.length === 0 ? (
            <p>{error.message}</p>
          ) : (
            <ul className="lobby-issues">
              {error.issues.map((issue, index) => (
                <li key={`${String(index)}-${issue}`}>{issue}</li>
              ))}
            </ul>
          )}
          {error.seriesId === null ? null : (
            <a
              href={paths.series(error.seriesId)}
              data-testid={playTestid.seriesLink}
              onClick={followInApp(paths.series(error.seriesId))}
            >
              Go to your series →
            </a>
          )}
        </div>
      ) : null}
    </div>
  );
}
