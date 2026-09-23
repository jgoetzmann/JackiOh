// Fuzz-level invariants for summoning sickness and exertion (SPEC §4.1, §4.2, §10.3, R53, R83,
// R171; docs/polish/4-edge-cases.md "Fuzz invariants"). `fuzz.test.ts` runs one monitor per game,
// and the edge-case hunters reuse it.
//
// THE MONITOR IS AN ORACLE, NOT THE FIX RESTATED. It never reads `summonedTurn` to decide who is
// sick. It keeps a shadow built only from the event stream:
//   - `turn`, from `turnStarted`;
//   - `entered`, the turn of each instance's latest entry, and `stint`, how many entries it has had.
//     An entry event is `cardPlayed`, `summoned`, `controlChanged`, or a `transformed` whose new
//     instance differs from the old. `fused` keeps the target's entry (R77), and a move along one
//     side or a Stack card resuming emits nothing and changes nothing;
//   - `lastAttack`, the turn and stint of each instance's latest declared (not forced) attack.
//
// The four checks:
//   I1 no sick attack is ever offered (§4.1, §6.1, R83, R171). In the main phase with no prompt
//      open, a unit of the acting player that entered on this turn has no attack target unless it
//      has Rush or Charge, and no hero target unless it has Charge; the chosen `attack`, if any, is
//      checked the same way. It reads `attackTargets`, which is what `legalActions` enumerates with.
//   I2 one declared attack per stint per turn. A unit that re-entered may attack again within its
//      keywords (R83, R171); forced attacks are not declarations and are skipped (R53).
//   I3 every card on the field arrived by an event (§10.3: every visible state change emits one).
//   I4 the bookkeeping matches the shadow (white-box R171): (a) `summonedTurn` is the turn of the
//      latest entry; (b) a spent attack exertion belongs to the current stint, so an exertion left
//      spent across an entry trips it.
//
// Every message leads with its id, names the instance, its def and the turn, and cites the SPEC
// reference, so the fuzz report's `signatureOf` groups one bug into one entry.

import type { ActionBody, GameEvent, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, hasKeyword } from "@jackioh/shared";
import { activeUnitsOf, attackTargets, findInstance, unitView, type CardInstance, type GameState } from "@jackioh/engine";

export type InvariantMonitor = {
  /** I1 and I3 on the state the next action is chosen in. [] when clean. */
  before(state: GameState, player: PlayerId, action: ActionBody): string[];
  /** Feeds one action's events into the shadow, then I2 and I4 against the resulting state. */
  after(events: readonly GameEvent[], state: GameState): string[];
};

type AttackMark = { turn: number; stint: number };

/** Every card on the field, a card dormant under a Stack pile and the backrow included (§3.2). */
function fieldCards(state: GameState): CardInstance[] {
  return PLAYER_IDS.flatMap((player) => {
    const side = state.players[player];
    return [
      ...side.units.flatMap((pile) => pile ?? []),
      ...side.backrow.flatMap((card) => (card === null ? [] : [card])),
    ];
  });
}

function nameOf(card: CardInstance): string {
  return `${card.id} (${card.defId}, ${card.controller}'s)`;
}

