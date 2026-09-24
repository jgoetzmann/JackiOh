// What a play may choose, what its choices then do, and what `legalActions` offers (SPEC §2.5, §8
// Conventions, §10.2, R43, R81, R90, R102, R151, R211). Found by the polish-4 edge-case hunt,
// round 2 (docs/polish/4-edge-cases.md, lenses L7 and L9); every case here failed before its fix.
//
// The agreement between `legalActions` and `reduce` held across seeded random-policy games and
// millions of mutated candidate actions. What failed is below: a power SPEC makes usable that neither
// side offered, choices a fused card was offered and then ignored, a mode SPEC's conventions require
// a target for that could name none, and a concede `reduce` accepts while a prompt is open that
// `legalActions` did not list.
//
// Round 9, lens "legality agreement": the bound on `legalActions`' enumeration dropped whole picks —
// a Lava Golem's all-enemy Tribute, a crafted card's first declaration's later picks — so the client,
// which builds a play only out of the plays listed (CLAUDE.md rule 7), could not make them. A Tribute's
// sets are listed whole and a cut keeps every pick of every declaration (R90, amended).

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, GameEvent, PlayerId } from "@jackioh/shared";
import {
  legalActions,
  reduce,
  subsystems,
  type CardInstance,
  type GameState,
  createRng,
  type EngineSink,
} from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";

const MR_VANILLA = "core-008";
const HIT_JOB = "core-016";
const MIDRANGE_MENACE = "core-019";
const CARNIVOROUS_CUBE = "core-022";
const EFFICIENCY_DIVIDEND = "core-024";
const ARCHIVIST = "core-030";
const PREM_PANTHER = "core-032";
const RENO = "core-053";
const SILLY_SILAS = "core-052";
const BIGOT = "core-002";
const TWISTED_SORCERER = "core-068";
const HEROIC_POWER = "core-098";
const CRAFT_A_CARD = "core-099";
const KYS_TUTOR = "core-051";

type PlayAction = Extract<ActionBody, { type: "play" }>;

let nonce = 0;
function act(state: GameState, body: ActionBody & { playerId: PlayerId }): { state: GameState; events: GameEvent[]; error?: string } {
  nonce += 1;
  return reduce(state, { ...body, nonce: `play-choices-${nonce}` } as Action);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function playsOf(state: GameState, card: CardInstance): PlayAction[] {
  return legalActions(state, card.controller).filter(
    (action): action is PlayAction => action.type === "play" && action.instanceId === card.id,
  );
}

describe("R43, R151: a Heroic Power created on the field rolls its power", () => {
  it("R151 Heroic Power copies Carnivorous Cube's Death summons roll a power, so activatePower is offered and accepted for them (R43)", () => {
    // R43: "one created later rolls when it is created"; R151: it rolls "as it arrives anywhere a
    // card can be looked at". The Cube eats a Heroic Power and its Death summons two fresh copies
    // straight into the backrow — never through a hand or a library, the only arrivals that roll.
    const g = scenario({
      p1: { hand: [CARNIVOROUS_CUBE, HIT_JOB, RENO], backrow: [HEROIC_POWER], mana: 10 },
      p2: { hand: [RENO] },
    });
    const eaten = must(g.backrow("p1", 1), "p1's Heroic Power");
    // Every Heroic Power in a real game has rolled by the time it is on the field (R43).
    eaten.memory[subsystems.POWER_KEY] = "burn";

    g.play(CARNIVOROUS_CUBE, { targets: [{ pick: "instance", instanceId: eaten.id }] });
    const cube = must(g.unit("p1", 1), "the Cube");
    g.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: cube.id }] });

    const copies = [1, 2, 3, 4, 5]
      .map((lane) => g.backrow("p1", lane))
      .filter((card): card is CardInstance => card !== null && card.defId === HEROIC_POWER);
    expect(copies).toHaveLength(2);
    expect(g.state.players.p1.mana.current).toBe(5); // 10 − 3 (Cube) − 2 (Hit Job): any power's X fits

    const offered = legalActions(g.state, "p1")
      .filter((action) => action.type === "activatePower")
      .map((action) => (action.type === "activatePower" ? action.instanceId : ""));
    expect(offered.sort()).toEqual(copies.map((copy) => copy.id).sort());

    const first = must(copies[0], "the first copy");
    const used = act(g.state, { type: "activatePower", playerId: "p1", instanceId: first.id });
    expect(used.error).toBeUndefined();
  });
});

