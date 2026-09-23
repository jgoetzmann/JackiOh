// The state model of SPEC §10.1. Everything here is JSON: no functions, no class instances, no
// closures, so a state survives JSON.parse(JSON.stringify(state)) and a replay is exact (§9.3).

import type {
  CardDef,
  CardDefs,
  Keyword,
  PlayerId,
  PromptKind,
  Row,
  Selection,
  Zone,
} from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import type { GameEvent, GameOverReason } from "@jackioh/shared";
import { BACKROW_ZONES, DECK_SIZE, HERO_HEALTH, UNIT_ZONES } from "./config";
import { registerCatalog, registeredCatalog } from "./catalog";

export type Phase = "setup" | "mulligan" | "start" | "main" | "end" | "over";
export type Position = "ATK" | "DEF";

export type CardInstance = {
  id: string;
  defId: string;
  owner: PlayerId;
  controller: PlayerId;
  radiant: boolean;
  zone: Zone;
  position?: Position;
  summonedTurn?: number;
  damage: number;
  buffs: { attack: number; health: number };
  grantedKeywords: Keyword[];
  vanilla: boolean;
  costMod: number;
  costOverride?: number;
  x?: number;
  embiggened?: boolean;
  counters: { plague?: number; grade?: number };
  memory: Record<string, unknown>;
  exertion: { attacked: boolean; switched: boolean };
  statsOverride?: { attack: number; health: number };
  /**
   * §7: the Bread Token's radiant face prints "Armor X", where X is the same unspent-mana X its
   * stats use — so it cannot be a printed number any more than its X/X can. Set beside
   * `statsOverride` by whoever summons it, and substituted into the printed `Armor` keyword by
   * `faceOf`. Inert until the token is radiant, because only the radiant face prints Armor.
   */
  armorOverride?: number;
  returnToHandAtEndOfTurn?: boolean;
  /** Indestructible would-destroy: no Taunt for this turn (R46). */
  tauntSuppressedTurn?: number;
  /** A backrow card whose identity is public, e.g. a Field Trap that has fired (R33). */
  faceUp?: boolean;
  /**
   * Instance id of the source whose damage instance was lethal — the hit that took this unit from
   * above 0 health to 0 or less, or a Poisonous hit — for "destroys a unit" (R42, R89). Unset while
   * no hit has killed it (`damage.creditKiller`).
   */
  lastDamagedBy?: string;
  /** Divine Shield has absorbed a hit and is gone until granted again (§6.1). */
  divineShieldSpent?: boolean;
  /** Destroyed by an effect; the next state check collects it (§4.5, §6.3 Destroy). */
  markedDestroyed?: boolean;
  /** Came back through Reborn, so it no longer has it (§4.5 step 4). */
  rebornSpent?: boolean;
};

/** A unit zone holds a Stack pile, top card first (§3.2). */
export type Pile = CardInstance[];

export type ModifierExpiry =
  | { until: "thisTurn"; turn: number }
  /** Lasts through that player's next turn; `fromTurn` is the turn it was created on (R48). */
  | { until: "nextTurnOf"; player: PlayerId; fromTurn: number }
  | { until: "used" }
  | { until: "never" };

export type PlayerModifier = {
  id: string;
  expiry: ModifierExpiry;
} & (
  | { kind: "costDiscount"; amount: number; onlyType?: "Spell"; onlyCurrentCost?: number; oncePerTurn?: boolean }
  | { kind: "echoNextSpell"; amount: number; sourceId?: string }
  | { kind: "radiantFirstCheapCard"; maxCost: number; usedTurn?: number }
  | { kind: "comboDraw"; amount: number }
  | { kind: "quickstrikerDamage" }
);

export type DelayedEffect = {
  id: string;
  /** Whose script scheduled it, for R68's creation order. */
  seq: number;
  owner: PlayerId;
  at: { phase: "start" | "end"; player: PlayerId };
  /** A serializable continuation: script id, hook name, captured data (§10.6). */
  resume: Resume;
  /**
   * R174: the instance this effect is aimed at, when it is aimed at one on the field (#50 Kpop
   * Fanatic's chosen permanent). The entry is dropped the moment that card leaves the field
   * (`zones.moveToZone`), so a card that comes back — bounced and replayed, or a Reborn body — is a
   * new arrival the effect never chose, and R76's "fizzles if the target has left the field" holds.
   */
  watch?: string;
};

