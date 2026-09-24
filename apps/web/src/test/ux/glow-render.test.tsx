// The board's half of the glow contract (docs/polish/7-mobile-ux.md, S6), rendered through `Game`
// so the highlight is the one the client really computes from `legal` and its own interaction:
//
//   B16  every card, zone, hero, `power` and `end-turn` carries `data-glow="ready"` exactly when its
//        testid is in `highlight.glow`, and no `data-glow` attribute otherwise;
//   B17  a card root carries `data-condition-active="true"` exactly when its `CardView` has
//        `conditionActive: true` (R195), for hand, unit and backrow cards alike; card backs never do.
//
// The expected glow is `highlightFor(view, legal, interaction).glow`, with the interaction built by
// the same `onClickTarget` the board's click drives, and each test also names the testids it
// expects to glow, so a highlight that went empty cannot pass by matching an empty DOM.

import type { ActionBody, CardView, PlayerView } from "@jackioh/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { IDLE, highlightFor, onClickTarget, type Interaction } from "../../game/actions.ts";
import { testid } from "../../game/contract.ts";
import Game from "../../game/Game.tsx";
import {
  baseView,
  card,
  emptySide,
  faceDownBackrow,
  faceUpBackrow,
  heroPower,
  pendingFor,
  unit,
} from "../fixtures.ts";

afterEach(cleanup);

const noop = (): void => undefined;

/** Three cards in hand, two units and a face-up backrow card on your side, a hero power; one enemy. */
function boardView(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hero: { health: 30, armor: 0, powers: [heroPower], power: heroPower },
      hand: [
        card({ instanceId: "h1", defId: "core-002", cost: 1 }),
        card({ instanceId: "h2", defId: "core-019", cost: 3 }),
        card({ instanceId: "h3", defId: "core-077", cost: 6 }),
      ],
      units: [unit("p1", { instanceId: "u1" }), unit("p1", { instanceId: "u2" }), null, null, null],
      backrow: [faceUpBackrow("p1", { instanceId: "b1", defId: "core-020", type: "Field Spell" }), null, null, null, null],
    }),
    opponent: emptySide("p2", {
      hand: { count: 3 },
      units: [unit("p2", { instanceId: "e1" }), null, null, null, null],
      backrow: [faceDownBackrow, null, null, null, null],
    }),
    ...over,
  });
}

const LEGAL: ActionBody[] = [
  { type: "play", instanceId: "h1", zone: { row: "units", lane: 3 } },
  { type: "play", instanceId: "h1", zone: { row: "units", lane: 4 } },
  { type: "play", instanceId: "h2", targets: [{ pick: "instance", instanceId: "e1" }] },
  { type: "play", instanceId: "h2", targets: [{ pick: "hero", player: "p2" }] },
  { type: "attack", attackerId: "u1", targetId: "e1" },
  { type: "attack", attackerId: "u1", targetId: "hero-p2" },
  { type: "switchPosition", instanceId: "u2" },
  { type: "activatePower", instanceId: "power-1" },
  { type: "endTurn" },
  { type: "offerDraw" },
  { type: "concede" },
];

function ownHand(view: PlayerView): CardView[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand should be full cards");
  return hand;
}

/** S6's `zone-<side>-<row>-<lane>`, lanes 1 to 5, spelled out so a loop can build it. */
function zoneTestid(side: "you" | "opponent", row: "units" | "backrow", lane: number): string {
  return `zone-${side}-${row}-${lane}`;
}

/** Every element B16 speaks for that this view renders. */
function glowableTestids(view: PlayerView): string[] {
  const ids: string[] = ownHand(view).map((c) => testid.handCard(c.instanceId));
  for (const side of ["you", "opponent"] as const) {
    const seat = side === "you" ? view.you : view.opponent;
    for (const u of seat.units) if (u !== null) ids.push(testid.card(u.instanceId));
    for (const b of seat.backrow) if (b !== null && !b.faceDown) ids.push(testid.card(b.instanceId));
    for (const row of ["units", "backrow"] as const) {
      for (let lane = 1; lane <= 5; lane += 1) ids.push(zoneTestid(side, row, lane));
    }
    ids.push(testid.hero(side));
  }
  if (view.you.hero.power !== null) ids.push(testid.power);
  ids.push(testid.endTurn);
  return ids;
}

function byTestid(id: string): Element {
  const el = document.querySelector(`[data-testid="${id}"]`);
  if (el === null) throw new Error(`nothing renders data-testid="${id}"`);
  return el;
}

/**
 * B16's two halves: each glowable element carries `data-glow="ready"` iff its testid glows, and no
 * element anywhere in the document carries a `data-glow` that the glow set does not name.
 */