describe("R90, R102: a fused card's declarations each read their own slice of the play's choices", () => {
  // Craft a Card fuses two Discovered Units into one hand card whose declared targets and modes are
  // the ingredients' lists concatenated in ingredient order (R102), so `legalActions` offers — and
  // `reduce` validates — one flat list read declaration by declaration (R90). The fused Cry used to
  // hand the whole list to every ingredient, and each ingredient read its first slot, so every
  // choice after the first was offered, accepted and then ignored.

  it("R102 a crafted Bigot + Twisted Sorcerer destroys Bigot's target and deals the Sorcerer's 4 to the Sorcerer's own target (R90)", () => {
    const g = scenario({
      seed: "craft-17", // the first Discover offers Bigot, the second Twisted Sorcerer
      p1: { hand: [CRAFT_A_CARD, RENO], mana: 4 },
      p2: { hand: [RENO], field: [PREM_PANTHER] },
    });
    g.play(CRAFT_A_CARD);
    g.answer(BIGOT);
    g.answer(TWISTED_SORCERER);
    const crafted = must(g.hand("p1").find((card) => card.defId.startsWith("t-")), "the crafted card");
    const panther = must(g.unit("p2", 1), "p2's Prem Panther (not a Human)");

    // Bigot's declaration first, the Sorcerer's second: both targets travel in the one play.
    const choice = [
      { pick: "instance" as const, instanceId: panther.id },
      { pick: "hero" as const, player: "p2" as const },
    ];
    expect(playsOf(g.state, crafted).some((play) => JSON.stringify(play.targets) === JSON.stringify(choice))).toBe(true);

    g.play(crafted, { zone: 2, targets: choice });

    const sorcererHit = g.lastEvents.find((event) => event.type === "damage");
    expect({
      panther: g.card(panther).zone.z,
      sorcererHit: sorcererHit !== undefined && sorcererHit.type === "damage" ? sorcererHit.targetId : null,
      p2Health: g.state.players.p2.hero.health,
    }).toEqual({ panther: "graveyard", sorcererHit: "hero-p2", p2Health: 26 });
  });

  it("R102 a crafted Archivist + Silly Silas draws by Archivist's mode and rotates by Silas's direction (R81, R90)", () => {
    const g = scenario({
      seed: "craft-76", // the first Discover offers Archivist, the second Silly Silas
      p1: { hand: [CRAFT_A_CARD, RENO], mana: 4, library: [MR_VANILLA, MIDRANGE_MENACE, MR_VANILLA] },
      p2: { hand: [RENO], field: [MR_VANILLA] },
    });
    g.play(CRAFT_A_CARD);
    g.answer(ARCHIVIST);
    g.answer(SILLY_SILAS);
    const crafted = must(g.hand("p1").find((card) => card.defId.startsWith("t-")), "the crafted card");
    const theirs = must(g.unit("p2", 1), "p2's Mr. Vanilla");

    // Archivist's declaration first, Silas's second: "highest", then "right".
    expect(
      playsOf(g.state, crafted).some((play) => JSON.stringify(play.modes) === JSON.stringify(["highest", "right"])),
    ).toBe(true);

    g.play(crafted, { zone: 2, modes: ["highest", "right"] });

    // Rotating right moves the crafted card from lane 2 to lane 3, and p2's lane-1 card, the last
    // step of the ring, onto p1's lane 1 (§3.1).
    expect({
      rotated: g.lastEvents.some((event) => event.type === "rotated"),
      craftedLane3: g.unit("p1", 3)?.id ?? null,
      theirsNowControlledBy: g.card(theirs).controller,
      hand: g.hand("p1").map((card) => card.defId),
    }).toEqual({ rotated: true, craftedLane3: crafted.id, theirsNowControlledBy: "p1", hand: [RENO, MIDRANGE_MENACE] });
  });
});

