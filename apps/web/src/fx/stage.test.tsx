// Polish 1 (docs/polish/1-animations.md, B46–B48): the stage cues.
//
// The board shows the view from before a burst until the whole burst has played (BUILD M5-T4), so
// the layer carries a moved card with a stand-in (B46), hides a card the burst has taken away (B47)
// and aims an attacker's lunge at what it attacks (B48). This file covers the planner (`stage.ts`,
// pure), the director's side (real elements, with their rectangles stubbed because jsdom has no
// layout) and the layer releasing everything the moment the board shows the next view.

import type { GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MIN_ENTRY_MS, createAnimationQueue, planEntries, type AnimationEntry } from "../game/animations.ts";
import { fullBoardView, withEvents } from "../test/fixtures.ts";
import {
  FX_CONCEAL_AT,
  FX_HOLD_MAX_MS,
  FX_INTENSITY_SCALE,
  FX_LUNGE_CONTACT_AT,
  FX_LUNGE_MAX_PX,
  FX_LUNGE_MIN_PX,
  FX_MIND_CONTROL_FLIGHT_FRACTION,
  FX_PARTICLE_CAP,
  FX_SLAM_AT,
} from "./constants.ts";
import { createFxDirector, type FxDirectorOptions } from "./director.ts";
import { landingBox, standInCopy } from "./dom.ts";
import FxLayer from "./FxLayer.tsx";
import { createFxMemory } from "./memory.ts";
import { resetFxSettingsForTests } from "./settings.ts";
import { planStage } from "./stage.ts";
import type { FxAnchor, FxBox, FxCue, FxFrameSource, FxPlanEnv } from "./types.ts";

beforeEach(() => {
  localStorage.clear();
  resetFxSettingsForTests();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  resetFxSettingsForTests();
});

/* fullBoardView's ids: your units u1..u5, the enemy's u6..u10, your hand c11..c14. */
const MINE = "u1";
const ENEMY = "u6";
const HAND = "c11";

function env(intensity: number = FX_INTENSITY_SCALE.normal): FxPlanEnv {
  return { intensity, card: () => undefined, memory: createFxMemory() };
}

function entryOf(events: GameEvent[], D: number, view: PlayerView = fullBoardView()): { entry: AnimationEntry; view: PlayerView } {
  const shown = withEvents(view, events);
  const entries = planEntries(events, shown, false);
  expect(entries).toHaveLength(1);
  return { entry: { ...entries[0]!, durationMs: D }, view: shown };
}

function stage(events: GameEvent[], D = 400, intensity?: number): FxCue[] {
  const { entry, view } = entryOf(events, D);
  return planStage(entry, view, env(intensity));
}

const tid = (testid: string): FxAnchor => ({ kind: "testid", testid });

const play = (player: "p1" | "p2", instanceId: string): GameEvent => ({
  type: "cardPlayed",
  player,
  instanceId,
  defId: "core-019",
  costPaid: 3,
});
const summon = (player: "p1" | "p2", instanceId: string, lane = 3): GameEvent => ({
  type: "summoned",
  player,
  instanceId,
  defId: "core-019",
  row: "units",
  lane,
});

/* ------------------------------------------------------------------------------------------- *
 * The planner
 * ------------------------------------------------------------------------------------------- */

