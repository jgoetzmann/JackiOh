// #95 Call to Chaos (Core Edition) and #95.1 Chaos Golem — SPEC §8.4, §7, §5.1, §10.5, §10.8,
// R4, R11, R28, R60, R64, R70, R87.
//
// BUILD M4-T4 row 95: "Each of the 10 effects has a test; recursion stops at 20 (R28); radiant
// rolls the recursion plus one of the other 9 effects (R28)".
// BUILD M4-T4 row 95.1: "10/10 with all four keywords".
//
// HOW AN EFFECT IS FORCED. §8.4 rolls one of ten, so a test that wants a named effect has to pin
// the roll. `subsystems.rollChaosEffects` is the roll and it is a pure function of the rng, whose
// whole state is `(state.seed, state.rngCursor)` (§9.3, §10.7). The roll is also the FIRST rng draw
// of the play action — paying, the Gifted Program hook, the move to `resolving` and the play event
// take none — so setting `state.rngCursor` before the play decides which of the ten resolves, and
// `cursorFor` finds a cursor for each by asking the engine's own roll. Nothing about an effect's
// behaviour is predicted that way: `cursorFor` only picks the fixture, and each `it` then asserts
// what the card actually did. The assumption itself is pinned by
// `it("§9.3 the roll is a pure function of (seed, cursor) …")`, so a pipeline that starts drawing
// rng earlier fails there by name instead of silently derailing the other ten.
//
// The ten effects' own machinery — the lazy wrappers, the chain counter on `memory`, R87's order —
// is proved against fixtures in `packages/engine/test/callToChaos.test.ts`. What this file owes is
// the card: that both faces of #95 are wired to that subsystem with the right §5.2 flag, and that
// the ten effects do the right thing against the REAL catalog (the real 3-cost Unit pool, the real
// Rush Token and Chaos Golem indices, the real backrow types) down the real §10.5 play path.

import { describe, expect, it } from "vitest";
import type { GameEvent, PlayerId } from "@jackioh/shared";
// R28's number lives in `config.ts` and is NOT re-exported by the subsystem namespace: reaching
// for it as `subsystems.CALL_TO_CHAOS_CHAIN_CAP` yields `undefined`, which silently disables every
// chain assertion below, so it is imported by name.
import { CALL_TO_CHAOS_CHAIN_CAP, createRng, effectiveCost, queryCost, subsystems } from "@jackioh/engine";
import type { CardInstance } from "@jackioh/engine";
import { cardDef } from "../src/catalog-data";
import { query } from "../src/query";
import { base as chaosBase, radiant as chaosRadiant } from "../src/scripts/095-call-to-chaos";
import { base as golemBase, radiant as golemRadiant } from "../src/scripts/095-1-chaos-golem";
import { scenario, type Scenario, type SideSetup } from "./_harness";

const CHAOS = "core-095"; // Spell, 4, Legendary, tag "Call to Chaos"
const GOLEM = "core-095-1"; // #95.1, Unit token, 10/10
const RUSH_TOKEN = "core-t-rush";

/** Fillers with known data: #19 is a 3-cost 9/9 Taunt Unit, #36 a 1-cost Spell, #53 a 3-cost Unit. */
const MENACE = "core-019";
const JAMMED = "core-036";
const RENO = "core-053";
/** A radiant #91 Fed Fauci is 2/12: the one enemy body that survives a 10-attack First Strike. */
const FAUCI = "core-091";
/** A radiant #19 is 18/18, which is lethal to a 10/10 whose Divine Shield is already spent. */
const BIG_MENACE = { def: MENACE, radiant: true } as const;

const SEED = "chaos-card";

/** §8.4's ten, by the names `subsystems.CHAOS_EFFECTS` files them under. */
type ChaosEffect = (typeof subsystems.CHAOS_EFFECTS)[number]["name"];

const CURSOR_SEARCH = 500;

/** What the engine's roll picks for (SEED, cursor); index 1 is the radiant pair's partner (R28). */
function rolledAt(cursor: number, radiantFace: boolean): ChaosEffect | undefined {
  const rolled = subsystems.rollChaosEffects(createRng(SEED, cursor), radiantFace);
  return rolled[radiantFace ? 1 : 0]?.name;
}

