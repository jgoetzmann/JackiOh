// The sound director (docs/polish/2-sound.md, B22 and B24 to B27, and R203's hand-over clause).
//
// The director is fed views and runner notifications and sends cues to a recording sink. Entries
// come from the real `planEntries`, and views from the web fixtures, so an event is the very object
// the view carries: the director matches events by identity, as the runner hands them out.

import type { ActionBody, GameEvent, PlayerId, PlayerView } from "@jackioh/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEATH_VOICE_DELAY_MS,
  FLUSH_GAP_MS,
  FLUSH_MAX_SFX,
  HIDDEN_DEF_ID,
  PAIR_OFFSET_MS,
  VOICE_DELAY_MS,
  VOICE_PRIORITY,
} from "./constants.ts";
import { createSoundDirector, eventsAfterOverlap, sameOccurrence, type SoundDirector } from "./director.ts";
import { createAudioEngine } from "./engine.ts";
import { resetAudioSettingsForTests, writeAudioSettings } from "./settings.ts";
import { FakeClock, FakeFetch, fakeContextFactory, fakeSpeech, settle } from "./test/fakeAudio.ts";
import { answerPrompts, devDeck, handDefId, playOf, realGame, type RealGame } from "./test/realGame.ts";
import type { AudioEngine, SfxId, SfxParams, SoundSink, VoiceLineKind, VoiceLineTable } from "./types.ts";
import { newEventsSince, planEntries, type AnimationEntry } from "../game/animations.ts";
import { baseView, emptySide, unit, withEvents } from "../test/fixtures.ts";

/* --------------------------------------------------------------------------------------------- *
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

const LINES: VoiceLineTable = {
  version: 1,
  personas: {
    hustler: { say: "Rocko (English (US))", rate: 215, pbas: 50, pmod: 45, web: { pitch: 1, rate: 1.15 } },
    plain: { say: "Eddy (English (US))", rate: 170, pbas: 40, pmod: 0, web: { pitch: 1, rate: 0.9 } },
    guard: { say: "Ralph", rate: 175, pbas: 38, pmod: 20, web: { pitch: 0.8, rate: 0.95 } },
  },
  cards: {
    "core-001": { kind: "unit", persona: "guard", play: "Stand behind me. Way behind.", death: "Defense... offended." },
    "core-004": { kind: "unit", persona: "hustler", play: "Double or nothing, baby!", death: "House always wins." },
    "core-008": { kind: "unit", persona: "plain", play: "Hello. I am very normal.", death: "Plain. Simple. Gone." },
  },
};

type Sent =
  | { kind: "sfx"; id: SfxId; params: SfxParams | undefined; delayMs: number }
  | { kind: "voice"; defId: string; line: VoiceLineKind; delayMs: number; priority?: number };

type Recorder = SoundSink & { sent: Sent[] };

function recorder(): Recorder {
  const sent: Sent[] = [];
  return {
    sent,
    playSfx(id, params, delayMs) {
      sent.push({ kind: "sfx", id, params, delayMs: delayMs ?? 0 });
      return true;
    },
    playVoice(defId, line, delayMs, priority) {
      sent.push(
        priority === undefined
          ? { kind: "voice", defId, line, delayMs: delayMs ?? 0 }
          : { kind: "voice", defId, line, delayMs: delayMs ?? 0, priority },
      );
      return true;
    },
  };
}

function rig(): { sink: Recorder; director: SoundDirector } {
  const sink = recorder();
  return { sink, director: createSoundDirector(sink, LINES) };
}

/** Every cue sent, as "sfx:id@delay" / "voice:defId/line@delay", in the order sent. */
function sent(sink: Recorder): string[] {
  return sink.sent.map((s) => (s.kind === "sfx" ? `sfx:${s.id}@${String(s.delayMs)}` : `voice:${s.defId}/${s.line}@${String(s.delayMs)}`));
}

const sfxSent = (sink: Recorder) => sink.sent.filter((s): s is Extract<Sent, { kind: "sfx" }> => s.kind === "sfx");
const voiceSent = (sink: Recorder) => sink.sent.filter((s): s is Extract<Sent, { kind: "voice" }> => s.kind === "voice");
/** Voice cues as "defId/line!priority". */
const linesSent = (sink: Recorder) => voiceSent(sink).map((v) => `${v.defId}/${v.line}!${String(v.priority)}`);

