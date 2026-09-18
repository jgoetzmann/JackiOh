/**
 * The WebSocket protocol (BUILD M6-T4, SPEC §9.1, §9.3, §10.8).
 *
 * BUILD M6-T4 fixes the message names — hello, view, action, ack, error, prompt, clock — and SPEC
 * fixes what they may carry:
 *
 *  - §9.1: "the client sends intent, never state", and the client may only read
 *    `viewFor(state, playerId)`. So `view` carries a `PlayerView` and, beside it, the *same
 *    viewer's* `legalActions(state, viewer)` — no `GameState`, no opponent hand, no library order,
 *    and never the other seat's array (see `ViewMessage`).
 *  - §9.3: "every action carries a client nonce, deduped server-side", and "`reduce` refuses
 *    illegal actions itself and returns the reason". `ack` reports the nonce and the log seq the
 *    action was written at; `error` relays the reducer's reason verbatim and never restates a rule.
 *  - §9.5: "the grace countdown is stored on the match so both clients show it". `clock` carries
 *    `MatchClocks` (the same shape `matches.clocks` persists — one shape, not two) plus the
 *    server's `now`, so a client renders remaining time without trusting its own clock skew.
 *  - §10.6, §10.8: with a prompt open the opponent "sees only that a prompt is open", so the
 *    `prompt` message is split on `forYou` and the non-holder's arm carries neither the choiceId
 *    nor the kind, let alone the options.
 *
 * The one security-relevant asymmetry: a client's `action` frame is parsed into `{ nonce, body }`
 * and its `playerId` is *discarded here*, not trusted and not forwarded. The actor stamps the
 * authenticated seat. A client therefore cannot submit an action as the other player even if it
 * puts `playerId: "p2"` on the wire (`actor.test.ts` asserts it).
 */

import type {
  ActionBody,
  ActionType,
  PlayerId,
  PlayerView,
  PromptKind,
  Row,
  Selection,
  ZoneChoice,
} from "@jackioh/shared";
import type { MatchClocks } from "../api/ports";

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

/**
 * The first frame on a socket. Authentication happens at the upgrade (`wsServer.ts`), so the
 * actor treats `hello` purely as "push me a fresh full view" (§9.5: "Reconnect gets a fresh full
 * view, never a log replay") and ignores every field on it — a token here can never re-seat a
 * socket that is already attached to a seat.
 */
export type HelloMessage = {
  type: "hello";
  token?: string;
  matchId?: string;
  roomCode?: string;
};

/**
 * Accepted only so a client that speaks it gets a pointed `error` instead of "malformed": joining
 * a room is `POST /api/rooms/:code/join` (`rooms.ts`), because the atomic single-claim and the
 * loadout re-check are HTTP concerns and a socket is opened for a match that already exists.
 */
export type JoinRoomMessage = { type: "joinRoom"; token?: string; roomCode: string };

/** An action the client wants applied. `playerId` never survives parsing (see the file header). */
export type ActionMessage = { type: "action"; nonce: string; body: ActionBody };

export type ClientMessage = HelloMessage | JoinRoomMessage | ActionMessage;

export type MalformedMessage = { type: "malformed"; reason: string };

export const CLIENT_MESSAGE_TYPES = ["hello", "joinRoom", "action"] as const;

/**
 * R79: `timeout`, `disconnectExpired` and `ceilingReached` are server-only — "never sent by a
 * client" (`packages/shared/src/actions.ts`). Accepting one from a socket would let a player end
 * their opponent's turn or the match, so parsing rejects them outright.
 */
export const SERVER_ONLY_ACTION_TYPES = ["timeout", "disconnectExpired", "ceilingReached"] as const;

export type ServerOnlyActionType = (typeof SERVER_ONLY_ACTION_TYPES)[number];

/** Everything else in the §10.2 union: what a socket may carry. */
export const CLIENT_ACTION_TYPES = [
  "mulligan",
  "play",
  "attack",
  "switchPosition",
  "activatePower",
  "answer",
  "offerDraw",
  "answerDraw",
  "concede",
  "endTurn",
] as const satisfies readonly Exclude<ActionType, ServerOnlyActionType>[];

export type ClientActionType = (typeof CLIENT_ACTION_TYPES)[number];

