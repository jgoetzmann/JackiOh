// Deaths and the state check (SPEC §4.5). Run after each action, each whole effect or trigger, each
// cast-on-draw cast and each combat, never between the hits of one effect (R59).
// M2-T5 adds the full test set; the loop itself is here.
//
// §4.5 step 3 fires one Death hook per collected card, and a hook is an effect list like any other:
// it can open a prompt. A prompt ends the action — "mid-action choices are state, not callbacks"
// (§9.3) — so step 3 is an engine sequence that can span a pause, and `work.ts`'s header names it
// as one. It is therefore resumable through `state.work` and through nothing else (R113, R117):
//
//   * the hook's own effect list pauses through `prompts.applyResumable`, which parks the effects
//     after the one that asked;
//   * the *pass* — which cards still owe a Death hook in R68's order, which ones reserved a zone for
//     step 4's Reborn, and which ones step 5 has to report — is parked in the same work item, as
//     plain JSON, so the paused board survives `JSON.parse(JSON.stringify(state))` and replays
//     exactly. Holding the remaining units in a live array was the bug: the rest of an interrupted
//     hook ran straight over the open prompt and the next dying card's prompt was silently dropped,
//     since `openPrompt` refuses to overwrite one that is already open.
//
// R78 and R89 are why the parked item carries whole instances rather than ids. Leaving the field
// resets an instance, so a Death hook reads the snapshot taken just before the move — and a
// continuation cannot re-derive that snapshot from the board, because the board no longer has it.
// The snapshot therefore travels in `resume.data` and is what `ctx.self` is on the way back too,
// which is the whole of R89's "a Death hook still reads the whole snapshot".
//
// R117: the pass is owed at the moment it pauses and never in advance. While `runDeathPass` is on
// the stack the cards it has not reached are its own, so a resolution loop running inside one of
// them can neither take nor re-run the step it is standing in.

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, hasKeyword } from "@jackioh/shared";
import { unitView } from "./layers";
import { endOrphanedModifiers, installLastingModifiers } from "./modifiers";
import { SELF_KEY, applyResumable, type ResumePlan } from "./prompts";
import type { EngineSink } from "./resolve";
import { makeContext } from "./resolve";
import { scriptOf } from "./scripts";
import { findInstance, type CardInstance, type Resume, type WorkItem } from "./state";
import {
  PAUSE_KEY,
  owe,
  owedWork,
  pausedOf,
  registerWorkHandler,
  resumeIndex,
  segmentsOf,
  type PausedStep,
} from "./work";
import {
  activeUnitsOf,
  cardAt,
  isUnitToken,
  moveToZone,
  placeOnField,
  releaseZone,
  reserveZone,
  resetInstance,
  slotOf,
  slotsOf,
  type ZoneSlot,
} from "./zones";

/**
 * Every unit on the field: the card that acts in each unit zone, the top of its pile (§3.2).
 *
 * §4.5 step 1 collects "units with health 0 or less", and a card dormant under a Stack is not on
 * the field (§3.2, R13, R174) — so the check never reaches under a pile. The top shields what is
 * buried: an aura or a layer-2 Felinor that stops reaching a buried card cannot kill it there, and a
 * dormant card that could not survive is judged the moment it resumes on top, when the check reads
 * it with the board's auras again. It keeps its damage meanwhile (§3.2), and nothing can mark it
 * destroyed, since nothing can target it (R90). Collecting buried cards killed a damaged card the
 * moment a Stack card buried it and a positive aura stopped reaching it, and let a buried Reborn
 * card come back on top of the card acting in its zone (R175 returns onto a pile only a unit that
 * died on top of it).
 */
function unitsOf(sink: EngineSink, player: PlayerId): CardInstance[] {
  return activeUnitsOf(sink.state, player);
}

/**
 * §4.5 step 1: a unit dies at 0 or less health or when marked destroyed. Indestructible units are
 * not collected for damage or a destroy mark, but one whose max health has fallen to 0 or less is
 * (R69); one merely at 0 or less health with positive max health stays.
 */
function isDying(sink: EngineSink, unit: CardInstance): boolean {
  const view = unitView(sink.state, unit);
  const indestructible = hasKeyword(view.keywords, "Indestructible");
  if (indestructible) return view.maxHealth <= 0;
  return view.health <= 0 || unit.markedDestroyed === true;
}

