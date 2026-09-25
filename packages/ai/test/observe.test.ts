// What the AI may know (SPEC §9.9, R185; docs/polish/3-ai.md B9–B12).
//
// `redact(state, seat)` is the only code that reads a true state, and `determinize` turns what it
// leaves into one concrete world. The proofs here are all observable: two true states that differ
// only in what the seat cannot see redact to the same hash and give the same decision; a
// determinized world shows the seat exactly the view the true state shows it; and every card the
// seat can read comes through a determinization untouched.
//
// The fixed pair (B9, B11) is the one the design names: p2's hand #2 Bigot and #11 Tempo Timmy
// against #53 Reno and #20 Pointmaster, a face-down #41 Sheepish against a face-down #60 Bear
// Honeypot, different p2 libraries, a reordered p1 library and different seeds. The mutation
// property (fast-check) generalises it to random mutations of random real games.

import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import {
  beginGame,
  createGame,
  createRng,
  defOf,
  hashState,
  effects,
  newInstance,
  query,
  registerScripts,
  registeredScripts,
  seatToAct,
  viewFor,
  type CardInstance,
  type GameState,
  type Script,
} from "@jackioh/engine";
import {
  AI_DETERMINIZE,
  HIDDEN_DEF_ID,
  decide,
  determinize,
  hiddenInstanceIds,
  redact,
} from "../src/index";
import {
  AI,
  act,
  cardById,
  clone,
  corePool,
  dealtGame,
  everyCard,
  isLegal,
  randomDecks,
  randomPolicyStates,
  scenario,
  trapPool,
  type ScenarioOptions,
} from "./_support";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const P1_SIDE = {
  hand: ["core-008", "core-035"],
  field: ["core-011"],
  library: ["core-020", "core-053", "core-025"],
} as const;

const P2_A = {
  hand: ["core-002", "core-011"],
  field: ["core-019"],
  backrow: [{ def: "core-041", faceUp: false }],
  library: ["core-005", "core-016", "core-047"],
  health: 20,
} as const;

const P2_B = {
  hand: ["core-053", "core-020"],
  field: ["core-019"],
  backrow: [{ def: "core-060", faceUp: false }],
  library: ["core-063", "core-044", "core-072"],
  health: 20,
} as const;

function build(seed: string, p2: ScenarioOptions["p2"], p1: ScenarioOptions["p1"] = P1_SIDE): GameState {
  return scenario({ seed, p1, p2 }).state;
}

/** A and B differ only in what p1 cannot see: p2's hidden cards, p1's library order and the seed. */
function pair(): { a: GameState; b: GameState } {
  const a = build("observe-a", P2_A);
  const b = clone(build("observe-b", P2_B));
  b.players.p1.library = [...b.players.p1.library].reverse();
  return { a, b };
}

function idsOf(cards: readonly CardInstance[]): string[] {
  return cards.map((card) => card.id);
}

/** The seat-visible fields B12 says a determinization leaves alone. */
function readable(card: CardInstance): unknown {
  return {
    id: card.id,
    defId: card.defId,
    zone: card.zone,
    radiant: card.radiant,
    damage: card.damage,
    buffs: card.buffs,
  };
}

function isHiddenBackrow(state: GameState, card: CardInstance, seat: PlayerId): boolean {
  return card.controller !== seat && card.faceUp !== true && defOf(state, card.defId).type !== "Field Spell";
}

/**
 * B9's mutation: rewrite everything `seat` may not know and nothing else. The opponent's hand and
 * library get new identities (and Radiant flags) and a new order, every backrow card the seat
 * cannot read gets another Trap, the seat's own library is reordered, and seed, cursor and the
 * nonce log are replaced.
 */
function mutateHidden(state: GameState, seat: PlayerId, seed: number): GameState {
  const out = clone(state);
  const rng = createRng(`observe-mutate:${seed}`);
  const opp = opponentOf(seat);
  const pool = corePool();
  const traps = trapPool();
  for (const card of [...out.players[opp].hand, ...out.players[opp].library]) {
    card.defId = rng.pick(pool) as string;
    card.radiant = rng.coin();
  }
  for (const player of PLAYER_IDS) {
    for (const card of out.players[player].backrow) {
      if (card !== null && isHiddenBackrow(state, card, seat)) card.defId = rng.pick(traps) as string;
    }
  }
  out.players[opp].hand = rng.shuffle(out.players[opp].hand);
  out.players[opp].library = rng.shuffle(out.players[opp].library);
  out.players[seat].library = rng.shuffle(out.players[seat].library);
  out.seed = `observe-mutated-${seed}`;
  out.rngCursor = rng.int(10_000);
  out.applied = [];
  return out;
}

