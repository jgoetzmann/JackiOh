// The action union (SPEC §10.2). Every action carries playerId and a client nonce, deduped by the reducer.

import type { PlayerId, Row } from "./catalog-types";

/** Where a permanent is being played (§3.2: the player picks the zone). */
export type ZoneChoice = { row: Row; lane: number };

/** One selection inside a play: an instance, a hero, or a zone (R81). */
export type Selection =
  | { pick: "instance"; instanceId: string }
  | { pick: "hero"; player: PlayerId }
  | { pick: "zone"; player: PlayerId; row: Row; lane: number }
  | { pick: "mode"; option: string }
  | { pick: "none" };

export type ActionBody =
  | { type: "mulligan"; keep: string[] }
  | {
      type: "play";
      instanceId: string;
      zone?: ZoneChoice;
      x?: number;
      embiggen?: boolean;
      /** Units sacrificed to pay a Tribute cost (§6.3). */
      tributes?: string[];
      targets?: Selection[];
      modes?: string[];
    }
  | { type: "attack"; attackerId: string; targetId: string }
  | { type: "switchPosition"; instanceId: string }
  | { type: "activatePower"; instanceId: string; targets?: Selection[] }
  | { type: "answer"; choiceId: string; selection: Selection[] }
  | { type: "offerDraw" }
  | { type: "answerDraw"; accept: boolean }
  | { type: "concede" }
  | { type: "endTurn" }
  // Server-only (R79): never sent by a client.
  | { type: "timeout" }
  | { type: "disconnectExpired"; player: PlayerId }
  | { type: "ceilingReached" };

export type Action = ActionBody & { playerId: PlayerId; nonce: string };

/** Omit over a union, member by member: plain Omit would collapse it to the shared keys. */
export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An action without its nonce, which the caller or the server adds. */
export type ActionInput = ActionBody & { playerId: PlayerId };

export type ActionType = ActionBody["type"];

/** Actions the non-active player may take (BUILD M1-T3). */
export const NON_ACTIVE_ACTION_TYPES = [
  "answer",
  "concede",
  "answerDraw",
  "disconnectExpired",
  "timeout",
  "ceilingReached",
] as const;

/** The actions that may be sent while a prompt is open (BUILD M1-T3). */
export const PROMPT_OPEN_ACTION_TYPES = [
  "answer",
  "mulligan",
  "concede",
  "timeout",
  "disconnectExpired",
  "ceilingReached",
] as const;