function heroCheck(sink: EngineSink): boolean {
  const dead = PLAYER_IDS.filter((player) => sink.state.players[player].hero.health <= 0);
  if (dead.length === 0) return false;
  const winner = dead.length === 2 ? "draw" : (dead[0] === "p1" ? "p2" : "p1");
  const reason = dead.length === 2 ? "both-heroes-dead" : "hero-death";
  sink.state.result = { winner, reason };
  sink.state.phase = "over";
  sink.events.push({ type: "gameOver", winner, reason });
  return true;
}

/** Every backrow card in play for this player, in lane order (§3). */
function backrowOf(sink: EngineSink, player: PlayerId): CardInstance[] {
  return slotsOf(player, "backrow").flatMap((ref) => {
    const card = cardAt(sink.state, ref);
    return card === null ? [] : [card];
  });
}

/**
 * R46: a marked Indestructible unit switches to Attack Position and loses Taunt for the turn.
 * A backrow card has no position, so an Indestructible Field Spell simply keeps its zone and the
 * mark is dropped with no event.
 */
function resolveIndestructibleMarks(sink: EngineSink): void {
  for (const player of PLAYER_IDS) {
    for (const unit of unitsOf(sink, player)) {
      if (unit.markedDestroyed !== true) continue;
      const view = unitView(sink.state, unit);
      if (!hasKeyword(view.keywords, "Indestructible") || view.maxHealth <= 0) continue;
      unit.markedDestroyed = false;
      unit.tauntSuppressedTurn = sink.state.turn;
      // R91: a unit already in Attack Position has nothing to switch, so nothing is reported — the
      // event is §10.10's 90° turn, and a unit that did not move must not be seen to.
      if (view.position === "ATK") continue;
      unit.position = "ATK";
      sink.events.push({ type: "positionSwitched", instanceId: unit.id, position: "ATK" });
    }
    for (const card of backrowOf(sink, player)) {
      if (card.markedDestroyed !== true) continue;
      if (!hasKeyword(unitView(sink.state, card).keywords, "Indestructible")) continue;
      card.markedDestroyed = false;
    }
  }
}

// ---------------------------------------------------------------------------
// One pass of §4.5 steps 3 to 5, and the remainder it owes (R113, R117)
// ---------------------------------------------------------------------------

/**
 * R113: the `resume.hook` of the one work item this module parks — the rest of a state-check pass.
 * It is an engine sequence and not a card's, so the name is one no `Script` can hold, and
 * `runOwedDeaths` below is registered for it at module scope, in the module that owns the sequence
 * and never from a test: `work.runWorkItem` raises on a hook nothing knows, and a pass that cannot
 * be resumed is exactly the lost sequence R113 exists to prevent.
 */
export const DEATHS_WORK = "@deaths";

/** The pass has one step, named so a reader of `state.work` can see what is owed. */
const DEATHS_STEP = "hooks";

/** Where the pass sits inside `resume.data`, so `work.ts`'s pause block keeps its own key. */
const PASS_KEY = "pass";

/**
 * What one pass of the check still owes once its collected cards have moved (§4.5 steps 3 to 5),
 * as plain JSON:
 *
 *  - `owed`   — step 3's Death hooks still to fire, in R68's order, each as the snapshot of the card
 *               taken just before it left the field. R78 has already reset the instance on the
 *               board, so the snapshot is the only place the hook's `ctx.self` can come from (R89),
 *               and a continuation cannot re-derive it — hence it travels here (R127).
 *  - `reborn` — step 4's returns: which collected unit had Reborn and which zone it reserved (R64).
 *               The instance is found again by id when the step runs, so a Death hook that removed
 *               it in between cannot be resurrected by a stale reference.
 *  - `collected` — step 5's report: `enteredGraveyard` for everything that is still in a graveyard
 *               once Reborn has taken its own back out (R47).
 */
export type DeathPass = {
  owed: CardInstance[];
  /**
   * `token` is set for a unit token, which ceased to exist as it left the field (R11) and so cannot
   * be found again by id: it is the card as it left, which step 4 brings back instead (R175).
   * `face` is the X/X a token was summoned with (§7's `statsOverride`, and the Bread Token's
   * `armorOverride`), which is its printed face (§10.4 layer 1) and so comes back with it (R175).
   */
  reborn: { id: string; at: ZoneSlot; token?: CardInstance; face?: RebornFace }[];
  collected: { id: string; defId: string; owner: PlayerId }[];
};