function expectDomGlow(view: PlayerView, glow: ReadonlySet<string>): void {
  for (const id of glowableTestids(view)) {
    expect(byTestid(id).getAttribute("data-glow"), id).toBe(glow.has(id) ? "ready" : null);
  }
  for (const el of document.querySelectorAll("[data-glow]")) {
    const id = el.getAttribute("data-testid") ?? "(no testid)";
    expect(glow.has(id), `${id} carries data-glow but is not in highlight.glow`).toBe(true);
    expect(el.getAttribute("data-glow"), id).toBe("ready");
  }
}

function glowFor(view: PlayerView, legal: readonly ActionBody[], interaction: Interaction): ReadonlySet<string> {
  return highlightFor(view, legal, interaction).glow ?? new Set<string>();
}

describe("B16 data-glow on the board follows highlight.glow", () => {
  it("B16 at rest: playable hand cards, the ready attacker and the power glow; nothing else does", () => {
    const view = boardView();
    render(<Game view={view} legal={LEGAL} onAction={noop} />);

    const glow = glowFor(view, LEGAL, IDLE);
    for (const id of [testid.handCard("h1"), testid.handCard("h2"), testid.card("u1"), testid.power]) {
      expect(glow.has(id), id).toBe(true);
    }
    expectDomGlow(view, glow);

    // Legal but never green: the switch-only unit, end-turn while moves remain, draw and concede.
    expect(screen.getByTestId(testid.card("u2"))).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.endTurn)).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.offerDraw)).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.concede)).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.handCard("h3"))).not.toHaveAttribute("data-glow");
  });

  it("B16 with a card selected, its zones glow and the hand does not", () => {
    const view = boardView();
    render(<Game view={view} legal={LEGAL} onAction={noop} />);

    fireEvent.click(screen.getByTestId(testid.handCard("h1")));

    const playing = onClickTarget(view, LEGAL, IDLE, { on: "hand", instanceId: "h1" }).interaction;
    const glow = glowFor(view, LEGAL, playing);
    expect(glow.has(testid.zone("you", "units", 3))).toBe(true);
    expect(glow.has(testid.zone("you", "units", 4))).toBe(true);
    expectDomGlow(view, glow);

    expect(screen.getByTestId(testid.zone("you", "units", 3))).toHaveAttribute("data-glow", "ready");
    expect(screen.getByTestId(testid.handCard("h1"))).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.handCard("h2"))).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.zone("you", "units", 5))).not.toHaveAttribute("data-glow");
  });

  it("B16 with an attacker selected, the enemy unit and hero glow and the attacker does not", () => {
    const view = boardView();
    render(<Game view={view} legal={LEGAL} onAction={noop} />);

    fireEvent.click(screen.getByTestId(testid.card("u1")));

    const attacking = onClickTarget(view, LEGAL, IDLE, { on: "unit", instanceId: "u1", side: "you", lane: 1 })
      .interaction;
    const glow = glowFor(view, LEGAL, attacking);
    expectDomGlow(view, glow);

    expect(screen.getByTestId(testid.card("e1"))).toHaveAttribute("data-glow", "ready");
    expect(screen.getByTestId(testid.hero("opponent"))).toHaveAttribute("data-glow", "ready");
    expect(screen.getByTestId(testid.card("u1"))).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.hero("you"))).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.power)).not.toHaveAttribute("data-glow");
  });

  it("B16 with the viewer's prompt open, the cells its options name glow", () => {
    const view = boardView({
      pending: pendingFor("target", [
        { key: "instance:e1", label: "Enemy", instanceId: "e1" },
        { key: "hero:p2", label: "Enemy hero", player: "p2" },
      ]),
    });
    render(<Game view={view} legal={[]} onAction={noop} />);

    const glow = glowFor(view, [], IDLE);
    expectDomGlow(view, glow);
    expect(screen.getByTestId(testid.card("e1"))).toHaveAttribute("data-glow", "ready");
    expect(screen.getByTestId(testid.hero("opponent"))).toHaveAttribute("data-glow", "ready");
  });

  it("B16 end-turn glows once nothing else can act, and draw and concede still do not", () => {
    const view = boardView();
    const legal: ActionBody[] = [{ type: "endTurn" }, { type: "offerDraw" }, { type: "concede" }];
    render(<Game view={view} legal={legal} onAction={noop} />);

    const glow = glowFor(view, legal, IDLE);
    expectDomGlow(view, glow);
    expect(screen.getByTestId(testid.endTurn)).toHaveAttribute("data-glow", "ready");
    expect(screen.getByTestId(testid.offerDraw)).not.toHaveAttribute("data-glow");
    expect(screen.getByTestId(testid.concede)).not.toHaveAttribute("data-glow");
  });

  it("B16 with no legal actions nothing on the board carries data-glow", () => {
    const view = boardView();
    render(<Game view={view} legal={[]} onAction={noop} />);

    expect(document.querySelectorAll("[data-glow]")).toHaveLength(0);
  });

  it("B16 a legal element without glow keeps data-legal and gets no data-glow", () => {
    const view = boardView();
    render(<Game view={view} legal={LEGAL} onAction={noop} />);

    // data-legal stays the click gate; the glow is a separate, narrower attribute.
    const u2 = screen.getByTestId(testid.card("u2"));
    expect(u2).toHaveAttribute("data-legal", "true");
    expect(u2).not.toHaveAttribute("data-glow");
    const u1 = screen.getByTestId(testid.card("u1"));
    expect(u1).toHaveAttribute("data-legal", "true");
    expect(u1).toHaveAttribute("data-glow", "ready");
  });
});

