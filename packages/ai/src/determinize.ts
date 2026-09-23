// R185: one concrete world consistent with what the seat knows. `redact` has already turned every
// hidden card into a placeholder; this fills each one with a real non-token Core definition drawn
// from what the opponent has not shown, shuffles the seat's own library, and gives the world a seed
// of its own, so no simulation can foresee a real draw or a real coin flip.
//
// docs/polish/3-ai.md's six steps, in order. `rng` is the AI's own stream and every draw below comes
// from it in a fixed order, so the same public state and the same rng give the same world.

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { cloneState, query, type CardInstance, type GameState, type Rng } from "@jackioh/engine";
import { AI_DETERMINIZE } from "./config";
import { HIDDEN_DEF_ID } from "./observe";

function allCards(state: GameState): CardInstance[] {
  const out: CardInstance[] = [];
  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    out.push(...side.hand, ...side.library, ...side.graveyard, ...side.exile, ...side.resolving);
    for (const pile of side.units) if (pile !== null) out.push(...pile);
    for (const card of side.backrow) if (card !== null) out.push(card);
  }
  return out;
}

/**
 * One def id, uniformly, from `pool` minus `seen` minus what this determinization already sampled;
 * with replacement from the whole pool once that is empty.
 */
function sampleDef(
  pool: readonly string[],
  seen: ReadonlySet<string>,
  sampled: Set<string>,
  rng: Rng,
): string {
  const open = pool.filter((id) => !seen.has(id) && !sampled.has(id));
  if (open.length > 0) {
    const pick = open[rng.int(open.length)] as string;
    sampled.add(pick);
    return pick;
  }
  return pool[rng.int(pool.length)] ?? HIDDEN_DEF_ID;
}

function isPlaceholder(card: CardInstance): boolean {
  return card.defId === HIDDEN_DEF_ID;
}

/** R185: one concrete world consistent with `publicState` (the output of redact). Pure given rng. */
export function determinize(publicState: GameState, seat: PlayerId, rng: Rng): GameState {
  const opp = opponentOf(seat);
  const next = cloneState(publicState);

  // Step 1: a stream the match never uses.
  next.seed = `ai:${rng.int(2 ** 31)}`;
  next.rngCursor = 0;

  // Step 2: what the opponent has shown, in any zone.
  const seen = new Set<string>();
  for (const card of allCards(next)) {
    if (card.owner === opp && !isPlaceholder(card)) seen.add(card.defId);
  }
  const sampled = new Set<string>();

  // Step 3: face-down backrow placeholders, in lane order, from the Trap and Field Trap pool.
  const trapPool = query({ set: "Core", type: ["Trap", "Field Trap"] }).map((def) => def.id);
  for (const side of [opp, seat] as const) {
    for (const card of next.players[side].backrow) {
      if (card !== null && isPlaceholder(card)) card.defId = sampleDef(trapPool, seen, sampled, rng);
    }
  }

  // Step 4: the opponent's hand, then its library, in (sorted) order, from the non-token Core pool.
  const pool = query({ set: "Core", excludeIndex: [...AI_DETERMINIZE.excludeIndexes] }).map((def) => def.id);
  for (const card of next.players[opp].hand) {
    if (isPlaceholder(card)) card.defId = sampleDef(pool, seen, sampled, rng);
  }
  for (const card of next.players[opp].library) {
    if (isPlaceholder(card)) card.defId = sampleDef(pool, seen, sampled, rng);
  }

  // Step 5: the seat's own library — the opponent's cards in it sampled as in step 4, then shuffled.
  for (const card of next.players[seat].library) {
    if (isPlaceholder(card)) card.defId = sampleDef(pool, seen, sampled, rng);
  }
  next.players[seat].library = rng.shuffle(next.players[seat].library);

  // Step 6: every sampled card kept its instance id, owner, controller and zone above.
  return next;
}