describe("B46 stand-ins are planned for every card the burst moves onto the board", () => {
  it("B46 a unit played from the viewer's hand flies from its hand card to its zone and lands on the slam; the hand card hides at once", () => {
    const D = 400;
    expect(stage([play("p1", HAND), summon("p1", HAND)], D)).toEqual([
      { kind: "hold", from: tid(`hand-card-${HAND}`), to: tid("zone-you-units-3"), delayMs: 0, landMs: Math.round(FX_SLAM_AT * D), durationMs: FX_HOLD_MAX_MS },
      { kind: "conceal", testid: `hand-card-${HAND}`, mode: "now", delayMs: 0, durationMs: FX_HOLD_MAX_MS },
    ]);
  });

  it("R227 a trap set face-down flies from its hand card, which still carries the id the trap had (formerId)", () => {
    const D = 400;
    const set: GameEvent[] = [
      { type: "cardPlayed", player: "p1", instanceId: "c99", defId: "core-041", costPaid: 1, formerId: HAND },
      { type: "summoned", player: "p1", instanceId: "c99", defId: "core-041", row: "backrow", lane: 2, formerId: HAND },
    ];
    expect(stage(set, D)).toEqual([
      { kind: "hold", from: tid(`hand-card-${HAND}`), to: tid("zone-you-backrow-2"), delayMs: 0, landMs: Math.round(FX_SLAM_AT * D), durationMs: FX_HOLD_MAX_MS },
      { kind: "conceal", testid: `hand-card-${HAND}`, mode: "now", delayMs: 0, durationMs: FX_HOLD_MAX_MS },
    ]);
  });

  it("B46 the opponent's unit flies from the opponent's hand of backs (R202: a back, never a face)", () => {
    const cues = stage([play("p2", "c99"), summon("p2", "c99", 2)]);
    expect(cues).toEqual([
      { kind: "hold", from: tid("hand-opponent"), to: tid("zone-opponent-units-2"), delayMs: 0, landMs: 240, durationMs: FX_HOLD_MAX_MS },
    ]);
  });

  it("B46 a unit summoned out of nowhere the viewer can see (a token, a Cry's summon) drops in as a light", () => {
    expect(stage([summon("p1", "t50", 4)], 250)).toEqual([
      { kind: "hold", from: null, to: tid("zone-you-units-4"), delayMs: 0, landMs: Math.round(FX_SLAM_AT * 250), durationMs: FX_HOLD_MAX_MS },
    ]);
  });

  it("B46 a stolen unit flies from its old place to its new zone over the mind-control flight and hides where it was", () => {
    const D = 450;
    expect(stage([{ type: "controlChanged", instanceId: ENEMY, controller: "p1", row: "units", lane: 4 }], D)).toEqual([
      { kind: "hold", from: tid(`card-${ENEMY}`), to: tid("zone-you-units-4"), delayMs: 0, landMs: Math.round(FX_MIND_CONTROL_FLIGHT_FRACTION * D), durationMs: FX_HOLD_MAX_MS },
      { kind: "conceal", testid: `card-${ENEMY}`, mode: "now", delayMs: 0, durationMs: FX_HOLD_MAX_MS },
    ]);
  });
});

describe("B47 a card the burst has taken away stays hidden once its own motion ends", () => {
  it("B47 the viewer's spell leaves the hand after its lift, not before", () => {
    const D = 400;
    expect(stage([play("p1", HAND)], D)).toEqual([
      { kind: "conceal", testid: `hand-card-${HAND}`, mode: "after", delayMs: Math.round(FX_CONCEAL_AT * D), durationMs: FX_HOLD_MAX_MS },
    ]);
  });

  it("B47 a destroyed, exiled or bounced board card hides after its dissolve; one off the board hides nothing", () => {
    const D = 350;
    const after = (id: string): FxCue => ({ kind: "conceal", testid: `card-${id}`, mode: "after", delayMs: Math.round(FX_CONCEAL_AT * D), durationMs: FX_HOLD_MAX_MS });
    expect(stage([{ type: "destroyed", instanceId: ENEMY, owner: "p2" } as GameEvent], D)).toEqual([after(ENEMY)]);
    expect(stage([{ type: "exiled", instanceId: MINE, owner: "p1" } as GameEvent], D)).toEqual([after(MINE)]);
    expect(stage([{ type: "bounced", instanceId: MINE, owner: "p1" } as GameEvent], D)).toEqual([after(MINE)]);
    expect(stage([{ type: "destroyed", instanceId: "gone", owner: "p2" } as GameEvent], D)).toEqual([]);
  });

  it("B47 the opponent's play hides nothing: the viewer sees only backs in that hand", () => {
    expect(stage([play("p2", "c99")])).toEqual([]);
  });
});