// ---------------------------------------------------------------------------
// Server -> client
// ---------------------------------------------------------------------------

/**
 * §10.8's `PlayerView`, plus the array the client greys the board out with.
 *
 * WHY `legal` RIDES HERE RATHER THAN IN A FRAME OF ITS OWN. §10.2: "`legalActions(state, playerId)`
 * is exported and is what both the client UI and the My Pawn AI consume", and BUILD M5-T2: "The
 * client never computes legality itself; it asks `legalActions` and greys out the rest." So the
 * browser cannot render a usable board without it — with an empty array `end-turn` is disabled and
 * no hand card is clickable. Two things settle where it goes:
 *
 *  - BUILD §1 fixes this file's message names as "hello, view, action, ack, error, prompt, clock".
 *    A seventh name would be a protocol BUILD does not list; a field on a frame it does list is not.
 *  - The array is only ever true *of one view*. Carried together they can never disagree, and a
 *    client cannot render a board narrowed by an array minted against a state one action older.
 *
 * It is NOT hidden information and it is not a second channel for any: `legalActions(state, p)`
 * enumerates the actions `p` itself may take, from `p`'s own hand, units and backrow, against
 * targets the same `PlayerView` already shows. The actor passes the viewer as the player
 * (`pushView`), so a socket never sees the other seat's array — which would leak the opponent's
 * hand by naming every `play` in it (§9.1's "Hidden: ... opponent hand").
 */
export type ViewMessage = { type: "view"; view: PlayerView; legal: ActionBody[] };

/** §9.3: the nonce that was accepted and the append-only log seq it was written at. */
export type AckMessage = { type: "ack"; nonce: string; seq: number };

export type SocketErrorCode =
  /** The frame was not a protocol message. */
  | "malformed"
  /** §9.3: the reducer refused the action; `message` is its reason, relayed verbatim. */
  | "illegal_action"
  /** A server-only action type, or an action for a seat this socket does not hold. */
  | "forbidden"
  /** §9.8: the per-match action rate limit. */
  | "rate_limited"
  /** A protocol message this endpoint does not serve (see `JoinRoomMessage`). */
  | "unsupported"
  /** The match already has a result; no further action will be applied. */
  | "match_over"
  | "internal";

/** `nonce` is present exactly when the failure belongs to an action the client sent. */
export type ErrorMessage = {
  type: "error";
  code: SocketErrorCode;
  message: string;
  nonce?: string;
};

/**
 * §10.6: exactly one prompt is open at a time, and the player who does not hold it learns only
 * that it exists. `deadline` is the prompt clock (R79) and is public: both clients show it.
 */
export type PromptMessage =
  | {
      type: "prompt";
      forYou: true;
      pendingFor: PlayerId;
      choiceId: string;
      kind: PromptKind;
      deadline: number | null;
    }
  | { type: "prompt"; forYou: false; pendingFor: PlayerId; deadline: number | null };

/**
 * §9.5: the deadlines both clients render, including the per-player disconnect grace and the hard
 * ceiling. `now` is the server's clock at send time, so the client computes remaining time as
 * `deadline - now` against its own monotonic delta instead of trusting its wall clock.
 */
export type ClockMessage = { type: "clock"; now: number; clocks: MatchClocks };

export type ServerMessage = ViewMessage | AckMessage | ErrorMessage | PromptMessage | ClockMessage;

export const SERVER_MESSAGE_TYPES = ["view", "ack", "error", "prompt", "clock"] as const;

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

/** `legal` must be `legalActions(state, view.viewer)`; the actor is the only caller (`pushView`). */
export function viewMessage(view: PlayerView, legal: readonly ActionBody[]): ViewMessage {
  return { type: "view", view, legal: [...legal] };
}

export function ackMessage(nonce: string, seq: number): AckMessage {
  return { type: "ack", nonce, seq };
}

export function errorMessage(
  code: SocketErrorCode,
  message: string,
  nonce?: string,
): ErrorMessage {
  return { type: "error", code, message, ...(nonce === undefined ? {} : { nonce }) };
}

export function clockMessage(now: number, clocks: MatchClocks): ClockMessage {
  return { type: "clock", now, clocks };
}

