// Tribute as an additional cost of playing a card (SPEC §6.3's Tribute row, §3.2, §10.5 steps 1-2,
// R81, R41).
//
// §6.3: "Tribute X | As an additional cost of playing a card, sacrifice X of your units; a card
// whose own text tributes (Carnivorous Cube) sacrifices what that text names instead, which may be
// any of your other permanents, backrow included (R41) | The play-time cost is the play validator's,
// and the choice travels in the play action (R81); the Sheep Token counts as 2 toward that X while
// it is on the field (§3.2), and Lava Golem may pick enemy units. A tribute written into a card's
// script is an ordinary Sacrifice of the permanent that script names, where the Sheep Token's 2
// never applies".
//
// §3.2: "Sheep Tokens are worth 2 Tributes while on the field." §10.5: step 1 validates "Tribute
// available", step 2 pays "mana, Tributes (sacrifice)". The declared cost is `staticFlags.tribute`
// in `src/script.ts`; the channel is `tributes?: string[]` on the `play` action in
// `packages/shared/src/actions.ts`.
//
// Fixtures are prefixed `tb-` and indexed above 1550 so they cannot collide (BUILD §0). The Sheep
// carries index `T-sheep`, which is what `playChoices.ts`'s `SHEEP_TOKEN_INDEX` reads.

