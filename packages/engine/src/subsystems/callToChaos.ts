// Call to Chaos (SPEC §8 #95, R28): the ten effects, the roll that picks them, and the capped
// recursion the tenth one drives.
//
// The card is a Spell whose base text is "one random effect" and whose radiant text is "two random
// effects": the recursion plus one of the other nine (§8, R28). Every effect here is built from the
// effects library, so #95's own file (M4) is a one-line hook that returns `[callToChaos()]` and
// stays a list of effects, like every other card (CLAUDE.md rule 5).
//
// Two things need care. First, each effect reads the board when it *resolves*, not when the hook
// builds it: the radiant roll resolves the recursion before its partner, and a nested cast can draw
// cards, summon units and change costs in between, so "your hand becomes Radiant" and "draw your
// whole library" must see the hand and library as they are at that moment (R58's "the library size
// when the effect starts"). Every effect is therefore one lazy wrapper that builds its sub-effects
// inside `apply`. Second, the chain length is game state, not a module variable: it lives on the
// cast instance's `memory` (§10.1), so a paused, serialized game resumes with the same cap left and
// two independent Calls in one turn never share a counter.

import type { CatalogQuery, Tag } from "@jackioh/shared";
import { defByIndex, query } from "../catalog";
import { CALL_TO_CHAOS_CHAIN_CAP } from "../config";
import { addToHand, draw, gainMana, heal, setCostMod, setRadiant, summon } from "../effects";
import { applyEffects, castCard, type EngineSink } from "../resolve";
import type { Rng } from "../rng";
import type { Effect, EffectContext } from "../script";
import { newInstance, type CardInstance } from "../state";

/** §8 #95: "summon 3 random 3-cost Units". */
export const CHAOS_UNIT_COUNT = 3;
export const CHAOS_UNIT_COST = 3;
/** §8 #95: "heal your hero 30" — a hero heal has no cap (§6.3 Heal). */
export const CHAOS_HEAL = 30;
/** §8 #95: "draw your whole library and gain 4 mana". */
export const CHAOS_MANA = 4;
/** §8 #95: "add 3 random cards to hand costing 0". */
export const CHAOS_ADDED_CARDS = 3;
/** §8 #95 and §7: "summon five 5/5 Rush Tokens", the stats coming from `statsOverride`. */
export const CHAOS_RUSH_TOKENS = 5;
export const CHAOS_RUSH_TOKEN_STATS = { attack: 5, health: 5 } as const;
/** §8 #95: "every card in your hand and library costs 2 less". */
export const CHAOS_COST_DISCOUNT = 2;
/** §8 #95: "summon 5 random Field Spells or Traps … into your backrow". */
export const CHAOS_BACKROW_CARDS = 5;

/** §5, §8 #95: the tag the Call to Chaos family carries, and so the recursion's pool (§10.7). */
export const CHAOS_TAG: Tag = "Call to Chaos";
/** §7: the tokens #95 summons, by catalog index. */
const RUSH_TOKEN_INDEX = "T-rush";
const CHAOS_GOLEM_INDEX = "95.1";

/** §5.1: the backrow half of the catalog — "Field Spells or Traps (Field Traps included)" (§8). */
const CHAOS_BACKROW_QUERY: CatalogQuery = { type: ["Field Spell", "Trap", "Field Trap"] };

/**
 * R28: how many casts of the chain this instance is. The played #95 has no entry and so is 0; the
 * card it casts is 1, the card that one casts is 2, and the chain stops once a cast would be the
 * 21st. It lives in `memory` because §10.1 puts everything a card must remember on the instance,
 * which keeps the counter serializable and per-chain.
 */
export const CHAOS_CHAIN_KEY = "chaosChain";

export function chaosChainOf(instance: CardInstance | null): number {
  const value = instance?.memory[CHAOS_CHAIN_KEY];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;
}

/** R28: the hard stop. At the cap the recursion effect resolves and does nothing at all. */
export function chaosChainCapReached(depth: number): boolean {
  return depth >= CALL_TO_CHAOS_CHAIN_CAP;
}

function sinkOf(ctx: EffectContext): EngineSink {
  return { state: ctx.state, events: ctx.events, rng: ctx.rng };
}

/**
 * R60: cards generated from the catalog may repeat, so each of the `count` picks is its own uniform
 * draw from the whole pool. §10.7 makes `catalog.query` the only random pool, and its index order
 * makes the draw depend on (seed, cursor) alone.
 */
function randomDefIds(ctx: EffectContext, q: CatalogQuery, count: number): string[] {
  const pool = query(q);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const def = ctx.rng.pick(pool);
    if (def !== undefined) out.push(def.id);
  }
  return out;
}

/** §7: a token summon needs the token's def id, which the catalog holds under its index. */
function tokenDefId(index: string): string | null {
  return defByIndex(index)?.id ?? null;
}

/**
 * One of the ten effects, built when it resolves rather than when the hook returns it, so every
 * state read happens after the effects before it have landed.
 */