export type Resume = {
  defId: string;
  hook: string;
  /** A named step, so a continuation reads as the script wrote it (§10.6). */
  step: string;
  radiant: boolean;
  /** The instance the script belongs to, when it still exists. */
  instanceId?: string;
  data: Record<string, unknown>;
};

/**
 * One paused step of an engine sequence (§9.3: "mid-action choices are state, not callbacks").
 * A work item never holds effects — those are closures — it names the continuation to re-enter,
 * so a state with paused work survives JSON and replays exactly (`src/work.ts`).
 */
/** §10.3: an emitted event waiting for the trigger loop to dispatch it. */
export type DispatchItem = {
  id: string;
  seq: number;
  event: GameEvent;
};

/**
 * R30: a spell's pending Echo repeats. A repeat waits here while a prompt from the first
 * resolution is still open, so the sequence survives the pause (§10.6, `src/work.ts`).
 */
export type EchoItem = {
  id: string;
  seq: number;
  instanceId: string;
  controller: PlayerId;
  /** Repeats still owed to this instance. */
  remaining: number;
};

export type WorkItem = {
  id: string;
  /** Creation order, so the queue is deterministic (R68). */
  seq: number;
  owner: PlayerId;
  resume: Resume;
};

export type PromptOption = {
  key: string;
  label: string;
  selection: Selection;
};

export type PendingChoice = {
  id: string;
  playerId: PlayerId;
  kind: PromptKind;
  prompt: string;
  options: PromptOption[];
  min: number;
  max: number;
  resume: Resume;
};

export type QueuedTrigger = {
  id: string;
  seq: number;
  instanceId: string;
  hook: string;
  resume: Resume;
};

/**
 * §4.2 step 4 and R44: the attack whose trap window is open — the moment between a declaration,
 * which has already spent the attacker's exertion, and the damage of step 5. `src/combat.ts` opens
 * it, a trap that fires inside it closes it with `effects/combat.cancelAttack` (§6.3 "Cancel an
 * attack"), and step 5 reads it back to find out whether there is still a combat to resolve.
 *
 * Ids and flags only, like the rest of §10.1: no instances and no closures, so the field survives
 * `cloneState`'s JSON round trip. That is not decoration here — My Pawn's window hands the rest of
 * the turn to the AI policy, which drives `reduce`, which clones, so by the time step 5 runs every
 * `CardInstance` the declaration was built from is a different object and only the ids still name
 * the same cards.
 */
export type DeclaredAttack = {
  /**
   * This declaration, told apart from one opened inside its own window (R44's AI turn takes
   * actions of its own). Deterministic, from `nextSeq`, so a replay mints the same ids.
   */
  id: string;
  /** The attacker's instance id. */
  attackerId: string;
  /** §4.2 step 2's two possibilities: an enemy unit's instance id, or `hero-<player>`. */
  targetId: string;
  /** Set by `cancelAttack` inside the window, so step 5 resolves no combat (§6.3, R44). */
  cancelled: boolean;
};

export type TurnLog = {
  playedIds: string[];
  cardsPlayed: number;
  unspentAtEnd?: number;
  /**
   * The cost each play this turn actually paid (R56), in play order beside `playedIds`, a cast's 0
   * included (R70). #64 Gifted Program's "the first card costing 1 or less you play each turn" is
   * the player's count, not the card's (R213). Optional so a log written without it reads as no
   * plays; `startTurn` rebuilds the log, which clears it.
   */
  costsPaid?: number[];
};

