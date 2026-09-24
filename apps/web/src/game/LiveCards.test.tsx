// Cards in play show what they are now; the collection shows them as printed (SPEC §10.10, R243).
//
// Every view here is a fixture shaped as `viewFor` builds it (src/test/fixtures.ts): the hand's
// `attack`, `health` and `power`, `UnitView.vanilla`, `HeroView.powers` and `PlayerView.defs` are
// what hidden-information.test.ts and vanilla-and-positions.test.ts pin the engine to carrying. The
// board, a prompt, the showcase and the log render them; the deck builder's detail view renders
// the catalog alone.

import { CATALOG } from "@jackioh/cards";
import type { BackrowView, CardDef, GameEvent, HeroPowerView, PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONCEALED_TEXT,
  CardDetail,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  INSPECT_HOVER,
  INSPECT_PRINTED,
  VANILLA_TEXT,
  closeInspect,
} from "../cards/index.ts";
import { HOVER_DELAY_MS } from "../cards/inspect/constants.ts";
import { resetFxSettingsForTests } from "../fx/settings.ts";
import { __resetSettingsForTests } from "../settings/store.ts";
import { baseView, card, emptySide, faceUpBackrow, fusedDef, unit, withEvents } from "../test/fixtures.ts";
import Board from "./Board.tsx";
import { CatalogContext, lookupFromDefs } from "./catalog.ts";
import { testid } from "./contract.ts";
import Log from "./Log.tsx";
import CardShowcase from "./showcase/CardShowcase.tsx";
import { showcaseTestid } from "./showcase/constants.ts";

afterEach(() => {
  act(() => {
    closeInspect();
  });
  cleanup();
  vi.useRealTimers();
  resetFxSettingsForTests();
  __resetSettingsForTests();
});

const lookup = lookupFromDefs(CATALOG);

function def(id: string): CardDef {
  const found = CATALOG[id];
  if (found === undefined) throw new Error(`the catalog has no ${id}`);
  return found;
}

function withCatalog(node: ReactElement): ReactElement {
  return <CatalogContext.Provider value={lookup}>{node}</CatalogContext.Provider>;
}

function renderBoard(view: PlayerView): void {
  render(withCatalog(<Board view={view} />));
}

/** Rests a mouse on `element` until its hover preview is up, and returns the preview. */
function hover(element: HTMLElement): HTMLElement {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
  });
  return screen.getByTestId(INSPECT_HOVER);
}

function text(root: Element, selector: string): string {
  return root.querySelector(selector)?.textContent ?? "";
}

/* ------------------------------------------------------------------------------ match-made cards */