function chaosEffect(name: ChaosEffectName, build: (ctx: EffectContext) => Effect[]): Effect {
  return {
    kind: `callToChaos:${name}`,
    apply(ctx): void {
      applyEffects(build(ctx), ctx);
    },
  };
}

/**
 * Point an effect from the library at one card by id. The library names a target through the
 * selections a play carried (R81), so a pick a script made itself travels the same way instead of
 * opening a second targeting path — and `setCostMod` stays the only place a cost change is written.
 */
function onInstance(effect: Effect, instanceId: string): Effect {
  return {
    kind: effect.kind,
    apply(ctx): void {
      effect.apply({ ...ctx, targets: [{ pick: "instance", instanceId }] });
    },
  };
}

// ---------------------------------------------------------------------------
// The ten effects, in the order §8 #95 lists them.
// ---------------------------------------------------------------------------

/** 1. "Summon 3 random 3-cost Units": three independent picks (R60), placed per R64. */
export function summonRandomThreeCostUnits(): Effect {
  return chaosEffect("units", (ctx) =>
    randomDefIds(ctx, { type: "Unit", cost: CHAOS_UNIT_COST }, CHAOS_UNIT_COUNT).map((defId) =>
      summon({ defId }),
    ),
  );
}

/** 2. "Heal your hero 30": §6.3 gives a hero heal no cap, so this may pass 30 health. */
export function healHeroThirty(): Effect {
  return chaosEffect("heal", () => [heal({ target: { of: "selfHero" }, amount: CHAOS_HEAL })]);
}

/**
 * 3. "Draw your whole library and gain 4 mana": R58 fixes the count at the library size when the
 * effect starts, so a cast-on-draw card drawn along the way cannot lengthen the draw, and an empty
 * library draws nothing at all rather than taking a fatigue hit (§2.4, R3).
 */
export function drawLibraryAndGainMana(): Effect {
  return chaosEffect("draw", (ctx) => [
    draw({ count: ctx.state.players[ctx.controller].library.length }),
    gainMana({ amount: CHAOS_MANA }),
  ]);
}

/**
 * 4. "Add 3 random cards to hand costing 0": three independent picks from the whole catalog, which
 * §5.1 already keeps free of tokens; the 0 is a `costOverride` on the new instance (R65). A full
 * hand burns what it cannot take (§2.4, R4).
 */
export function addRandomZeroCostCards(): Effect {
  return chaosEffect("add", (ctx) =>
    randomDefIds(ctx, {}, CHAOS_ADDED_CARDS).map((defId) => addToHand({ defId, costOverride: 0 })),
  );
}

/**
 * 5. "Your hand becomes Radiant": every card in hand right now (§5.2). A card that is already
 * Radiant is untouched, since the flag is never unset (§6.3 Make Radiant).
 */
export function makeHandRadiant(): Effect {
  return chaosEffect("radiant", (ctx) =>
    ctx.state.players[ctx.controller].hand.map((card) => setRadiant({ instanceId: card.id })),
  );
}

/**
 * 6. "Summon five 5/5 Rush Tokens": the §7 Rush Token with a `statsOverride`, five separate summons,
 * so a board with fewer free zones simply takes fewer (R64) instead of failing as a whole.
 */
export function summonRushTokens(): Effect {
  return chaosEffect("tokens", () => {
    const defId = tokenDefId(RUSH_TOKEN_INDEX);
    if (defId === null) return [];
    return Array.from({ length: CHAOS_RUSH_TOKENS }, () =>
      summon({ defId, statsOverride: { ...CHAOS_RUSH_TOKEN_STATS } }),
    );
  });
}

/**
 * 7. "Every card in your hand and library costs 2 less": the cards that are there when the effect
 * resolves, each getting a permanent `costMod` that travels with it between zones (R78). It changes
 * those cards, not the player, so a card drawn afterwards still pays full price.
 */
export function discountHandAndLibrary(): Effect {
  return chaosEffect("discount", (ctx) => {
    const side = ctx.state.players[ctx.controller];
    const discount = setCostMod({ target: { of: "chosen" }, amount: -CHAOS_COST_DISCOUNT });
    return [...side.hand, ...side.library].map((card) => onInstance(discount, card.id));
  });
}

/** 8. "Summon a Chaos Golem": the 10/10 token of §7 (index 95.1), placed per R64. */
export function summonChaosGolem(): Effect {
  return chaosEffect("golem", () => {
    const defId = tokenDefId(CHAOS_GOLEM_INDEX);
    return defId === null ? [] : [summon({ defId })];
  });
}

/**
 * 9. "Summon 5 random Field Spells or Traps (Field Traps included, traps face-down) into your
 * backrow": five independent picks (R60). `summon` sends every one of those types to the backrow
 * and leaves a Trap or Field Trap face-down while a Field Spell is public (§3.2, R33).
 */
export function summonRandomBackrow(): Effect {
  return chaosEffect("backrow", (ctx) =>
    randomDefIds(ctx, CHAOS_BACKROW_QUERY, CHAOS_BACKROW_CARDS).map((defId) => summon({ defId })),
  );
}