export type PlayerState = {
  hero: { health: number; armor: number };
  mana: { current: number; max: number; nextTurnMod: number; permMod: number };
  hand: CardInstance[];
  library: CardInstance[];
  graveyard: CardInstance[];
  exile: CardInstance[];
  /** Cards mid-resolution: a Spell sits here between its play and its graveyard (§10.5). */
  resolving: CardInstance[];
  units: (Pile | null)[];
  backrow: (CardInstance | null)[];
  locks: { units: boolean[]; backrow: boolean[] };
  mods: PlayerModifier[];
  turnLog: TurnLog;
  drawOffer: { offeredTurn?: number; blockedUntil?: number };
  fatigueCount: number;
  /** Turns this player has started, for the mana refresh (§2.3). */
  turnsStarted: number;
  /** My Pawn: the AI policy plays out the rest of this turn (R44). */
  aiTurn: boolean;
};

export type GameState = {
  seed: string;
  rngCursor: number;
  /** Player-turn counter, 1-based, capped by TURN_CAP_PLAYER_TURNS (§2.5, R2). */
  turn: number;
  active: PlayerId;
  phase: Phase;
  players: Record<PlayerId, PlayerState>;
  pending: PendingChoice | null;
  triggerQueue: QueuedTrigger[];
  /** The attack whose trap window is open, between declaration and damage (§4.2 step 4, R44). */
  declaredAttack: DeclaredAttack | null;
  /** Paused sequences waiting to continue, in order (§9.3, §10.6). */
  work: WorkItem[];
  /**
   * R113: how many items the *current* pause cascade has parked. A scope parks its remainder at
   * this index and advances it, so one cascade lands innermost-first, and taking an item resets it
   * to 0 so the next cascade is inserted ahead of everything still owed. Neither a plain queue nor
   * a plain stack is correct: a Cry's parked tail must run before the play steps that follow it,
   * while a prompt opened *inside* that tail must run before both.
   */
  workCursor: number;
  /** Echo repeats owed but not yet resolved (R30). */
  echoQueue: EchoItem[];
  /** Events emitted but not yet dispatched to triggers (§10.3). */
  dispatch: DispatchItem[];
  delayed: DelayedEffect[];
  /** Ceaseless Void's four game counters (R55). */
  counters: { drawn: number; played: number; destroyed: number; exiled: number };
  transientDefs: Record<string, CardDef>;
  /** Zones a dying Reborn unit holds until it returns (R64). */
  reserved: { player: PlayerId; row: Row; lane: number }[];
  /** Players who have answered their mulligan (§2.1). */
  mulliganed: PlayerId[];
  result: null | { winner: PlayerId | "draw"; reason: GameOverReason };
  /** Next instance/choice/trigger id, so ids are deterministic under replay. */
  nextId: number;
  /** Monotonic sequence for R68's creation order. */
  nextSeq: number;
  /** Nonce dedupe: the events each already-applied action produced (§9.3). */
  applied: { nonce: string; events: GameEvent[] }[];
};

function emptyRow<T>(size: number): (T | null)[] {
  return Array.from({ length: size }, () => null);
}

function emptyLocks(size: number): boolean[] {
  return Array.from({ length: size }, () => false);
}

export function createPlayerState(): PlayerState {
  return {
    hero: { health: HERO_HEALTH, armor: 0 },
    mana: { current: 0, max: 0, nextTurnMod: 0, permMod: 0 },
    hand: [],
    library: [],
    graveyard: [],
    exile: [],
    resolving: [],
    units: emptyRow<Pile>(UNIT_ZONES),
    backrow: emptyRow<CardInstance>(BACKROW_ZONES),
    locks: { units: emptyLocks(UNIT_ZONES), backrow: emptyLocks(BACKROW_ZONES) },
    mods: [],
    turnLog: { playedIds: [], cardsPlayed: 0 },
    drawOffer: {},
    fatigueCount: 0,
    turnsStarted: 0,
    aiTurn: false,
  };
}

export type CreateGameOptions = {
  seed: string;
  decks: [string[], string[]];
  /** Registers the catalog for this process; omit when it is already registered. */
  catalog?: CardDefs;
};

