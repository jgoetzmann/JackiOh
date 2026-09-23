// What a play may choose, what its choices then do, and what `legalActions` offers (SPEC §2.5, §8
// Conventions, §10.2, R43, R81, R90, R102, R151, R211). Found by the polish-4 edge-case hunt,
// round 2 (docs/polish/4-edge-cases.md, lenses L7 and L9); every case here failed before its fix.
//
// The agreement between `legalActions` and `reduce` held across seeded random-policy games and
// millions of mutated candidate actions. What failed is below: a power SPEC makes usable that neither
// side offered, choices a fused card was offered and then ignored, a mode SPEC's conventions require
// a target for that could name none, and a concede `reduce` accepts while a prompt is open that
// `legalActions` did not list.

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, GameEvent, PlayerId } from "@jackioh/shared";
import { legalActions, reduce, subsystems, type CardInstance, type GameState } from "@jackioh/engine";
import { scenario } from "./_harness";

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
