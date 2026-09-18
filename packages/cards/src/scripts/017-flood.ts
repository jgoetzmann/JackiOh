// #17 Flood (SPEC §8.1): "Bounce all units on both sides", radiant "Choose one: bounce all units,
// bounce all enemy units, destroy all enemy units; then draw 1". Engine cell: "Tokens vanish on
// bounce; hand cap burns extras".
//
// The radiant cell restates the whole effect, so the base "bounce all units on both sides" survives
// only as one of the three options (§8 Conventions).
//
// Neither the vanishing nor the burning is this card's business: §6.3 Bounce goes through
// `effects/move.ts`, where a unit token ceases to exist instead of reaching a hand (R11) and a full
// hand burns the card to the graveyard (R4, §2.4).
//
// R81: "the targets and modes a card's script declares travel in the `play` action … so Glowy Jelly
// Bean's hand card and Silly Silas's direction are chosen with the play and never pause resolution".
// Flood's "choose one" is therefore a declared `modes` and NOT a `PendingChoice`: the pick arrives in
// `ctx.modes`, which `chosenOptions` reads (after any prompt mode pick, so one helper covers both).

import type { EffectContext, Effect, Script } from "@jackioh/engine";
// BLOCKED (engine, effects/move.ts and effects/destroy.ts): `bounceAll` and `destroyAll` do not
// exist yet. The effects library has only single-target `bounce`/`destroy` and `TargetSpec` cannot
// name an arbitrary instance, so no face of Flood can be written without them and this import is red
// until M3-T1 adds them. Proposed, in the house style of `stealAll`/`switchAllPositions`/
// `buffAllUnits` (`{ side: PlayerSpec | "both" }`):
//   export function bounceAll(args: { side: PlayerSpec | "both"; of?: ("unit" | "backrow")[] }): Effect
//     — `of` defaults to ["unit"]; bounces in side-then-lane order (the controller's side first,
//       lanes 1-5, §3.2), each card through the existing `bounce` body so R11 and R4 are unchanged.
//   export function destroyAll(args: {
//     side: PlayerSpec | "both"; of?: ("unit" | "backrow")[]; type?: CardType | CardType[];
//     tags?: Tag[]; notTags?: Tag[];
//   }): Effect
//     — marks every match and stops, exactly like `destroy`, so Indestructible survives (R46) and
//       everything dies in the one state check that follows (R59).
import { bounceAll, chosenOptions, destroyAll, draw } from "@jackioh/engine/effects";
import type { ModeDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-017");

/**
 * The three options, word for word from §8. They are the card's public interface: `legalActions`
 * offers these strings, the client shows them and the hook below matches on them, so the declaration
 * and the hook must never drift apart — hence one constant for both.
 */
const BOUNCE_ALL = "bounce all units";
const BOUNCE_ENEMY = "bounce all enemy units";
const DESTROY_ENEMY = "destroy all enemy units";

const MODES: ModeDecl[] = [{ kind: "mode", options: [BOUNCE_ALL, BOUNCE_ENEMY, DESTROY_ENEMY] }];

/** "Bounce all units on both sides" — the base text, and radiant's first option. */
function bounceBothSides(): Effect {
  return bounceAll({ side: "any" });
}

/**
 * The option the play carried. `whyChoicesRefused` (playChoices.ts) already refuses a play that
 * names no mode for a declared one, so the fallback is unreachable in a legal game; it is the first
 * option rather than "do nothing" because "choose one" is a mandatory choice, not an optional rider.
 */
function pickedMode(ctx: EffectContext): string {
  return chosenOptions(ctx)[0] ?? BOUNCE_ALL;
}

function chosenEffect(ctx: EffectContext): Effect {
  const picked = pickedMode(ctx);
  if (picked === DESTROY_ENEMY) return destroyAll({ side: "enemy", rows: ["units"] });
  if (picked === BOUNCE_ENEMY) return bounceAll({ side: "enemy" });
  return bounceBothSides();
}

export const base: Script = {
  cry: () => [bounceBothSides()],
};

export const radiant: Script = {
  modes: MODES,
  // "; then draw 1": the draw follows whichever mode resolved, on all three of them.
  cry: (ctx) => [chosenEffect(ctx), draw({ count: 1 })],
};