import type { Action, ActionInput, CardDef, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH } from "../src/config";
import { damage, sacrifice } from "../src/effects";
import {
  SHEEP_TOKEN_INDEX,
  legalTributeSets,
  legalTributeUnits,
  tributeCostOf,
  tributeValueOf,
  whyChoicesRefused,
} from "../src/playChoices";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { applyEffects, makeContext } from "../src/resolve";
import type { CardScripts, Script, StaticFlags } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { activeUnitsOf } from "../src/zones";
import { plain } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 1550;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `tb-${name}`,
    index: String(nextIndex),
    name: `${name} (tribute)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function unit(name: string, attack = 3, health = 3, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack, health, keywords: [], text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords: [], text: name },
    ...extra,
  });
}

/**
 * §7's Sheep Token, the one unit "worth 2 Tributes while on the field" (§3.2). Its `index` is
 * `T-sheep`, which is how the engine recognises it; being a unit token it also ceases to exist when
 * it leaves the field rather than reaching a graveyard (R11).
 */
const sheep = unit("sheep", 1, 1, {
  index: SHEEP_TOKEN_INDEX,
  tags: ["Token"],
  rarity: "Token",
  token: true,
  cost: 1,
});

/** #66 The Rock's shape: Tribute 1 on a big body. */
const tributeOne = unit("tribute-one", 10, 10, { cost: 4 });
/** Tribute 2, the cost one Sheep alone can pay (§3.2). */
const tributeTwo = unit("tribute-two", 8, 8, { cost: 3 });
/** #55 Lava Golem's shape: Tribute 3 that may pick enemy units. */
const lavaGolem = unit("lava-golem", 10, 5, { cost: 3 });
/** A body with a Death hook, so "the tribute counts as a death" is observable (§6.3 Sacrifice). */
const deathPinger = unit("death-pinger", 2, 2);
/** #22 Carnivorous Cube's shape: its own text tributes a permanent, so no Tribute cost (R41). */
const cube = unit("cube", 4, 6, { cost: 3 });
/** A backrow permanent for the Cube to eat, which a Tribute X may never take (§6.3, R41). */
const fieldCard = def("field-card", "Field Spell");

const DEFS = [sheep, tributeOne, tributeTwo, lavaGolem, deathPinger, cube, fieldCard];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

/**
 * #55 "may tribute enemy units". `src/script.ts`'s `StaticFlags` does not declare the flag yet —
 * `src/playChoices.ts` reads it structurally and says so in a comment — so the fixture asserts the
 * shape the engine reads.
 */
const lavaGolemFlags = { tribute: 3, tributeEnemies: true } as StaticFlags;

const SCRIPTS: Record<string, CardScripts> = {
  [tributeOne.id]: both({ staticFlags: { tribute: 1 } }),
  [tributeTwo.id]: both({ staticFlags: { tribute: 2 } }),
  [lavaGolem.id]: both({ staticFlags: lavaGolemFlags }),
  [deathPinger.id]: both({ death: () => [damage({ to: { of: "enemyHero" }, amount: 3 })] }),
  // #22: the Cube's own text names what it sacrifices, so the choice is a target, not a Tribute.
  [cube.id]: both({
    targets: [
      {
        kind: "target",
        min: 1,
        max: 1,
        filter: { side: "ally", of: ["unit", "backrow"], excludeSelf: true },
      },
    ],
    cry: () => [sacrifice({ target: { of: "chosen" } })],
  }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `tb${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = actResult(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in p1's main phase, with this file's fixtures registered and 4 mana. */
function playing(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
  return state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

function handCard(state: GameState, defId: string, player: PlayerId = "p1"): CardInstance {
  return only(inHand(state, defId, player));
}

function unitIds(state: GameState, player: PlayerId): string[] {
  return activeUnitsOf(state, player).map((card) => card.id);
}

// ---------------------------------------------------------------------------

describe("Tribute as an additional cost of a play (§6.3, §3.2, R81)", () => {
  it("§6.3 refuses a play whose tributes fall short of its Tribute X, and refuses a board that cannot pay", () => {
    const state = playing("tribute-short");
    const card = handCard(state, tributeTwo.id);
    expect(tributeCostOf(card)).toBe(2);

    const play = (tributes: string[]): string | null =>
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        zone: { row: "units", lane: 3 },
        tributes,
      });

    // An empty board cannot pay Tribute 2 at all, so the play is refused outright (§10.5 step 1).
    expect(play([])).toMatch(/needs Tribute 2/);

    // One body pays 1 of the 2, so the board still cannot pay: that is the refusal, whatever the
    // play named.
    const one = put(state, plain.id, slot("p1", "units", 1));
    expect(play([])).toMatch(/needs Tribute 2/);
    expect(play([one.id])).toMatch(/needs Tribute 2/);

    const two = put(state, plain.id, slot("p1", "units", 2));
    expect(play([one.id, two.id])).toBeNull();
    expect(play([one.id])).toMatch(/needs Tribute 2/);
    // Naming one unit twice is one unit, not two: a Tribute sacrifices X separate units (§6.3).
    expect(play([one.id, one.id])).toMatch(/same unit twice/);
    // The cost is exact: a third unit is not "sacrifice X of your units".
    const three = put(state, plain.id, slot("p1", "units", 4));
    expect(play([one.id, two.id, three.id])).toMatch(/tributes 2, no more/);
    // And a unit the chooser does not control is not theirs to tribute.
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    expect(play([one.id, theirs.id])).toMatch(/cannot be tributed/);

    // A card with no Tribute cost takes no tributes at all (R90's "declared nothing" reading).
    const free = handCard(state, deathPinger.id);
    expect(tributeCostOf(free)).toBe(0);
    expect(
      whyChoicesRefused(state, "p1", free, {
        type: "play",
        instanceId: free.id,
        zone: { row: "units", lane: 5 },
        tributes: [one.id],
      }),
    ).toMatch(/needs no Tribute/);
  });

  it("§3.2 a Sheep Token counts 2 toward a Tribute cost, so one Sheep alone pays Tribute 2", () => {
    const state = playing("sheep-counts-two");
    const woolly = put(state, sheep.id, slot("p1", "units", 1));
    const ordinary = put(state, plain.id, slot("p1", "units", 2));

    expect(tributeValueOf(state, woolly)).toBe(2);
    expect(tributeValueOf(state, ordinary)).toBe(1);

    const card = handCard(state, tributeTwo.id);
    const play = (tributes: string[]): string | null =>
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        zone: { row: "units", lane: 3 },
        tributes,
      });

    // One Sheep is enough; the Sheep plus a body overpays, and an ordinary body alone underpays.
    expect(play([woolly.id])).toBeNull();
    expect(play([ordinary.id])).toMatch(/needs Tribute 2/);
    expect(play([woolly.id, ordinary.id])).toMatch(/tributes 2, no more/);

    // The enumeration says the same thing: the Sheep pays on its own, or two bodies together.
    const sets = legalTributeSets(state, "p1", card);
    expect(sets).toContainEqual([woolly.id]);
    expect(sets).not.toContainEqual([ordinary.id]);
    const third = put(state, plain.id, slot("p1", "units", 4));
    expect(legalTributeSets(state, "p1", card)).toContainEqual([ordinary.id, third.id]);

    // Tribute 1 takes the Sheep too — 2 is worth "at least 1", and nothing smaller exists (§3.2).
    const cheap = handCard(state, tributeOne.id);
    expect(
      whyChoicesRefused(state, "p1", cheap, {
        type: "play",
        instanceId: cheap.id,
        zone: { row: "units", lane: 5 },
        tributes: [woolly.id],
      }),
    ).toBeNull();
  });

  it("§6.3 sacrifices the tributed units, which counts as a death, rather than destroying them", () => {
    // The primitive first: §6.3's Tribute row pays with a Sacrifice, and Sacrifice "counts as a
    // death" — the destroyed counter, the `destroyed` event and the Death trigger (R78).
    const direct = playing("tribute-sacrifice-primitive");
    const doomed = put(direct, deathPinger.id, slot("p1", "units", 1));
    const sink = sinkFor(direct);
    const ctx = makeContext(sink, null, {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: doomed.id }],
    });
    const before = direct.counters.destroyed;
    applyEffects([sacrifice({ target: { of: "chosen" } })], ctx);
    expect(direct.counters.destroyed).toBe(before + 1);
    expect(eventsOfType(sink.events, "destroyed").map((event) => event.instanceId)).toEqual([doomed.id]);
    expect(direct.players.p1.graveyard.some((card) => card.id === doomed.id)).toBe(true);
    expect(direct.players.p2.hero.health).toBe(HERO_HEALTH - 3); // its Death hook fired

    // And the play pays the same way: the tributed unit is sacrificed at §10.5 step 2, not marked
    // destroyed for the next state check (§6.3 Destroy vs Sacrifice).
    const state = playing("tribute-sacrifice-play");
    const food = put(state, deathPinger.id, slot("p1", "units", 1));
    const card = handCard(state, tributeOne.id);
    const played = actResult(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      zone: { row: "units", lane: 2 },
      tributes: [food.id],
    });
    expect(played.error).toBeUndefined();
    expect(unitIds(played.state, "p1")).toEqual([card.id]);
    expect(played.state.players.p1.graveyard.some((held) => held.id === food.id)).toBe(true);
    expect(played.state.counters.destroyed).toBe(state.counters.destroyed + 1);
    expect(eventsOfType(played.events, "destroyed").map((event) => event.instanceId)).toEqual([food.id]);
    // A Sacrifice is immediate, so nothing is left marked for the state check to collect.
    expect(played.state.players.p1.units.flatMap((pile) => pile ?? []).some((c) => c.markedDestroyed === true))
      .toBe(false);
    // "Counts as a death", so the Death hook ran.
    expect(played.state.players.p2.hero.health).toBe(HERO_HEALTH - 3);
  });

  it("R81 carries the Tribute choice in the play action's tributes and never opens a prompt for it", () => {
    const state = playing("tribute-travels");
    const a = put(state, plain.id, slot("p1", "units", 1));
    const b = put(state, plain.id, slot("p1", "units", 2));
    const card = handCard(state, tributeTwo.id);

    // Every way to pay is enumerable ahead of the play, which is what "travels in the action" needs.
    expect(legalTributeSets(state, "p1", card)).toEqual([[a.id, b.id]]);

    const plays = legalActions(state, "p1").filter(
      (action) => action.type === "play" && action.instanceId === card.id,
    );
    expect(plays.length).toBeGreaterThan(0);
    for (const play of plays) {
      if (play.type !== "play") continue;
      expect(play.tributes).toEqual([a.id, b.id]);
      expect(whyChoicesRefused(state, "p1", card, play)).toBeNull();
    }

    // §10.6: "No Core card opens an `x`, `embiggen`, `zone`, `tribute` or `direction` prompt".
    const played = actResult(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      zone: { row: "units", lane: 3 },
      tributes: [a.id, b.id],
    });
    expect(played.error).toBeUndefined();
    expect(played.state.pending).toBeNull();
    expect(played.events.some((event) => event.type === "promptOpened")).toBe(false);
    expect(unitIds(played.state, "p1")).toEqual([card.id]);
  });

  it("§6.3 treats a tribute a card's script writes as an ordinary Sacrifice, where the Sheep's 2 never applies (R41)", () => {
    const state = playing("script-tribute");
    const woolly = put(state, sheep.id, slot("p1", "units", 1));
    const backrow = put(state, fieldCard.id, slot("p1", "backrow", 1));
    const card = handCard(state, cube.id);

    // #22 declares no Tribute cost: what it sacrifices is named by its own text, so the play carries
    // a target, not a tribute, and a `tributes` list is refused.
    expect(tributeCostOf(card)).toBe(0);
    expect(
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        zone: { row: "units", lane: 2 },
        tributes: [woolly.id],
        targets: [{ pick: "instance", instanceId: woolly.id }],
      }),
    ).toMatch(/needs no Tribute/);

    // R41: the script's reach is "any of your other permanents, backrow included", which a Tribute X
    // never offers — that cost is "X of your units".
    expect(legalTributeUnits(state, "p1", handCard(state, tributeOne.id)).map((u) => u.id)).toEqual([
      woolly.id,
    ]);
    const played = actResult(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      zone: { row: "units", lane: 2 },
      targets: [{ pick: "instance", instanceId: backrow.id }],
    });
    expect(played.error).toBeUndefined();
    expect(played.state.players.p1.backrow[0]).toBeNull();
    expect(played.state.counters.destroyed).toBe(state.counters.destroyed + 1);

    // And aimed at the Sheep it takes exactly one permanent: the Sheep's 2 is a Tribute value only,
    // so a script Sacrifice can never get two permanents' worth out of one Sheep (§6.3).
    const onSheep = playing("script-tribute-sheep");
    const woolly2 = put(onSheep, sheep.id, slot("p1", "units", 1));
    const other = put(onSheep, plain.id, slot("p1", "units", 2));
    const cube2 = handCard(onSheep, cube.id);
    const eaten = actResult(onSheep, {
      type: "play",
      instanceId: cube2.id,
      playerId: "p1",
      zone: { row: "units", lane: 3 },
      targets: [{ pick: "instance", instanceId: woolly2.id }],
    });
    expect(eaten.error).toBeUndefined();
    expect(eaten.state.counters.destroyed).toBe(onSheep.counters.destroyed + 1);
    // R11: a unit token ceases to exist instead of reaching a graveyard, and the other unit stays.
    expect(eaten.state.players.p1.graveyard.some((held) => held.id === woolly2.id)).toBe(false);
    expect(unitIds(eaten.state, "p1")).toEqual([other.id, cube2.id]);
  });

  it("§8 #55 counts both sides for a Tribute that may pick enemy units, where a Sheep is still 2", () => {
    const state = playing("lava-golem");
    const mine = put(state, plain.id, slot("p1", "units", 1));
    const theirSheep = put(state, sheep.id, slot("p2", "units", 1));
    const theirBody = put(state, plain.id, slot("p2", "units", 2));
    const card = handCard(state, lavaGolem.id);
    expect(tributeCostOf(card)).toBe(3);

    // The validator counts both sides' units for #55, and the enemy Sheep is worth 2 there too.
    const offered = legalTributeUnits(state, "p1", card).map((u) => u.id);
    expect(offered).toEqual([mine.id, theirSheep.id, theirBody.id]);

    const play = (tributes: string[]): string | null =>
      whyChoicesRefused(state, "p1", card, {
        type: "play",
        instanceId: card.id,
        zone: { row: "units", lane: 2 },
        tributes,
      });

    expect(play([mine.id, theirSheep.id])).toBeNull(); // 1 + 2 = 3
    expect(play([mine.id, theirBody.id])).toMatch(/needs Tribute 3/); // 1 + 1 = 2
    expect(play([theirSheep.id, theirBody.id])).toBeNull(); // 2 + 1 = 3, all enemy
    expect(legalTributeSets(state, "p1", card)).toContainEqual([mine.id, theirSheep.id]);

    // Every other Tribute card stays on its own side (§6.3: "X of *your* units").
    const ordinary = handCard(state, tributeTwo.id);
    expect(legalTributeUnits(state, "p1", ordinary).map((u) => u.id)).toEqual([mine.id]);
  });
});