function cursorFor(effect: ChaosEffect, radiantFace = false): number {
  for (let cursor = 0; cursor < CURSOR_SEARCH; cursor += 1) {
    if (rolledAt(cursor, radiantFace) === effect) return cursor;
  }
  throw new Error(
    `no cursor below ${CURSOR_SEARCH} rolls "${effect}" from seed "${SEED}" ` +
      `(radiant face: ${String(radiantFace)})`,
  );
}

/**
 * p1 holds #95 and a spare card and has mana to spare, so §2.5's auto-end never fires under the
 * assertions: the spare is still affordable once the 4 is paid, which is a "meaningful" action.
 */
function side(extra: SideSetup = {}): SideSetup {
  return { hand: [CHAOS, MENACE], mana: 8, ...extra };
}

/** Play #95 with the roll pinned to `effect`. `chain` seeds R28's counter on the played card. */
function chaos(
  effect: ChaosEffect,
  opts: { p1?: SideSetup; p2?: SideSetup; radiantFace?: boolean; chain?: number } = {},
): Scenario {
  const radiantFace = opts.radiantFace === true;
  const p1 = opts.p1 ?? side();
  const hand = p1.hand ?? [CHAOS, MENACE];
  const s = scenario({
    seed: SEED,
    p1: {
      ...p1,
      hand: hand.map((entry) => (entry === CHAOS ? { def: CHAOS, radiant: radiantFace } : entry)),
    },
    ...(opts.p2 === undefined ? {} : { p2: opts.p2 }),
  });
  if (opts.chain !== undefined) s.card(CHAOS).memory[subsystems.CHAOS_CHAIN_KEY] = opts.chain;
  s.state.rngCursor = cursorFor(effect, radiantFace);
  return s.play(CHAOS);
}

function eventsOf<T extends GameEvent["type"]>(s: Scenario, type: T): Extract<GameEvent, { type: T }>[] {
  return s.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function unitsOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const found = s.unit(player, lane);
    return found === null ? [] : [found];
  });
}

function backrowOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const found = s.backrow(player, lane);
    return found === null ? [] : [found];
  });
}

function keywordsOf(s: Scenario, card: CardInstance): string[] {
  return s.stats(card).keywords.map((keyword) => keyword.kind);
}

