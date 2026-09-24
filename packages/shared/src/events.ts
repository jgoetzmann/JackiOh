// The event union (SPEC §10.3). Every visible state change emits one, and BUILD M5-T4 animates each type.
// Payloads carry ids and numbers only, so an event list serializes and replays exactly.

import type { Keyword, PlayerId, PromptKind, Row, Zone } from "./catalog-types";

export type GameEvent =
  | {
      type: "cardPlayed";
      player: PlayerId;
      instanceId: string;
      defId: string;
      costPaid: number;
      x?: number;
      embiggened?: boolean;
      /**
       * R119: the permanents that arrived on the field during this play before §10.5 step 4
       * announced it — a tributed unit's Death at step 2 (#22's copies) — which do not answer it, as
       * `cardResolved`'s field says for step 7. Engine bookkeeping: a view never forwards it.
       */
      arrivedDuring?: string[];
      /**
       * R174, R212: the field's departures as the play was announced (the engine's exit mark), so a
       * response the loop hands this event later judges the played card's stay from the moment the
       * event happened. Engine bookkeeping: a view never forwards it.
       */
      exitsFrom?: number;
    }
  /**
   * §10.5 step 7: the card has finished resolving — after its Cry and any Echo repeats, and after a
   * Spell has reached the graveyard or exile. R17 keys the post-resolution traps on this moment
   * (Bear Honeypot, Unstable Clone Machine, Unlicensed Experimentation), as against Sheepish, which
   * fires at step 4 and costs the card its Cry. `permanent` says whether the card is still in play,
   * which is R61's distinction for Unlicensed Experimentation.
   *
   * `costPaid` repeats `cardPlayed`'s number — the mana actually charged after every modifier, R65's
   * X and embiggen prices included, and 0 for a cast (R70). It is carried rather than looked up
   * because R89 is the hazard: a trigger answering this event must find what it needs on the event,
   * since the instance may have been reset between the two moments (#60 reads "costing 1 or less").
   *
   * `radiant` is the face that resolved, for the same reason: #33 Unstable Clone Machine copies the
   * played card with its radiant flag (R34, R57), and by step 7 the card may have ceased to exist —
   * #41 Sheepish transforms a played Unit at step 4 — so a trigger cannot look it up. It is the
   * card's flag at step 7 when it still exists, and the flag it was played with otherwise. A view
   * that hides the card hides this too (R97).
   */
  | {
      type: "cardResolved";
      player: PlayerId;
      instanceId: string;
      defId: string;
      permanent: boolean;
      costPaid: number;
      radiant?: boolean;
      /**
       * R119: the permanents that arrived on the field while this play resolved, whatever put them
       * there — a Recruit by its Cry (#98), #95's backrow, a Reborn body its own Cry brought back, a
       * unit a trap answering the play summoned — which do not answer it, as the played card does not
       * answer its own play. Engine bookkeeping: a view never forwards it.
       */
      arrivedDuring?: string[];
      /**
       * R174, R212: the field's departures as step 7 emitted this (the engine's exit mark). A cast's
       * `cardResolved` waits for the loop of the effect that cast it (R70), and the rest of that
       * effect's list, and the state check after it, can take the card off the field and Reborn put
       * a new body back before the event reaches a response — which judges the card's stay from
       * here, not from the dispatch, so that body is not "it". Engine bookkeeping: a view never
       * forwards it.
       */
      exitsFrom?: number;
    }
  | {
      type: "summoned";
      player: PlayerId;
      instanceId: string;
      defId: string;
      row: Row;
      lane: number;
      /** R119: on a played card's step-4 `summoned`, as on its `cardPlayed`. A view never forwards it. */
      arrivedDuring?: string[];
      /** R174, R212: on a played card's step-4 `summoned`, as on its `cardPlayed`. A view never forwards it. */
      exitsFrom?: number;
    }
  | { type: "damage"; sourceId: string | null; targetId: string; amount: number; combat: boolean }
  | { type: "healthLost"; player: PlayerId; amount: number }
  | { type: "healed"; targetId: string; amount: number }
  | { type: "divineShieldLost"; instanceId: string }
  /** R89: what the card was as it died — the layers' attack and max health, and who killed it. */
  | {
      type: "destroyed";
      instanceId: string;
      defId: string;
      owner: PlayerId;
      attack: number;
      maxHealth: number;
      killerId: string | null;
    }
  | { type: "enteredGraveyard"; instanceId: string; defId: string; owner: PlayerId }
  | { type: "exiled"; instanceId: string; defId: string; owner: PlayerId }
  | { type: "bounced"; instanceId: string; defId: string; owner: PlayerId }
  | { type: "burned"; instanceId: string; defId: string; owner: PlayerId }
  | { type: "discarded"; instanceId: string; defId: string; owner: PlayerId }
  | { type: "drawn"; player: PlayerId; instanceId: string; defId: string }
  | { type: "addedToHand"; player: PlayerId; instanceId: string; defId: string }
  | { type: "shuffledIn"; player: PlayerId; instanceId: string; defId: string; position: number }
  | { type: "buffed"; instanceId: string; attack: number; health: number }
  | {
      type: "keywordGranted";
      instanceId: string;
      keyword: Keyword;
      /**
       * R46: set when the unit loses the keyword instead — the Taunt an Indestructible unit's
       * knock-down takes for the rest of the turn, which a unit already in Attack Position would
       * otherwise lose with no event (§10.3, R91). Absent on a grant.
       */
      lost?: true;
    }
  | { type: "counterChanged"; instanceId: string; counter: "plague" | "grade"; value: number }
  /**
   * R177: `hiddenFrom` is set on a change made to a card in a library — both players, who could not
   * read it there (§3) — so a view keeps the event hidden from them for good, even once the card
   * reads openly. The view uses it and never forwards it.
   */
  | { type: "costChanged"; instanceId: string; cost: number; hiddenFrom?: PlayerId[] }
  | { type: "modifierChanged"; player: PlayerId; modifierId: string; added: boolean }
  | { type: "radiantSet"; instanceId: string; defId: string; zone: Zone }
  /**
   * R177: `hiddenFrom` names the players who could not read the old card where it ceased to exist —
   * both of them for a library card, the other player for a face-down trap (R33) — so a view keeps
   * it hidden from them for good, even after its replacement reaches a public pile. Absent when the
   * old card was public. The view uses it and never forwards it.
   */
  | {
      type: "transformed";
      instanceId: string;
      fromDefId: string;
      toDefId: string;
      newInstanceId: string;
      hiddenFrom?: PlayerId[];
    }
  | { type: "fused"; instanceIds: string[]; resultInstanceId: string; defId: string }
  | { type: "positionSwitched"; instanceId: string; position: "ATK" | "DEF" }
  | { type: "controlChanged"; instanceId: string; controller: PlayerId; row: Row; lane: number }
  | { type: "rotated"; direction: "left" | "right" }
  | { type: "swapped"; what: "health" | "board" | "library" }
  | { type: "locked"; player: PlayerId; row: Row; lane: number }
  /**
   * R154: `row` and `lane` say which zone flipped, so a client can point at it without being told
   * which card it was. `instanceId` and `defId` follow §10.8's redaction (R97) — the controller
   * reads them, the other player reads the sentinel — and a face-down trap is given no instance id
   * in the view at all, so without the lane the opponent's side has nothing to animate on.
   */
  | {
      type: "trapFired";
      instanceId: string;
      defId: string;
      controller: PlayerId;
      row: Row;
      lane: number;
    }
  | { type: "attackDeclared"; attackerId: string; targetId: string; forced: boolean }
  | { type: "attackCancelled"; attackerId: string; targetId: string; byInstanceId: string }
  | { type: "manaChanged"; player: PlayerId; current: number; max: number }
  | { type: "turnStarted"; player: PlayerId; turn: number }
  | { type: "turnEnded"; player: PlayerId; turn: number; unspentMana: number }
  | { type: "turnAutoEnded"; player: PlayerId; turn: number }
  | { type: "promptOpened"; player: PlayerId; choiceId: string; kind: PromptKind }
  | { type: "promptAnswered"; player: PlayerId; choiceId: string }
  | { type: "drawOffered"; player: PlayerId }
  | { type: "drawAnswered"; player: PlayerId; accept: boolean }
  | { type: "gameOver"; winner: PlayerId | "draw"; reason: GameOverReason };