describe("B48 the lunge is aimed at what it attacks", () => {
  it("B48 an attack on a unit aims the attacker at that card and throws a spark there on contact", () => {
    const D = 350;
    const cues = stage([{ type: "attackDeclared", attackerId: MINE, targetId: ENEMY, forced: false }], D);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ kind: "lunge", attacker: `card-${MINE}`, target: `card-${ENEMY}`, delayMs: 0, durationMs: D });
    expect(cues[1]).toMatchObject({ kind: "burst", preset: "spark", at: tid(`card-${ENEMY}`), delayMs: Math.round(FX_LUNGE_CONTACT_AT * D) });
  });

  it("B48 an attack on a hero aims at that hero's portrait, from either seat", () => {
    expect(stage([{ type: "attackDeclared", attackerId: MINE, targetId: "hero-p2", forced: false }])[0]).toMatchObject({
      kind: "lunge",
      target: "hero-opponent",
    });
    expect(stage([{ type: "attackDeclared", attackerId: ENEMY, targetId: "hero-p1", forced: false }])[0]).toMatchObject({
      kind: "lunge",
      attacker: `card-${ENEMY}`,
      target: "hero-you",
    });
  });

  it("B48 an attacker or a target the view does not render aims nothing", () => {
    expect(stage([{ type: "attackDeclared", attackerId: "nobody", targetId: ENEMY, forced: false }])).toEqual([]);
    expect(stage([{ type: "attackDeclared", attackerId: MINE, targetId: "nobody", forced: false }])).toEqual([]);
  });
});