/** §2.6 and §9.4 L2, L3, L6: the rules a deck must satisfy before a game exists. */
export function validateDeck(deck: readonly string[], catalog: CardDefs, label: string): void {
  if (deck.length !== DECK_SIZE) {
    throw new Error(`${label}: deck must hold exactly ${DECK_SIZE} cards (§2.6 L2), got ${deck.length}`);
  }
  const seen = new Set<string>();
  for (const defId of deck) {
    const def = catalog[defId];
    if (def === undefined) {
      throw new Error(`${label}: "${defId}" is not in the catalog (§9.4 L6)`);
    }
    if (seen.has(defId)) {
      throw new Error(`${label}: "${defId}" appears twice; no duplicate card ids (§2.6 L3)`);
    }
    seen.add(defId);
    if (def.token || def.tags.includes("Token")) {
      throw new Error(`${label}: "${defId}" is a Token card and cannot be in a deck (§2.6 L3)`);
    }
  }
}

export function newInstance(
  state: Pick<GameState, "nextId">,
  defId: string,
  owner: PlayerId,
  zone: Zone,
): CardInstance {
  const instance: CardInstance = {
    id: `c${state.nextId}`,
    defId,
    owner,
    controller: owner,
    radiant: false,
    zone,
    damage: 0,
    buffs: { attack: 0, health: 0 },
    grantedKeywords: [],
    vanilla: false,
    costMod: 0,
    counters: {},
    memory: {},
    exertion: { attacked: false, switched: false },
  };
  state.nextId += 1;
  return instance;
}

/**
 * A game in phase `setup`: libraries hold the decks in list order, and `setup.ts` (M1-T5)
 * shuffles them with the match rng and deals the opening hands.
 */
export function createGame(options: CreateGameOptions): GameState {
  if (options.catalog !== undefined) registerCatalog(options.catalog);
  const catalog = registeredCatalog();

  validateDeck(options.decks[0], catalog, "p1");
  validateDeck(options.decks[1], catalog, "p2");

  const state: GameState = {
    seed: options.seed,
    rngCursor: 0,
    turn: 0,
    active: "p1",
    phase: "setup",
    players: { p1: createPlayerState(), p2: createPlayerState() },
    pending: null,
    triggerQueue: [],
    declaredAttack: null,
    work: [],
    workCursor: 0,
    echoQueue: [],
    dispatch: [],
    delayed: [],
    counters: { drawn: 0, played: 0, destroyed: 0, exiled: 0 },
    transientDefs: {},
    reserved: [],
    mulliganed: [],
    result: null,
    nextId: 1,
    nextSeq: 1,
    applied: [],
  };

  PLAYER_IDS.forEach((player, seat) => {
    const deck = options.decks[seat] ?? [];
    const side = state.players[player];
    side.library = deck.map((defId) => newInstance(state, defId, player, { z: "library", player }));
  });

  return state;
}

/**
 * A deep copy of a state. §10.1 keeps the state JSON-only, so a JSON round-trip is a faithful
 * clone and quietly enforces that invariant: anything unserializable would not survive it.
 */
export function cloneState(state: GameState): GameState {
  return JSON.parse(JSON.stringify(state)) as GameState;
}

export function activeUnits(side: PlayerState): CardInstance[] {
  return side.units.flatMap((pile) => {
    const top = pile?.[0];
    return top === undefined ? [] : [top];
  });
}

export function allZonesEmpty(side: PlayerState): boolean {
  return side.units.every((pile) => pile === null) && side.backrow.every((card) => card === null);
}

export function findInstance(state: GameState, instanceId: string): CardInstance | undefined {
  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    const inPiles = side.units.flatMap((pile) => pile ?? []);
    const candidates: (CardInstance | null | undefined)[] = [
      ...side.hand,
      ...side.library,
      ...side.graveyard,
      ...side.exile,
      ...inPiles,
      ...side.backrow,
      // R98: a card that asks a question mid-resolution is still itself, and §10.5 parks it here
      // between its play and its destination, so a resumed step finds `ctx.self` rather than null.
      ...side.resolving,
    ];
    const found = candidates.find((card) => card?.id === instanceId);
    if (found != null) return found;
  }
  return undefined;
}

export function rowOf(side: PlayerState, row: Row): (Pile | null)[] | (CardInstance | null)[] {
  return row === "units" ? side.units : side.backrow;
}
