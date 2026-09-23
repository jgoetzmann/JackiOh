// #22 Carnivorous Cube (SPEC §8.2, R41, R57, R64, R81).
//
// Base: "Cry: Tribute one of your other permanents and remember it. Death: summon 2 copies of the
// remembered card". Radiant restates the Death clause only ("Death: fill your board with copies"),
// so the Cry — the tribute and the remembering — is kept unchanged (§8 Conventions).
//
// §6.3 Tribute: "a card whose own text tributes (Carnivorous Cube) sacrifices what that text names
// instead, which may be any of your other permanents, backrow included (R41) … A tribute written
// into a card's script is an ordinary Sacrifice of the permanent that script names, where the Sheep
// Token's 2 never applies." So the meal is picked with the play (R81, a `tribute` target the play
// action carries, never a prompt) and eaten with `sacrifice`, which bypasses Indestructible and
// counts as a death.
//
// What is remembered is `memory.eaten = { defId, radiant, row, statsOverride?, armorOverride? }`
// (§10.1): R41 keeps the eaten card's radiant flag and `statsOverride` (with §7's `armorOverride`
// beside it) on every copy, and copies of a backrow card go
// to the backrow — which the remembered `row` records, so Death needs no catalog lookup. R41's two
// fizzles are one condition each: nothing to tribute → the Cry does nothing and remembers nothing;
// nothing eaten → Death does nothing. It can never eat itself: the declared target excludes it and
// the hook re-checks.

import type { Effect, EffectContext, Script } from "@jackioh/engine";
import { BACKROW_ZONES, findInstance } from "@jackioh/engine";
import { fillBoard, remember, sacrifice, summon } from "@jackioh/engine/effects";
import type { Row, TargetDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-022");

/** `memory.eaten`, plain JSON so the state survives a replay round-trip (§9.3, §10.1). */
type Eaten = {
  defId: string;
  /** R41, R57: a copy of a Radiant meal is Radiant. */
  radiant: boolean;
  /** R41: copies of an eaten backrow card go to the backrow. */
  row: Row;
  /** R41, R57: a token eaten with §7 stats copies with those stats. */
  statsOverride?: { attack: number; health: number };
  /** §7: a Bread Token's "Armor X" is the other half of its X/X, so a copy keeps it beside them. */
  armorOverride?: number;
};

const EATEN = "eaten";

/**
 * R81: the meal travels in the `play` action, as a `tribute` pick the client shows as one.
 *
 * `min: 1` is R41's "must eat if able", and R90 supplies the "if able": a declaration the board
 * cannot satisfy "does not refuse the play — the play is legal with the answers that exist and the
 * effect fizzles on resolution", which is exactly R41's "nothing to tribute → Cry fizzles".
 *
 * Deliberately no `amount`: `playChoices.tributeCostOf` reads a `tribute` declaration's `amount` as
 * §6.3's Tribute *cost*, which is paid with the play action's `tributes` list, counts Sheep Tokens
 * as 2, reaches units only and refuses the play when the board cannot pay it (#66). §6.3 says the
 * opposite for this card — "a card whose own text tributes (Carnivorous Cube) sacrifices what that
 * text names instead, which may be any of your other permanents, backrow included (R41) … where the
 * Sheep Token's 2 never applies" — so the meal is a declared target the script sacrifices itself,
 * and the play carries no Tribute cost.
 */
const targets: TargetDecl[] = [
  {
    kind: "tribute",
    min: 1,
    max: 1,
    filter: { side: "ally", of: ["unit", "backrow"], excludeSelf: true },
  },
];

/** Read the named permanent off the play's selection; null when there was nothing legal to eat. */
function mealOf(ctx: EffectContext): Eaten | null {
  const selection = ctx.targets[0];
  if (selection === undefined || selection.pick !== "instance") return null;

  const card = findInstance(ctx.state, selection.instanceId);
  if (card === undefined || card.zone.z !== "field") return null;
  // "One of your other permanents": ally only, and R41's "cannot eat itself".
  if (card.controller !== ctx.controller) return null;
  if (ctx.self !== null && card.id === ctx.self.id) return null;

  return {
    defId: card.defId,
    radiant: card.radiant,
    row: card.zone.row,
    ...(card.statsOverride === undefined
      ? {}
      : { statsOverride: { attack: card.statsOverride.attack, health: card.statsOverride.health } }),
    ...(card.armorOverride === undefined ? {} : { armorOverride: card.armorOverride }),
  };
}

function eatenOf(ctx: EffectContext): Eaten | null {
  const stored: unknown = ctx.self?.memory[EATEN];
  if (typeof stored !== "object" || stored === null) return null;
  const value = stored as Partial<Eaten>;
  if (typeof value.defId !== "string") return null;
  const row: Row = value.row === "backrow" ? "backrow" : "units";
  return {
    defId: value.defId,
    radiant: value.radiant === true,
    row,
    ...(value.statsOverride === undefined ? {} : { statsOverride: value.statsOverride }),
    ...(typeof value.armorOverride === "number" ? { armorOverride: value.armorOverride } : {}),
  };
}

/** One copy of the meal: R57's flags, and R64 puts it in the leftmost free zone of its own row. */
function copyOf(eaten: Eaten): Effect {
  return summon({
    defId: eaten.defId,
    radiant: eaten.radiant,
    ...(eaten.statsOverride === undefined ? {} : { statsOverride: eaten.statsOverride }),
    ...(eaten.armorOverride === undefined ? {} : { armorOverride: eaten.armorOverride }),
  });
}

/** Remember the meal, then eat it — the effects apply in this order, so the read happens first. */
const cry: Script["cry"] = (ctx) => {
  const meal = mealOf(ctx);
  if (meal === null) return []; // R41: nothing to tribute → the Cry fizzles.
  return [remember({ key: EATEN, value: meal }), sacrifice({ target: { of: "chosen" } })];
};

export const base: Script = {
  targets,
  cry,
  death: (ctx) => {
    const eaten = eatenOf(ctx);
    if (eaten === null) return []; // R41: nothing eaten → Death does nothing.
    return [copyOf(eaten), copyOf(eaten)];
  },
};

export const radiant: Script = {
  targets,
  cry,
  death: (ctx) => {
    const eaten = eatenOf(ctx);
    if (eaten === null) return [];
    // R64: "fill your board" summons into every empty, unlocked unit zone left to right.
    if (eaten.row === "units") {
      return [
        fillBoard({
          defId: eaten.defId,
          radiant: eaten.radiant,
          ...(eaten.statsOverride === undefined ? {} : { statsOverride: eaten.statsOverride }),
          ...(eaten.armorOverride === undefined ? {} : { armorOverride: eaten.armorOverride }),
        }),
      ];
    }
    // `fillBoard` refuses a non-unit row, so an eaten backrow card fills the backrow as one
    // laneless `summon` per zone: each takes the leftmost free zone and the extras fizzle (R64).
    return Array.from({ length: BACKROW_ZONES }, () => copyOf(eaten));
  },
};