describe("R200 stage cues pace nothing", () => {
  it("R200 every stage cue starts inside its entry, a stand-in lands inside it, a lunge ends with it, and nothing is held past FX_HOLD_MAX_MS", () => {
    const samples: GameEvent[][] = [
      [play("p1", HAND), summon("p1", HAND)],
      [play("p2", "c99"), summon("p2", "c99")],
      [summon("p1", "t50")],
      [play("p1", HAND)],
      [{ type: "destroyed", instanceId: ENEMY, owner: "p2" } as GameEvent],
      [{ type: "controlChanged", instanceId: ENEMY, controller: "p1", row: "units", lane: 4 }],
      [{ type: "attackDeclared", attackerId: MINE, targetId: ENEMY, forced: false }],
    ];
    for (const events of samples) {
      for (let D = MIN_ENTRY_MS; D <= 1400; D += 7) {
        for (const cue of stage(events, D)) {
          expect(cue.delayMs, JSON.stringify(cue)).toBeGreaterThanOrEqual(0);
          expect(cue.delayMs, JSON.stringify(cue)).toBeLessThanOrEqual(D);
          if (cue.kind === "hold") expect(cue.landMs).toBeLessThanOrEqual(D);
          // A lunge is the entry's own motion; holds and conceals last until the board shows the next
          // view, which R200 caps at FX_HOLD_MAX_MS.
          if (cue.kind === "lunge") expect(cue.durationMs).toBeLessThanOrEqual(D);
          if (cue.kind === "hold" || cue.kind === "conceal") expect(cue.durationMs).toBe(FX_HOLD_MAX_MS);
        }
      }
    }
  });

  it("R200 at intensity 0 the layer is off and plans no stage cue", () => {
    expect(stage([play("p1", HAND), summon("p1", HAND)], 400, 0)).toEqual([]);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * The DOM side
 * ------------------------------------------------------------------------------------------- */

/** jsdom lays nothing out, so every element the director measures gets a fixed rectangle. */
function place(element: Element, box: FxBox): void {
  element.getBoundingClientRect = () =>
    ({ x: box.x, y: box.y, left: box.x, top: box.y, width: box.width, height: box.height, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => ({}) }) as DOMRect;
}

function boardElement(testid: string, box: FxBox, html = ""): HTMLElement {
  const el = document.createElement("div");
  el.setAttribute("data-testid", testid);
  el.innerHTML = html;
  place(el, box);
  document.body.appendChild(el);
  return el;
}

const HAND_BOX: FxBox = { x: 100, y: 600, width: 60, height: 82 };
const ZONE_BOX: FxBox = { x: 300, y: 300, width: 240, height: 84 };
const ENEMY_BOX: FxBox = { x: 300, y: 100, width: 60, height: 82 };

function directorHarness(over: Partial<FxDirectorOptions> = {}) {
  let t = 1000;
  const pending = new Map<number, (ms: number) => void>();
  const scrolled = new Set<() => void>();
  let next = 1;
  const frames: FxFrameSource = {
    request(callback) {
      pending.set(next, callback);
      next += 1;
      return next - 1;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  const root = document.createElement("div");
  document.body.appendChild(root);
  const measure = (anchor: FxAnchor): FxBox | null => {
    if (anchor.kind !== "testid") return null;
    const el = document.querySelector(`[data-testid="${anchor.testid}"]`);
    if (el === null) return null;
    const r = el.getBoundingClientRect();
    return r.width === 0 && r.height === 0 ? null : { x: r.left, y: r.top, width: r.width, height: r.height };
  };
  const director = createFxDirector({
    surface: null,
    domRoot: root,
    now: () => t,
    frames,
    visibility: { hidden: () => false, subscribe: () => () => undefined },
    measure,
    shakeSink: { apply: () => undefined, clear: () => undefined },
    seed: 7,
    capacity: FX_PARTICLE_CAP,
    viewport: {
      subscribe(listener) {
        scrolled.add(listener);
        return () => scrolled.delete(listener);
      },
    },
    ...over,
  });
  return {
    root,
    director,
    /** Frames the director has asked for and not had yet. */
    pendingFrames: (): number => pending.size,
    /** The page scrolled or resized. */
    scroll(): void {
      for (const listener of [...scrolled]) listener();
    },
    frameAt(ms: number): void {
      t = ms;
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(t);
    },
    now: () => t,
  };
}

function textNodes(root: Node): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, 4);
  while (walker.nextNode() !== null) out.push(walker.currentNode as Text);
  return out;
}

describe("B46 the stand-in in the page", () => {
  it("B46 a stand-in is a copy of the card with no testid, no interaction and no text node, landing card-shaped in the zone", () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX, '<span class="card-name" title="x">Tempo Timmy</span><button data-testid="inner" tabindex="0">go</button>');
    hand.className = "card card-hand";
    hand.setAttribute("data-legal", "true");
    hand.setAttribute("role", "button");
    boardElement("zone-you-units-3", ZONE_BOX);
    const h = directorHarness();

    h.director.play(stage([play("p1", HAND), summon("p1", HAND)]));

    const hold = h.root.querySelector<HTMLElement>('[data-fx="hold"]');
    expect(hold).not.toBeNull();
    if (hold === null) return;
    expect(hold.getAttribute("data-look")).toBe("card");
    expect(hold.getAttribute("aria-hidden")).toBe("true");
    expect(hold.querySelectorAll("[data-testid], [role], [tabindex], [data-legal], [title]")).toHaveLength(0);
    expect(textNodes(hold)).toEqual([]);
    expect([...hold.querySelectorAll(".fx-hold-text")].map((s) => s.getAttribute("data-text"))).toEqual(["Tempo Timmy", "go"]);
    const land = landingBox(ZONE_BOX, HAND_BOX);
    expect(hold.style.getPropertyValue("--fx-x")).toBe(`${land.x}px`);
    expect(hold.style.getPropertyValue("--fx-h")).toBe(`${land.height}px`);
    expect(hold.style.getPropertyValue("--fx-land-ms")).toBe(`${Math.round(FX_SLAM_AT * 400)}ms`);
    // It starts where the hand card was.
    const dx = HAND_BOX.x + HAND_BOX.width / 2 - (land.x + land.width / 2);
    expect(hold.style.getPropertyValue("--fx-dx")).toBe(`${dx}px`);
    // The card it stands in for is hidden in the same task, so no paint shows both or neither.
    expect(hand.getAttribute("data-fx-concealed")).toBe("now");
    // Exactly one element with the card's testid is left in the document.
    expect(document.querySelectorAll(`[data-testid="hand-card-${HAND}"]`)).toHaveLength(1);
  });

  it("B46 release() removes every stand-in and un-hides every card at once; the rest keeps running", () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    boardElement("zone-you-units-3", ZONE_BOX);
    const h = directorHarness();
    h.director.play([
      ...stage([play("p1", HAND), summon("p1", HAND)]),
      { kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: 900 },
    ]);
    h.frameAt(1016);
    expect(h.root.querySelectorAll('[data-fx="hold"]')).toHaveLength(1);
    expect(h.root.querySelectorAll('[data-fx="banner"]')).toHaveLength(1);

    h.director.release();
    expect(h.root.querySelectorAll('[data-fx="hold"]')).toHaveLength(0);
    expect(hand.hasAttribute("data-fx-concealed")).toBe(false);
    expect(h.root.querySelectorAll('[data-fx="banner"]')).toHaveLength(1);
  });

  it("R200 a stand-in the board never catches up with is undone once FX_HOLD_MAX_MS has passed, on the layer's next frame or play", () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    boardElement("zone-you-units-3", ZONE_BOX);
    const h = directorHarness();
    h.director.play(stage([play("p1", HAND), summon("p1", HAND)]));
    h.frameAt(1000 + FX_HOLD_MAX_MS - 1);
    expect(h.root.querySelectorAll('[data-fx="hold"]')).toHaveLength(1);
    // Anything that wakes the layer past the cap finds the stand-in expired.
    h.director.play([{ kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: 900 }]);
    h.frameAt(1000 + FX_HOLD_MAX_MS);
    expect(h.root.querySelectorAll('[data-fx="hold"]')).toHaveLength(0);
    expect(hand.hasAttribute("data-fx-concealed")).toBe(false);
  });

  it("B46 a parked stand-in keeps no frame loop running and measures nothing until the board moves under it", () => {
    // Review: every frame re-measured the zone and rewrote left/top/width/height, forcing a layout per
    // frame for the rest of the burst (93 layouts against 30 without the summon, on a phone at 4x CPU).
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    const zone = boardElement("zone-you-units-3", ZONE_BOX);
    let measured = 0;
    const rect = zone.getBoundingClientRect.bind(zone);
    zone.getBoundingClientRect = () => {
      measured += 1;
      return rect();
    };
    const h = directorHarness();
    h.director.play(stage([play("p1", HAND), summon("p1", HAND)]));
    const hold = h.root.querySelector<HTMLElement>('[data-fx="hold"]')!;
    const placedAt = measured;
    h.frameAt(1016);
    expect(h.pendingFrames()).toBe(0);
    expect(measured).toBe(placedAt);
    expect(h.root.querySelectorAll('[data-fx="hold"]')).toHaveLength(1);

    // A scroll moves the zone: the stand-in follows by translate alone, its box untouched.
    const left = hold.style.getPropertyValue("--fx-x");
    place(zone, { ...ZONE_BOX, y: ZONE_BOX.y - 40 });
    h.scroll();
    expect(h.pendingFrames()).toBe(1);
    h.frameAt(1032);
    expect(hold.style.getPropertyValue("translate")).toBe("0px -40px");
    expect(hold.style.getPropertyValue("--fx-x")).toBe(left);
    expect(h.pendingFrames()).toBe(0);

    // Back where it was placed: no offset left.
    place(zone, ZONE_BOX);
    h.scroll();
    h.frameAt(1048);
    expect(hold.style.getPropertyValue("translate")).toBe("");
  });

  it("B46 a stand-in follows the board shake while it lasts, then stops measuring", () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    const zone = boardElement("zone-you-units-3", ZONE_BOX);
    const offsets: number[] = [];
    const h = directorHarness({
      shakeSink: {
        apply: (offset) => {
          offsets.push(offset.x);
          place(zone, { ...ZONE_BOX, x: ZONE_BOX.x + offset.x });
        },
        clear: () => place(zone, ZONE_BOX),
      },
    });
    h.director.play([...stage([play("p1", HAND), summon("p1", HAND)]), { kind: "shake", trauma: 1, delayMs: 0 }]);
    const hold = h.root.querySelector<HTMLElement>('[data-fx="hold"]')!;
    let t = 1000;
    while (h.pendingFrames() > 0 && t < 4000) {
      t += 16;
      h.frameAt(t);
      const shift = Number.parseFloat(hold.style.getPropertyValue("translate") || "0");
      if (h.pendingFrames() > 0) expect(shift).toBeCloseTo(offsets.at(-1) ?? 0, 6);
    }
    expect(offsets.length).toBeGreaterThan(3);
    // The shake is over, the board is back, and so is the stand-in; nothing keeps the loop alive.
    expect(h.pendingFrames()).toBe(0);
    expect(hold.style.getPropertyValue("translate")).toBe("");
  });

  it("B46 the stand-in plays what the board plays on the card it carries (a Cry's buff, a transform), but not the card's own lift", async () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    hand.setAttribute("data-animating", "cardPlayed");
    boardElement("zone-you-units-3", ZONE_BOX);
    const h = directorHarness();
    h.director.play(stage([play("p1", HAND), summon("p1", HAND)]));
    const copy = h.root.querySelector<HTMLElement>('[data-fx="hold"] .fx-hold-card')!;
    expect(copy.hasAttribute("data-animating")).toBe(false);

    hand.setAttribute("data-animating", "buffed");
    await Promise.resolve();
    expect(copy.getAttribute("data-animating")).toBe("buffed");
    hand.setAttribute("data-animating", "transformed");
    await Promise.resolve();
    expect(copy.getAttribute("data-animating")).toBe("transformed");
    hand.removeAttribute("data-animating");
    await Promise.resolve();
    expect(copy.hasAttribute("data-animating")).toBe(false);

    // Released: the copy is gone and nothing watches the hand card any more.
    h.director.release();
    hand.setAttribute("data-animating", "damage");
    await Promise.resolve();
    expect(copy.hasAttribute("data-animating")).toBe(false);
  });

  it("R200 a stand-in's copy has no data-animating of its own: it echoes the carried card's and drops it before any other task runs", async () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    boardElement("zone-you-units-3", ZONE_BOX);
    const h = directorHarness();
    h.director.play(stage([play("p1", HAND), summon("p1", HAND)]));
    const animatingInLayer = (): Element[] => [...h.root.querySelectorAll("[data-animating]")];
    expect(animatingInLayer()).toEqual([]);

    hand.setAttribute("data-animating", "damage");
    await Promise.resolve();
    expect(animatingInLayer().map((el) => el.getAttribute("data-animating"))).toEqual(["damage"]);

    // The runner takes the card's attribute away; the copy's goes in the same task, so a wait on
    // `[data-animating]` (cy.settled) ends exactly when it would without the layer.
    let seenByNextTask: number | null = null;
    const nextTask = new Promise<void>((done) => {
      setTimeout(() => {
        seenByNextTask = animatingInLayer().length;
        done();
      }, 0);
    });
    hand.removeAttribute("data-animating");
    await Promise.resolve();
    expect(animatingInLayer()).toEqual([]);
    await nextTask;
    expect(seenByNextTask).toBe(0);
  });

  it("B46 with nothing to copy the stand-in is a card-shaped light that drops in", () => {
    boardElement("zone-you-units-4", ZONE_BOX);
    const h = directorHarness();
    h.director.play(stage([summon("p1", "t50", 4)]));
    const hold = h.root.querySelector<HTMLElement>('[data-fx="hold"]');
    expect(hold?.getAttribute("data-look")).toBe("glow");
    expect(hold?.querySelector(".fx-hold-glow")).not.toBeNull();
    expect(hold?.style.getPropertyValue("--fx-o0")).toBe("0");
  });

  it("B46 the opponent's back is copied from the last card in their hand", () => {
    boardElement("hand-opponent", { x: 0, y: 0, width: 400, height: 90 }, '<div class="card card-back" id="b1"></div><div class="card card-back" id="b2"></div>');
    const backs = document.querySelectorAll(".card-back");
    place(backs[0]!, { x: 10, y: 5, width: 50, height: 70 });
    place(backs[1]!, { x: 70, y: 5, width: 50, height: 70 });
    boardElement("zone-opponent-units-2", ZONE_BOX);
    const h = directorHarness();
    h.director.play(stage([play("p2", "c99"), summon("p2", "c99", 2)]));
    const copy = h.root.querySelector('[data-fx="hold"] .fx-hold-card');
    expect(copy?.classList.contains("card-back")).toBe(true);
    expect(copy?.hasAttribute("id")).toBe(false);
  });

  it("B46 an effect aimed at a carried card lands on its stand-in, not on the empty place it left", () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    boardElement("zone-you-units-3", ZONE_BOX);
    const h = directorHarness();
    h.director.play(stage([play("p1", HAND), summon("p1", HAND)]));
    const hold = h.root.querySelector<HTMLElement>('[data-fx="hold"]')!;
    const land = landingBox(ZONE_BOX, HAND_BOX);
    place(hold, land);
    h.director.play([{ kind: "splat", tone: "heal", amount: 1, at: tid(`hand-card-${HAND}`), delayMs: 0, durationMs: 500 }]);
    h.frameAt(1016);
    const splat = h.root.querySelector<HTMLElement>('[data-fx="splat"]');
    expect(splat?.style.getPropertyValue("--fx-x")).toBe(`${land.x + land.width / 2}px`);
  });
});

