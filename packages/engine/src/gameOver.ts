// The end of a game (SPEC §2.5, R216): every way a game ends goes through `endGame`, so a finished
// game has one shape whatever ended it.

import type { GameOverReason, PlayerId } from "@jackioh/shared";
import type { EngineSink } from "./resolve";

/**
 * §2.5: the game is over. R216: nothing happens after that, so a question still open when it ends —
 * a Discover the other seat conceded under (R211), a Death hook's question the state check that found
 * a hero at 0 left standing (R156) — can never be answered: `legalActions` offers nothing once there
 * is a result, and a prompt left in `state.pending` would be shown to a seat that can do nothing with
 * it (§10.8). It is closed with the game, and `gameOver` is the last event of the action.
 */
export function endGame(sink: EngineSink, winner: PlayerId | "draw", reason: GameOverReason): void {
  const state = sink.state;
  state.result = { winner, reason };
  state.phase = "over";
  state.pending = null;
  sink.events.push({ type: "gameOver", winner, reason });
}
