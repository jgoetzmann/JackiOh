// Fixture `PlayerView`s. Every web test renders one of these and nothing else, which is the
// point: if a component needs something that is not in a `PlayerView`, the fixture cannot give
// it and the gap is a finding against SPEC §10.8.

import type {
  BackrowView,
  CardView,
  GameEvent,
  HeroPowerView,
  Keyword,
  PendingOption,
  PendingView,
  PlayerId,
  PlayerView,
  PromptKind,
  SideView,
  UnitView,
} from "@jackioh/shared";

let counter = 0;

/** Deterministic instance ids, so snapshots are stable. */
export function resetIds(): void {
  counter = 0;
}

function nextId(prefix: string): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export function card(over: Partial<CardView> = {}): CardView {
  return { instanceId: nextId("c"), defId: "core-001", radiant: false, cost: 2, ...over };
}

export function unit(owner: PlayerId, over: Partial<UnitView> = {}): UnitView {
  return {
    instanceId: nextId("u"),
    defId: "core-004",
    radiant: false,
    cost: 3,
    owner,
    controller: owner,
    attack: 3,
    maxHealth: 4,
    health: 4,
    keywords: [],
    armor: 0,
    position: "ATK",
    counters: {},
    buried: 0,
    canAct: true,
    ...over,
  };
}

export function faceUpBackrow(
  owner: PlayerId = "p1",
  over: Partial<Extract<BackrowView, { faceDown: false }>> = {},
): BackrowView {
  return {
    instanceId: nextId("b"),
    defId: "core-020",
    radiant: false,
    cost: 1,
    faceDown: false,
    type: "Field Spell",
    counters: {},
    owner,
    controller: owner,
    ...over,
  };
}

export const faceDownBackrow: BackrowView = { faceDown: true };

export function emptySide(player: PlayerId, over: Partial<SideView> = {}): SideView {
  return {
    player,
    hero: { health: 30, armor: 0, powers: [], power: null },
    mana: { current: 4, max: 4 },
    hand: [],
    libraryCount: 12,
    graveyard: [],
    exile: [],
    resolving: [],
    units: [null, null, null, null, null],
    backrow: [null, null, null, null, null],
    locks: { units: [false, false, false, false, false], backrow: [false, false, false, false, false] },
    reserved: { units: [false, false, false, false, false], backrow: [false, false, false, false, false] },
    fatigueCount: 0,
    ...over,
  };
}

const ALL_KEYWORDS: Keyword[] = [
  { kind: "Taunt" },
  { kind: "Rush" },
  { kind: "Charge" },
  { kind: "First Strike" },
  { kind: "Poisonous" },
  { kind: "Lifesteal" },
  { kind: "Reborn" },
  { kind: "Divine Shield" },
  { kind: "Trample" },
  { kind: "Cleave" },
  { kind: "Indestructible" },
  { kind: "Immutable" },
  { kind: "Stack" },
  { kind: "Can't attack" },
  { kind: "Armor", n: 2 },
  { kind: "Lucky", n: 3 },
];

export function baseView(over: Partial<PlayerView> = {}): PlayerView {
  return {
    viewer: "p1",
    turn: 3,
    active: "p1",
    phase: "main",
    you: emptySide("p1"),
    opponent: emptySide("p2", { hand: { count: 4 } }),
    pending: null,
    events: [],
    result: null,
    clockMs: null,
    ...over,
  };
}

/** §8 #98: a Heroic Power the viewer controls, with the instance `activatePower` needs. */
export const heroPower: HeroPowerView = {
  instanceId: "power-1",
  defId: "core-098",
  name: "Heroic Power",
  x: 2,
  usedThisTurn: false,
};

/**
 * The M5-T1 acceptance fixture: a full board — 10 units, 10 backrow cards, a Stack pile with
 * cards buried under it, every keyword on show, radiant cards, plague and grade counters, locks,
 * a reserved zone (R64), a card mid-resolution, a hero power, and an opponent hand that is a
 * count only (SPEC §10.8).
 */
