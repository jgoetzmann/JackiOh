// Effects that ask the controller something: Choose one, a target, a card in hand, and Discover
// (SPEC §6.3, §10.6). Each opens a prompt and hands the answer to a named resume step.

import type { CardType, PlayerId, Selection } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { defOf, excludingIndex, query, type CatalogQueryArgs } from "../catalog";
import { openPrompt, resumeSelf } from "../prompts";
import type { Effect, EffectContext } from "../script";
import { effectiveCost } from "../mana";
import type { CardInstance, GameState } from "../state";
import { activeUnitsOf, cardAt, isUnitToken, slotsOf } from "../zones";
import { playerOf, type PlayerSpec } from "./targets";

/** Which cards a `target` prompt may offer. */
export type TargetScope = {
  side?: "ally" | "enemy" | "any";
  of?: ("unit" | "hero" | "backrow")[];
  type?: CardType | CardType[];
  excludeSelf?: boolean;
};

function sidesOf(ctx: EffectContext, side: TargetScope["side"]): PlayerId[] {
  if (side === "ally") return [ctx.controller];
  if (side === "enemy") return [opponentOf(ctx.controller)];
  return [...PLAYER_IDS];
}

/** Every card and hero a scope allows, in a deterministic order (active side first, lane order). */
export function targetsInScope(ctx: EffectContext, scope: TargetScope = {}): Selection[] {
  const kinds = scope.of ?? ["unit"];
  const out: Selection[] = [];

  for (const player of sidesOf(ctx, scope.side)) {
    if (kinds.includes("unit")) {
      for (const unit of activeUnitsOf(ctx.state, player)) {
        if (scope.excludeSelf === true && unit.id === ctx.self?.id) continue;
        out.push({ pick: "instance", instanceId: unit.id });
      }
    }
    if (kinds.includes("backrow")) {
      for (const ref of slotsOf(player, "backrow")) {
        const card = cardAt(ctx.state, ref);
        if (card === null) continue;
        if (scope.excludeSelf === true && card.id === ctx.self?.id) continue;
        out.push({ pick: "instance", instanceId: card.id });
      }
    }
    if (kinds.includes("hero")) out.push({ pick: "hero", player });
  }

  return out;
}

/**
 * §10.6: an answered prompt's selection arrives in `ctx.targets`, so a Discover's pick — a `mode`
 * option carrying a def id — is read from there. Play-time modes (R81) arrive in `ctx.modes`, and a
 * resume step may be reached either way, so both are offered in order.
 */
export function chosenOptions(ctx: EffectContext): string[] {
  const picked = ctx.targets.flatMap((selection) =>
    selection.pick === "mode" ? [selection.option] : [],
  );
  return [...picked, ...ctx.modes];
}

function label(ctx: EffectContext, selection: Selection): string {
  if (selection.pick === "hero") return `${selection.player}'s hero`;
  if (selection.pick === "instance") {
    const card = findOnBoard(ctx, selection.instanceId);
    return card === null ? selection.instanceId : defOf(ctx.state, card.defId).name;
  }
  if (selection.pick === "mode") return selection.option;
  return "nothing";
}

/**
 * §10.6, §10.8: an option's key is what the client sends back, so one key names one option — two
 * Duplicating Felinors in reach are two options, and a key built from the label (the card's name)
 * gave both the same one. The key is built from the selection itself, which is unique among the
 * options by construction, and never from a name (R177 keeps names off what a view may not read).
 */
function keyOf(selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return `instance:${selection.instanceId}`;
    case "hero":
      return `hero:${selection.player}`;
    case "mode":
      return `mode:${selection.option}`;
    case "zone":
      return `zone:${selection.player}:${selection.row}:${selection.lane}`;
    default:
      return "none";
  }
}

function findOnBoard(ctx: EffectContext, instanceId: string): CardInstance | null {
  for (const player of PLAYER_IDS) {
    const side = ctx.state.players[player];
    const found = [
      ...side.hand,
      ...side.graveyard,
      ...side.units.flatMap((pile) => pile ?? []),
      ...side.backrow.flatMap((card) => (card === null ? [] : [card])),
    ].find((card) => card.id === instanceId);
    if (found !== undefined) return found;
  }
  return null;
}

/** §6.3 Choose one: a mode prompt whose answer resumes the script at `step`. */
export function chooseMode(args: {
  options: string[];
  step: string;
  prompt?: string;
  data?: Record<string, unknown>;
}): Effect {
  return {
    kind: "chooseMode",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "mode",
        prompt: args.prompt ?? "Choose one",
        options: args.options.map((option) => ({
          key: `mode:${option}`,
          label: option,
          selection: { pick: "mode", option },
        })),
        resume: resumeSelf(ctx, args.step, args.data ?? {}),
      });
    },
  };
}