describe("R243 a fused card says what it is: name, text, tags, keywords and stats, never a blank face", () => {
  // #99 Craft a Card's result in hand, and #85's fusion of a played unit onto one on the field.
  const crafted = fusedDef([def("core-011"), def("core-089")], 1);
  const onField = fusedDef([def("core-020"), def("core-003")], 2);

  function fusedView(): PlayerView {
    return baseView({
      you: emptySide("p1", {
        hand: [card({ instanceId: "h1", defId: crafted.id, cost: 0, attack: 5, health: 5 })],
        units: [
          unit("p1", {
            instanceId: "u1",
            defId: onField.id,
            attack: 8,
            maxHealth: 3,
            health: 3,
            keywords: [{ kind: "First Strike" }, { kind: "Taunt" }, { kind: "Divine Shield" }, { kind: "Reborn" }],
          }),
          null,
          null,
          null,
          null,
        ],
      }),
      defs: { [crafted.id]: crafted, [onField.id]: onField },
    });
  }

  it("a crafted card in hand prints its fused name, both ingredients' text, its tags and its summed stats", () => {
    renderBoard(fusedView());
    const root = screen.getByTestId(testid.handCard("h1"));
    expect(text(root, ".card-name")).toBe("Tempo Timmy + Corpse Eater");
    const rules = text(root, ".card-text");
    expect(rules).toContain(def("core-011").base.text);
    expect(rules).toContain(def("core-089").base.text);
    expect([...root.querySelectorAll(".cf-tag")].map((tag) => tag.textContent)).toEqual(["Human"]);
    expect(root.querySelector("[data-face-attack]")).toHaveAttribute("data-face-attack", "5");
    expect(root.querySelector("[data-face-health]")).toHaveAttribute("data-face-health", "5");
    expect(root).toHaveAttribute("data-rarity", "Epic");
    expect(root).toHaveAttribute("data-card-type", "Unit");
    // No id where a name belongs.
    expect(root.textContent).not.toContain("t-1:");
  });

  it("a fused unit on the field names itself on the minion, and its preview prints the fused text and keywords", () => {
    vi.useFakeTimers();
    renderBoard(fusedView());
    const root = screen.getByTestId(testid.card("u1"));
    expect(text(root, ".card-name")).toBe("Pointmaster + Right-house defender");
    expect([...root.querySelectorAll("[data-keyword]")].map((chip) => chip.getAttribute("data-keyword"))).toEqual([
      "First Strike",
      "Taunt",
      "Divine Shield",
      "Reborn",
    ]);
    const preview = hover(root);
    expect(text(preview, ".card-name")).toBe("Pointmaster + Right-house defender");
    expect(text(preview, ".card-text")).toContain(def("core-003").base.text);
    const glossary = [...preview.querySelectorAll("[data-glossary-term]")].map((entry) => entry.getAttribute("data-glossary-term"));
    expect(glossary).toEqual(expect.arrayContaining(["First Strike", "Taunt", "Divine Shield", "Reborn"]));
  });

  it("without the view's definitions the same card has only its id, which is the blank face this replaces", () => {
    const { defs: _defs, ...bare } = fusedView();
    renderBoard(bare);
    expect(text(screen.getByTestId(testid.handCard("h1")), ".card-name")).toBe(crafted.id);
  });

  it("the log names a fused card by its name, and the showcase holds up the opponent's crafted card as itself", () => {
    vi.useFakeTimers();
    const playedFused: GameEvent = { type: "cardPlayed", player: "p2", instanceId: "e1", defId: crafted.id, costPaid: 0 };
    const view = baseView({
      opponent: emptySide("p2", {
        hand: { count: 2 },
        units: [unit("p2", { instanceId: "e1", defId: crafted.id, attack: 5, maxHealth: 5, health: 5 }), null, null, null, null],
      }),
      defs: { [crafted.id]: crafted },
    });
    const before = withEvents(baseView(), [{ type: "turnStarted", player: "p2", turn: 4 }]);
    const { rerender } = render(withCatalog(<CardShowcase view={before} />));
    rerender(withCatalog(<CardShowcase view={withEvents(view, [...before.events, playedFused])} />));
    expect(text(screen.getByTestId(showcaseTestid.face), ".card-name")).toBe("Tempo Timmy + Corpse Eater");
    expect(text(screen.getByTestId(showcaseTestid.face), ".card-text")).toContain(def("core-089").base.text);
    cleanup();

    render(withCatalog(<Log view={withEvents(view, [playedFused])} />));
    expect(screen.getByTestId(testid.log).textContent).toContain("Tempo Timmy + Corpse Eater");
    expect(screen.getByTestId(testid.log).textContent).not.toContain("t-1:");
  });

  it("the opponent's hand stays backs, and a face-down card stays a back, whatever the view's definitions hold", () => {
    const view: PlayerView = {
      ...fusedView(),
      opponent: emptySide("p2", { hand: { count: 3 }, backrow: [{ faceDown: true }, null, null, null, null] }),
    };
    renderBoard(view);
    const theirs = screen.getByTestId("hand-opponent");
    expect(theirs.querySelectorAll(".card-back")).toHaveLength(3);
    expect(theirs.textContent).toBe("Hand3");
    const zone = screen.getByTestId(testid.zone("opponent", "backrow", 1));
    expect(zone.querySelector(".card-back")).not.toBeNull();
    expect(zone.textContent).toBe("");
  });
});

/* ------------------------------------------------------------------------- stats that move in hand */

