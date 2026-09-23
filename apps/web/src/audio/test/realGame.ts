// Test helper for the audio suite: real engine games, reached the way the client reaches them
// (`game/engine.real.ts`'s `enginePort()`), so a test can feed the director the very views
// `viewFor` redacts for each seat (R97, R154). It is not a test file.
//
// The driver is deterministic: a seed, two decks and a caller's policy. Nothing here decides a
// rule; every action it sends comes from `legalActions`.

import type { Action, ActionBody, CardDefs, GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { resolveDeck } from "../../game/decks.ts";
import type { EnginePort, EngineState } from "../../game/engine.ts";
import { enginePort } from "../../game/engine.real.ts";

export type RealGame = {
  port: EnginePort;
  catalog: CardDefs;
  state(): EngineState;
  view(player: PlayerId): PlayerView;
  legal(player: PlayerId): ActionBody[];
  /** The seat that may act now: the one with a legal action other than conceding or offering a draw. */
  actor(): PlayerId | null;
  /** Reduces one action; throws on a refusal. Returns the unredacted events it produced. */
  act(player: PlayerId, body: ActionBody): GameEvent[];
};

let port: EnginePort | null = null;

export function realPort(): EnginePort {
  port ??= enginePort();
  return port;
}

export function devDeck(id: "first20" | "cheap20"): string[] {
  const resolved = resolveDeck(id, realPort().catalog?.() ?? {});
  if (!("deck" in resolved)) throw new Error(resolved.error);
  return resolved.deck;
}

/** A game after `beginGame`, with both mulligans answered by keeping every card. */
export function realGame(seed: string, decks: [string[], string[]]): RealGame {
  const p = realPort();
  let state = p.beginGame(p.createGame({ seed, decks })).state;
  let nonce = 0;
  const game: RealGame = {
    port: p,
    catalog: p.catalog?.() ?? {},
    state: () => state,
    view: (player) => p.viewFor(state, player),
    legal: (player) => p.legalActions(state, player),
    actor: () =>
      (["p1", "p2"] as const).find((player) =>
        p.legalActions(state, player).some((a) => a.type !== "concede" && a.type !== "offerDraw"),
      ) ?? null,
    act: (player, body) => {
      nonce += 1;
      const result = p.reduce(state, { ...body, playerId: player, nonce: `audio-${String(nonce)}` } as Action);
      if (result.error !== undefined) throw new Error(`${player} ${body.type}: ${result.error}`);
      state = result.state;
      return result.events;
    },
  };
  for (let i = 0; i < 2; i += 1) {
    const who = game.actor();
    if (who === null || !game.legal(who).some((a) => a.type === "mulligan")) break;
    const hand = game.view(who).you.hand;
    game.act(who, { type: "mulligan", keep: Array.isArray(hand) ? hand.map((c) => c.instanceId) : [] });
  }
  return game;
}

/** The hand card's defId for an instance in `player`'s own hand, or null. */
export function handDefId(game: RealGame, player: PlayerId, instanceId: string): string | null {
  const hand = game.view(player).you.hand;
  if (!Array.isArray(hand)) return null;
  return hand.find((c) => c.instanceId === instanceId)?.defId ?? null;
}

/** A legal `play` of that instance, preferring one with no prompt-bearing extras, or undefined. */
export function playOf(game: RealGame, player: PlayerId, instanceId: string): ActionBody | undefined {
  return game.legal(player).find((a) => a.type === "play" && a.instanceId === instanceId);
}

/** Answers any open prompt with its first legal answer, until none is open. */
export function answerPrompts(game: RealGame): void {
  for (let i = 0; i < 10; i += 1) {
    const who = game.actor();
    if (who === null) return;
    const answer = game.legal(who).find((a) => a.type === "answer");
    if (answer === undefined) return;
    game.act(who, answer);
  }
}
