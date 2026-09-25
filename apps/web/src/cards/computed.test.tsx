// R280: in play, a card whose view carries `preview` prints what its formula comes to now, in
// braces after the formula — in hand, on the field, and in the overlays that show those faces. The
// collection prints no value. Every view is a fixture shaped as `viewFor` builds it; the engine's
// side (which cards carry it, and for whom) is packages/engine/test/preview.test.ts's and
// packages/cards/test/preview.test.ts's.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef, PlayerView } from "@jackioh/shared";

import { resetFxSettingsForTests } from "../fx/settings.ts";
import Board from "../game/Board.tsx";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import { testid } from "../game/contract.ts";
import { __resetSettingsForTests } from "../settings/store.ts";
import { baseView, card, emptySide, faceUpBackrow, unit } from "../test/fixtures.ts";
import { CardFace } from "./CardFace.tsx";
import { CardDetail } from "./inspect/CardDetail.tsx";
import { HOVER_DELAY_MS } from "./inspect/constants.ts";
import { closeInspect } from "./inspect/store.ts";
import { INSPECT_FACE_BASE, INSPECT_FACE_RADIANT, INSPECT_HOVER } from "./inspect/testids.ts";
import { faceModel } from "./model.ts";

afterEach(() => {
  act(() => closeInspect());
  cleanup();
  vi.useRealTimers();
  resetFxSettingsForTests();
  __resetSettingsForTests();
});

const lookup = lookupFromDefs(CATALOG);

function def(id: string): CardDef {
  const found = CATALOG[id];
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

function withCatalog(node: ReactElement): ReactElement {
  return <CatalogContext.Provider value={lookup}>{node}</CatalogContext.Provider>;
}

function hover(element: HTMLElement): HTMLElement {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(HOVER_DELAY_MS * 2);
  });
  return screen.getByTestId(INSPECT_HOVER);
}

function values(root: Element): string[] {
  return [...root.querySelectorAll(".cf-value")].map((value) => value.textContent ?? "");
}

/** #31 in hand, #91 on the field, #40 face up in the backrow, each with what viewFor says it comes to. */
function view(): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hand: [card({ instanceId: "h31", defId: "core-031", cost: 2, preview: [{ label: "Fib(cost+1)", value: 2 }] })],
      units: [
        unit("p1", {
          instanceId: "u91",
          defId: "core-091",
          attack: 1,
          maxHealth: 6,
          health: 4,
          counters: { plague: 2 },
          preview: [{ label: "+1 mana per Plague Token", value: 2 }],
        }),
        null,
        null,
        null,
        null,
      ],
      backrow: [
        faceUpBackrow("p1", {
          instanceId: "b40",
          defId: "core-040",
          radiant: true,
          type: "Field Spell",
          preview: [{ label: "twice the cards in your exile", value: 6 }],
        }),
        null,
        null,
        null,
        null,
      ],
    }),
  });
}

describe("R280 what a formula comes to now", () => {
  it("R280 a hand card prints its value in braces right after the formula", () => {
    vi.useFakeTimers();
    render(withCatalog(<Board view={view()} />));
    const hand = screen.getByTestId(testid.handCard("h31"));
    expect(values(hand)).toEqual(["{2}"]);
    expect(hand.querySelector(".card-text")?.textContent).toContain("Deal Fib(cost+1) {2} damage to a target");
    const value = hand.querySelector(".cf-value");
    expect(value).toHaveAttribute("aria-label", "currently 2");
    expect(value).toHaveAttribute("data-label", "Fib(cost+1)");
    // Its hover preview prints the same.
    expect(values(hover(hand))).toEqual(["{2}"]);
  });

  it("R280 a unit on the field and a face-up backrow card print theirs in the face their preview shows", () => {
    vi.useFakeTimers();
    render(withCatalog(<Board view={view()} />));
    const fauci = hover(screen.getByTestId(testid.card("u91")));
    expect(fauci.querySelector(".card-text")?.textContent).toContain("+1 mana per Plague Token {2}");
    act(() => closeInspect());
    const echoes = hover(screen.getByTestId(testid.card("b40")));
    expect(echoes.querySelector(".card-text")?.textContent).toContain("equal to twice the cards in your exile {6}");
  });

  it("R280 values that share a label share one pair of braces, and a label the text lacks goes at the end", () => {
    const face = faceModel({
      defId: "core-092",
      def: def("core-092"),
      radiant: false,
      inPlay: {
        preview: [
          { label: "the combined stats of all your Felinors", value: 2 },
          { label: "the combined stats of all your Felinors", value: 3 },
          { label: "not on this card", value: 9 },
        ],
      },
    });
    const { container } = render(<CardFace face={face} layout="full" />);
    expect(values(container)).toEqual(["{2/3}", "{9}"]);
    const text = container.querySelector(".card-text")?.textContent ?? "";
    expect(text).toContain("the combined stats of all your Felinors {2/3}");
    expect(text.endsWith("{9}")).toBe(true);
  });

  it("R280 the collection prints no value, and a face in play with no preview prints none", () => {
    render(<CardDetail def={def("core-031")} onClose={() => undefined} />);
    expect(values(screen.getByTestId(INSPECT_FACE_BASE))).toEqual([]);
    expect(values(screen.getByTestId(INSPECT_FACE_RADIANT))).toEqual([]);
    cleanup();
    const { container } = render(<CardFace face={faceModel({ defId: "core-031", def: def("core-031"), radiant: false, inPlay: {} })} layout="full" />);
    expect(values(container)).toEqual([]);
  });

  it("R280 a card whose words in play are not its printed ones prints no value (a Vanilla unit, ???)", () => {
    const preview = [{ label: "+1 mana per Plague Token", value: 2 }];
    const vanilla = faceModel({ defId: "core-091", def: def("core-091"), radiant: false, inPlay: { vanilla: true, preview } });
    expect(vanilla.values).toEqual([]);
    const chaos = faceModel({ defId: "core-095", def: def("core-095"), radiant: false, inPlay: { preview } });
    expect(chaos.values).toEqual([]);
  });
});