export function createInvariantMonitor(start: GameState): InvariantMonitor {
  let turn = start.turn;
  const entered = new Map<string, number>();
  const stint = new Map<string, number>();
  const lastAttack = new Map<string, AttackMark>();

  function enter(id: string): void {
    entered.set(id, turn);
    stint.set(id, (stint.get(id) ?? 0) + 1);
  }

  /** I1 for one unit and one would-be target set. */
  function sickAttack(state: GameState, unit: CardInstance, targetIds: readonly string[], what: string): string | null {
    if (targetIds.length === 0) return null;
    const keywords = unitView(state, unit).keywords;
    if (hasKeyword(keywords, "Charge")) return null;
    if (!hasKeyword(keywords, "Rush")) {
      return (
        `I1 sick attack ${what}: ${nameOf(unit)} entered on turn ${state.turn} and has neither Rush ` +
        `nor Charge, yet may attack ${targetIds.join(", ")} (§4.1, R171)`
      );
    }
    const heroes = targetIds.filter((id) => id.startsWith("hero-"));
    if (heroes.length === 0) return null;
    return (
      `I1 sick hero attack ${what}: ${nameOf(unit)} entered on turn ${state.turn} with Rush and no ` +
      `Charge, yet may attack ${heroes.join(", ")} (§6.1, R171)`
    );
  }

  return {
    before(state, player, action): string[] {
      const found: string[] = [];

      // I3: nothing is on the field that no event put there.
      for (const card of fieldCards(state)) {
        if (!entered.has(card.id)) {
          found.push(`I3 silent arrival: ${nameOf(card)} is on the field on turn ${state.turn} with no entry event (§10.3)`);
        }
      }

      // I1: only where attacks can be offered at all.
      if (state.result !== null || state.pending !== null || state.phase !== "main" || player !== state.active) {
        return found;
      }
      for (const unit of activeUnitsOf(state, player)) {
        if (entered.get(unit.id) !== state.turn) continue;
        const targets = attackTargets(state, unit).map((target) =>
          target.kind === "hero" ? `hero-${target.player}` : target.instance.id,
        );
        const violation = sickAttack(state, unit, targets, "offered");
        if (violation !== null) found.push(violation);
      }
      if (action.type === "attack") {
        const attacker = findInstance(state, action.attackerId);
        if (attacker !== undefined && entered.get(attacker.id) === state.turn) {
          const violation = sickAttack(state, attacker, [action.targetId], "chosen");
          if (violation !== null) found.push(violation);
        }
      }
      return found;
    },

    after(events, state): string[] {
      const found: string[] = [];

      for (const event of events) {
        switch (event.type) {
          case "turnStarted":
            turn = event.turn;
            break;
          case "cardPlayed":
          case "summoned":
          case "controlChanged":
            enter(event.instanceId);
            break;
          case "transformed":
            if (event.newInstanceId !== event.instanceId) enter(event.newInstanceId);
            break;
          case "attackDeclared": {
            // R53: a forced attack is not a declaration and spends nothing.
            if (event.forced) break;
            const mark: AttackMark = { turn, stint: stint.get(event.attackerId) ?? 0 };
            const previous = lastAttack.get(event.attackerId);
            if (previous !== undefined && previous.turn === mark.turn && previous.stint === mark.stint) {
              const unit = findInstance(state, event.attackerId);
              const who = unit === undefined ? event.attackerId : nameOf(unit);
              found.push(
                `I2 second attack: ${who} declared a second attack on turn ${turn} without re-entering ` +
                  `the field (§4.1 one exertion per turn, R171)`,
              );
            }
            lastAttack.set(event.attackerId, mark);
            break;
          }
          default:
            break;
        }
      }

      // I4: the engine's bookkeeping agrees with the shadow.
      for (const card of fieldCards(state)) {
        const at = entered.get(card.id);
        if (at === undefined) continue; // I3 reports it before the next action.
        if (card.summonedTurn !== at) {
          found.push(
            `I4 entry mismatch: ${nameOf(card)} has summonedTurn ${String(card.summonedTurn)} on turn ` +
              `${state.turn}, but its latest entry event was on turn ${at} (§4.1, R83, R171)`,
          );
        }
        if (card.exertion.attacked) {
          const mark = lastAttack.get(card.id);
          if (mark === undefined || mark.stint !== (stint.get(card.id) ?? 0)) {
            found.push(
              `I4 stale exertion: ${nameOf(card)} has a spent attack on turn ${state.turn} that it ` +
                `did not declare since its latest entry (§4.1, R171)`,
            );
          }
        }
      }

      return found;
    },
  };
}