/** A target prompt (§10.6). With no legal target the effect fizzles and the card still resolves. */
export function chooseTarget(args: {
  step: string;
  scope?: TargetScope;
  prompt?: string;
  data?: Record<string, unknown>;
}): Effect {
  return {
    kind: "chooseTarget",
    apply(ctx): void {
      const options = targetsInScope(ctx, args.scope);
      if (options.length === 0) return;
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: args.prompt ?? "Choose a target",
        options: options.map((selection) => ({
          key: keyOf(selection),
          label: label(ctx, selection),
          selection,
        })),
        resume: resumeSelf(ctx, args.step, args.data ?? {}),
      });
    },
  };
}

/** A pick from your own hand (#26, #80). */
export function chooseFromHand(args: {
  step: string;
  count?: number;
  prompt?: string;
  data?: Record<string, unknown>;
}): Effect {
  return {
    kind: "chooseFromHand",
    apply(ctx): void {
      const hand = ctx.state.players[ctx.controller].hand;
      if (hand.length === 0) return;
      const count = Math.min(args.count ?? 1, hand.length);
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "hand",
        prompt: args.prompt ?? "Choose a card in your hand",
        options: hand.map((card) => ({
          key: `instance:${card.id}`,
          label: defOf(ctx.state, card.defId).name,
          selection: { pick: "instance", instanceId: card.id },
        })),
        min: count,
        max: count,
        resume: resumeSelf(ctx, args.step, args.data ?? {}),
      });
    },
  };
}

/**
 * What a Discover's options are (R247). `card`, the default, offers the definitions themselves: each
 * option is a catalog id, labelled with the card's name, and the view names the card behind it
 * (§10.8). `index` offers the definitions' §5 indices instead — #82 KY's Trial's "Discover among 3
 * distinct random numbers" — so each option is the number, labelled with it and naming no
 * definition, and the resume step turns the number it gets back into its card (`defByIndex`).
 */
export type DiscoverOffer = "card" | "index";

/**
 * §6.3 Discover: choose 1 of 3, drawn without replacement from the stated pool and shown only to
 * the chooser. The options are definitions, so the resume step decides what to do with the pick —
 * or, with `offer: "index"`, their numbers (R247).
 *
 * `query` may be a function of the context, read when the effect applies rather than when the hook
 * builds its list: a hook is rebuilt each time a paused list resumes (`prompts.runResume`), and a
 * pool that costs something to build — #97 Zephyrs' scorer plays every candidate (§10.7) — is then
 * built once, for the Discover that uses it, and not again for the effects after it.
 */
export function discoverFromCatalog(args: {
  step: string;
  query?: CatalogQueryArgs | ((ctx: EffectContext) => CatalogQueryArgs);
  count?: number;
  prompt?: string;
  data?: Record<string, unknown>;
  /** R247: what each option is, the card or its number. Default `card`. */
  offer?: DiscoverOffer;
}): Effect {
  return {
    kind: "discoverFromCatalog",
    apply(ctx): void {
      const self = ctx.self;
      const asked = typeof args.query === "function" ? args.query(ctx) : args.query;
      // §5.1: a random pool never offers the card that generated it.
      const pool = query(
        excludingIndex(asked ?? {}, self === null ? undefined : defOf(ctx.state, self.defId).index),
      );
      if (pool.length === 0) return;

      const offered = ctx.rng.shuffle(pool).slice(0, args.count ?? 3);
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "discover",
        prompt: args.prompt ?? "Discover a card",
        options: offered.map((def) => {
          // R247: a number is offered as itself, so nothing in the option names the card it stands for.
          const option = args.offer === "index" ? def.index : def.id;
          return {
            key: `mode:${option}`,
            label: args.offer === "index" ? def.index : def.name,
            selection: { pick: "mode", option },
          };
        }),
        resume: resumeSelf(ctx, args.step, args.data ?? {}),
      });
    },
  };
}

/**
 * Which library cards a `discoverFromLibrary` may reveal. It is not a `CatalogQueryArgs`: the pool
 * is a pile of instances rather than the catalog, so only the filters #51 KY's Private Tutor names
 * are here, and a card that needs tags or rarity out of a library should widen this rather than be
 * routed through `catalog.query`, which would offer cards the library does not hold.
 */
export type LibraryFilter = {
  type?: CardType | CardType[];
  costRange?: { min?: number; max?: number };
};

/**
 * #51's engine cell: "Field Trap counts as Trap". A `type` filter matches the field exactly, so
 * asking for "Trap" has to name both fields or #18 Bread and Butter and #71 Intern Stimmy silently
 * vanish from the pool. The reverse does not hold: asking for "Field Trap" means Field Traps only.
 */