export type GameEventType = GameEvent["type"];

export type GameOverReason =
  | "hero-death"
  | "both-heroes-dead"
  | "concede"
  | "draw-accepted"
  | "turn-cap"
  | "disconnect"
  | "match-ceiling";

/**
 * Every type in the union, for the animation-table test (BUILD M5-T4).
 *
 * `satisfies readonly GameEventType[]` below is only a SUBSET check — it rejects a member that is
 * not a `GameEventType` and says nothing about one that is missing. `GameEventTypesAreExhaustive`
 * underneath the array closes that direction, and `test/events.test.ts` closes it again at runtime
 * by reading the union out of this file's own source, so a new event cannot slip past `vitest run`.
 */
export const GAME_EVENT_TYPES = [
  "cardPlayed",
  "cardResolved",
  "summoned",
  "damage",
  "healthLost",
  "healed",
  "divineShieldLost",
  "destroyed",
  "enteredGraveyard",
  "exiled",
  "bounced",
  "burned",
  "discarded",
  "drawn",
  "addedToHand",
  "shuffledIn",
  "buffed",
  "keywordGranted",
  "counterChanged",
  "costChanged",
  "modifierChanged",
  "radiantSet",
  "transformed",
  "fused",
  "positionSwitched",
  "controlChanged",
  "rotated",
  "swapped",
  "locked",
  "trapFired",
  "attackDeclared",
  "attackCancelled",
  "manaChanged",
  "turnStarted",
  "turnEnded",
  "turnAutoEnded",
  "promptOpened",
  "promptAnswered",
  "drawOffered",
  "drawAnswered",
  "gameOver",
] as const satisfies readonly GameEventType[];

/**
 * The other half of the check: a `GameEvent` member missing from `GAME_EVENT_TYPES` is a COMPILE
 * ERROR, and the error names it — `Type '"newThing"' does not satisfy the constraint 'never'`.
 *
 * `Exclude` leaves exactly the members the array forgot; `never` is the only type that satisfies
 * the constraint, so an empty difference compiles and a non-empty one does not. Nothing is emitted:
 * this is a type alias, so the assertion costs no runtime bytes.
 */
type NoneMissing<T extends never> = T;

export type GameEventTypesAreExhaustive = NoneMissing<
  Exclude<GameEventType, (typeof GAME_EVENT_TYPES)[number]>
>;