/**
 * R175: the face a Reborn body comes back with when the card was summoned X/X. §10.4 layer 1 reads a
 * token's printed stats off `statsOverride` ("printed 0/0; always summoned as X/X", §7), so it is the
 * card's face and not a change to it: R78's reset takes the override off a card that leaves the field
 * for a pile, but a body that returns at 1 health returns as the card it was printed as, and a Bread
 * Token that came back 0/0 at 0 health would only die again at the next pass.
 */
type RebornFace = { statsOverride?: { attack: number; health: number }; armorOverride?: number };

function rebornFaceOf(unit: CardInstance): RebornFace | undefined {
  if (unit.statsOverride === undefined && unit.armorOverride === undefined) return undefined;
  return {
    ...(unit.statsOverride === undefined ? {} : { statsOverride: { ...unit.statsOverride } }),
    ...(unit.armorOverride === undefined ? {} : { armorOverride: unit.armorOverride }),
  };
}

/** Plain JSON, never a live array: what is parked must survive a round trip (§9.3, §10.1). */
function passJson(pass: DeathPass): DeathPass {
  return JSON.parse(JSON.stringify(pass)) as DeathPass;
}

function instancesOf(raw: unknown): CardInstance[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (card): card is CardInstance =>
      card !== null && typeof card === "object" && typeof (card as CardInstance).id === "string",
  );
}

/**
 * What a `DEATHS_WORK` item owes, or null when it is not one: the reader for its payload, read back
 * defensively because the item came through JSON (§10.1).
 */