const played = (defId: string, instanceId: string, player: PlayerId = "p1"): GameEvent => ({
  type: "cardPlayed",
  player,
  instanceId,
  defId,
  costPaid: 2,
});
const summoned = (defId: string, instanceId: string, player: PlayerId = "p1"): GameEvent => ({
  type: "summoned",
  player,
  instanceId,
  defId,
  row: "units",
  lane: 2,
});
const damage = (amount: number, targetId = "u9"): GameEvent => ({ type: "damage", sourceId: null, targetId, amount, combat: false });
const healed = (amount: number, targetId = "hero-p1"): GameEvent => ({ type: "healed", targetId, amount });
const drawn = (instanceId: string): GameEvent => ({ type: "drawn", player: "p1", instanceId, defId: "core-004" });
const buffed = (instanceId: string): GameEvent => ({ type: "buffed", instanceId, attack: 1, health: 1 });
const locked = (lane: number): GameEvent => ({ type: "locked", player: "p2", row: "backrow", lane });
const burned = (instanceId: string): GameEvent => ({ type: "burned", instanceId, defId: "core-005", owner: "p2" });
const destroyed = (defId: string, instanceId: string, owner: PlayerId = "p1"): GameEvent => ({
  type: "destroyed",
  instanceId,
  defId,
  owner,
  attack: 2,
  maxHealth: 2,
  killerId: null,
});
const mana = (player: PlayerId, current: number): GameEvent => ({ type: "manaChanged", player, current, max: 10 });
const over = (winner: PlayerId | "draw"): GameEvent => ({ type: "gameOver", winner, reason: "hero-death" });

/** A copy with the same fields: what the next view's window carries for an event already seen. */
const again = (event: GameEvent): GameEvent => JSON.parse(JSON.stringify(event)) as GameEvent;

/** Viewer p1, both sides at 4 mana (the fixture's), no events: the first view of a game. */
function firstView(patch: Partial<PlayerView> = {}): PlayerView {
  return baseView(patch);
}

function p2View(events: GameEvent[] = []): PlayerView {
  return baseView({
    viewer: "p2",
    active: "p2",
    you: emptySide("p2"),
    opponent: emptySide("p1"),
    events,
  });
}

/** Feeds the first view, then one view carrying `events`; returns that view. */
function begin(director: SoundDirector, events: GameEvent[], first: PlayerView = firstView()): PlayerView {
  director.onView(first);
  const next = withEvents(first, events);
  director.onView(next);
  return next;
}

function entriesOf(view: PlayerView, events: readonly GameEvent[], reducedMotion = false): AnimationEntry[] {
  return planEntries(events, view, reducedMotion);
}

function must<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/* --------------------------------------------------------------------------------------------- *
 * B24: cues play when an entry starts
 * --------------------------------------------------------------------------------------------- */

