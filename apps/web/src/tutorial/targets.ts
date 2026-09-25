// A coach anchor as the `data-testid`s the board already renders (game/contract.ts, BUILD M5-T1).
//
// The view names the instance behind a definition (the human's hand, both sides' units), so the
// coach finds "Mr. Vanilla in your hand" as `hand-card-<instanceId>` without a hook into the board.
// An anchor the view cannot place (the card has left the hand) resolves to nothing, and the coach
// shows its bubble without a mark.

import type { PlayerView } from "@jackioh/shared";

import { LANES, sideView, testid } from "../game/contract.ts";
import type { CoachAnchor } from "./coach.ts";

export function coachTargets(anchor: CoachAnchor | null, view: PlayerView): string[] {
  if (anchor === null) return [];
  switch (anchor.kind) {
    case "handCard": {
      const hand = view.you.hand;
      if (!Array.isArray(hand)) return [];
      const card = hand.find((candidate) => candidate.defId === anchor.defId);
      return card === undefined ? [] : [testid.handCard(card.instanceId)];
    }
    case "hand":
      return ["hand-you"];
    case "unit": {
      const unit = sideView(view, anchor.side).units.find((candidate) => candidate?.defId === anchor.defId);
      return unit === undefined || unit === null ? [] : [testid.card(unit.instanceId)];
    }
    case "units":
      return LANES.map((lane) => testid.zone(anchor.side, "units", lane));
    case "backrow":
      return anchor.lane === undefined
        ? LANES.map((lane) => testid.zone(anchor.side, "backrow", lane))
        : [testid.zone(anchor.side, "backrow", anchor.lane)];
    case "zone":
      return [testid.zone(anchor.side, anchor.row, anchor.lane)];
    case "hero":
      return [testid.hero(anchor.side)];
    case "mana":
      return ["mana-you"];
    case "endTurn":
      return [testid.endTurn];
    case "prompt":
      return ["prompt-modal"];
    case "library":
      return [`library-${anchor.side}`];
    case "graveyard":
      return [`graveyard-${anchor.side}`];
  }
}