describe("R243 a hand card shows the stats it has now", () => {
  it("a Corpse Eater that has fed in hand shows its grown attack and health, toned as a buff (#89)", () => {
    renderBoard(
      baseView({ you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-089", cost: 4, attack: 9, health: 11 })] }) }),
    );
    const root = screen.getByTestId(testid.handCard("h1"));
    const attack = root.querySelector("[data-face-attack]");
    const health = root.querySelector("[data-face-health]");
    expect(attack).toHaveAttribute("data-face-attack", "9");
    expect(attack).toHaveAttribute("data-tone", "buffed");
    expect(health).toHaveAttribute("data-face-health", "11");
    expect(health).toHaveAttribute("data-tone", "buffed");
  });

  it("the same card in the collection is the printed 2/2", () => {
    render(<CardDetail def={def("core-089")} onClose={() => {}} />);
    expect(screen.getByTestId(INSPECT_FACE_BASE).querySelector("[data-face-attack]")).toHaveAttribute("data-face-attack", "2");
  });
});

/* ------------------------------------------------------------------------------- #98 Heroic Power */

describe("R43 a Heroic Power in play prints the one power it rolled", () => {
  it("in hand: only the rolled power and its X, on the text and on the gem", () => {
    renderBoard(
      baseView({ you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-098", cost: 3, power: "recruit" })] }) }),
    );
    const root = screen.getByTestId(testid.handCard("h1"));
    expect(text(root, ".card-text")).toBe("Indestructible. Once per turn, spend 3: Recruit a permanent. Playing it activates it once");
    expect(text(root, ".card-text")).not.toContain("7 random powers");
    expect(text(root, ".cost-gem")).toBe("3");
  });

  it("on the field: the power the hero's list names for it, with the printed list of seven beside the face", () => {
    vi.useFakeTimers();
    const power: HeroPowerView = { instanceId: "b1", defId: "core-098", name: "ping", x: 1, usedThisTurn: false };
    const heroic: BackrowView = faceUpBackrow("p1", { instanceId: "b1", defId: "core-098", cost: 1 });
    renderBoard(
      baseView({
        you: emptySide("p1", {
          hero: { health: 30, armor: 0, powers: [power], power },
          backrow: [heroic, null, null, null, null],
        }),
      }),
    );
    const preview = hover(screen.getByTestId(testid.card("b1")));
    expect(text(preview, ".card-text")).toBe("Indestructible. Once per turn, spend 1: Deal 1 damage to a target. Playing it activates it once");
    expect(text(preview, `[data-testid="${INSPECT_PRINTED}"]`)).toContain("gain one of 7 random powers");
  });

  it("in the collection: the whole list of seven, base and radiant", () => {
    render(<CardDetail def={def("core-098")} onClose={() => {}} />);
    expect(text(screen.getByTestId(INSPECT_FACE_BASE), ".card-text")).toContain("gain one of 7 random powers");
    expect(text(screen.getByTestId(INSPECT_FACE_RADIANT), ".card-text")).toContain("Powers become");
  });
});

/* ---------------------------------------------------------------------------- #95 Call to Chaos */

describe("Call to Chaos reads ??? in play and its real text in the collection", () => {
  it("in hand its rules box is ???, and its preview holds no printed text beside it", () => {
    vi.useFakeTimers();
    renderBoard(baseView({ you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-095", cost: 4 })] }) }));
    const root = screen.getByTestId(testid.handCard("h1"));
    expect(text(root, ".card-text")).toBe(CONCEALED_TEXT);
    expect(text(root, ".card-name")).toBe("Call to Chaos (Core Edition)");
    const preview = hover(root);
    expect(text(preview, ".card-text")).toBe(CONCEALED_TEXT);
    expect(preview.querySelector(`[data-testid="${INSPECT_PRINTED}"]`)).toBeNull();
    expect(preview.textContent).not.toContain("summon 3 random 3-cost Units");
  });

  it("the collection's detail view prints both faces' real text", () => {
    render(<CardDetail def={def("core-095")} onClose={() => {}} />);
    expect(text(screen.getByTestId(INSPECT_FACE_BASE), ".card-text")).toContain("summon 3 random 3-cost Units");
    expect(text(screen.getByTestId(INSPECT_FACE_RADIANT), ".card-text")).toContain("cast a random Call to Chaos");
  });
});

/* --------------------------------------------------------------------------------------- Vanilla */

describe("R243 a Vanilla unit is marked, and its preview says its text is gone", () => {
  it("the minion wears the Vanilla stamp and its preview prints the lost text only as printed", () => {
    vi.useFakeTimers();
    renderBoard(
      baseView({
        you: emptySide("p1", {
          units: [
            unit("p1", { instanceId: "u1", defId: "core-091", attack: 1, maxHealth: 6, health: 6, keywords: [], vanilla: true }),
            null,
            null,
            null,
            null,
          ],
        }),
      }),
    );
    const root = screen.getByTestId(testid.card("u1"));
    expect(root).toHaveAttribute("data-vanilla", "true");
    expect(text(root, ".cf-vanilla-word")).toBe("Vanilla");
    const preview = hover(root);
    expect(text(preview, ".card-text")).toBe(VANILLA_TEXT);
    expect(text(preview, `[data-testid="${INSPECT_PRINTED}"]`)).toContain(def("core-091").base.text);
  });

  it("a unit that is not Vanilla carries no mark", () => {
    renderBoard(
      baseView({ you: emptySide("p1", { units: [unit("p1", { instanceId: "u1", defId: "core-091" }), null, null, null, null] }) }),
    );
    const root = screen.getByTestId(testid.card("u1"));
    expect(root).not.toHaveAttribute("data-vanilla");
    expect(root.querySelector(".cf-vanilla")).toBeNull();
  });
});
