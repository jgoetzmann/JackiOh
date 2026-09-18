// `/play` — the lobby: the ranked queue and the room-code challenge (SPEC §9.5).
//
// NO SPEC DRIVES THIS SCREEN. Spec 06 creates its room over `POST /api/rooms` and joins over
// `POST /api/rooms/:code/join` precisely because "the room screen has no testids yet", so nothing
// here is load-bearing for M8. It is kept small and honest on purpose, and it enforces nothing: the
// queue asserts the account is active, not in a match and holding a valid loadout (§9.5), and this
// screen only relays what it said.
//
// TWO GAPS, both reported rather than papered over (see the hand-off report):
//
//  1. §9.5 makes the room code "the primary mode while the player base is small", but nothing tells
//     the HOST that its room was claimed. `POST /api/rooms` answers `{ code, expiresAt, deckIndex }`
//     and `GET /api/auth/me` answers `{ profile: { id, status, rating }, … }` with no `inMatchId`,
//     so a host has a code and no way to learn the match id it turns into. Spec 06 sidesteps it by
//     driving the browser straight to `/match/<id>` with the id the joiner's HTTP response carried.
//  2. The same for the queue. `POST /api/queue` answers `{ ticketId, status, matchId, population }`,
//     which does report a pairing that happened inline — but if the sweeper pairs the ticket a
//     moment later there is no endpoint to ask. `GET /api/queue/population` is a count, not a
//     ticket, and a second `POST` is refused with `already_queued`.
//
// So both flows navigate when the round trip they made returns a match id, and say plainly when it
// did not. No polling loop is invented here to hide a missing endpoint.

import { useState, type FormEvent, type ReactElement } from "react";

import { ApiRequestError, createRoom, dequeue, enqueue, joinRoom } from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";

/** Chrome this screen invented; none of it is in `e2e/support/testids.ts` (no spec drives it). */
export const playTestid = {
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

/** §9.4, §9.5: the deck a match freezes is a loadout index. Deck 0 until a picker exists. */
const DECK_INDEX = 0;

function messageOf(cause: unknown): string {
  if (cause instanceof ApiRequestError) return cause.message;
  return cause instanceof Error ? cause.message : String(cause);
}

export type PlayRouteProps = { token: string };

export default function PlayRoute({ token }: PlayRouteProps): ReactElement {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [joinCode, setJoinCode] = useState("");

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
      const result = (await enqueue(token, DECK_INDEX)) as EnqueueResult;
      if (typeof result.matchId === "string" && result.matchId.length > 0) {
        navigate(paths.match(result.matchId));
        return;
      }
      const population = result.population;
      setStatus(
        `In the queue${typeof population === "number" ? ` · ${String(population)} waiting` : ""}. ` +
          "Nothing yet tells this client when the sweeper pairs the ticket — see the note in this file.",
      );
    });
  }

  function onLeaveQueue(): void {
    run(async () => {
      await dequeue(token);
      setStatus("Left the queue.");
    });
  }

  function onCreateRoom(): void {
    run(async () => {
      const room = await createRoom(token, DECK_INDEX);
      setRoomCode(room.code);
      setStatus(
        "Give your opponent this code. Nothing yet tells the host when the room is claimed, " +
          "so the match id has to come from the joiner — see the note in this file.",
      );
    });
  }

  function onJoin(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    run(async () => {
      // R104 normalises input to upper case server-side; sending it that way keeps a typed code
      // and a pasted one identical on the wire.
      const joined = await joinRoom(token, joinCode.trim().toUpperCase(), DECK_INDEX);
      navigate(paths.match(joined.matchId));
    });
  }

  return (
    <div className="app-shell">
      <h1>JackiOh — play</h1>

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