/** How many times a #95 was played or cast: R70 makes a cast a play, so both emit `cardPlayed`. */
function chaosPlays(s: Scenario): Extract<GameEvent, { type: "cardPlayed" }>[] {
  return eventsOf(s, "cardPlayed").filter((event) => event.defId === CHAOS);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

// ---------------------------------------------------------------------------
// The card, its two faces and the fixture assumption.
// ---------------------------------------------------------------------------

describe("#95 Call to Chaos — the card", () => {
  it("§8.4 is a 4-cost Spell that resolves and reaches the graveyard (§10.5 step 7)", () => {
    const s = chaos("heal");
    s.expectInZone(CHAOS, "graveyard");
    s.expectMana("p1", 4); // 8 − 4
    expect(eventsOf(s, "cardPlayed")[0]?.costPaid).toBe(4);
  });

  it("§8.4 costs 4: it is uncastable on 3 mana", () => {
    const s = scenario({ seed: SEED, p1: { hand: [CHAOS], mana: 3 } });
    expect(() => s.play(CHAOS)).toThrow(/costs 4, more than your mana/);
  });

  it("§10.9 both faces hang the whole card off `cry`, and nothing else", () => {
    // §8.4's two cells differ only in how many effects are rolled, which is the subsystem's
    // argument; a second hook here would be a rule this card does not have.
    expect(Object.keys(chaosBase)).toEqual(["cry"]);
    expect(Object.keys(chaosRadiant)).toEqual(["cry"]);
  });

  it("§9.3 the roll is a pure function of (seed, cursor), so pinning the cursor pins the effect", () => {
    // The fixture assumption of this file, asserted rather than assumed: the roll is the play's
    // first rng draw, so `rolledAt(cursor)` is what the card does. Proved through the card with
    // the one effect nothing else can be mistaken for — the Chaos Golem is a token only #95 makes.
    const golemCursor = cursorFor("golem");
    const play = (): Scenario => {
      const s = scenario({ seed: SEED, p1: side() });
      s.state.rngCursor = golemCursor;
      return s.play(CHAOS);
    };
    expect(unitsOf(play(), "p1").map((unit) => unit.defId)).toEqual([GOLEM]);
    // …and the same seed and cursor replay to the same roll (R60, §9.3).
    expect(unitsOf(play(), "p1").map((unit) => unit.defId)).toEqual([GOLEM]);
  });

  it("R28 the base face rolls exactly ONE of the ten, and all ten are reachable", () => {
    const names = new Set<string>();
    for (let cursor = 0; cursor < CURSOR_SEARCH; cursor += 1) {
      const rolled = subsystems.rollChaosEffects(createRng(SEED, cursor), false);
      expect(rolled).toHaveLength(1);
      names.add(must(rolled[0], "a rolled effect").name);
    }
    expect(names.size).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// The ten effects of §8.4, in the order the card lists them.
// ---------------------------------------------------------------------------

describe("#95 Call to Chaos — base, the ten effects", () => {
  it("§8.4 1/10 summons 3 random 3-cost Units, into the leftmost free zones (R60, R64)", () => {
    const s = chaos("units");
    const summoned = eventsOf(s, "summoned");
    expect(summoned).toHaveLength(3);
    expect(summoned.map((event) => event.lane)).toEqual([1, 2, 3]);
    expect(summoned.every((event) => event.row === "units")).toBe(true);

    // The pool is the real catalog's 3-cost non-token Units, read per R65.
    const pool = query({ type: "Unit", cost: 3 }).map((def) => def.id);
    expect(pool.length).toBeGreaterThan(1);
    for (const unit of unitsOf(s, "p1")) {
      const def = cardDef(unit.defId);
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(false);
      expect(queryCost(def)).toBe(3);
      expect(pool).toContain(unit.defId);
    }
    // A summon is not a play: none of the three fired its Cry (R1).
    expect(eventsOf(s, "cardPlayed")).toHaveLength(1);
  });

  it("§8.4 2/10 heals your hero 30 and only yours, past 30 (§6.3 Heal has no hero cap)", () => {
    const hurt = chaos("heal", { p1: side({ health: 12 }), p2: { health: 12 } });
    hurt.expectHealth("p1", 42);
    hurt.expectHealth("p2", 12);
    expect(eventsOf(hurt, "healed")).toHaveLength(1);

    const full = chaos("heal");
    full.expectHealth("p1", 60);
  });

  it("§8.4 3/10 draws your whole library and gains 4 mana (R58)", () => {
    const s = chaos("draw", { p1: side({ library: [RENO, JAMMED, MENACE] }) });
    expect(s.pile("p1", "library")).toHaveLength(0);
    expect(s.hand("p1").map((card) => card.defId).sort()).toEqual(
      [MENACE, RENO, JAMMED, MENACE].sort(),
    );
    s.expectMana("p1", 8); // 8 − 4 paid + 4 gained
    expect(eventsOf(s, "drawn")).toHaveLength(3);
  });

  it("§8.4 3/10 on an empty library draws nothing and takes no fatigue (R3, R58)", () => {
    const s = chaos("draw");
    expect(eventsOf(s, "drawn")).toHaveLength(0);
    s.expectHealth("p1", 30);
    expect(s.state.players.p1.fatigueCount).toBe(0);
    s.expectMana("p1", 8);
  });

  it("§8.4 4/10 adds 3 random cards to hand, each costing 0 (R60, R65)", () => {
    const s = chaos("add");
    const added = eventsOf(s, "addedToHand");
    expect(added).toHaveLength(3);

    const fresh = s.hand("p1").filter((card) => added.some((event) => event.instanceId === card.id));
    expect(fresh).toHaveLength(3);
    for (const card of fresh) {
      // The 0 is a `costOverride` on the new instance (R65), and it is the price the play
      // validator reads — not merely a rider nothing consults.
      expect(card.costOverride).toBe(0);
      expect(effectiveCost(s.state, card)).toBe(0);
      expect(cardDef(card.defId).token).toBe(false);
    }
  });

  it("§8.4 5/10 makes every card in your hand Radiant and leaves an already-Radiant one alone", () => {
    const s = chaos("radiant", {
      p1: { hand: [CHAOS, MENACE, { def: RENO, radiant: true }], mana: 8 },
    });
    const hand = s.hand("p1");
    expect(hand).toHaveLength(2); // #95 left the hand to resolve
    expect(hand.every((card) => card.radiant)).toBe(true);
    // The already-Radiant #53 keeps its flag, which is never unset; both hand cards are cued all the
    // same, because a hidden card's cue must not depend on its face (R177, R97).
    expect(eventsOf(s, "radiantSet").map((event) => event.instanceId)).toEqual(hand.map((card) => card.id));
  });

  it("§8.4 6/10 summons five RADIANT Rush Tokens (§7's 6/6), not a bespoke 5/5", () => {
    const s = chaos("tokens");
    const tokens = unitsOf(s, "p1");
    expect(tokens.map((unit) => unit.defId)).toEqual(Array.from({ length: 5 }, () => RUSH_TOKEN));
    // §7: the printed token is 3/3 and its Radiant face is 6/6. #95 used to invent a 5/5 through
    // `statsOverride` — the only card in the set that chose its own Rush Token size — and now
    // summons the token's own Radiant face, so the stats live in the catalog and nowhere else.
    expect(cardDef(RUSH_TOKEN).base.attack).toBe(3);
    expect(cardDef(RUSH_TOKEN).radiant.attack).toBe(6);
    for (const token of tokens) {
      expect(token.radiant).toBe(true);
      expect(token.statsOverride, "no bespoke stats any more").toBeUndefined();
      s.expectStats(token, { attack: 6, health: 6, maxHealth: 6 });
      expect(keywordsOf(s, token)).toContain("Rush");
    }
  });

  it("§8.4 6/10 takes the zones that are free and fizzles the rest (R64)", () => {
    const s = chaos("tokens", { p1: side({ field: [MENACE, MENACE, MENACE] }) });
    expect(unitsOf(s, "p1").filter((unit) => unit.defId === RUSH_TOKEN)).toHaveLength(2);
    // The summons never reach across the board (§3.2).
    expect(unitsOf(s, "p2")).toHaveLength(0);
  });

  it("§8.4 7/10 makes every card in your hand and library cost 2 less, floored at 0 (R65, R78)", () => {
    const s = chaos("discount", {
      p1: { hand: [CHAOS, MENACE, JAMMED], library: [RENO], mana: 8 },
    });

    const menace = must(s.hand("p1").find((card) => card.defId === MENACE), "#19 in hand");
    const jammed = must(s.hand("p1").find((card) => card.defId === JAMMED), "#36 in hand");
    const reno = must(s.pile("p1", "library")[0], "#53 in the library");
    for (const card of [menace, jammed, reno]) expect(card.costMod).toBe(-2);

    // The price the validator reads: #19 costs 3 → 1, #36 costs 1 → 0 rather than −1 (R65's floor).
    expect(effectiveCost(s.state, menace)).toBe(1);
    expect(effectiveCost(s.state, jammed)).toBe(0);
    expect(effectiveCost(s.state, reno)).toBe(1);
    expect(eventsOf(s, "costChanged")).toHaveLength(3);
  });

  it("§8.4 7/10 is 'your hand and library': it changes those cards, not the player, not p2", () => {
    const s = chaos("discount", {
      p1: side({ library: [RENO] }),
      p2: { hand: [MENACE], library: [RENO] },
    });

    // Not the player: no `costDiscount` modifier is created, so a card that arrives later — a
    // draw, an add — pays full price. The −2 rides on the instances that were there (R78).
    expect(s.state.players.p1.mods.filter((mod) => mod.kind === "costDiscount")).toEqual([]);
    // …and the discount travels WITH the card it landed on, out of the library and into the hand.
    s.startTurn();
    const drawn = must(s.hand("p1").find((card) => card.defId === RENO), "the drawn #53");
    expect(drawn.costMod).toBe(-2);
    expect(effectiveCost(s.state, drawn)).toBe(1); // 3 − 2

    // "your hand and library": the opponent's cards are untouched.
    for (const card of [...s.hand("p2"), ...s.pile("p2", "library")]) {
      expect(card.costMod).toBe(0);
    }
  });

  it("§8.4 8/10 summons a Chaos Golem: §7's 10/10 token of index 95.1", () => {
    const s = chaos("golem");
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([GOLEM]);
    s.expectStats(GOLEM, { attack: 10, health: 10, maxHealth: 10 });
  });

  it("§8.4 9/10 summons 5 random Field Spells or Traps into your backrow, traps face-down (R33)", () => {
    const s = chaos("backrow");
    const summoned = eventsOf(s, "summoned");
    expect(summoned).toHaveLength(5);
    expect(summoned.every((event) => event.row === "backrow")).toBe(true);
    expect(summoned.map((event) => event.lane)).toEqual([1, 2, 3, 4, 5]);

    const placed = backrowOf(s, "p1");
    expect(placed).toHaveLength(5);
    for (const card of placed) {
      const def = cardDef(card.defId);
      // "Field Spells or Traps (Field Traps included)".
      expect(["Field Spell", "Trap", "Field Trap"]).toContain(def.type);
      // §3.2, R33: a Field Spell is public and a Trap or Field Trap is face-down.
      expect(card.faceUp === true).toBe(def.type === "Field Spell");
    }

    // §10.8: the opponent is told a face-down zone is occupied and nothing more.
    const asSeenByP2 = s.view("p2").opponent.backrow;
    placed.forEach((card, at) => {
      const seen = asSeenByP2[at];
      if (cardDef(card.defId).type === "Field Spell") {
        expect(seen).toMatchObject({ faceDown: false, defId: card.defId });
      } else {
        expect(seen).toEqual({ faceDown: true });
      }
    });
  });

  it("§8.4 10/10 casts a random Call to Chaos: free, counted as a play, its script run (R70)", () => {
    const s = chaos("recast");
    const plays = chaosPlays(s);
    expect(plays).toHaveLength(2);
    // R70: "a cast is free … with cost paid 0".
    expect(plays[0]?.costPaid).toBe(4);
    expect(plays[1]?.costPaid).toBe(0);
    // R70: "counts as a play for every rule that counts or reacts to plays".
    expect(s.state.counters.played).toBe(2);
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(2);
    expect(s.state.players.p1.turnLog.playedIds).toContain(plays[1]?.instanceId);

    // §5.1's exception: the pool for "a random Call to Chaos" includes #95 itself, and the card
    // cast is the BASE form however the caster was rolled (R28).
    const cast = s.card(must(plays[1], "the cast card's event").instanceId);
    expect(cast.defId).toBe(CHAOS);
    expect(cast.radiant).toBe(false);
    // It was the chain's first cast while it resolved, and it has landed as the printed card again
    // (R215): the chain's count stays with the chain, never with the card a graveyard holds.
    expect(cast.memory[subsystems.CHAOS_CHAIN_KEY]).toBeUndefined();

    // R87: a card cast from no zone goes to the caster's graveyard when it resolves, which is what
    // feeds Gravedigger and Reminisce down a long chain.
    s.expectInZone(cast, "graveyard");
    expect(s.pile("p1", "graveyard").filter((card) => card.defId === CHAOS)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// R4's hand cap and R28's chain cap.
// ---------------------------------------------------------------------------

describe("#95 Call to Chaos — the two caps", () => {
  it("R4 a full hand takes what it can and burns the rest", () => {
    // §2.4's cap is 10. The hand holds #95 plus nine others, so it is back to nine once #95 is
    // resolving: one of the three added cards fits and two are burned to the graveyard.
    const filler = Array.from({ length: 9 }, () => MENACE);
    const s = chaos("add", { p1: { hand: [CHAOS, ...filler], mana: 8 } });
    expect(s.hand("p1")).toHaveLength(10);
    expect(eventsOf(s, "addedToHand")).toHaveLength(1);
    expect(eventsOf(s, "burned")).toHaveLength(2);
  });

  it("R28 the chain is a hard stop: at the cap the recursion resolves into nothing", () => {
    const s = chaos("recast", { chain: CALL_TO_CHAOS_CHAIN_CAP });
    // The played card is already at the cap, so its roll of the recursion casts nothing at all —
    // and no substitute effect is rolled in its place (R87).
    expect(chaosPlays(s)).toHaveLength(1);
    expect(s.state.counters.played).toBe(1);
    s.expectInZone(CHAOS, "graveyard");
  });

  it("R28 one below the cap casts exactly one more, and that cast is the last", () => {
    const s = chaos("recast", { chain: CALL_TO_CHAOS_CHAIN_CAP - 1 });
    const plays = chaosPlays(s);
    expect(plays).toHaveLength(2);
    // The card it cast is AT the cap, so whatever that one rolled, it cast nothing further — the
    // two plays above are the whole chain — and it landed as the printed card again (R215).
    const cast = s.card(must(plays[1], "the cast card's event").instanceId);
    s.expectInZone(cast, "graveyard");
    expect(cast.memory[subsystems.CHAOS_CHAIN_KEY]).toBeUndefined();
  });

  it("R28 the counter is instance state, so two Calls in one turn do not share it", () => {
    const s = chaos("recast", { p1: { hand: [CHAOS, CHAOS], mana: 8 } });
    expect(chaosPlays(s)).toHaveLength(2);
    // The second copy still carries no counter: nothing global was spent on the first chain.
    const second = must(s.hand("p1")[0], "the second #95");
    expect(second.defId).toBe(CHAOS);
    expect(second.memory[subsystems.CHAOS_CHAIN_KEY]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The radiant face (§8.4: "Two random effects").
// ---------------------------------------------------------------------------

describe("#95 Call to Chaos — radiant", () => {
  it("R28 rolls the recursion plus one of the other 9, the recursion never doubled", () => {
    // The played card sits one below the cap, so the guaranteed recursion casts exactly one card
    // and that card can cast nothing further. The #95 play count is then 1 + the number of
    // recursions the radiant roll produced, which pins "guaranteed and never doubled" as a number.
    const partners = new Set<string>();
    for (let cursor = 0; cursor < 40; cursor += 1) {
      const s = scenario({
        seed: SEED,
        p1: { hand: [{ def: CHAOS, radiant: true }, MENACE], mana: 8 },
      });
      s.card(CHAOS).memory[subsystems.CHAOS_CHAIN_KEY] = CALL_TO_CHAOS_CHAIN_CAP - 1;
      s.state.rngCursor = cursor;
      s.play(CHAOS);
      expect(chaosPlays(s)).toHaveLength(2);
      partners.add(String(rolledAt(cursor, true)));
    }
    expect(partners.has("recast")).toBe(false);
    expect(partners.size).toBeGreaterThan(1);
  });

  it("R87 resolves the recursion first, so its whole chain is done before the partner reads", () => {
    const s = chaos("golem", {
      radiantFace: true,
      chain: CALL_TO_CHAOS_CHAIN_CAP - 1,
    });
    const cast = must(chaosPlays(s)[1], "the cast #95");
    const castAt = s.events.indexOf(cast);
    const golemAt = s.events.findIndex((event) => event.type === "summoned" && event.defId === GOLEM);
    expect(castAt).toBeGreaterThanOrEqual(0);
    expect(golemAt).toBeGreaterThan(castAt);
  });

  it("R28 at the cap a radiant Call runs only its partner", () => {
    const s = chaos("golem", { radiantFace: true, chain: CALL_TO_CHAOS_CHAIN_CAP });
    expect(chaosPlays(s)).toHaveLength(1);
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([GOLEM]);
  });

  it("§5.2 a base copy gets no guaranteed recursion, however deep the chain is", () => {
    // Both faces call the same subsystem; the `radiant` argument each face passes is the whole
    // difference, which is why the base face can roll any single one of the ten.
    const s = chaos("heal", { chain: CALL_TO_CHAOS_CHAIN_CAP - 1 });
    expect(chaosPlays(s)).toHaveLength(1);
    s.expectHealth("p1", 60);
  });
});

// ---------------------------------------------------------------------------
// #95.1 Chaos Golem (§8.4, §7, R11).
// ---------------------------------------------------------------------------

describe("#95.1 Chaos Golem", () => {
  it("§7 is a 10/10 with all four keywords, on both faces (§8: no radiant form)", () => {
    const s = scenario({
      p1: { field: [GOLEM], hand: [MENACE] },
      p2: { field: [{ def: GOLEM, radiant: true }] },
    });
    for (const player of ["p1", "p2"] as const) {
      const golem = must(s.unit(player, 1), `${player}'s Chaos Golem`);
      s.expectStats(golem, { attack: 10, health: 10, maxHealth: 10 });
      expect(keywordsOf(s, golem).sort()).toEqual(
        ["Divine Shield", "First Strike", "Lifesteal", "Rush"].sort(),
      );
    }
    // §8: "No radiant form" — the radiant script IS the base script and the catalog prints the same
    // face twice, so a Radiant Chaos Golem differs by the §5.2 flag alone. There is no script at
    // all: §10.4 layer 1 reads the stats and the four keywords straight off the def.
    expect(golemRadiant).toBe(golemBase);
    expect(golemBase).toEqual({});
    expect(cardDef(GOLEM).radiant).toEqual(cardDef(GOLEM).base);
  });

  it("§6.1 Rush: the turn it arrives it may attack a unit but not the hero", () => {
    const s = chaos("golem", { p2: { field: [MENACE] } });
    const golem = must(s.unit("p1", 1), "the summoned Chaos Golem");
    expect(golem.defId).toBe(GOLEM);

    expect(() => s.attack(golem, "hero")).toThrow();
    const victim = must(s.unit("p2", 1), "the enemy #19");
    s.attack(golem, victim);
    // §4.3: #19 is 9/9, so First Strike kills it before it strikes back and the shield is intact.
    s.expectInZone(victim, "graveyard");
    expect(s.card(golem).divineShieldSpent).toBeUndefined();
    s.expectStats(golem, { health: 10 });
  });

  it("§4.4 step 1 Divine Shield negates the whole first hit and is spent", () => {
    // A radiant #91 Fed Fauci is 2/12, the one enemy body that survives a 10-attack First Strike
    // and so gets to strike back into the shield.
    const s = scenario({
      p1: { field: [GOLEM], hand: [MENACE], health: 15 },
      p2: { field: [{ def: FAUCI, radiant: true }] },
    });
    const golem = must(s.unit("p1", 1), "the Golem");
    const fauci = must(s.unit("p2", 1), "the radiant #91");

    s.attack(golem, fauci);
    s.expectStats(fauci, { health: 2 }); // 12 − 10
    s.expectStats(golem, { health: 10 }); // the 2 back was negated whole
    expect(s.card(golem).divineShieldSpent).toBe(true);
    expect(keywordsOf(s, s.card(golem))).not.toContain("Divine Shield");
    expect(eventsOf(s, "divineShieldLost")).toHaveLength(1);
  });

  it("§4.4 step 8 Lifesteal heals its controller's hero by the amount dealt", () => {
    const s = scenario({ p1: { field: [GOLEM], hand: [MENACE], health: 15 }, p2: { health: 30 } });
    const golem = must(s.unit("p1", 1), "the Golem");

    s.attack(golem, "hero");
    s.expectHealth("p2", 20); // 30 − 10
    s.expectHealth("p1", 25); // 15 + the 10 dealt
    expect(eventsOf(s, "healed")).toHaveLength(1);
  });

  it("R11 it is a unit token: dying is ceasing to exist, with no graveyard and no card to eat", () => {
    // `divineShieldSpent` is the state one hit leaves behind (§4.4 step 1), set here so a single
    // exchange can be lethal; a radiant #19 is 18/18, which kills an unshielded 10/10.
    const s = scenario({
      p1: { field: [GOLEM], hand: [MENACE] },
      p2: { field: [BIG_MENACE] },
    });
    const golem = must(s.unit("p1", 1), "the Golem");
    s.card(golem).divineShieldSpent = true;
    expect(cardDef(GOLEM).token).toBe(true);

    s.attack(golem, must(s.unit("p2", 1), "the radiant #19"));
    // §3.2, R11: it never enters a graveyard, so #89 Corpse Eater can never feed on one either.
    s.expectInZone(golem, "gone");
    expect(s.pile("p1", "graveyard").some((card) => card.defId === GOLEM)).toBe(false);
    expect(s.pile("p1", "exile").some((card) => card.defId === GOLEM)).toBe(false);
  });

  it("§5.1 it is a token, so no random pool and no Discover can reach it", () => {
    expect(query({}).map((def) => def.id)).not.toContain(GOLEM);
    expect(query({ type: "Unit" }).map((def) => def.id)).not.toContain(GOLEM);
    // …which is what makes #99 Craft a Card unable to craft one.
    expect(query({ type: "Unit", cost: 4 }).map((def) => def.id)).not.toContain(GOLEM);
  });
});

describe("#95's printed text (round 10 of the polish-4 edge-case hunt)", () => {
  it("names the Radiant Rush Tokens it summons, not the 5/5s issue #1 took out (§8.4 #95, §7)", () => {
    // §8.4 #95's base effect: "summon five Radiant Rush Tokens", and §7: "Call to Chaos is NOT one
    // of these any more: it summons the token's own Radiant face (6/6) rather than a bespoke 5/5".
    // The engine does that ("6/10 summons five RADIANT Rush Tokens" above), and the catalog's
    // printed text — what apps/web's Card and Prompt render for the card — says so too.
    const text = cardDef(CHAOS).base.text;
    expect(text).not.toMatch(/5\/5/);
    expect(text).toMatch(/five Radiant Rush Tokens/);
  });
});