export function fullBoardView(over: Partial<PlayerView> = {}): PlayerView {
  resetIds();

  const yourUnits: UnitView[] = [
    unit("p1", { defId: "core-004", attack: 2, maxHealth: 3, health: 1, keywords: [{ kind: "Taunt" }] }),
    unit("p1", {
      defId: "core-011",
      radiant: true,
      attack: 7,
      maxHealth: 7,
      health: 7,
      keywords: ALL_KEYWORDS,
      armor: 2,
      counters: { plague: 2, grade: 3 },
    }),
    unit("p1", { defId: "core-017", position: "DEF", attack: 1, maxHealth: 6, health: 6 }),
    // A Stack pile: three cards buried under the top one (§3.2), face-down and dormant.
    unit("p1", { defId: "core-034", keywords: [{ kind: "Stack" }], buried: 3, attack: 5, maxHealth: 5, health: 4 }),
    unit("p1", { defId: "core-051", attack: 0, maxHealth: 1, health: 1, canAct: false, cost: 0 }),
  ];

  const enemyUnits: UnitView[] = [
    unit("p2", { defId: "core-008", attack: 4, maxHealth: 4, health: 4, keywords: [{ kind: "Divine Shield" }] }),
    unit("p2", { defId: "core-013", position: "DEF", attack: 3, maxHealth: 5, health: 2 }),
    unit("p2", { defId: "core-022", radiant: true, attack: 6, maxHealth: 2, health: 2, counters: { plague: 1 } }),
    unit("p2", { defId: "core-040", attack: 1, maxHealth: 1, health: 1, armor: 1 }),
    unit("p2", { defId: "core-100", attack: 10, maxHealth: 10, health: 10, cost: 0, keywords: [{ kind: "Trample" }] }),
  ];

  return baseView({
    you: emptySide("p1", {
      hero: {
        health: 21,
        armor: 3,
        powers: [heroPower],
        power: heroPower,
      },
      mana: { current: 2, max: 4 },
      hand: [
        card({ defId: "core-002", cost: 1 }),
        card({ defId: "core-019", cost: 3, radiant: true }),
        card({ defId: "core-055", cost: 0 }),
        card({ defId: "core-077", cost: 6 }),
      ],
      graveyard: [card({ defId: "core-003" }), card({ defId: "core-005" })],
      exile: [card({ defId: "core-007" })],
      units: yourUnits.map((u) => u),
      backrow: [
        faceUpBackrow("p1", { defId: "core-020", type: "Field Spell" }),
        faceUpBackrow("p1", { defId: "core-061", type: "Field Trap", counters: { grade: 2 } }),
        faceDownBackrow,
        faceDownBackrow,
        faceUpBackrow("p1", { defId: "core-084", type: "Trap", radiant: true }),
      ],
      locks: { units: [false, false, false, false, false], backrow: [false, false, true, false, false] },
    }),
    opponent: emptySide("p2", {
      hero: { health: 30, armor: 0, powers: [], power: null },
      mana: { current: 0, max: 3 },
      hand: { count: 6 },
      libraryCount: 9,
      graveyard: [card({ defId: "core-009" })],
      exile: [],
      units: enemyUnits.map((u) => u),
      // The opponent's traps are face-down; their Field Spells are public (SPEC §10.8). Lane 5 used
      // to be `null`, which left the fixture with 9 backrow cards against the 10 BUILD M5-T1 asks
      // for — and no empty field zone is lost by filling it: `baseView`/`emptySide` are all-null
      // boards, and `routes/match.test.tsx` renders one of them through `Game` into this same
      // `Board`.
      backrow: [
        faceDownBackrow,
        faceDownBackrow,
        faceUpBackrow("p2", { defId: "core-031", type: "Field Spell" }),
        faceDownBackrow,
        faceDownBackrow,
      ],
      locks: { units: [false, true, false, false, false], backrow: [false, false, false, false, false] },
    }),
    ...over,
  });
}

export function pendingFor(kind: PromptKind, options: PendingOption[], over: Partial<Extract<PendingView, { forYou: true }>> = {}): PendingView {
  return {
    forYou: true,
    choiceId: "ch1",
    kind,
    options,
    min: 1,
    max: 1,
    prompt: `Choose (${kind})`,
    ...over,
  };
}

export const waitingPending: PendingView = { forYou: false, pendingFor: "p2" };

export function withEvents(view: PlayerView, events: GameEvent[]): PlayerView {
  return { ...view, events };
}