// ---------------------------------------------------------------------------------------------
// B17: data-condition-active
// ---------------------------------------------------------------------------------------------

function flaggedView(): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hero: { health: 30, armor: 0, powers: [heroPower], power: heroPower },
      hand: [
        card({ instanceId: "h1", defId: "core-010", cost: 0, conditionActive: true }),
        card({ instanceId: "h2", defId: "core-019", cost: 3 }),
      ],
      units: [
        unit("p1", { instanceId: "u1", conditionActive: true }),
        unit("p1", { instanceId: "u2" }),
        null,
        null,
        null,
      ],
      backrow: [
        faceUpBackrow("p1", { instanceId: "b1", defId: "core-093", type: "Field Spell", conditionActive: true }),
        faceUpBackrow("p1", { instanceId: "b2", defId: "core-020", type: "Field Spell" }),
        null,
        null,
        null,
      ],
    }),
    opponent: emptySide("p2", {
      hand: { count: 4 },
      units: [unit("p2", { instanceId: "e1" }), null, null, null, null],
      backrow: [faceDownBackrow, faceDownBackrow, null, null, null],
    }),
  });
}

function conditionTestids(): string[] {
  return [...document.querySelectorAll("[data-condition-active]")]
    .map((el) => el.getAttribute("data-testid") ?? "(no testid)")
    .sort();
}

describe("B17 data-condition-active follows the view's conditionActive", () => {
  it("B17 hand, unit and backrow roots carry it exactly when their CardView does, and nothing else does", () => {
    render(<Game view={flaggedView()} legal={[]} onAction={noop} />);

    expect(conditionTestids()).toEqual([testid.card("b1"), testid.card("u1"), testid.handCard("h1")].sort());
    for (const id of [testid.handCard("h1"), testid.card("u1"), testid.card("b1")]) {
      expect(screen.getByTestId(id)).toHaveAttribute("data-condition-active", "true");
    }
    for (const id of [testid.handCard("h2"), testid.card("u2"), testid.card("b2"), testid.card("e1")]) {
      expect(screen.getByTestId(id)).not.toHaveAttribute("data-condition-active");
    }
  });

  it("B17 card backs never carry it: the opponent's hand and face-down backrow", () => {
    render(<Game view={flaggedView()} legal={[]} onAction={noop} />);

    const theirHand = screen.getByTestId("hand-opponent");
    expect(theirHand.querySelectorAll("[data-condition-active]")).toHaveLength(0);
    for (let lane = 1; lane <= 5; lane += 1) {
      const zone = screen.getByTestId(zoneTestid("opponent", "backrow", lane));
      expect(zone.querySelectorAll("[data-condition-active]"), `opponent backrow ${lane}`).toHaveLength(0);
    }
  });

  it("B17 the flag and the green glow are separate attributes on one playable card", () => {
    const legal: ActionBody[] = [
      { type: "play", instanceId: "h1" },
      { type: "play", instanceId: "h2", zone: { row: "units", lane: 3 } },
      { type: "endTurn" },
    ];
    render(<Game view={flaggedView()} legal={legal} onAction={noop} />);

    const flaggedAndPlayable = screen.getByTestId(testid.handCard("h1"));
    expect(flaggedAndPlayable).toHaveAttribute("data-glow", "ready");
    expect(flaggedAndPlayable).toHaveAttribute("data-condition-active", "true");
    const playableOnly = screen.getByTestId(testid.handCard("h2"));
    expect(playableOnly).toHaveAttribute("data-glow", "ready");
    expect(playableOnly).not.toHaveAttribute("data-condition-active");
  });

  it("B17 a flagged card the engine does not list keeps the flag and gets no glow", () => {
    render(<Game view={flaggedView()} legal={[{ type: "endTurn" }]} onAction={noop} />);

    const flagged = screen.getByTestId(testid.handCard("h1"));
    expect(flagged).toHaveAttribute("data-condition-active", "true");
    expect(flagged).not.toHaveAttribute("data-glow");
  });
});