export function owedDeathsOf(resume: Resume): DeathPass | null {
  if (resume.hook !== DEATHS_WORK) return null;
  const raw = resume.data[PASS_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const pass = raw as Partial<DeathPass>;
  return {
    owed: instancesOf(pass.owed),
    reborn: Array.isArray(pass.reborn) ? pass.reborn : [],
    collected: Array.isArray(pass.collected) ? pass.collected : [],
  };
}

/**
 * The continuation of the pass as it stands now. `prompts.applyResumable` is handed this as its
 * plan, so the tail of a Death hook that asks is parked as *this* item — the hook's own remaining
 * effects and the rest of the pass in one record, which is what keeps R113's order right without
 * two items racing each other.
 */
function planFor(pass: DeathPass, owner: PlayerId): ResumePlan {
  return {
    defId: "",
    hook: DEATHS_WORK,
    step: DEATHS_STEP,
    radiant: false,
    data: { [PASS_KEY]: passJson(pass) },
    owner,
  };
}

/**
 * Park the rest of the pass (R113). `work.ts` owns `state.work`, so this only ever calls `owe`: the
 * item lands at `state.workCursor`, which puts it behind anything the pausing hook's own effects
 * parked inside it and — when a resumption parks again — in front of everything else still owed.
 *
 * R117: every caller calls this at the moment it actually pauses and never in advance.
 */
function oweDeaths(sink: EngineSink, pass: DeathPass, step: PausedStep | null): void {
  const resume: Resume = {
    defId: "",
    hook: DEATHS_WORK,
    step: DEATHS_STEP,
    radiant: false,
    data: {
      [PASS_KEY]: passJson(pass),
      ...(step === null ? {} : { [PAUSE_KEY]: { ...step } }),
    },
  };
  owe(sink, resume);
}

/**
 * §4.5 step 4: each collected unit that had Reborn returns to its reserved zone (unless the zone was
 * Locked meanwhile) at 1 health without Reborn, as a reset instance (R78); its Cry does not fire,
 * and because it has entered the field again it is summoning sick for the rest of that turn (R83).
 */
function rebornStep(sink: EngineSink, pass: DeathPass): void {
  for (const entry of pass.reborn) {
    releaseZone(sink.state, entry.at);
    // R127's shape at the level of a unit: the pass names it by id, so a Death hook that exiled or
    // unmade it in between leaves nothing to bring back rather than a stale object to resurrect.
    // A unit token is the exception R175 makes: it ceased to exist as it left (R11), so no pile
    // holds it and the pass carries the card as it left instead, reset the way R78 resets any
    // Reborn body on its way out.
    const copy = entry.token === undefined ? findInstance(sink.state, entry.id) : rebornToken(entry.token);
    if (copy === undefined) continue;
    copy.grantedKeywords = copy.grantedKeywords.filter((k) => k.kind !== "Reborn");
    copy.vanilla = false;
    // R175: an X/X token's X/X is its printed face, so the body keeps it through the reset.
    if (entry.face?.statsOverride !== undefined) copy.statsOverride = { ...entry.face.statsOverride };
    if (entry.face?.armorOverride !== undefined) copy.armorOverride = entry.face.armorOverride;
    // R175: a unit that died on top of a Stack pile left the card beneath to resume in its zone
    // (§3.2), and that card did not enter anything, so the zone is still the one R64 reserved. The
    // body returns on top of the pile, and the card beneath goes dormant again. With no pile the
    // zone is empty, which `stack` never changes: every other card was kept out by the reservation.
    const back = placeOnField(sink.state, copy, entry.at, { stack: true });
    if (!back) continue;
    const view = unitView(sink.state, copy);
    copy.damage = Math.max(0, view.maxHealth - 1);
    copy.rebornSpent = true;
    // R83: it enters the field again now, so it is summoning sick like any fresh summon.
    copy.summonedTurn = sink.state.turn;
    sink.state.players[copy.owner].graveyard = sink.state.players[copy.owner].graveyard.filter(
      (card) => card.id !== copy.id,
    );
    sink.events.push({
      type: "summoned",
      player: copy.controller,
      instanceId: copy.id,
      defId: copy.defId,
      row: entry.at.row,
      lane: entry.at.lane,
    });
  }
}

/**
 * R175: the body a unit token with Reborn comes back as. The snapshot is the token as it left the
 * field, so R78's reset is applied here, where `moveToZone` would have applied it had the token
 * reached a pile: damage, buffs, granted keywords, counters, memory, exertion and controller go,
 * and the zone is set by `placeOnField`.
 */
function rebornToken(snapshot: CardInstance): CardInstance {
  const body = JSON.parse(JSON.stringify(snapshot)) as CardInstance;
  resetInstance(body);
  return body;
}

/**
 * A card that came straight back through Reborn never stayed in the graveyard, so only the ones
 * still there are reported — including a Reborn whose zone was Locked meanwhile (R47).
 */
function graveyardStep(sink: EngineSink, pass: DeathPass): void {
  for (const entry of pass.collected) {
    const stayed = sink.state.players[entry.owner].graveyard.some((card) => card.id === entry.id);
    if (!stayed) continue;
    sink.events.push({
      type: "enteredGraveyard",
      instanceId: entry.id,
      defId: entry.defId,
      owner: entry.owner,
    });
  }
}

/**
 * §4.5 steps 3 to 5 for one pass, resumably. Returns true when the pass finished, false when a
 * prompt (or the end of the game) stopped it — in which case what is left is on `state.work`.
 *
 * `at` is the control block a resumption brings back: the first card in `owed` is then part-way
 * through its own effect list and continues at that index, with the selections the pause captured.
 */
function runDeathPass(sink: EngineSink, pass: DeathPass, at: PausedStep | null): boolean {
  let resumeAt = at;

  for (;;) {
    // The game ending stops the pass for good: there is nothing left to resume into.
    if (sink.state.result !== null) return false;

    const snapshot = pass.owed[0];
    if (snapshot === undefined) break;

    // §9.3: a prompt is state, so the cards from here on wait for the answer action — and they have
    // not had their Death hook, which is precisely what is owed (R113). A prompt already open when
    // the pass begins means it has fired nothing at all, so the whole of step 3 is owed.
    if (sink.state.pending !== null) {
      oweDeaths(sink, pass, resumeAt);
      return false;
    }

    // §5.2: the face the card was wearing as it died, which is the snapshot's own.
    const hook = scriptOf(snapshot).death;
    if (hook === undefined) {
      pass.owed.shift();
      resumeAt = null;
      continue;
    }

    const ctx = makeContext(sink, snapshot, {
      controller: snapshot.controller,
      targets: resumeAt?.targets ?? [],
      modes: resumeAt?.modes ?? [],
      // R89: a prompt this hook opens is answered in a later action, when the instance on the board
      // is R78's reset one; the step it re-enters reads this snapshot instead (`prompts.runResume`).
      data: { [SELF_KEY]: snapshot },
    });
    const effects = hook(ctx);
    // A fused Death runs every ingredient's list (R77, R102), which continues part by part.
    const from = resumeIndex(effects, resumeAt);
    resumeAt = null;

    const owedBefore = owedWork(sink.state, DEATHS_WORK).length;
    if (applyResumable(sink, ctx, planFor(pass, snapshot.controller), effects, from)) {
      pass.owed.shift();
      continue;
    }

    if (sink.state.result !== null) return false;
    // `applyResumable` parked this pass when the hook had effects left after the one that asked.
    // When the *last* effect asked there was no tail to park, and the pass still owes the cards
    // after this one and steps 4 and 5 — so it parks itself, at the index that ends this hook.
    if (owedWork(sink.state, DEATHS_WORK).length === owedBefore) {
      const segments = segmentsOf(effects);
      oweDeaths(sink, pass, {
        from: effects.length,
        targets: [...ctx.targets],
        modes: [...ctx.modes],
        ...(segments === undefined ? {} : { segments }),
      });
    }
    return false;
  }

  // Neither of these can ask anything, so they finish the pass once step 3 is done.
  rebornStep(sink, pass);
  graveyardStep(sink, pass);
  return true;
}

/**
 * `work.ts`'s handler for a parked pass: the same pass, continued where it stopped (R113, R122).
 * Once it is done the check goes round again, because §4.5 step 5 repeats until nothing changes and
 * the pause did not excuse the pass from its repeat.
 */
function runOwedDeaths(sink: EngineSink, item: WorkItem): void {
  const pass = owedDeathsOf(item.resume);
  if (pass === null) return;
  if (!runDeathPass(sink, pass, pausedOf(item.resume.data))) return;
  stateCheck(sink);
}

registerWorkHandler(DEATHS_WORK, runOwedDeaths);

// ---------------------------------------------------------------------------
// The check itself (§4.5)
// ---------------------------------------------------------------------------

/** §4.5 loops until nothing changes; this bounds a pathological loop loudly (R69, R89). */
export const STATE_CHECK_PASS_CAP = 100;

/** How a collected card left: the state check's own collection, or a Sacrifice (§6.3). */
type DeathCause = "collected" | "sacrificed";

/**
 * §4.5 step 1: collect, in R68's order, and move them all at once — units by health or a destroy
 * mark, backrow cards by a destroy mark, since they have no health of their own — leaving the pass
 * that steps 3 to 5 still owe.
 *
 * "At once" is two loops, not one. Every collected card is read — its layers for R89's `destroyed`
 * event, its Reborn for step 4 and its snapshot for step 3 — before any of them moves, because a
 * card's layers depend on the others: an aura source (#65.1 Spikey Pillow's −2 attack) or a Felinor
 * a #92 Felinor Fiender counts at layer 2 that was moved first would leave the next card read
 * without it, so what it "was as it died" would hang on nothing but lane order.
 *
 * A Sacrifice (§6.3) "counts as a death" and reaches the same pass through `sacrificeNow`: it is no
 * damage instance, so it names no killer (R42), and it bypasses Indestructible, which is why the
 * caller rather than `isDying` decides it dies.
 */
function collect(sink: EngineSink, dying: readonly CardInstance[], cause: DeathCause = "collected"): DeathPass {
  const pass: DeathPass = { owed: [], reborn: [], collected: [] };

  const read = dying.map((unit) => {
    const view = unitView(sink.state, unit);
    return {
      unit,
      view,
      at: slotOf(sink.state, unit),
      token: isUnitToken(sink.state, unit),
      // R78 resets an instance as it leaves, so the Death hook of step 3 reads this snapshot (R89).
      snapshot: JSON.parse(JSON.stringify(unit)) as CardInstance,
    };
  });

  for (const { unit, view, at, token, snapshot } of read) {
    pass.owed.push(snapshot);
    pass.collected.push({ id: unit.id, defId: unit.defId, owner: unit.owner });
    if (hasKeyword(view.keywords, "Reborn") && at !== null) {
      reserveZone(sink.state, at);
      // R175: a unit token ceases to exist below and no pile will hold it, so its return is
      // carried by the pass itself, with the X/X it was summoned as.
      const face = rebornFaceOf(unit);
      pass.reborn.push({ id: unit.id, at, ...(token ? { token: snapshot } : {}), ...(face === undefined ? {} : { face }) });
    }
    sink.state.counters.destroyed += 1;
    // R89: the event carries what the card was, since R78 resets the instance as it leaves.
    sink.events.push({
      type: "destroyed",
      instanceId: unit.id,
      defId: unit.defId,
      owner: unit.owner,
      attack: view.attack,
      maxHealth: view.maxHealth,
      // R42, R89: the unit whose damage instance was lethal. `damage.ts` credits a hit only as it
      // takes the unit from above 0 health to 0 or less (or Poisonous marks it), and a destroy
      // effect clears the credit as it marks (`effects/destroy.ts`), so a unit a spell destroyed or
      // an aura starved after some unit damaged it has no killer. A sacrifice has none either.
      killerId: cause === "sacrificed" ? null : (unit.lastDamagedBy ?? null),
    });
    moveToZone(sink.state, unit, "graveyard");
  }

  return pass;
}

/**
 * §6.3 Sacrifice: the card goes from the field to its owner's graveyard at once, bypassing
 * Indestructible, and "counts as a death" — so it is §4.5's death in full rather than a move with a
 * Death hook bolted on: the destroyed counter (R55) and the `destroyed` event (R89), its Death hook
 * off the snapshot (R78), and §6.1's Reborn, which returns a sacrificed Reborn unit to the zone it
 * reserved at 1 health (R64, R83), exactly as the state check returns a unit that died there. A
 * Death hook that asks pauses the rest of the pass on `state.work` like any other (R113). Step 2's
 * hero check is left to the state check that follows the whole effect (R59): a sacrifice is one
 * effect among the list that made it, and nothing about it touches a hero.
 */
export function sacrificeNow(sink: EngineSink, card: CardInstance): void {
  runDeathPass(sink, collect(sink, [card], "sacrificed"), null);
}

/**
 * §6.3 Tribute: "sacrifice X of your units" is one payment, the tributed set of R101, so the set
 * dies together, the way §4.5 step 1 moves everything it collects at once: every unit is read before
 * any of them moves, then all move, and their Death hooks fire in R68's order — "Death triggers use
 * the same side and lane order (§4.5)" — not in the order a play happened to list them. Listed one
 * by one, the first sacrifice's Death ran before the others had died, so the client chose the order
 * the Deaths resolved in (#81's Death radiating a unit #86's Death was about to steal, or not).
 */
export function sacrificeTogether(sink: EngineSink, cards: readonly CardInstance[]): void {
  if (cards.length === 0) return;
  // R68's walk: the active player's side, then the opponent's; units, then the backrow; lane 1 up.
  const order: PlayerId[] = sink.state.active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
  const ordered = order.flatMap((player) =>
    (["units", "backrow"] as const).flatMap((row) =>
      slotsOf(player, row).flatMap((ref) =>
        cards.filter((card) => {
          const at = slotOf(sink.state, card);
          return at !== null && at.player === ref.player && at.row === ref.row && at.lane === ref.lane;
        }),
      ),
    ),
  );
  runDeathPass(sink, collect(sink, ordered, "sacrificed"), null);
}

/**
 * R42: `lastDamagedBy` names the hit that took a unit to 0 or less health. A unit the check leaves
 * standing above 0 — healed, buffed, or given back its health by an aura leaving — was killed by no
 * hit, so an older credit must not name the killer of a death the layers cause later.
 */
function forgetSpentKillers(sink: EngineSink, survivors: readonly CardInstance[]): void {
  for (const unit of survivors) {
    if (unit.lastDamagedBy === undefined) continue;
    if (unitView(sink.state, unit).health > 0) delete unit.lastDamagedBy;
  }
}

export function stateCheck(sink: EngineSink): void {
  for (let pass = 0; pass < STATE_CHECK_PASS_CAP; pass += 1) {
    if (sink.state.result !== null) return;
    resolveIndestructibleMarks(sink);
    endOrphanedModifiers(sink);
    installLastingModifiers(sink);

    const order: PlayerId[] = sink.state.active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
    const units = order.flatMap((player) => unitsOf(sink, player));
    const dyingUnits = units.filter((unit) => isDying(sink, unit));
    forgetSpentKillers(sink, units.filter((unit) => !dyingUnits.includes(unit)));
    const dying = [
      ...dyingUnits,
      ...order.flatMap((player) =>
        backrowOf(sink, player).filter((card) => card.markedDestroyed === true),
      ),
    ];

    if (dying.length === 0) {
      if (heroCheck(sink)) return;
      return;
    }

    const collected = collect(sink, dying);

    // Step 2: heroes.
    if (heroCheck(sink)) return;

    // Steps 3 to 5, which a Death hook's prompt can pause: what is left is then owed in state and
    // `runOwedDeaths` brings the check back, repeat included.
    if (!runDeathPass(sink, collected, null)) return;
  }

  // §4.5 repeats "until nothing changes"; a board that never settles is a bug, not a draw.
  throw new Error(`the board did not settle in ${STATE_CHECK_PASS_CAP} passes`);
}