/** For the holder of the prompt: the choiceId it must answer and the kind to render. */
export function promptForYou(
  pendingFor: PlayerId,
  choiceId: string,
  kind: PromptKind,
  deadline: number | null,
): PromptMessage {
  return { type: "prompt", forYou: true, pendingFor, choiceId, kind, deadline };
}

/** For the other player: that a prompt is open, and nothing about it (§10.6). */
export function promptForOpponent(pendingFor: PlayerId, deadline: number | null): PromptMessage {
  return { type: "prompt", forYou: false, pendingFor, deadline };
}

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

// ---------------------------------------------------------------------------
// Parsing: total, never throws, and whitelists every field it keeps
// ---------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isBool = (value: unknown): value is boolean => typeof value === "boolean";

const isInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

const isRow = (value: unknown): value is Row => value === "units" || value === "backrow";

const isPlayerId = (value: unknown): value is PlayerId => value === "p1" || value === "p2";

const malformed = (reason: string): MalformedMessage => ({ type: "malformed", reason });

function parseZone(value: unknown): ZoneChoice | null {
  if (!isRecord(value)) return null;
  if (!isRow(value.row) || !isInt(value.lane) || value.lane < 0) return null;
  return { row: value.row, lane: value.lane };
}

function parseSelection(value: unknown): Selection | null {
  if (!isRecord(value)) return null;
  switch (value.pick) {
    case "instance":
      return isString(value.instanceId) ? { pick: "instance", instanceId: value.instanceId } : null;
    case "hero":
      return isPlayerId(value.player) ? { pick: "hero", player: value.player } : null;
    case "zone":
      return isPlayerId(value.player) && isRow(value.row) && isInt(value.lane) && value.lane >= 0
        ? { pick: "zone", player: value.player, row: value.row, lane: value.lane }
        : null;
    case "mode":
      return isString(value.option) ? { pick: "mode", option: value.option } : null;
    case "none":
      return { pick: "none" };
    default:
      return null;
  }
}

function parseSelections(value: unknown): Selection[] | null {
  if (!Array.isArray(value)) return null;
  const out: Selection[] = [];
  for (const entry of value) {
    const selection = parseSelection(entry);
    if (selection === null) return null;
    out.push(selection);
  }
  return out;
}

/**
 * Structural validation only. Whether the action is *legal* is the reducer's call (§9.3), so this
 * checks shapes and nothing else — but it rebuilds the body field by field, which is what keeps a
 * client-supplied `playerId` (or any other smuggled key) from reaching `reduce`.
 */