const TRAP_TYPES: readonly CardType[] = ["Trap", "Field Trap"];

function filterTypes(filter: LibraryFilter): CardType[] | undefined {
  const asked =
    filter.type === undefined ? [] : Array.isArray(filter.type) ? filter.type : [filter.type];
  if (asked.length === 0) return undefined;
  return asked.flatMap((type) => (type === "Trap" ? [...TRAP_TYPES] : [type]));
}

/**
 * R65: a library card's cost is R65's one calculation for that instance (`effectiveCost`), which is
 * what #30 Archivist and #94 Genn's Greed read (R24, R66): a card never played has no X (so an X-cost
 * card reads 0) and no embiggen price (its base), and its `costMod` and `costOverride` travel with
 * it into every zone (R78), so #95's "every card in your library costs 2 less" moves its bracket.
 */
function matchesFilter(state: GameState, card: CardInstance, filter: LibraryFilter): boolean {
  // R218: a unit-token card leaves a library only by being drawn or played (R11), so a reveal that
  // puts the pick in a hand passes over it, as a Recruit does.
  if (isUnitToken(state, card)) return false;
  const types = filterTypes(filter);
  if (types !== undefined && !types.includes(defOf(state, card.defId).type)) return false;

  const cost = effectiveCost(state, card);
  const range = filter.costRange;
  if (range?.min !== undefined && cost < range.min) return false;
  if (range?.max !== undefined && cost > range.max) return false;
  return true;
}

/**
 * §6.3's Discover row is explicit that this is the same primitive with the library as the pool:
 * "'Reveal N matching cards, then choose one' (KY's Private Tutor) is this same primitive with the
 * library as the pool: the revealed cards are that prompt's options, so only the chooser ever sees
 * them (§10.8)". So this is `discoverFromGraveyard` over a filtered library: `count` options drawn
 * without replacement with `ctx.rng.shuffle`, so the revealed cards are always different (R60).
 *
 * §10.8 is what makes revealing safe: "a card revealed out of a library is revealed only as an
 * option of the prompt that reveals it: the chooser sees it in full, the opponent sees only that a
 * prompt is open, and the rest of the library stays hidden from both." Nothing is copied out of
 * `state.pending.options`, so `viewFor` has one place to hide. The prompt therefore goes to
 * `ctx.controller` — the chooser — even when `player` names the other side's library as the pool.
 *
 * The options are real library INSTANCES, not definitions, which is the whole difference from
 * `discoverFromCatalog`: the resume step moves the pick with `addToHand({ instance: { of: "chosen" }
 * })` rather than creating a copy and leaving the revealed card in the library.
 *
 * No match at all opens no prompt: the effect fizzles and the card still resolves (§6.3), which is
 * the branch #51 answers with its Empty Notebook.
 */
export function discoverFromLibrary(args: {
  step: string;
  count?: number;
  player?: PlayerSpec;
  filter?: LibraryFilter;
  prompt?: string;
  data?: Record<string, unknown>;
}): Effect {
  return {
    kind: "discoverFromLibrary",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const filter = args.filter ?? {};
      const pool = ctx.state.players[player].library.filter((card) => matchesFilter(ctx.state, card, filter));
      if (pool.length === 0) return;

      const offered = ctx.rng.shuffle(pool).slice(0, args.count ?? 3);
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "discover",
        prompt: args.prompt ?? "Choose one of the revealed cards",
        options: offered.map((card) => ({
          key: `instance:${card.id}`,
          label: defOf(ctx.state, card.defId).name,
          selection: { pick: "instance", instanceId: card.id },
        })),
        resume: resumeSelf(ctx, args.step, args.data ?? {}),
      });
    },
  };
}

/** R50: Discover from the actual graveyard, so spell tokens there are eligible. */
export function discoverFromGraveyard(args: {
  step: string;
  count?: number;
  prompt?: string;
  data?: Record<string, unknown>;
}): Effect {
  return {
    kind: "discoverFromGraveyard",
    apply(ctx): void {
      const graveyard = ctx.state.players[ctx.controller].graveyard;
      if (graveyard.length === 0) return;

      const offered = ctx.rng.shuffle(graveyard).slice(0, args.count ?? 3);
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "discover",
        prompt: args.prompt ?? "Discover a card from your graveyard",
        options: offered.map((card) => ({
          key: `instance:${card.id}`,
          label: defOf(ctx.state, card.defId).name,
          selection: { pick: "instance", instanceId: card.id },
        })),
        resume: resumeSelf(ctx, args.step, args.data ?? {}),
      });
    },
  };
}