describe("B47 concealing in the page", () => {
  it("B47 an after-conceal is set at its delay and undone on release", () => {
    const card = boardElement(`card-${ENEMY}`, ENEMY_BOX);
    const h = directorHarness();
    const D = 350;
    h.director.play(stage([{ type: "destroyed", instanceId: ENEMY, owner: "p2" } as GameEvent], D));
    h.frameAt(1000);
    expect(card.hasAttribute("data-fx-concealed")).toBe(false);
    h.frameAt(1000 + Math.round(FX_CONCEAL_AT * D));
    expect(card.getAttribute("data-fx-concealed")).toBe("after");
    h.director.release();
    expect(card.hasAttribute("data-fx-concealed")).toBe(false);
  });

  it("B47 clear() undoes every stage effect as well", () => {
    const card = boardElement(`card-${ENEMY}`, ENEMY_BOX);
    const h = directorHarness();
    h.director.play([{ kind: "conceal", testid: `card-${ENEMY}`, mode: "now", delayMs: 0, durationMs: FX_HOLD_MAX_MS }]);
    expect(card.getAttribute("data-fx-concealed")).toBe("now");
    h.director.clear();
    expect(card.hasAttribute("data-fx-concealed")).toBe(false);
  });
});

describe("B48 aiming the lunge in the page", () => {
  it("B48 the attacker is aimed along the line to its target, stopping just into it, and release clears the aim", () => {
    const attacker = boardElement(`card-${MINE}`, { x: 300, y: 300, width: 60, height: 82 });
    boardElement(`card-${ENEMY}`, ENEMY_BOX);
    const h = directorHarness();
    h.director.play(stage([{ type: "attackDeclared", attackerId: MINE, targetId: ENEMY, forced: false }], 350));
    const x = Number.parseFloat(attacker.style.getPropertyValue("--fx-lunge-x"));
    const y = Number.parseFloat(attacker.style.getPropertyValue("--fx-lunge-y"));
    expect(x).toBeCloseTo(0, 5);
    // Straight up the board: 200 px between centres, less 0.55 of the two half-heights (82).
    expect(y).toBeLessThan(-FX_LUNGE_MIN_PX);
    expect(y).toBeGreaterThan(-200);
    h.director.release();
    expect(attacker.style.getPropertyValue("--fx-lunge-x")).toBe("");
  });

  it("B48 the aim is at least the BUILD lunge distance and at most FX_LUNGE_MAX_PX", () => {
    const attacker = boardElement(`card-${MINE}`, { x: 0, y: 0, width: 60, height: 82 });
    boardElement(`card-${ENEMY}`, { x: 3000, y: 0, width: 60, height: 82 });
    const h = directorHarness();
    h.director.play([{ kind: "lunge", attacker: `card-${MINE}`, target: `card-${ENEMY}`, delayMs: 0, durationMs: 350 }]);
    expect(Number.parseFloat(attacker.style.getPropertyValue("--fx-lunge-x"))).toBeCloseTo(FX_LUNGE_MAX_PX, 5);

    const near = boardElement(`card-${ENEMY}-near`, { x: 10, y: 0, width: 60, height: 82 });
    h.director.play([{ kind: "lunge", attacker: `card-${MINE}`, target: near.getAttribute("data-testid")!, delayMs: 0, durationMs: 350 }]);
    expect(Number.parseFloat(attacker.style.getPropertyValue("--fx-lunge-x"))).toBeCloseTo(FX_LUNGE_MIN_PX, 5);
  });
});