/** viewFor without its event tail, which B10 exempts. */
function viewWithoutEvents(state: GameState, seat: PlayerId): unknown {
  const { events: _events, ...rest } = viewFor(state, seat);
  return rest;
}

// Real mid-game states for the property and for B10 (ids minted by createGame, both seats valid).
const REAL_STATES: GameState[] = [
  ...randomPolicyStates("observe-real-1", 7, 600),
  ...randomPolicyStates("observe-real-2", 9, 600),
  ...randomPolicyStates("observe-real-3", 5, 400),
];

// ---------------------------------------------------------------------------------------------
// B9: redact
// ---------------------------------------------------------------------------------------------

describe("redact (B9)", () => {
  it("R185 B9: two states differing only in p2's hidden hand, face-down trap, library, p1's library order and the seed redact to one hash", () => {
    const { a, b } = pair();
    expect(hashState(a)).not.toBe(hashState(b));
    expect(hashState(redact(a, AI))).toBe(hashState(redact(b, AI)));
  });

  it("R185 B9: redact does not mutate its input", () => {
    const { a } = pair();
    const before = JSON.stringify(a);
    redact(a, AI);
    expect(JSON.stringify(a)).toBe(before);
  });

  it("R185 B9: the hidden set is the opponent's hand and library plus the backrow the seat cannot read", () => {
    const { a } = pair();
    const expected = new Set([
      ...idsOf(a.players.p2.hand),
      ...idsOf(a.players.p2.library),
      ...a.players.p2.backrow.flatMap((card) => (card === null ? [] : [card.id])),
    ]);
    expect(hiddenInstanceIds(a, AI)).toEqual(expected);
  });

  it("R185 B9: hidden cards become placeholders; every public field, the seat's hand and the seed-free history stay", () => {
    const { a } = pair();
    const pub = redact(a, AI);
    const hidden = hiddenInstanceIds(a, AI);

    expect(pub.seed).toBe("redacted");
    expect(pub.rngCursor).toBe(0);
    expect(pub.applied).toEqual([]);
    for (const id of hidden) {
      const card = cardById(pub, id);
      expect(card, id).toBeDefined();
      expect(card?.defId, id).toBe(HIDDEN_DEF_ID);
      expect(card?.radiant, id).toBe(false);
    }
    // p2's hand is re-ordered by numeric id, which erases the true order.
    const handIds = idsOf(pub.players.p2.hand).map((id) => Number(id.slice(1)));
    expect(handIds).toEqual([...handIds].sort((x, y) => x - y));
    // Public cards and the seat's own hand are untouched.
    expect(pub.players.p1.hand.map((card) => card.defId)).toEqual(["core-008", "core-035"]);
    expect(pub.players.p2.units.flatMap((pile) => pile ?? []).map((card) => card.defId)).toEqual(["core-019"]);
    expect(pub.players.p1.units.flatMap((pile) => pile ?? []).map((card) => card.defId)).toEqual(["core-011"]);
    expect(pub.players.p2.hero.health).toBe(20);
    expect(pub.players.p2.hand).toHaveLength(2);
    expect(pub.players.p2.library).toHaveLength(3);
    expect(pub.players.p1.library.map((card) => card.defId).sort()).toEqual(["core-020", "core-025", "core-053"]);
  });

  it("R185 B9: with nothing in the opponent's hand, library or face-down backrow, nothing is hidden", () => {
    const state = build("observe-nothing-hidden", { field: ["core-019"], graveyard: ["core-044"] }, { hand: ["core-008"] });
    expect(hiddenInstanceIds(state, AI).size).toBe(0);
    const pub = redact(state, AI);
    for (const card of everyCard(state)) expect(readable(cardById(pub, card.id) as CardInstance)).toEqual(readable(card));
  });

  it("R185 B9: the seat's own face-down trap is not hidden from it", () => {
    const state = build("observe-own-trap", P2_A, { ...P1_SIDE, backrow: [{ def: "core-041", faceUp: false }] });
    const own = state.players.p1.backrow.find((card) => card !== null);
    expect(own?.defId).toBe("core-041");
    expect(hiddenInstanceIds(state, AI).has((own as CardInstance).id)).toBe(false);
    expect(cardById(redact(state, AI), (own as CardInstance).id)?.defId).toBe("core-041");
  });

  it("R185 B9: the opponent's Field Spell is public even when it is not flagged face-up", () => {
    const state = build("observe-field-spell", { ...P2_A, backrow: [{ def: "core-006", faceUp: false }] });
    const well = state.players.p2.backrow.find((card) => card !== null) as CardInstance;
    expect(well.defId).toBe("core-006");
    expect(hiddenInstanceIds(state, AI).has(well.id)).toBe(false);
    expect(cardById(redact(state, AI), well.id)?.defId).toBe("core-006");
  });

  it("R185 B9: the opponent's open prompt reaches the seat with no options", () => {
    const s = scenario({
      seed: "observe-their-prompt",
      active: "p2",
      turn: 10,
      p1: { hand: ["core-008"] },
      p2: { hand: ["core-072"], graveyard: ["core-044", "core-008"], library: ["core-011"] },
    });
    s.play("core-072");
    const state = s.state;
    expect(state.pending?.playerId).toBe("p2");
    expect(state.pending?.options.length).toBeGreaterThan(0);

    const pub = redact(state, AI);
    expect(pub.pending?.playerId).toBe("p2");
    expect(pub.pending?.options).toEqual([]);
    // The seat's own prompt keeps its options: seen from p2 nothing is removed.
    expect(redact(state, "p2").pending?.options).toEqual(state.pending?.options);
  });

  it("R266 B9: while both mulligans are open, the opponent's sealed answer and its options reach the seat as nothing", () => {
    const dealt = dealtGame("observe-their-mulligan");
    const keptAll = act(dealt, "p2", { type: "mulligan", keep: dealt.players.p2.hand.map((card) => card.id) });
    const keptNone = act(dealt, "p2", { type: "mulligan", keep: [] });

    // Whatever p2 kept, the seat's state is the same: only that p2 has answered (R265, R266).
    expect(hashState(redact(keptNone, AI))).toBe(hashState(redact(keptAll, AI)));
    const pub = redact(keptAll, AI);
    expect(pub.mulligan?.p2.keep).toEqual([]);
    expect(pub.mulligan?.p2.prompt.options).toEqual([]);
    // The seat's own mulligan keeps its options, and it answers it without waiting.
    expect(pub.mulligan?.p1.prompt.options).toEqual(keptAll.mulligan?.p1.prompt.options);
    expect(decide(keptAll, AI, { rng: createRng("observe-their-mulligan") })?.reason).toBe("mulligan");
  });

  it("R266 B9: a sealed answer owed behind the seat's own paused resolution reaches it as keeping everything", () => {
    // A cast-on-draw Spell that asks its caster (no Core one asks, so a fixture): p1's replacement
    // draw casts it, and p2's sealed answer waits in setup's owed item until p1 answers (R224, R265).
    const asking = "ai-r266-cod-asks";
    const script: Script = {
      staticFlags: { castOnDraw: true },
      cry: () => [effects.chooseMode({ options: ["ok"], step: "ok", prompt: "the cast's question" })],
      resume: { ok: () => [] },
    };
    registerScripts({ ...registeredScripts(), [asking]: { base: script, radiant: script } });
    const paused = (p2Keeps: "all" | "none"): GameState => {
      const dealt = dealtGame("observe-owed-mulligan");
      dealt.transientDefs[asking] = {
        id: asking,
        index: asking,
        name: asking,
        set: "Core",
        type: "Spell",
        tags: [],
        rarity: "Common",
        token: false,
        cost: 0,
        base: { keywords: [], text: asking },
        radiant: { keywords: [], text: asking },
      };
      dealt.players.p1.library.unshift(newInstance(dealt, asking, "p1", { z: "library", player: "p1" }));
      const keep = p2Keeps === "all" ? dealt.players.p2.hand.map((card) => card.id) : [];
      const sealed = act(dealt, "p2", { type: "mulligan", keep });
      return act(sealed, "p1", { type: "mulligan", keep: sealed.players.p1.hand.slice(1).map((card) => card.id) });
    };
    const keptAll = paused("all");
    const keptNone = paused("none");
    expect(keptAll.pending?.playerId).toBe(AI);
    expect(keptAll.work.length).toBeGreaterThan(0);

    // The seat is asked now, and what it may know is the same whatever p2 kept.
    expect(hashState(redact(keptNone, AI))).toBe(hashState(redact(keptAll, AI)));
    expect(decide(keptNone, AI, { rng: createRng("observe-owed") })?.action).toEqual(
      decide(keptAll, AI, { rng: createRng("observe-owed") })?.action,
    );
  });

  it("R185 B9: a card in the seat's own library that was minted for the opponent's deck (R73) is hidden too", () => {
    const state = clone(beginGame(createGame({ seed: "observe-r73", decks: randomDecks("observe-r73") })).state);
    // #87's library swap, reduced to its effect on two cards: they now sit in p1's library.
    const moved = state.players.p2.library.splice(0, 2);
    for (const card of moved) card.zone = { z: "library", player: "p1" };
    state.players.p1.library.push(...moved);

    const hidden = hiddenInstanceIds(state, AI);
    for (const card of moved) expect(hidden.has(card.id), card.id).toBe(true);
    for (const card of state.players.p1.library) {
      if (moved.includes(card)) continue;
      expect(hidden.has(card.id), `${card.id} is p1's own card`).toBe(false);
    }
    for (const card of state.players.p1.hand) expect(hidden.has(card.id)).toBe(false);

    const pub = redact(state, AI);
    for (const card of moved) expect(cardById(pub, card.id)?.defId).toBe(HIDDEN_DEF_ID);
  });

  it("R312 a card in the seat's own library it was never shown is hidden, so what it is cannot move a decision", () => {
    const a = clone(beginGame(createGame({ seed: "observe-r312", decks: randomDecks("observe-r312") })).state);
    // #83's library replacements (or a library #87 swapped away and back), reduced to two cards:
    // p1 was never shown them, so its own `viewFor` counts them unknown (R312) and so must the AI.
    const replaced = a.players[AI].library.slice(0, 2);
    for (const card of replaced) delete card.knownAs;
    const b = clone(a);
    const legendary = "core-052";
    for (const card of b.players[AI].library.slice(0, 2)) {
      card.defId = legendary;
      card.radiant = true;
    }

    const hidden = hiddenInstanceIds(a, AI);
    for (const card of replaced) expect(hidden.has(card.id), card.id).toBe(true);
    for (const card of a.players[AI].library.slice(2)) expect(hidden.has(card.id), `${card.id} is known`).toBe(false);
    expect(viewFor(a, AI).you.ownLibrary?.unknown).toBe(2);
    expect(hashState(redact(b, AI))).toBe(hashState(redact(a, AI)));
    for (const card of replaced) expect(cardById(redact(b, AI), card.id)?.defId).toBe(HIDDEN_DEF_ID);
  });

  it("R185 B9: a different public unit on the opponent's field changes the redacted hash", () => {
    const a = build("observe-a", P2_A);
    const c = build("observe-a", { ...P2_A, field: ["core-025"] });
    expect(hashState(redact(c, AI))).not.toBe(hashState(redact(a, AI)));
  });

  it("R185 B9: a face-up backrow card is readable, so its identity changes the redacted hash", () => {
    const a = build("observe-faceup", { ...P2_A, backrow: [{ def: "core-041", faceUp: true }] });
    const b = build("observe-faceup", { ...P2_A, backrow: [{ def: "core-060", faceUp: true }] });
    expect(hashState(redact(a, AI))).not.toBe(hashState(redact(b, AI)));
  });

  it("R185 B9: the seat's own hand is known, so a different own hand changes the redacted hash", () => {
    const a = build("observe-a", P2_A);
    const b = build("observe-a", P2_A, { ...P1_SIDE, hand: ["core-008", "core-044"] });
    expect(hashState(redact(a, AI))).not.toBe(hashState(redact(b, AI)));
  });

  it("R185 B9: the seat knows its own library's contents, so different contents change the redacted hash", () => {
    const a = build("observe-a", P2_A);
    const b = build("observe-a", P2_A, { ...P1_SIDE, library: ["core-020", "core-053", "core-019"] });
    expect(hashState(redact(a, AI))).not.toBe(hashState(redact(b, AI)));
  });

  it("R185 B9: the opponent's hand size is public, so one more hidden card changes the redacted hash", () => {
    const a = build("observe-a", P2_A);
    const b = build("observe-a", { ...P2_A, hand: ["core-002", "core-011", "core-005"] });
    expect(hashState(redact(a, AI))).not.toBe(hashState(redact(b, AI)));
  });

  it("R185 B9: from the other seat the same two states are not alike (p2 reads its own hand)", () => {
    const { a, b } = pair();
    expect(hashState(redact(a, "p2"))).not.toBe(hashState(redact(b, "p2")));
  });

  it("R185 B9: property: any mutation of what the seat cannot know leaves the redacted hash unchanged", { timeout: 120_000 }, () => {
    const bases: { state: GameState; seats: PlayerId[] }[] = [
      { state: pair().a, seats: [AI] },
      ...REAL_STATES.map((state) => ({ state, seats: [...PLAYER_IDS] })),
    ];
    fc.assert(
      fc.property(
        fc.nat({ max: bases.length - 1 }),
        fc.nat({ max: 1 }),
        fc.integer(),
        (baseAt, seatAt, mutation) => {
          const base = bases[baseAt];
          if (base === undefined) throw new Error("no base state");
          const seat = base.seats[seatAt % base.seats.length] as PlayerId;
          const mutated = mutateHidden(base.state, seat, mutation);
          // The mutation really changed the true state (the seed alone guarantees it).
          expect(hashState(mutated)).not.toBe(hashState(base.state));
          expect(hashState(redact(mutated, seat))).toBe(hashState(redact(base.state, seat)));
        },
      ),
      { numRuns: 150, seed: 185 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
// B10: no information is lost
// ---------------------------------------------------------------------------------------------

describe("determinize loses nothing the seat can see (B10)", () => {
  it("R185 B10: viewFor of a determinized redaction equals the true view, events aside, from both seats", { timeout: 120_000 }, () => {
    expect(REAL_STATES.length).toBeGreaterThan(20);
    REAL_STATES.forEach((state, at) => {
      for (const seat of PLAYER_IDS) {
        const det = determinize(redact(state, seat), seat, createRng(`observe-b10:${at}:${seat}`));
        expect(viewWithoutEvents(det, seat), `state ${at}, seat ${seat}`).toEqual(viewWithoutEvents(state, seat));
      }
    });
  });

  it("R185 B10: the fixed scenario's view survives redaction and determinization", () => {
    const { a } = pair();
    const det = determinize(redact(a, AI), AI, createRng("observe-b10-fixed"));
    expect(viewWithoutEvents(det, AI)).toEqual(viewWithoutEvents(a, AI));
  });
});

// ---------------------------------------------------------------------------------------------
// B11: the same decision
// ---------------------------------------------------------------------------------------------

describe("decide cannot see hidden cards (B11)", () => {
  it("R185 B11: decide gives deep-equal decisions for the fixed pair under the same AI rng", { timeout: 180_000 }, () => {
    const { a, b } = pair();
    for (const k of ["observe-k1", "observe-k2", "observe-k3"]) {
      const fromA = decide(a, AI, { rng: createRng(k) });
      const fromB = decide(b, AI, { rng: createRng(k) });
      expect(fromA, k).not.toBeNull();
      expect(fromB, k).toEqual(fromA);
      expect(isLegal(a, AI, (fromA as NonNullable<typeof fromA>).action), k).toBe(true);
    }
  });

  it("R185 B11: decide gives deep-equal decisions for random mutations of real states", { timeout: 180_000 }, () => {
    const candidates = REAL_STATES.filter(
      (state) => state.result === null && seatToAct(state) === state.active,
    ).slice(0, 4);
    expect(candidates.length).toBeGreaterThan(0);
    candidates.forEach((state, at) => {
      const seat = seatToAct(state);
      const mutated = mutateHidden(state, seat, at + 1);
      const rngSeed = `observe-b11-real-${at}`;
      const original = decide(state, seat, { rng: createRng(rngSeed) });
      expect(decide(mutated, seat, { rng: createRng(rngSeed) }), `state ${at}`).toEqual(original);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// B12: determinize
// ---------------------------------------------------------------------------------------------

describe("determinize (B12)", () => {
  it("B12: every card the seat can read keeps its id, def, zone, Radiant flag, damage and buffs", () => {
    const { a } = pair();
    const hidden = hiddenInstanceIds(a, AI);
    const det = determinize(redact(a, AI), AI, createRng("observe-b12-readable"));
    for (const card of everyCard(a)) {
      if (hidden.has(card.id)) continue;
      const after = cardById(det, card.id);
      expect(after, card.id).toBeDefined();
      expect(readable(after as CardInstance), card.id).toEqual(readable(card));
    }
  });

  it("B12: readable cards survive determinization in real mid-game states, from both seats", { timeout: 60_000 }, () => {
    REAL_STATES.slice(0, 12).forEach((state, at) => {
      for (const seat of PLAYER_IDS) {
        const hidden = hiddenInstanceIds(state, seat);
        const det = determinize(redact(state, seat), seat, createRng(`observe-b12-real:${at}:${seat}`));
        for (const card of everyCard(state)) {
          if (hidden.has(card.id)) continue;
          const after = cardById(det, card.id);
          expect(after, `${at} ${seat} ${card.id}`).toBeDefined();
          expect(readable(after as CardInstance), `${at} ${seat} ${card.id}`).toEqual(readable(card));
        }
      }
    });
  });

  it("B12: every hidden card gets a real non-token Core def; opponent samples are distinct and unseen; face-down ones are traps", () => {
    const { a } = pair();
    const hidden = hiddenInstanceIds(a, AI);
    const pool = new Set(corePool());
    const traps = new Set(trapPool());
    const opponentPublic = new Set(
      everyCard(a)
        .filter((card) => card.owner === "p2" && !hidden.has(card.id))
        .map((card) => card.defId),
    );
    const faceDownIds = new Set(a.players.p2.backrow.flatMap((card) => (card === null ? [] : [card.id])));

    for (let k = 0; k < 40; k += 1) {
      const det = determinize(redact(a, AI), AI, createRng(`observe-b12-samples:${k}`));
      const samples: string[] = [];
      for (const id of hidden) {
        const card = cardById(det, id);
        expect(card, id).toBeDefined();
        const defId = (card as CardInstance).defId;
        expect(defId).not.toBe(HIDDEN_DEF_ID);
        expect(pool.has(defId), `${id} sampled ${defId}`).toBe(true);
        if (faceDownIds.has(id)) expect(traps.has(defId), `${id} sampled ${defId}`).toBe(true);
        samples.push(defId);
      }
      expect(new Set(samples).size, `seed ${k}: ${samples.join(",")}`).toBe(samples.length);
      for (const defId of samples) expect(opponentPublic.has(defId), `seed ${k}: ${defId}`).toBe(false);
    }
  });

  it("B12: with more face-down cards than unseen traps, the sampler falls back to the whole trap pool", () => {
    const faceDown = ["core-018", "core-041", "core-060", "core-071", "core-085"];
    const shown = ["core-096", "core-041"];
    const state = build("observe-trap-exhaust", {
      backrow: faceDown.map((def) => ({ def, faceUp: false })),
      graveyard: shown,
    });
    const lanes = state.players.p2.backrow.map((card) => card?.id);
    expect(lanes.every((id) => id !== undefined)).toBe(true);
    const traps = new Set(trapPool());
    const unseen = trapPool().filter((id) => !shown.includes(id));
    expect(unseen.length).toBeLessThan(faceDown.length);

    for (let k = 0; k < 20; k += 1) {
      const det = determinize(redact(state, AI), AI, createRng(`observe-trap-exhaust:${k}`));
      const samples = lanes.map((id) => cardById(det, id as string)?.defId as string);
      for (const defId of samples) expect(traps.has(defId), `seed ${k}: ${defId}`).toBe(true);
      // In lane order: the unseen traps are used up first, each once, before any fallback.
      const first = samples.slice(0, unseen.length);
      expect([...first].sort(), `seed ${k}`).toEqual([...unseen].sort());
    }
  });

  it("B12: with more hidden cards than the Core pool, every card is used before any repeat, and nothing throws", () => {
    const pool = corePool();
    const state = build("observe-pool-exhaust", { library: [...pool, "core-008", "core-011", "core-019"] }, {});
    const excluded = new Set(
      query({ set: "Core" })
        .filter((def) => (AI_DETERMINIZE.excludeIndexes as readonly string[]).includes(def.index))
        .map((def) => def.id),
    );
    const det = determinize(redact(state, AI), AI, createRng("observe-pool-exhaust"));
    const samples = det.players.p2.library.map((card) => card.defId);
    expect(samples).toHaveLength(pool.length + 3);
    const poolSet = new Set(pool);
    for (const defId of samples) expect(poolSet.has(defId), defId).toBe(true);
    const used = new Set(samples);
    for (const id of pool) {
      if (excluded.has(id)) continue;
      expect(used.has(id), `${id} was never sampled`).toBe(true);
    }
  });

  it("B12: a state with nothing hidden comes through determinization card for card", () => {
    const state = build("observe-public-det", { field: ["core-019", "core-011"], graveyard: ["core-044"] }, P1_SIDE);
    expect(hiddenInstanceIds(state, AI).size).toBe(0);
    const det = determinize(redact(state, AI), AI, createRng("observe-public-det"));
    expect(everyCard(det)).toHaveLength(everyCard(state).length);
    for (const card of everyCard(state)) {
      expect(readable(cardById(det, card.id) as CardInstance), card.id).toEqual(readable(card));
    }
  });

  it("B12: the seat's own library keeps its contents; only its order may change", () => {
    const { a } = pair();
    const det = determinize(redact(a, AI), AI, createRng("observe-b12-own"));
    expect(idsOf(det.players.p1.library).sort()).toEqual(idsOf(a.players.p1.library).sort());
    expect(det.players.p1.library.map((card) => card.defId).sort()).toEqual(
      a.players.p1.library.map((card) => card.defId).sort(),
    );
  });

  it("B12: the determinized seed is the AI's own, never the match's", () => {
    const { a } = pair();
    for (let k = 0; k < 10; k += 1) {
      const det = determinize(redact(a, AI), AI, createRng(`observe-b12-seed:${k}`));
      expect(det.seed).not.toBe(a.seed);
      expect(det.seed).toMatch(/^ai:/);
      expect(det.rngCursor).toBe(0);
    }
  });

  it("B12: determinize is pure given its rng, and different rngs give different worlds", () => {
    const { a } = pair();
    const pub = redact(a, AI);
    const before = JSON.stringify(pub);
    const one = determinize(pub, AI, createRng("observe-b12-pure"));
    const two = determinize(pub, AI, createRng("observe-b12-pure"));
    expect(two).toEqual(one);
    expect(JSON.stringify(pub)).toBe(before);

    const hands = new Set<string>();
    for (let k = 0; k < 10; k += 1) {
      const det = determinize(pub, AI, createRng(`observe-b12-vary:${k}`));
      hands.add(det.players.p2.hand.map((card) => card.defId).join(","));
    }
    expect(hands.size).toBeGreaterThan(1);
  });

  it("B12: a hidden hand or library slot never samples an excluded index (#98's memory, R43)", () => {
    // Freshly dealt: p2's four-card hand and sixteen-card library are all hidden from p1.
    const state = dealtGame("observe-b12-exclude");
    const excluded = new Set(
      query({ set: "Core" })
        .filter((def) => (AI_DETERMINIZE.excludeIndexes as readonly string[]).includes(def.index))
        .map((def) => def.id),
    );
    expect(excluded.size).toBeGreaterThan(0);
    const slots = [...state.players.p2.hand, ...state.players.p2.library].map((card) => card.id);
    expect(slots.length).toBeGreaterThan(10);
    for (let k = 0; k < 100; k += 1) {
      const det = determinize(redact(state, AI), AI, createRng(`observe-b12-exclude:${k}`));
      for (const id of slots) {
        const defId = cardById(det, id)?.defId as string;
        expect(excluded.has(defId), `seed ${k}: ${id} sampled ${defId}`).toBe(false);
      }
    }
  });
});