function parseActionBody(raw: Record<string, unknown>): ActionBody | MalformedMessage {
  const type = raw.type;
  if (!isString(type)) return malformed(`"action.type" must be a string`);
  if ((SERVER_ONLY_ACTION_TYPES as readonly string[]).includes(type)) {
    return malformed(`"${type}" is a server-only action (R79)`);
  }
  if (!(CLIENT_ACTION_TYPES as readonly string[]).includes(type)) {
    return malformed(`"${type}" is not an action type`);
  }

  switch (type as ClientActionType) {
    case "mulligan": {
      if (!isStringList(raw.keep)) return malformed(`"mulligan.keep" must be an array of ids`);
      return { type: "mulligan", keep: raw.keep };
    }
    case "play": {
      if (!isString(raw.instanceId)) return malformed(`"play.instanceId" must be a string`);
      const body: Extract<ActionBody, { type: "play" }> = { type: "play", instanceId: raw.instanceId };
      if (raw.zone !== undefined) {
        const zone = parseZone(raw.zone);
        if (zone === null) return malformed(`"play.zone" must be { row, lane }`);
        body.zone = zone;
      }
      if (raw.x !== undefined) {
        if (!isInt(raw.x) || raw.x < 0) return malformed(`"play.x" must be a non-negative integer`);
        body.x = raw.x;
      }
      if (raw.embiggen !== undefined) {
        if (!isBool(raw.embiggen)) return malformed(`"play.embiggen" must be a boolean`);
        body.embiggen = raw.embiggen;
      }
      if (raw.tributes !== undefined) {
        if (!isStringList(raw.tributes)) return malformed(`"play.tributes" must be an array of ids`);
        body.tributes = raw.tributes;
      }
      if (raw.targets !== undefined) {
        const targets = parseSelections(raw.targets);
        if (targets === null) return malformed(`"play.targets" must be an array of selections`);
        body.targets = targets;
      }
      if (raw.modes !== undefined) {
        if (!isStringList(raw.modes)) return malformed(`"play.modes" must be an array of strings`);
        body.modes = raw.modes;
      }
      return body;
    }
    case "attack": {
      if (!isString(raw.attackerId) || !isString(raw.targetId)) {
        return malformed(`"attack" needs "attackerId" and "targetId"`);
      }
      return { type: "attack", attackerId: raw.attackerId, targetId: raw.targetId };
    }
    case "switchPosition": {
      if (!isString(raw.instanceId)) return malformed(`"switchPosition.instanceId" must be a string`);
      return { type: "switchPosition", instanceId: raw.instanceId };
    }
    case "activatePower": {
      if (!isString(raw.instanceId)) return malformed(`"activatePower.instanceId" must be a string`);
      const body: Extract<ActionBody, { type: "activatePower" }> = {
        type: "activatePower",
        instanceId: raw.instanceId,
      };
      if (raw.targets !== undefined) {
        const targets = parseSelections(raw.targets);
        if (targets === null) return malformed(`"activatePower.targets" must be selections`);
        body.targets = targets;
      }
      return body;
    }
    case "answer": {
      if (!isString(raw.choiceId)) return malformed(`"answer.choiceId" must be a string`);
      const selection = parseSelections(raw.selection);
      if (selection === null) return malformed(`"answer.selection" must be an array of selections`);
      return { type: "answer", choiceId: raw.choiceId, selection };
    }
    case "answerDraw": {
      if (!isBool(raw.accept)) return malformed(`"answerDraw.accept" must be a boolean`);
      return { type: "answerDraw", accept: raw.accept };
    }
    case "offerDraw":
      return { type: "offerDraw" };
    case "concede":
      return { type: "concede" };
    case "endTurn":
      return { type: "endTurn" };
  }
}

/** The longest nonce the server will hold in its dedupe map (§9.8: nothing unbounded). */
export const MAX_NONCE_LENGTH = 128;
/** A frame larger than this is rejected before it is parsed (§9.8). */
export const MAX_FRAME_BYTES = 64 * 1024;

export function parseClientMessage(text: string): ClientMessage | MalformedMessage {
  if (text.length > MAX_FRAME_BYTES) return malformed("that frame is too large");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return malformed("every frame must be JSON");
  }
  if (!isRecord(parsed)) return malformed("every frame must be a JSON object");

  const type = parsed.type;
  if (!isString(type)) return malformed(`"type" must be a string`);

  switch (type) {
    case "hello": {
      const message: HelloMessage = { type: "hello" };
      if (parsed.token !== undefined) {
        if (!isString(parsed.token)) return malformed(`"hello.token" must be a string`);
        message.token = parsed.token;
      }
      if (parsed.matchId !== undefined) {
        if (!isString(parsed.matchId)) return malformed(`"hello.matchId" must be a string`);
        message.matchId = parsed.matchId;
      }
      if (parsed.roomCode !== undefined) {
        if (!isString(parsed.roomCode)) return malformed(`"hello.roomCode" must be a string`);
        message.roomCode = parsed.roomCode;
      }
      return message;
    }
    case "joinRoom": {
      if (!isString(parsed.roomCode)) return malformed(`"joinRoom.roomCode" must be a string`);
      const message: JoinRoomMessage = { type: "joinRoom", roomCode: parsed.roomCode };
      if (parsed.token !== undefined) {
        if (!isString(parsed.token)) return malformed(`"joinRoom.token" must be a string`);
        message.token = parsed.token;
      }
      return message;
    }
    case "action": {
      const raw = parsed.action;
      if (!isRecord(raw)) return malformed(`"action" must be an object`);
      const nonce = raw.nonce ?? parsed.nonce;
      if (!isString(nonce) || nonce.length === 0) {
        return malformed(`every action carries a client nonce (SPEC §9.3)`);
      }
      if (nonce.length > MAX_NONCE_LENGTH) return malformed("that nonce is too long");
      const body = parseActionBody(raw);
      if (body.type === "malformed") return body;
      return { type: "action", nonce, body };
    }
    default:
      return malformed(`"${type}" is not a client message`);
  }
}
