// Stage directions (docs/polish/1-animations.md, visual pass 2, B46–B48).
//
// The S7 recipes draw OVER the board. The cues planned here act on the board's own elements, to hide
// a seam in how the board is shown: BUILD M5-T4 keeps the view from before a burst on screen until
// the whole burst has played, so a card the burst moves stays where it was until the very end.
// Played from the hand, a unit went back into the hand as soon as its own entry ended and sat there
// while its Cry resolved; a destroyed card came back after its dissolve; an attacker lunged straight
// up the screen whoever it attacked. Three cues fix that without touching the runner:
//
// - `hold`: a stand-in carries the card to the zone the next view shows it in (flying from the hand
//   card, or from the opponent's hand of backs, or appearing as a card-shaped light) and stays there
//   until the board shows that view.
// - `conceal`: the card the burst has taken away stays hidden once its own motion ends, until the
//   board shows the view it is gone from.
// - `lunge`: the attacker's lunge aims at the element it attacks, and a spark meets it on contact.
//
// R200 still holds: nothing here paces, extends or reschedules an entry. A hold or a conceal lasts
// until the shown view changes (FxLayer releases them in the same commit that draws the new board)
// and never past FX_HOLD_MAX_MS. R202 still holds: a stand-in copies only what the viewer's board
// already renders (the viewer's own hand card, a face-up board card, a card back), and a unit that
// comes from nowhere the viewer can see arrives as a card-shaped light.
//
// Pure, like `cues.ts`: it reads its arguments and returns data.

import type { GameEvent, PlayerView } from "@jackioh/shared";

import { animTestid, locateInstance, targetFor, type AnimationEntry } from "../game/animations.ts";
import { sideOf, testid } from "../game/contract.ts";
import {
  FX_CONCEAL_AT,
  FX_HOLD_MAX_MS,
  FX_LUNGE_CONTACT_AT,
  FX_MIND_CONTROL_FLIGHT_FRACTION,
  FX_SLAM_AT,
} from "./constants.ts";
import type { FxAnchor, FxCue, FxPlanEnv } from "./types.ts";

/** The contact spark's base count and power (rule 9), scaled by intensity like every burst. */
const STAGE_TUNING = {
  contactSpark: { count: 14, power: 1 },
} as const;

const HERO_TARGET = /^hero-(p1|p2)$/;

function tid(id: string): FxAnchor {
  return { kind: "testid", testid: id };
}

const frac = (fraction: number, D: number): number => Math.round(fraction * D);

/** The element an attack is aimed at: the defending card, or the hero named `hero-<playerId>`. */
function attackTarget(targetId: string, view: PlayerView): string | null {
  const hero = HERO_TARGET.exec(targetId)?.[1];
  if (hero === "p1" || hero === "p2") return testid.hero(sideOf(view, hero));
  return locateInstance(view, targetId);
}

type Ctx = { entry: AnimationEntry; view: PlayerView; env: FxPlanEnv; D: number };

function stageOf(event: GameEvent, c: Ctx): FxCue[] {
  const { entry, view, D } = c;
  const hold = (from: FxAnchor | null, to: string, landMs: number): FxCue => ({
    kind: "hold",
    from,
    to: tid(to),
    delayMs: 0,
    landMs,
    durationMs: FX_HOLD_MAX_MS,
  });
  const conceal = (id: string, mode: "now" | "after"): FxCue => ({
    kind: "conceal",
    testid: id,
    mode,
    delayMs: mode === "now" ? 0 : frac(FX_CONCEAL_AT, D),
    durationMs: FX_HOLD_MAX_MS,
  });

  switch (event.type) {
    case "cardPlayed": {
      // A unit played from the viewer's hand is carried by its `summoned` stand-in below.
      const paired = entry.events.some((e) => e.type === "summoned" && e.instanceId === event.instanceId);
      const at = targetFor(event, view);
      if (paired || at === null || !at.startsWith("hand-card-")) return [];
      return [conceal(at, "after")];
    }
    case "summoned": {
      const zone = targetFor(event, view);
      if (zone === null) return [];
      const played = entry.events.find(
        (e): e is Extract<GameEvent, { type: "cardPlayed" }> => e.type === "cardPlayed" && e.instanceId === event.instanceId,
      );
      const landMs = frac(FX_SLAM_AT, D);
      if (played !== undefined && event.instanceId !== "hidden") {
        const inHand = locateInstance(view, event.instanceId);
        if (inHand !== null && inHand.startsWith("hand-card-")) {
          return [hold(tid(inHand), zone, landMs), conceal(inHand, "now")];
        }
      }
      if (played !== undefined && sideOf(view, played.player) === "opponent") {
        // Out of a hand the viewer only sees as backs: a back flies to the zone (R202).
        return [hold(tid(animTestid.hand("opponent")), zone, landMs)];
      }
      return [hold(null, zone, landMs)];
    }
    case "destroyed":
    case "exiled":
    case "bounced": {
      const at = targetFor(event, view);
      return at !== null && at.startsWith("card-") ? [conceal(at, "after")] : [];
    }
    case "discarded": {
      const at = targetFor(event, view);
      return at !== null && at.startsWith("hand-card-") ? [conceal(at, "after")] : [];
    }
    case "controlChanged": {
      const zone = targetFor(event, view);
      if (zone === null || event.instanceId === "hidden") return [];
      const from = locateInstance(view, event.instanceId);
      if (from === null || !from.startsWith("card-")) return [];
      return [hold(tid(from), zone, frac(FX_MIND_CONTROL_FLIGHT_FRACTION, D)), conceal(from, "now")];
    }
    case "attackDeclared": {
      const attacker = targetFor(event, view);
      const target = attackTarget(event.targetId, view);
      if (attacker === null || target === null || attacker === target) return [];
      const tuning = STAGE_TUNING.contactSpark;
      return [
        { kind: "lunge", attacker, target, delayMs: 0, durationMs: D },
        {
          kind: "burst",
          preset: "spark",
          at: tid(target),
          delayMs: frac(FX_LUNGE_CONTACT_AT, D),
          count: Math.max(1, Math.round(tuning.count * c.env.intensity)),
          spread: "point",
          power: tuning.power,
        },
      ];
    }
    default:
      return [];
  }
}

/** Plans the stage cues of one entry, in event order. Nothing at intensity 0 (the layer is off). */
export function planStage(entry: AnimationEntry, view: PlayerView, env: FxPlanEnv): FxCue[] {
  if (!(env.intensity > 0)) return [];
  const cues: FxCue[] = [];
  for (const event of entry.events) cues.push(...stageOf(event, { entry, view, env, D: entry.durationMs }));
  return cues;
}