describe("B24 cues play when the runner starts an entry", () => {
  it("B24 onView sends nothing to the sink, it only owes the fresh events", () => {
    const { sink, director } = rig();
    begin(director, [damage(3), healed(2), played("core-004", "c1")]);

    expect(sink.sent).toEqual([]);
    expect(director.owedCount()).toBe(3);
  });

  it("B24 onEntryStart sends exactly that entry's cues, entry by entry", () => {
    const { sink, director } = rig();
    const view = begin(director, [damage(3), healed(2)]);
    const [first, second] = entriesOf(view, view.events);

    director.onEntryStart(must(first, "the damage entry"));
    expect(sent(sink)).toEqual(["sfx:impact@0"]);
    expect(sfxSent(sink)[0]?.params?.amount).toBe(3);
    expect(director.owedCount()).toBe(1);

    director.onEntryStart(must(second, "the heal entry"));
    expect(sent(sink)).toEqual(["sfx:impact@0", "sfx:heal@0"]);
    expect(director.owedCount()).toBe(0);
  });

  it("B24 the summoned half of a collapsed cardPlayed + summoned entry is offset by PAIR_OFFSET_MS", () => {
    const { sink, director } = rig();
    const view = begin(director, [played("core-004", "c1"), summoned("core-004", "c1")]);
    const entries = entriesOf(view, view.events);
    expect(entries, "planEntries collapses the pair into one entry").toHaveLength(1);

    director.onEntryStart(must(entries[0], "the pair"));

    expect([...sent(sink)].sort()).toEqual(
      ["sfx:play@0", `voice:core-004/play@${String(VOICE_DELAY_MS)}`, `sfx:summon@${String(PAIR_OFFSET_MS)}`].sort(),
    );
    expect(director.owedCount()).toBe(0);
  });

  it("B24 a bare summoned (a token, a Recruit) is its own entry, with no offset, speaking at the lowest priority (B56)", () => {
    const { sink, director } = rig();
    const view = begin(director, [summoned("core-004", "t1", "p2")]);

    director.onEntryStart(must(entriesOf(view, view.events)[0], "the summon"));

    expect(sent(sink)).toEqual(["sfx:summon@0", `voice:core-004/play@${String(VOICE_DELAY_MS)}`]);
    expect(linesSent(sink)).toEqual([`core-004/play!${String(VOICE_PRIORITY.summon)}`]);
  });

  it("B56 a played unit speaks once: its landing in the same entry, or a later one, adds no second line", () => {
    const { sink, director } = rig();
    const view = begin(director, [played("core-004", "c1"), summoned("core-004", "c1"), summoned("core-008", "t2")]);
    for (const entry of entriesOf(view, view.events)) director.onEntryStart(entry);

    expect(linesSent(sink)).toEqual([
      `core-004/play!${String(VOICE_PRIORITY.play)}`,
      `core-008/play!${String(VOICE_PRIORITY.summon)}`,
    ]);
  });

  it("B56 a summon is sized by the unit as the newest view shows it", () => {
    const { sink, director } = rig();
    const first = firstView();
    director.onView(first);
    const big = unit("p1", { instanceId: "c1", defId: "core-004", attack: 6, health: 5, maxHealth: 5 });
    const next = withEvents(
      { ...first, you: emptySide("p1", { units: [big, null, null, null, null] }) },
      [played("core-004", "c1"), summoned("core-004", "c1")],
    );
    director.onView(next);
    director.onEntryStart(must(entriesOf(first, next.events)[0], "the pair"));

    expect(sfxSent(sink).find((c) => c.id === "summon")?.params).toEqual({ amount: 11 });
  });

  it("B24 an entry whose events were never owed still sounds, resolved against the last view", () => {
    const { sink, director } = rig();
    const view = firstView();
    director.onView(view);

    director.onEntryStart(must(entriesOf(view, [damage(5)])[0], "a damage entry"));

    expect(sent(sink)).toEqual(["sfx:impact@0"]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B25: the flush
 * --------------------------------------------------------------------------------------------- */

describe("B25 events the runner never started are flushed once, condensed, by onIdle", () => {
  it("B25 a reduced-motion burst: SFX deduped in stream order, at most FLUSH_MAX_SFX, FLUSH_GAP_MS apart, one line, gameOver last", () => {
    const { sink, director } = rig();
    begin(director, [
      played("core-004", "c1"),
      summoned("core-004", "c1"),
      damage(3),
      healed(2),
      drawn("c2"),
      buffed("u2"),
      over("p1"),
    ]);
    // Nothing was started: under reduced motion the runner drains inside enqueue and goes idle.
    director.onIdle();

    const order: SfxId[] = ["play", "summon", "impact", "heal", "draw", "buff"];
    const expected = [...order.slice(0, FLUSH_MAX_SFX - 1), "victory"].map((id, j) => `sfx:${id}@${String(j * FLUSH_GAP_MS)}`);
    expect(sent(sink).filter((s) => s.startsWith("sfx:"))).toEqual(expected);
    expect(voiceSent(sink)).toEqual([
      { kind: "voice", defId: "core-004", line: "play", delayMs: VOICE_DELAY_MS, priority: VOICE_PRIORITY.play },
    ]);
    expect(director.owedCount()).toBe(0);
  });

  it("B25 the flush keeps the first cue of each id, with its own params", () => {
    const { sink, director } = rig();
    begin(director, [damage(1), drawn("c1"), damage(5), drawn("c2"), healed(2)]);
    director.onIdle();

    const expected = ["impact", "draw", "heal"].slice(0, FLUSH_MAX_SFX).map((id, j) => `sfx:${id}@${String(j * FLUSH_GAP_MS)}`);
    expect(sent(sink)).toEqual(expected);
    expect(sfxSent(sink)[0]?.params?.amount).toBe(1);
  });

  it("B25 the flush's one line is the most important of the burst, the first on a tie", () => {
    const { sink, director } = rig();
    begin(director, [played("core-004", "c1"), summoned("core-008", "t2"), destroyed("core-001", "u3"), destroyed("core-008", "u4")]);
    director.onIdle();

    expect(voiceSent(sink)).toEqual([
      { kind: "voice", defId: "core-001", line: "death", delayMs: DEATH_VOICE_DELAY_MS, priority: VOICE_PRIORITY.react },
    ]);
  });

  it("B25 the flush sends at most one voice line, the first, at its own delay", () => {
    const { sink, director } = rig();
    begin(director, [destroyed("core-004", "u1"), destroyed("core-008", "u2"), destroyed("core-001", "u3")]);
    director.onIdle();

    expect(voiceSent(sink)).toEqual([
      { kind: "voice", defId: "core-004", line: "death", delayMs: DEATH_VOICE_DELAY_MS, priority: VOICE_PRIORITY.react },
    ]);
    expect(sent(sink).filter((s) => s.startsWith("sfx:"))).toEqual(["sfx:death@0"]);
  });

  it("B25 a flushed sfx ignores its own delay and takes its slot in the gap sequence", () => {
    const sink = recorder();
    const lines: VoiceLineTable = {
      ...LINES,
      cards: { ...LINES.cards, "core-005": { kind: "spell", persona: "plain", cast: "Hoarding is self care." } },
    };
    const director = createSoundDirector(sink, lines);
    begin(director, [drawn("c1"), played("core-005", "c2")]);
    director.onIdle();

    const delays = sfxSent(sink).map((s) => s.delayMs);
    expect([...delays].sort((a, b) => a - b)).toEqual([0, FLUSH_GAP_MS, 2 * FLUSH_GAP_MS].slice(0, Math.min(3, FLUSH_MAX_SFX)));
    const spell = sfxSent(sink).find((s) => s.id === "spell");
    expect(spell?.delayMs, "the spell shimmer's own 60 ms is not used in a flush").not.toBe(60);
  });

  it("B25 the gameOver cue is present and last even when more SFX than FLUSH_MAX_SFX precede it", () => {
    const { sink, director } = rig();
    begin(director, [damage(2), healed(1), drawn("c1"), buffed("u1"), locked(2), burned("c9"), over("p2")]);
    director.onIdle();

    const sfxIds = sfxSent(sink).map((s) => s.id);
    expect(sfxIds).toHaveLength(FLUSH_MAX_SFX);
    expect(sfxIds.at(-1)).toBe("defeat");
    expect(sfxSent(sink).at(-1)?.delayMs).toBe((FLUSH_MAX_SFX - 1) * FLUSH_GAP_MS);
    expect(sfxIds.slice(0, -1)).toEqual((["impact", "heal", "draw", "buff", "lock", "burn"] as SfxId[]).slice(0, FLUSH_MAX_SFX - 1));
  });

  it("B25 a gameOver early in the stream still plays last", () => {
    const { sink, director } = rig();
    begin(director, [over("draw"), damage(2), drawn("c1")]);
    director.onIdle();

    expect(sent(sink)).toEqual(["sfx:impact@0", `sfx:draw@${String(FLUSH_GAP_MS)}`, `sfx:notify@${String(2 * FLUSH_GAP_MS)}`]);
  });

  it("B25 gameOver's zero-length entry, which the runner skips, is flushed when it goes idle", () => {
    const { sink, director } = rig();
    const view = begin(director, [damage(2), over("p1")]);
    const entries = entriesOf(view, view.events).filter((e) => e.durationMs > 0);
    expect(entries.map((e) => e.type)).toEqual(["damage"]);

    director.onEntryStart(must(entries[0], "the damage entry"));
    expect(sent(sink)).toEqual(["sfx:impact@0"]);

    director.onIdle();
    expect(sent(sink)).toEqual(["sfx:impact@0", "sfx:victory@0"]);
  });

  it("B25 events skipped ahead of the entry the runner starts are flushed first, then that entry plays", () => {
    const { sink, director } = rig();
    const view = begin(director, [damage(2), drawn("c1"), healed(3)]);
    const heal = must(entriesOf(view, view.events).at(-1), "the heal entry");

    director.onEntryStart(heal);

    expect(sent(sink)).toEqual(["sfx:impact@0", `sfx:draw@${String(FLUSH_GAP_MS)}`, "sfx:heal@0"]);
    expect(director.owedCount()).toBe(0);
    director.onIdle();
    expect(sink.sent).toHaveLength(3);
  });

  it("B25 onIdle with nothing owed sends nothing", () => {
    const { sink, director } = rig();
    director.onView(firstView());
    director.onIdle();
    director.onIdle();

    expect(sink.sent).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B26: nothing is voiced twice
 * --------------------------------------------------------------------------------------------- */

describe("B26 no event is voiced twice", () => {
  it("B26 across overlapping event windows, the events both views carry sound once", () => {
    const { sink, director } = rig();
    const a = damage(2);
    const b = played("core-004", "c1");
    const view1 = begin(director, [a, b]);
    for (const entry of entriesOf(view1, view1.events)) director.onEntryStart(entry);
    const afterFirst = sink.sent.length;

    const c = healed(4);
    director.onView(withEvents(view1, [again(a), again(b), c]));
    expect(director.owedCount()).toBe(1);
    director.onIdle();

    expect(sent(sink).slice(afterFirst)).toEqual(["sfx:heal@0"]);
    expect(voiceSent(sink)).toHaveLength(1);
  });

  it("B26 a sliding window that drops its oldest events still voices only the new one", () => {
    const { sink, director } = rig();
    const a = damage(2);
    const b = drawn("c1");
    const view1 = begin(director, [a, b]);
    director.onIdle();
    const afterFirst = sink.sent.length;

    director.onView(withEvents(view1, [again(b), healed(1)]));
    director.onIdle();

    expect(sent(sink).slice(afterFirst)).toEqual(["sfx:heal@0"]);
  });

  it("B26 the same view fed twice voices nothing more", () => {
    const { sink, director } = rig();
    const view = begin(director, [damage(2), played("core-004", "c1")]);
    director.onView(view);
    director.onView({ ...view });
    expect(director.owedCount()).toBe(2);

    director.onIdle();
    expect(voiceSent(sink)).toHaveLength(1);
    expect(sfxSent(sink).filter((s) => s.id === "impact")).toHaveLength(1);
  });

  it("B26 an onIdle after an entry already voiced its event sends nothing", () => {
    const { sink, director } = rig();
    const view = begin(director, [destroyed("core-004", "u1")]);
    director.onEntryStart(must(entriesOf(view, view.events)[0], "the death entry"));
    const afterEntry = sink.sent.length;
    expect(afterEntry).toBe(2);

    director.onIdle();

    expect(sink.sent).toHaveLength(afterEntry);
  });

  it("B26 two onIdle calls in a row flush once", () => {
    const { sink, director } = rig();
    begin(director, [damage(2), destroyed("core-008", "u2")]);

    director.onIdle();
    const once = sink.sent.length;
    expect(once).toBeGreaterThan(0);
    director.onIdle();

    expect(sink.sent).toHaveLength(once);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B27: a fresh view or a new seat voices nothing (R203)
 * --------------------------------------------------------------------------------------------- */

describe("R203: a hand-over plays nothing the arriving seat's view did not produce", () => {
  it("R203 (B27) the first view voices nothing, and its window is dropped", () => {
    const { sink, director } = rig();
    director.onView(firstView({ events: [played("core-004", "c1"), destroyed("core-008", "u2"), over("p1")] }));

    expect(director.owedCount()).toBe(0);
    director.onIdle();
    expect(sink.sent).toEqual([]);
  });

  it("R203 (B27) a view for another seat drops every owed event, so a later onIdle sends nothing", () => {
    const { sink, director } = rig();
    begin(director, [played("core-004", "c1"), destroyed("core-008", "u2")]);
    expect(director.owedCount()).toBe(2);

    director.onView(p2View([played("core-004", "c1"), destroyed("core-008", "u2"), damage(3)]));

    expect(director.owedCount()).toBe(0);
    director.onIdle();
    expect(sink.sent).toEqual([]);
  });

  it("R203 (B27) after the hand-over, the arriving seat's own next events sound as usual", () => {
    const { sink, director } = rig();
    begin(director, [damage(1)]);
    const arrived = p2View([damage(1)]);
    director.onView(arrived);
    director.onIdle();
    expect(sink.sent).toEqual([]);

    director.onView({ ...arrived, events: [again(damage(1)), healed(6, "hero-p2")] });
    director.onIdle();
    expect(sent(sink)).toEqual(["sfx:heal@0"]);
  });

  it("R203 (B27) handing back to the first seat drops again", () => {
    const { sink, director } = rig();
    const view1 = begin(director, [damage(1)]);
    director.onView(p2View([damage(1), drawn("c3")]));
    director.onView(withEvents(view1, [damage(1), drawn("c3"), healed(2)]));

    expect(director.owedCount()).toBe(0);
    director.onIdle();
    expect(sink.sent).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B22: the director's mana baseline
 * --------------------------------------------------------------------------------------------- */

describe("B22 the mana baseline", () => {
  it("B22 starts at the planned view's mana.current for that player", () => {
    const { sink, director } = rig();
    // Both fixture sides hold 4 mana: 6 is a gain of 2 for p1, and 3 is no gain for p2.
    const view = begin(director, [mana("p1", 6), mana("p2", 3)]);
    for (const entry of entriesOf(view, view.events)) director.onEntryStart(entry);

    const cues = sfxSent(sink);
    expect(cues.map((c) => c.id)).toEqual(["mana"]);
    expect(cues[0]?.params?.amount).toBe(2);
    expect(cues[0]?.params?.mine).toBe(true);
  });

  it("B22 then follows each resolved manaChanged, not the view", () => {
    const { sink, director } = rig();
    // Spend 4 → 1 (silent), then gain 1 → 3: a gain of 2 from the tracked 1, not a loss from the view's 4.
    const view = begin(director, [mana("p1", 1), mana("p1", 3)]);
    for (const entry of entriesOf(view, view.events)) director.onEntryStart(entry);

    const cues = sfxSent(sink);
    expect(cues.map((c) => c.id)).toEqual(["mana"]);
    expect(cues[0]?.params?.amount).toBe(2);
  });

  it("B22 reads the opponent's baseline from the opponent's side, and it is not mine", () => {
    const { sink, director } = rig();
    const first = firstView({ opponent: emptySide("p2", { mana: { current: 1, max: 5 }, hand: { count: 3 } }) });
    const view = begin(director, [mana("p2", 5)], first);
    for (const entry of entriesOf(view, view.events)) director.onEntryStart(entry);

    const cues = sfxSent(sink);
    expect(cues.map((c) => c.id)).toEqual(["mana"]);
    expect(cues[0]?.params?.amount).toBe(4);
    expect(cues[0]?.params?.mine ?? false).toBe(false);
  });

  it("B22 the tracked baseline carries across views and through a flush", () => {
    const { sink, director } = rig();
    const view1 = begin(director, [mana("p1", 0)]);
    director.onIdle();
    expect(sink.sent).toEqual([]);

    // The next view is planned against a view that still says 4; the tracked value is 0.
    director.onView(withEvents(view1, [again(mana("p1", 0)), mana("p1", 2)]));
    director.onIdle();

    const cues = sfxSent(sink);
    expect(cues.map((c) => c.id)).toEqual(["mana"]);
    expect(cues[0]?.params?.amount).toBe(2);
  });

  it("B22 a new seat forgets the tracked baseline and reads the new view", () => {
    const { sink, director } = rig();
    begin(director, [mana("p1", 1)]);
    director.onIdle();

    // On p2's seat, p1's side shows 4: a manaChanged to 3 is no gain there, whatever p1 was tracked at.
    const arrived = p2View();
    director.onView(arrived);
    director.onView({ ...arrived, events: [mana("p1", 3)] });
    director.onIdle();

    expect(sink.sent).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B55: a window R97 has un-redacted is not new
 * --------------------------------------------------------------------------------------------- */

/** Every entry the Game would enqueue for `next` (task 1's exact matcher), started in order, then idle. */
function playLikeGame(director: SoundDirector, prev: PlayerView, next: PlayerView): void {
  director.onView(next);
  for (const entry of planEntries(newEventsSince(prev.events, next.events), prev, false)) director.onEntryStart(entry);
  director.onIdle();
}

describe("B55 an event the last window carried is old news, even once R97 names its card", () => {
  const hiddenDraw: GameEvent = { type: "drawn", player: "p2", instanceId: HIDDEN_DEF_ID, defId: HIDDEN_DEF_ID };
  const namedDraw: GameEvent = { type: "drawn", player: "p2", instanceId: "c26", defId: "core-004" };

  it("B55 sameOccurrence lets the sentinel match the value it later reveals, in either direction, and nothing else", () => {
    expect(sameOccurrence(hiddenDraw, namedDraw)).toBe(true);
    expect(sameOccurrence(namedDraw, hiddenDraw)).toBe(true);
    expect(sameOccurrence(namedDraw, { ...namedDraw, player: "p1" })).toBe(false);
    expect(sameOccurrence(damage(2), damage(3))).toBe(false);
    expect(sameOccurrence(hiddenDraw, { type: "addedToHand", player: "p2", instanceId: "c26", defId: "core-004" })).toBe(false);
    expect(
      sameOccurrence(
        { type: "fused", instanceIds: [HIDDEN_DEF_ID, "u2"], resultInstanceId: "u9", defId: "core-004" },
        { type: "fused", instanceIds: ["u1", "u2"], resultInstanceId: "u9", defId: "core-004" },
      ),
    ).toBe(true);
  });

  it("B55 the overlap survives an un-redacted draw, so only the new action's events are owed", () => {
    const old = [turn2(), mana("p2", 5), hiddenDraw];
    const fresh = [played("core-004", "c26", "p2"), summoned("core-004", "c26", "p2")];
    expect(eventsAfterOverlap(old, [again(turn2()), again(mana("p2", 5)), namedDraw, ...fresh])).toEqual(fresh);
    expect(newEventsSince(old, [again(turn2()), again(mana("p2", 5)), namedDraw, ...fresh]), "task 1's exact matcher replays it all").toHaveLength(5);
  });

  it("B55 when the runner replays the whole window, only the new action sounds", () => {
    const { sink, director } = rig();
    const first = firstView();
    const view1 = withEvents(first, [turn2(), mana("p2", 5), hiddenDraw]);
    director.onView(first);
    playLikeGame(director, first, view1);
    const before = sink.sent.length;

    const view2 = withEvents(view1, [again(turn2()), again(mana("p2", 5)), namedDraw, played("core-004", "c26", "p2")]);
    playLikeGame(director, view1, view2);

    expect(sent(sink).slice(before)).toEqual(["sfx:play@0", `voice:core-004/play@${String(VOICE_DELAY_MS)}`]);
  });

  it("B55 with real engine views: the opponent draws, then plays that card, and the watcher hears only the play", () => {
    const found = drawThenPlay();
    expect(found, "a seed where p2 plays the card it drew, un-redacting its draw in p1's window").not.toBeNull();
    const { before, after, produced } = must(found ?? undefined, "the scenario");
    expect(newEventsSince(before.events, after.events).length, "task 1's exact matcher replays the window").toBeGreaterThan(produced);

    const heard = rig();
    heard.director.onView(before);
    playLikeGame(heard.director, before, after);

    // The control: the same new events after a window that matches byte for byte.
    const control = rig();
    control.director.onView(before);
    const tail = after.events.slice(after.events.length - produced);
    const clean = { ...after, events: [...before.events, ...tail] };
    playLikeGame(control.director, before, clean);

    expect(sent(heard.sink)).toEqual(sent(control.sink));
    expect(sent(heard.sink).some((c) => c.startsWith("sfx:turnStart")), "no stale turn-start stinger").toBe(false);
    expect(voiceSent(heard.sink).length, "at most the played card's own line").toBeLessThanOrEqual(1);
  });
});

function turn2(): GameEvent {
  return { type: "turnStarted", player: "p2", turn: 2 };
}

/**
 * A real game (cheap20 against cheap20) played until p2 plays a card it drew earlier in p1's
 * window, so p1's `drawn` for it turns from the sentinel into the card (R97). Deterministic: the
 * same seeds in the same order, the first that produces it wins.
 */
function drawThenPlay(): { before: PlayerView; after: PlayerView; produced: number } | null {
  for (let seed = 1; seed <= 40; seed += 1) {
    const game = realGame(`audio-redraw-${String(seed)}`, [devDeck("cheap20"), devDeck("cheap20")]);
    for (let step = 0; step < 12; step += 1) {
      answerPrompts(game);
      const who = game.actor();
      if (who === null) break;
      if (who === "p2") {
        const drawn = [...game.view("p2").events].reverse().find((e) => e.type === "drawn" && e.player === "p2");
        const play = drawn === undefined || drawn.type !== "drawn" ? undefined : playOf(game, "p2", drawn.instanceId);
        const before = game.view("p1");
        if (play !== undefined) {
          const produced = game.act("p2", play).length;
          const after = game.view("p1");
          if (newEventsSince(before.events, after.events).length > produced) return { before, after, produced };
          break;
        }
      }
      game.act(who, { type: "endTurn" });
    }
  }
  return null;
}

/* --------------------------------------------------------------------------------------------- *
 * R203 against the engine's own redaction
 * --------------------------------------------------------------------------------------------- */

type Seats = { p1: Recorder; p2: Recorder };

type Heard = { seats: Seats; events: GameEvent[]; after: { p1: PlayerView; p2: PlayerView } };

/** Both seats' directors, fed `before` then `after` the way Game feeds them; returns what each heard. */
function hearAction(game: RealGame, player: PlayerId, body: ActionBody): Heard {
  const seats: Seats = { p1: recorder(), p2: recorder() };
  const before = { p1: game.view("p1"), p2: game.view("p2") };
  const directors = { p1: createSoundDirector(seats.p1), p2: createSoundDirector(seats.p2) };
  directors.p1.onView(before.p1);
  directors.p2.onView(before.p2);
  const events = game.act(player, body);
  const after = { p1: game.view("p1"), p2: game.view("p2") };
  playLikeGame(directors.p1, before.p1, after.p1);
  playLikeGame(directors.p2, before.p2, after.p2);
  return { seats, events, after };
}

const SHEEPISH = "core-041";

/** A real game where p1 sets #41 Sheepish and p2 then plays a unit into it. */
function sheepishGame(): { set: Heard; fire: Heard } | null {
  const cheap = devDeck("cheap20");
  const p1Deck = [SHEEPISH, ...cheap.filter((id) => id !== SHEEPISH)].slice(0, 20);
  const p2Deck = cheap.filter((id) => id !== SHEEPISH);
  for (let seed = 1; seed <= 40; seed += 1) {
    const game = realGame(`audio-sheepish-${String(seed)}`, [p1Deck, p2Deck.slice(0, 20)]);
    let set: Heard | null = null;
    for (let step = 0; step < 16; step += 1) {
      answerPrompts(game);
      const who = game.actor();
      if (who === null) break;
      if (who === "p1" && set === null) {
        const hand = game.view("p1").you.hand;
        const trap = Array.isArray(hand) ? hand.find((c) => c.defId === SHEEPISH) : undefined;
        const play = trap === undefined ? undefined : playOf(game, "p1", trap.instanceId);
        if (play !== undefined) {
          set = hearAction(game, "p1", play);
          continue;
        }
      }
      if (who === "p2" && set !== null) {
        const unitPlay = game
          .legal("p2")
          .find((a) => a.type === "play" && game.catalog[handDefId(game, "p2", a.instanceId) ?? ""]?.type === "Unit");
        if (unitPlay !== undefined) {
          const fire = hearAction(game, "p2", unitPlay);
          if (fire.events.some((e) => e.type === "trapFired")) return { set, fire };
          break;
        }
      }
      game.act(who, { type: "endTurn" });
    }
  }
  return null;
}

describe("R203 against real viewFor redaction: a trap names itself only to its controller", () => {
  const scenario = sheepishGame();

  it("R203 a real Sheepish is set and then fires on a real unit play", () => {
    expect(scenario, "a seed where p1 sets Sheepish and p2 plays a unit into it").not.toBeNull();
  });

  it("R203 setting it: its owner hears the set sound, the other seat the plain play, and neither a line", () => {
    const { set } = must(scenario ?? undefined, "the scenario");
    expect(sent(set.seats.p1)).toContain("sfx:trapSet@0");
    expect(voiceSent(set.seats.p1)).toEqual([]);
    expect(sent(set.seats.p2)).toContain("sfx:play@0");
    expect(sent(set.seats.p2)).not.toContain("sfx:trapSet@0");
    expect(voiceSent(set.seats.p2)).toEqual([]);
  });

  it("R203 firing it: only the controller's seat hears Sheepish speak, and it outranks the play it answers (R204)", () => {
    const { fire } = must(scenario ?? undefined, "the scenario");
    expect(sent(fire.seats.p1)).toContain("sfx:trapSting@0");
    expect(linesSent(fire.seats.p1)).toContain(`${SHEEPISH}/cast!${String(VOICE_PRIORITY.react)}`);
    expect(sent(fire.seats.p2)).toContain("sfx:trapSting@0");
    expect(voiceSent(fire.seats.p2).map((v) => v.defId)).not.toContain(SHEEPISH);
    expect(voiceSent(fire.seats.p2).map((v) => v.defId)).not.toContain(HIDDEN_DEF_ID);
    const unitLine = voiceSent(fire.seats.p1).find((v) => v.line === "play");
    expect(unitLine?.priority, "the unit's own play line, which the trap's line cuts in on").toBe(VOICE_PRIORITY.play);
  });

  it("R203 the client's sentinel is the one the engine's viewFor redacts the fired trap to on the other seat", () => {
    const { fire } = must(scenario ?? undefined, "the scenario");
    const fired = (view: PlayerView) => view.events.find((e) => e.type === "trapFired");
    expect(fired(fire.after.p1)).toMatchObject({ defId: SHEEPISH, controller: "p1" });
    expect(fired(fire.after.p2)).toMatchObject({ defId: HIDDEN_DEF_ID, instanceId: HIDDEN_DEF_ID, controller: "p1" });
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B47 end to end: the director into the real engine
 * --------------------------------------------------------------------------------------------- */

describe("B47 a trap that answers a play is heard over that play's line", () => {
  let engine: AudioEngine | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    resetAudioSettingsForTests();
    writeAudioSettings({ muted: false, voiceOn: true });
  });

  afterEach(() => {
    engine?.dispose();
    engine = null;
    resetAudioSettingsForTests();
    localStorage.clear();
    vi.useRealTimers();
  });

  it("B47 Tempo Timmy into Sheepish: on the controller's seat the Timmy line starts, then Sheepish cuts in and is heard", async () => {
    const factory = fakeContextFactory({ state: "suspended", resumeMode: "run", decodedSeconds: 2 });
    const clock = new FakeClock(5_000);
    const fetch = new FakeFetch();
    engine = createAudioEngine({ createContext: factory.create, speech: fakeSpeech().port, fetchBytes: fetch.fetchBytes, now: clock.now });
    engine.unlock();
    const audio = factory.last();
    const director = createSoundDirector(engine);
    const elapse = async (ms: number): Promise<void> => {
      clock.advance(ms);
      audio.advance(ms / 1000);
      await vi.advanceTimersByTimeAsync(ms);
      await settle();
    };

    // p2's seat: p1 plays #11 Tempo Timmy, and p2's face-down #41 Sheepish answers it (R17).
    const seat = p2View();
    director.onView(seat);
    const next = withEvents(seat, [
      played("core-011", "c11", "p1"),
      summoned("core-011", "c11", "p1"),
      { type: "trapFired", instanceId: "b41", defId: SHEEPISH, controller: "p2", row: "backrow", lane: 2 },
    ]);
    director.onView(next);
    const [pair, trap] = planEntries(next.events, seat, false);
    director.onEntryStart(must(pair, "the play"));
    await settle();
    await elapse(400);
    director.onEntryStart(must(trap, "the trap"));
    await settle();
    await elapse(3_000);

    const lines = engine.log().flatMap((c) => (c.kind === "voice" ? [`${c.defId}-${c.line}:${c.outcome}`] : []));
    expect(lines).toEqual(["core-011-play:file", `${SHEEPISH}-cast:file`]);
    // The decoded lines are 2 s long; the SFX noise buffer is 1 s and the unlock frame one sample.
    const sources = audio.nodesOf("bufferSource").filter((n) => n.buffer !== null && Math.abs(n.buffer.duration - 2) < 1e-9);
    expect(sources, "two lines started").toHaveLength(2);
    expect(sources[0]?.stopTime, "Timmy's line was stopped early").not.toBeNull();
    expect(sources[1]?.stopTime, "Sheepish's line played out").toBeNull();
  });
});