describe("§8 Conventions, R90: a mode that deals damage or heals needs its target", () => {
  it("R90 Efficiency Dividend's damage and heal modes are never offered or accepted without a target while one exists, and its mana mode names none (§8 Conventions)", () => {
    // §8: "target" means the player picks from all legal units and heroes, and only a target SET that
    // is empty lets the Cry fizzle; R90: "a declaration the board cannot satisfy does not refuse the
    // play". A hero is always a legal target, so "deal X damage to a target" and "heal a target 2X"
    // can always be satisfied. The card used to declare its target `min: 0` for the sake of the mana
    // mode, which let a damage or heal play name nobody and pay its X for nothing.
    const g = scenario({
      p1: { hand: [EFFICIENCY_DIVIDEND, RENO], mana: 4 },
      p2: { hand: [RENO], field: [MR_VANILLA] },
    });
    const dividend = must(g.hand("p1")[0], "Efficiency Dividend");

    const untargeted = playsOf(g.state, dividend).filter(
      (play) => (play.modes ?? [])[0] !== "mana" && (play.targets ?? []).length === 0,
    );
    expect(untargeted).toEqual([]);

    const refused = act(g.state, {
      type: "play",
      playerId: "p1",
      instanceId: dividend.id,
      x: 3,
      modes: ["damage"],
      targets: [],
    });
    expect(refused.error).toBeDefined();

    // The mana mode names no target at all: it is offered without one, and refused with one.
    const mana = playsOf(g.state, dividend).filter((play) => (play.modes ?? [])[0] === "mana");
    expect(mana.length).toBeGreaterThan(0);
    expect(mana.every((play) => (play.targets ?? []).length === 0)).toBe(true);
    const aimed = act(g.state, {
      type: "play",
      playerId: "p1",
      instanceId: dividend.id,
      x: 2,
      modes: ["mana"],
      targets: [{ pick: "hero", player: "p2" }],
    });
    expect(aimed.error).toBeDefined();
  });
});

describe("R211: concede is on offer while a prompt is open", () => {
  it("R211 legalActions offers concede to both players while a prompt is open, as reduce accepts it (§2.5, §10.2)", () => {
    // KY's Private Tutor opens a type prompt for p1. reduce accepts a concede from either seat while
    // it is open (BUILD M1-T3), so legalActions — which the client's Concede button reads (§10.2) —
    // must list it for both, alongside the holder's answers.
    const g = scenario({
      p1: { hand: [KYS_TUTOR], library: [RENO, MR_VANILLA, "core-005"] },
      p2: { field: [{ def: MR_VANILLA, lane: 1 }], library: [RENO] },
    });
    g.play(KYS_TUTOR);
    expect(g.state.pending?.playerId).toBe("p1");

    for (const player of ["p1", "p2"] as const) {
      expect(reduce(g.state, { type: "concede", playerId: player, nonce: `c-${player}` }).error).toBeUndefined();
      expect(legalActions(g.state, player).map((action) => action.type)).toContain("concede");
    }
    // The holder is still offered its answers; the other seat nothing else.
    expect(legalActions(g.state, "p1").some((action) => action.type === "answer")).toBe(true);
    expect(legalActions(g.state, "p2")).toEqual([{ type: "concede" }]);
  });
});

// ---------------------------------------------------------------------------
// Round 9: every pick a play may make is one legalActions offers (R81, R90, R101, R102)
// ---------------------------------------------------------------------------

type PlayBody = Extract<ActionBody, { type: "play" }>;

const LAVA_GOLEM = "core-055"; // Tribute 3; may tribute enemy units (§8 #55, R101)
const KPOP_FANATIC = "core-050"; // Unit: Cry: choose an enemy permanent (unit or backrow)
const RUSH_TOKEN_FARM = "core-058"; // a public Field Spell that acts only at its start of turn


function unitsOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const unit = s.unit(player, lane);
    return unit === null ? [] : [unit];
  });
}

function playsFor(state: GameState, player: PlayerId, card: CardInstance): PlayBody[] {
  return legalActions(state, player).filter(
    (action): action is PlayBody => action.type === "play" && action.instanceId === card.id,
  );
}

