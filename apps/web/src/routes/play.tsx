// `/play` — the lobby: the ranked queue and the room-code challenge (SPEC §9.5).
//
// NO SPEC DRIVES THIS SCREEN. Spec 06 creates its room over `POST /api/rooms` and joins over
// `POST /api/rooms/:code/join` precisely because "the room screen has no testids yet", so nothing
// here is load-bearing for M8. It is kept small and honest on purpose, and it enforces nothing: the
// queue asserts the account is active, not in a match and holding a valid deck (§9.5, R172), and
// this screen only relays what it said.
//
// THE DECK PICKER (R172). A match freezes either a loadout deck (`{ deckIndex }`) or one of the
// account's library decks (`{ deckId }`). The picker offers every library deck, labelling a short
// one with its count, and the loadout's decks when one is saved. Nothing is disabled: whether a
// deck may be played is the server's verdict (CLAUDE.md rule 7), and picking a short deck gets the
// validator's own L2 sentence back from the queue. The count only decides the default, which is
// the first full library deck. Before the two reads land, and if both fail, the choice is loadout
// deck 1, which is what this screen always sent.
//
// BOTH GAPS ARE CLOSED, and by the endpoint they asked for rather than by a workaround here.
//
// They were: nothing told the HOST that its room was claimed, and nothing told a QUEUED player
// that the sweeper had paired their ticket a moment after they enqueued. In both cases the OTHER
// player's HTTP response carried the match id and this one's did not, so one player sat on /play
// while their opponent sat on the board — the whole reason two people could not simply play.
//
// The note that used to be here said "no polling loop is invented to hide a missing endpoint",
// and that was the right call: the fix is the endpoint. `GET /api/auth/me` now returns
// `currentMatchId` (§9.5's `profiles.current_match_id`, cleared by every ending), so waiting is a
// legitimate read of one's own state rather than a guess. `useMatchWatch` below polls it only
// while this screen is actually waiting, and stops the moment it navigates or the player leaves
// the queue.

import { useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";

import { DECK_SIZE } from "../game/deckbuilder/deckSize.ts";
import { DECK_NUMBERS } from "../game/deckbuilder/loadout.ts";
import {
  ApiRequestError,
  createRoom,
  dequeue,
  enqueue,
  getLoadout,
  getMe,
  joinRoom,
  listDecks,
  type DeckChoice,
  type LibraryDeck,
} from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import { BackLink } from "./nav.tsx";

/**
 * How often the wait asks whether a match has appeared. R108 sweeps the queue every 3 s, so a
 * shorter poll only adds requests without finding a pairing sooner.
 */
const MATCH_WATCH_MS = 2_000;

/**
 * Chrome this screen invented. Only `deck` is mirrored in `e2e/support/testids.ts`; nothing else
 * here is driven by a spec.
 */
export const playTestid = {
  deck: "play-deck",
  queue: "play-queue",
  leaveQueue: "play-leave-queue",
  createRoom: "play-create-room",
  roomCode: "play-room-code",
  joinForm: "play-join-form",
  joinInput: "play-join-code",
  joinSubmit: "play-join-submit",
  status: "play-status",
  error: "play-error",
} as const;

/** `POST /api/queue` (`apps/server/src/api/queue.ts`); `api.ts` types the call as `unknown`. */
type EnqueueResult = {
  ticketId?: string;
  status?: string;
  matchId?: string | null;
  population?: number;
};

/** §9.5: loadout deck 1, the choice this screen made before it had a picker. */
const FALLBACK: DeckChoice = { deckIndex: 0 };

/** The picker's option values: a `<select>` carries strings, a request carries a `DeckChoice`. */
function keyOf(choice: DeckChoice): string {
  return "deckId" in choice ? `library:${choice.deckId}` : `loadout:${String(choice.deckIndex)}`;
}

function choiceOf(key: string): DeckChoice {
  const rest = key.slice(key.indexOf(":") + 1);
  return key.startsWith("library:") ? { deckId: rest } : { deckIndex: Number(rest) };
}

/** A label and a default, never a gate: the server decides whether the deck is playable. */
function isComplete(deck: LibraryDeck): boolean {
  return deck.cards.length === DECK_SIZE;
}

/** What the picker offers. `loadout` is true unless `GET /api/loadout` said there is none. */
type Offer = { library: readonly LibraryDeck[]; loadout: boolean };

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * While `waiting`, asks `/api/auth/me` for this profile's own `currentMatchId` and navigates the
 * moment one appears. §9.5 sets it when a match starts and clears it at every ending, so it is
 * the authoritative answer to "am I in a match" for both the room host and a queued player.
 *
 * Polling is confined to the wait: the interval exists only while `waiting` is true, and the
 * effect's cleanup clears it on navigation, on leaving the queue, and on unmount. A failed poll is
 * ignored rather than shown — a dropped request while waiting is not something the player can act
 * on, and the next tick retries.
 */
function useMatchWatch(token: string, waiting: boolean): void {
  // Survives a re-render so a slow response cannot navigate twice.
  const navigated = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const check = (): void => {
      void getMe(token)
        .then((me) => {
          const matchId = me.currentMatchId;
          if (cancelled || navigated.current) return;
          if (typeof matchId === "string" && matchId.length > 0) {
            navigated.current = true;
            navigate(paths.match(matchId));
          }
        })
        .catch(() => undefined);
    };

    // ONE CHECK ON EVERY MOUNT, waiting or not. `waiting` lives in component state, so a player
    // who RELOADS /play after being paired loses it with the page — and without this check they
    // sit in the lobby forever while their opponent is already on the board. That is the same
    // dead end this hook exists to remove, just reached by refreshing instead of by waiting.
    check();

    // The interval is still confined to an actual wait: a screen that is not expecting a pairing
    // has no reason to keep asking.
    if (!waiting) {
      return () => {
        cancelled = true;
      };
    }
    const handle = setInterval(check, MATCH_WATCH_MS);
    return () => {
      cancelled = true;
      clearInterval(handle);
    };
  }, [token, waiting]);
}