describe("B46 standInCopy and landingBox", () => {
  it("B46 the landing box is the zone's height, the source's shape, centred in the zone and never wider than it", () => {
    const land = landingBox(ZONE_BOX, HAND_BOX);
    expect(land.height).toBe(ZONE_BOX.height - 2);
    expect(land.width).toBeCloseTo((ZONE_BOX.height - 2) * (HAND_BOX.width / HAND_BOX.height), 6);
    expect(land.x + land.width / 2).toBeCloseTo(ZONE_BOX.x + ZONE_BOX.width / 2, 6);
    const narrow = landingBox({ x: 0, y: 0, width: 30, height: 84 }, HAND_BOX);
    expect(narrow.width).toBe(28);
  });

  it("B46 a copy keeps the card's classes and words but never its identity", () => {
    const source = document.createElement("div");
    source.className = "card radiant";
    source.setAttribute("data-testid", "card-u1");
    source.setAttribute("data-cost", "3");
    source.innerHTML = '<span data-keyword="Taunt" aria-label="Taunt">TA</span>';
    const copy = standInCopy(source);
    expect(copy.classList.contains("radiant")).toBe(true);
    expect(copy.classList.contains("fx-hold-card")).toBe(true);
    expect(copy.getAttribute("data-cost")).toBe("3");
    expect(copy.hasAttribute("data-testid")).toBe(false);
    expect(copy.querySelector("[aria-label]")).toBeNull();
    expect(textNodes(copy)).toEqual([]);
    expect(source.getAttribute("data-testid")).toBe("card-u1");
  });
});