describe("R81, R90, R101: every Tribute a play may pay is one legalActions offers", () => {
  it("§8 #55 a Lava Golem play that tributes three enemy units is offered, not only sets holding the player's own first units (R81, R90, R101)", () => {
    // p1 has four units and one free unit zone, p2 five units: nine units Lava Golem may tribute.
    const s = scenario({
      p1: { hand: [LAVA_GOLEM], field: [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA] },
      p2: { field: [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA], hand: [MR_VANILLA] },
    });
    const golem = must(s.state.players.p1.hand.find((card) => card.defId === LAVA_GOLEM), "the Lava Golem in hand");
    const enemies = unitsOf(s, "p2").map((unit) => unit.id);
    const allEnemy = [enemies[2]!, enemies[3]!, enemies[4]!];

    // reduce accepts the play: #55 "may tribute enemy units" (R101), three units pay Tribute 3.
    const accepted = reduce(s.state, {
      type: "play",
      playerId: "p1",
      nonce: "r9-legality-golem",
      instanceId: golem.id,
      zone: { row: "units", lane: 5 },
      tributes: allEnemy,
    } as Action);
    expect(accepted.error, "reduce accepts Lava Golem tributing three enemy units").toBeUndefined();

    // …so legalActions, which the client narrows and the AI policy draws from (§10.2, CLAUDE.md
    // rule 7), must offer it. The Tribute sets are enumerated own units first and cut at
    // MAX_CHOICE_COMBINATIONS, so with nine candidates every offered set holds one of p1's first
    // three units and no set of enemy units alone is ever offered.
    const offered = playsFor(s.state, "p1", golem);
    expect(offered.length).toBeGreaterThan(0);
    const enemyOnly = offered.filter((play) => (play.tributes ?? []).every((id) => enemies.includes(id)));
    expect(
      enemyOnly.length,
      "offered Lava Golem plays whose Tribute is paid with enemy units only",
    ).toBeGreaterThan(0);
    const exact = offered.some(
      (play) => [...(play.tributes ?? [])].sort().join(",") === [...allEnemy].sort().join(","),
    );
    expect(exact, "the accepted all-enemy Tribute set is among the offered plays").toBe(true);
  });
});

describe("R81, R90, R102: every pick a crafted card's declaration may make is one legalActions offers", () => {
  it("§8 #99 a crafted Twisted Sorcerer + Kpop Fanatic is offered with the Sorcerer's 4 damage aimed at the enemy hero (R81, R90, R102)", () => {
    // p1: four units and a free lane; p2: five units and three public Field Spells. The Sorcerer's
    // declaration reaches eleven picks (p1's four units and hero, p2's five units and hero), Kpop's
    // eight (p2's five units and three backrow cards).
    const s = scenario({
      p1: { hand: [TWISTED_SORCERER, KPOP_FANATIC], field: [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA] },
      p2: {
        field: [MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA, MR_VANILLA],
        backrow: [RUSH_TOKEN_FARM, RUSH_TOKEN_FARM, RUSH_TOKEN_FARM],
        hand: [MR_VANILLA],
      },
    });
    const sorcerer = must(s.state.players.p1.hand.find((card) => card.defId === TWISTED_SORCERER), "the Sorcerer");
    const kpop = must(s.state.players.p1.hand.find((card) => card.defId === KPOP_FANATIC), "the Kpop Fanatic");
    // §8 #99: "Discover a Unit, then Discover another; Fuse them; the result costs 0 and goes to your
    // hand" — the fusion #99's last step makes, called where the rule lives (R77, R102).
    const sink: EngineSink = { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
    const crafted = must(subsystems.fuse(sink, { ingredients: [sorcerer, kpop], toHand: "p1" }), "the crafted card");
    expect(s.state.players.p1.hand.map((card) => card.id)).toContain(crafted.id);

    const enemyUnits = unitsOf(s, "p2").map((unit) => unit.id);
    const heroPick = { pick: "hero" as const, player: "p2" as const };
    const play = {
      type: "play",
      playerId: "p1",
      nonce: "r9-legality-crafted",
      instanceId: crafted.id,
      zone: { row: "units", lane: 5 },
      targets: [heroPick, { pick: "instance", instanceId: enemyUnits[0]! }],
    } as Action;
    // reduce accepts it: the Sorcerer's part names the enemy hero, Kpop's an enemy unit (R90, R102).
    const accepted = reduce(s.state, play);
    expect(accepted.error, "reduce accepts the crafted card's play at the enemy hero").toBeUndefined();
    expect(accepted.state.players.p2.hero.health, "the Sorcerer's part dealt its 4 to the enemy hero").toBe(26);

    // legalActions must offer the Sorcerer's part every pick it may make. The two declarations are
    // crossed first-slowest and cut at MAX_CHOICE_COMBINATIONS, so only the Sorcerer's first eight
    // picks (p1's side, then p2's first three units) ever reach an offered play.
    const offered = playsFor(s.state, "p1", crafted);
    expect(offered.length).toBeGreaterThan(0);
    const firstPicks = new Set(
      offered.map((action) => {
        const first = (action.targets ?? [])[0];
        return first === undefined ? "none" : first.pick === "hero" ? `hero:${first.player}` : first.pick === "instance" ? first.instanceId : first.pick;
      }),
    );
    expect(firstPicks.has("hero:p2"), "an offered play aims the Sorcerer's part at the enemy hero").toBe(true);
    for (const id of enemyUnits) expect(firstPicks.has(id), `an offered play aims the Sorcerer's part at ${id}`).toBe(true);
  });
});
