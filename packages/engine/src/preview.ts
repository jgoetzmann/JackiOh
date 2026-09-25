// The number a formula comes to now (SPEC §10.8, §10.9, R280). A card whose text computes a number
// from the board — #31's Fib(cost+1), #70's sum over missing health and exile, #40 radiant's twice
// the exile — would leave the player to do the arithmetic, and the client may not (CLAUDE.md rule 7).
// So the engine does it: the card's script declares `preview`, a pure read, and `viewFor` carries
// its answer on the card's view as `preview`. This module is the one place that asks the hook.
//
// Where a card carries it is where the viewer may read the card, and nowhere else (§10.8):
//   - the viewer's own hand, in any phase — a value is information, not the playability glow R195
//     keeps to the viewer's own main phase, and the hand's faces are the viewer's to read (§9.1);
//   - a unit on top of its pile, either seat's (the field is public);
//   - a backrow card of either seat that is face-up to the viewer: a Field Spell, a fired Field Trap,
//     and a face-down Trap or Field Trap for its controller alone (R33).
// Never on the opponent's hand, a library card, a card dormant under a Stack (R13) or a card in a
// graveyard, exile or the resolving zone. `viewFor` asks only in the three places above; the guards
// below refuse the rest again, without calling the hook, so a caller that asks about the wrong card
// learns nothing either.
//
// The hook is asked about the card as it runs: its own face (`radiant`), its own controller — the
// other seat's for a public card of theirs, since the number is the card's and not the viewer's —
// the zone, and `yourTurn` for that controller. It reads only what that controller may read (§9.1),
// and everything it may read is public or the viewer's own wherever it is shown, so it reveals
// nothing. An empty answer, or no hook, is no preview: the key is absent rather than `[]`.

import type { PlayerId, PreviewValue } from "@jackioh/shared";
import { defOf } from "./catalog";
import type { ConditionZone } from "./script";
import { scriptOf } from "./scripts";
import type { CardInstance, GameState } from "./state";
import { isBuried } from "./zones";

/**
 * §10.8: "traps show as unknown, Field Spells are public". A backrow Trap or Field Trap is readable
 * by its current controller only until it flips face-up, which is what R33 keys on `controller`.
 * The one rule both `viewFor` (what a view shows of a backrow card) and this module (what a preview
 * may be asked about) read, so the two cannot drift apart.
 */
export function backrowIsPublic(state: GameState, card: CardInstance, viewer: PlayerId): boolean {
  const type = defOf(state, card.defId).type;
  if (type !== "Trap" && type !== "Field Trap") return true;
  return card.faceUp === true || card.controller === viewer;
}

/** R280, §10.8: whether `viewer` may read `card` where the question places it. */
function mayPreview(state: GameState, card: CardInstance, viewer: PlayerId, zone: ConditionZone): boolean {
  const at = card.zone;
  if (zone === "hand") return at.z === "hand" && at.player === viewer;
  if (at.z !== "field") return false;
  if (at.row === "units") return !isBuried(state, card);
  return backrowIsPublic(state, card, viewer);
}

/**
 * R280: the labelled numbers `viewer` sees on `card`, or null for none. Pure: it copies what the hook
 * returns, so the view holds no reference into a script, and it calls the hook at most once.
 */
export function previewOf(
  state: GameState,
  card: CardInstance,
  viewer: PlayerId,
  zone: ConditionZone,
): PreviewValue[] | null {
  if (!mayPreview(state, card, viewer, zone)) return null;
  const hook = scriptOf(card).preview;
  if (hook === undefined) return null;
  const values = hook({
    state,
    self: card,
    controller: card.controller,
    radiant: card.radiant,
    zone,
    yourTurn: state.active === card.controller,
  });
  const copied = values
    .filter((entry) => typeof entry.label === "string" && entry.label.length > 0 && Number.isFinite(entry.value))
    .map((entry) => ({ label: entry.label, value: entry.value }));
  return copied.length === 0 ? null : copied;
}