/* ------------------------------------------------------------------------------------------- *
 * The layer: the release lands in the same commit as the new board
 * ------------------------------------------------------------------------------------------- */

describe("B46 FxLayer releases the stage when the shown view changes", () => {
  it("B46 a stand-in lives while the runner holds the view back and is gone in the render that shows the next view", () => {
    const hand = boardElement(`hand-card-${HAND}`, HAND_BOX);
    hand.className = "card";
    boardElement("zone-you-units-3", ZONE_BOX);
    const timers: (() => void)[] = [];
    const queue = createAnimationQueue({ schedule: (fn) => timers.push(fn), reducedMotion: false });
    const frames: FxFrameSource = { request: () => 1, cancel: () => undefined };
    const seams = {
      now: () => 0,
      frames,
      visibility: { hidden: () => false, subscribe: () => () => undefined },
      surface: () => null,
      viewportWidth: () => 1280,
    };
    const before = fullBoardView();
    const tree = (view: PlayerView) => (
      <div className="game">
        <FxLayer queue={queue} view={view} seams={seams} />
      </div>
    );
    const utils = render(tree(before));
    act(() => queue.enqueue([play("p1", HAND), summon("p1", HAND)], before));
    expect(document.querySelectorAll('[data-fx="hold"]')).toHaveLength(1);

    // A rerender with the same view (any state change in Game) keeps it.
    utils.rerender(tree(before));
    expect(document.querySelectorAll('[data-fx="hold"]')).toHaveLength(1);

    act(() => timers.shift()?.());
    utils.rerender(tree(fullBoardView()));
    expect(document.querySelectorAll('[data-fx="hold"]')).toHaveLength(0);
    expect(hand.hasAttribute("data-fx-concealed")).toBe(false);
  });
});