/**
 * 10. "Cast a random Call to Chaos": a Cast per R70 — free, counted as a play, running the card's
 * own script. Only Core exists, so the pool is #95 itself and the card cast is the *base* form even
 * when a Radiant #95 cast it (R28); the new card is Radiant only if something later makes it so.
 *
 * R28 caps the chain at CALL_TO_CHAOS_CHAIN_CAP casts. The cap is a hard stop: at the cap this
 * effect resolves into nothing, and no re-roll replaces it (R87).
 *
 * The cast card is a real generated card, like the ones "add 3 random cards to hand" makes (R60), so
 * §10.5 step 7 sends it to the caster's graveyard when it has resolved (R87), which is what feeds
 * Gravedigger and Reminisce down a long chain.
 */
export function castRandomCallToChaos(): Effect {
  return {
    kind: "callToChaos:recast",
    apply(ctx): void {
      const depth = chaosChainOf(ctx.self);
      if (chaosChainCapReached(depth)) return;

      const def = ctx.rng.pick(query({ tags: [CHAOS_TAG] }));
      if (def === undefined) return;

      const card = newInstance(ctx.state, def.id, ctx.controller, {
        z: "resolving",
        player: ctx.controller,
      });
      card.memory[CHAOS_CHAIN_KEY] = depth + 1;
      castCard(sinkOf(ctx), card);
    },
  };
}

// ---------------------------------------------------------------------------
// The roll (§8 #95, R28).
// ---------------------------------------------------------------------------

export type ChaosEffectName =
  | "units"
  | "heal"
  | "draw"
  | "add"
  | "radiant"
  | "tokens"
  | "discount"
  | "golem"
  | "backrow"
  | "recast";

export type ChaosEffectDef = {
  name: ChaosEffectName;
  /** The §8 clause this entry implements, for the client log and for test readability. */
  label: string;
  build: () => Effect;
};

/** R28: the effect the radiant form always rolls, and the one that drives the chain. */
export const CHAOS_RECURSION: ChaosEffectName = "recast";

/** The ten effects of §8 #95, in the order the card lists them. */
export const CHAOS_EFFECTS: readonly ChaosEffectDef[] = [
  { name: "units", label: "Summon 3 random 3-cost Units", build: summonRandomThreeCostUnits },
  { name: "heal", label: "Heal your hero 30", build: healHeroThirty },
  { name: "draw", label: "Draw your whole library and gain 4 mana", build: drawLibraryAndGainMana },
  { name: "add", label: "Add 3 random cards to hand costing 0", build: addRandomZeroCostCards },
  { name: "radiant", label: "Your hand becomes Radiant", build: makeHandRadiant },
  { name: "tokens", label: "Summon five 5/5 Rush Tokens", build: summonRushTokens },
  { name: "discount", label: "Every card in your hand and library costs 2 less", build: discountHandAndLibrary },
  { name: "golem", label: "Summon a Chaos Golem", build: summonChaosGolem },
  { name: "backrow", label: "Summon 5 random Field Spells or Traps into your backrow", build: summonRandomBackrow },
  { name: "recast", label: "Cast a random Call to Chaos", build: castRandomCallToChaos },
];

export function chaosEffectByName(name: string): ChaosEffectDef | null {
  return CHAOS_EFFECTS.find((effect) => effect.name === name) ?? null;
}

/**
 * R28: the base form rolls one of the ten; the radiant form rolls two — "cast a random Call to
 * Chaos" plus one drawn from the other nine, so the recursion is guaranteed and never doubled.
 *
 * Order: §8 writes the recursion first, so it resolves first and its whole chain is done before the
 * partner effect reads the board (R87).
 */
export function rollChaosEffects(rng: Rng, radiant: boolean): ChaosEffectDef[] {
  if (!radiant) {
    const one = rng.pick(CHAOS_EFFECTS);
    return one === undefined ? [] : [one];
  }

  const recursion = chaosEffectByName(CHAOS_RECURSION);
  const other = rng.pick(CHAOS_EFFECTS.filter((effect) => effect.name !== CHAOS_RECURSION));
  return [...(recursion === null ? [] : [recursion]), ...(other === undefined ? [] : [other])];
}

/**
 * The whole card, as one effect: #95's script is `cry: () => [callToChaos()]` for both forms.
 *
 * The roll happens when the effect resolves, so the rng cursor moves with the resolution and a
 * replay that stops on a prompt in between still lines up (§10.7). `radiant` defaults to the
 * instance's own flag, which is what `makeContext` put in the context (§5.2).
 */
export function callToChaos(args: { radiant?: boolean } = {}): Effect {
  return {
    kind: "callToChaos",
    apply(ctx): void {
      const radiant = args.radiant ?? ctx.radiant;
      applyEffects(
        rollChaosEffects(ctx.rng, radiant).map((chosen) => chosen.build()),
        ctx,
      );
    },
  };
}
