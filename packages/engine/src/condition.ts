// Hearthstone's yellow glow (SPEC §10.8, §10.9, R195). A playable card lights up yellow when its
// printed condition is met — Combo, "if your hero is below N" — and the engine decides that, never
// the client (CLAUDE.md rule 7). `viewFor` asks this module about three kinds of card only: the
// viewer's own hand, the top of a unit pile and a public backrow card. Everything else (graveyard,
// exile, resolving, buried cards, the opponent's hand) is never asked.
//
// The rules, in order; the first that applies decides:
//   1. the game is over                                            -> false
//   2. a field card the viewer does not control                    -> false, hook not called
//   3. a hand card outside the viewer's own main phase, or with a
//      prompt open (the only time it could not be played now)      -> false, hook not called
//   4. the running face declares no `conditionMet` (a transient def
//      with no registered script gets EMPTY_SCRIPT from `scriptsFor`;
//      a fused def carries its ingredients' hooks, or-ed, R196)       -> false
//   5. otherwise the hook's answer, strictly `=== true`.
//
// Rule 2 is what keeps this from leaking: a hook only ever runs for its controller, who may read
// everything the Core hooks read (hero health, library counts, plays this turn, a grade, §9.1).

import type { PlayerId } from "@jackioh/shared";
import type { ConditionZone } from "./script";
import { scriptOf } from "./scripts";
import type { CardInstance, GameState } from "./state";

/** R195: whether `viewer` sees `card` glowing yellow. Pure; calls the hook at most once. */
export function conditionActive(
  state: GameState,
  card: CardInstance,
  viewer: PlayerId,
  zone: ConditionZone,
): boolean {
  if (state.result !== null) return false;
  if (zone === "field" && card.controller !== viewer) return false;
  if (zone === "hand" && !(state.phase === "main" && state.active === viewer && state.pending === null)) {
    return false;
  }
  const hook = scriptOf(card).conditionMet;
  if (hook === undefined) return false;
  return (
    hook({
      state,
      self: card,
      controller: viewer,
      radiant: card.radiant,
      zone,
      yourTurn: state.active === viewer,
    }) === true
  );
}