export type PlayRouteProps = { token: string };

export default function PlayRoute({ token }: PlayRouteProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");
  /** True while this screen is waiting to be paired: queued, or hosting an unclaimed room. */
  const [waiting, setWaiting] = useState(false);
  const [offer, setOffer] = useState<Offer>({ library: [], loadout: true });
  const [picked, setPicked] = useState<DeckChoice | null>(null);

  useMatchWatch(token, waiting);

  // Both reads are optional. A failed library read offers no library deck; a failed loadout read
  // still offers the loadout, since deck 1 is the fallback and the server judges it either way.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      listDecks(token).then(
        (response) => response.decks,
        () => [],
      ),
      getLoadout(token).then(
        (response) => response.loadout !== null,
        () => true,
      ),
    ]).then(([library, loadout]) => {
      if (!cancelled) setOffer({ library, loadout });
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const firstComplete = offer.library.find(isComplete);
  const choice: DeckChoice =
    picked ?? (firstComplete === undefined ? FALLBACK : { deckId: firstComplete.id });
  const playable = offer.library.length > 0 || offer.loadout;

  function run(work: () => Promise<void>): void {
    if (busy) return;
    setBusy(true);
    setError(null);
    work()
      .catch((cause: unknown) => {
        setError(messageOf(cause));
      })
      .finally(() => {
        setBusy(false);
      });
  }

  function onEnqueue(): void {
    run(async () => {
      const result = (await enqueue(token, choice)) as EnqueueResult;
      if (typeof result.matchId === "string" && result.matchId.length > 0) {
        navigate(paths.match(result.matchId));
        return;
      }
      const population = result.population;
      setWaiting(true);
      setStatus(
        `In the queue${typeof population === "number" ? ` · ${String(population)} waiting` : ""}. ` +
          "You will be taken to the board as soon as someone is found.",
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
    run(async () => {
      const room = await createRoom(token, choice);
      setRoomCode(room.code);
      setWaiting(true);
      setStatus("Give your opponent this code. You will be taken to the board when they join.");
    });
  }

  function onJoin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    run(async () => {
      // R104 normalises input to upper case server-side; sending it that way keeps a typed code
      // and a pasted one identical on the wire.
      const joined = await joinRoom(token, joinCode.trim().toUpperCase(), choice);
      navigate(paths.match(joined.matchId));
    });
  }

  return (
    <div className="app-shell">
      <BackLink />
      <h1>JackiOh — play</h1>

      <section className="form-card">
        <label htmlFor="play-deck">Deck</label>
        <select
          id="play-deck"
          data-testid={playTestid.deck}
          value={keyOf(choice)}
          disabled={busy}
          onChange={(event) => {
            setPicked(choiceOf(event.target.value));
          }}
        >
          {playable ? null : (
            // Nothing to pick: the fallback is still what is sent, and the server says why not.
            <option value={keyOf(FALLBACK)} disabled>
              No deck yet
            </option>
          )}
          {offer.library.length === 0 ? null : (
            <optgroup label="My decks">
              {offer.library.map((deck) => (
                <option key={deck.id} value={keyOf({ deckId: deck.id })}>
                  {isComplete(deck)
                    ? deck.name
                    : `${deck.name} (${String(deck.cards.length)}/${String(DECK_SIZE)})`}
                </option>
              ))}
            </optgroup>
          )}
          {offer.loadout ? (
            <optgroup label="Loadout">
              {DECK_NUMBERS.map((deck) => (
                <option key={deck} value={keyOf({ deckIndex: deck - 1 })}>
                  {`Deck ${String(deck)}`}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
      </section>

      <section className="form-card">
        <h2>Ranked queue</h2>
        <div className="row">
          <button type="button" data-testid={playTestid.queue} disabled={busy} onClick={onEnqueue}>
            Find a match
          </button>
          <button
            type="button"
            data-testid={playTestid.leaveQueue}
            disabled={busy}
            onClick={onLeaveQueue}
          >
            Leave the queue
          </button>
        </div>
      </section>

      <section className="form-card">
        <h2>Room code</h2>
        <div className="row">
          <button
            type="button"
            data-testid={playTestid.createRoom}
            disabled={busy}
            onClick={onCreateRoom}
          >
            Create a room
          </button>
          {roomCode === null ? null : (
            <code data-testid={playTestid.roomCode}>{roomCode}</code>
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
          <button type="submit" data-testid={playTestid.joinSubmit} disabled={busy}>
            Join
          </button>
        </form>
      </section>

      {status !== null ? (
        <p className="notice" data-testid={playTestid.status} role="status">
          {status}
        </p>
      ) : null}
      {error !== null ? (
        <p className="notice" data-testid={playTestid.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
