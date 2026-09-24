// Polish 6, slice C: the detail view (docs/polish/6-cards.md, B29).
//
// `<CardDetail def onClose actions? meta?>` is a centred dialog: both faces side by side, a meta
// line `#<index> · <set> · <rarity> · <type>` plus ` · <tags>`, the glossary of both faces, then
// the caller's meta and actions, then inspect-close. Its close paths and focus return are B25, in
// inspect.test.tsx. Real catalog throughout.

import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef } from "@jackioh/shared";

import { CARD_SETTINGS_DEFAULTS, writeCardSettings } from "../settings.ts";
import { CardDetail, closeInspect } from "./index.ts";
import {
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  INSPECT_GLOSSARY,
} from "./testids.ts";

/** The meta line's separator, as the Surface spells it. */
const SEP = " · ";

function defOf(id: string): CardDef {
  const def = CATALOG[id];
  if (def === undefined) throw new Error(`expected ${id} in the catalog`);
  return def;
}

function metaOf(def: CardDef): string {
  return `#${def.index}${SEP}${def.set}${SEP}${def.rarity}${SEP}${def.type}`;
}

function faceRoot(testId: string): HTMLElement {
  const holder = screen.getByTestId(testId);
  const face = holder.querySelector<HTMLElement>(".cf");
  if (face === null) throw new Error(`expected a CardFace inside ${testId}`);
  return face;
}

function termsInDetail(): (string | null)[] {
  const detail = screen.getByTestId(INSPECT_DETAIL);
  return Array.from(detail.querySelectorAll(`[data-testid="${INSPECT_GLOSSARY}"] li`)).map((li) =>
    li.getAttribute("data-glossary-term"),
  );
}

function precedes(a: Node, b: Node): boolean {
  return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

afterEach(() => {
  act(() => {
    closeInspect();
  });
  cleanup();
  writeCardSettings(CARD_SETTINGS_DEFAULTS);
});

describe("CardDetail (B29)", () => {
  it("B29 renders inspect-detail as a dialog holding the base face, then the radiant face", () => {
    const def = defOf("core-043");
    render(<CardDetail def={def} onClose={() => undefined} />);

    const detail = screen.getByTestId(INSPECT_DETAIL);
    expect(detail).toHaveAttribute("role", "dialog");
    const base = within(detail).getByTestId(INSPECT_FACE_BASE);
    const radiant = within(detail).getByTestId(INSPECT_FACE_RADIANT);
    expect(precedes(base, radiant), "base face first").toBe(true);

    expect(faceRoot(INSPECT_FACE_BASE).querySelector(".card-name")).toHaveTextContent(def.name);
    expect(faceRoot(INSPECT_FACE_RADIANT).querySelector(".card-name")).toHaveTextContent(def.name);
    expect(faceRoot(INSPECT_FACE_BASE)).not.toHaveAttribute("data-radiant-face");
    expect(faceRoot(INSPECT_FACE_RADIANT)).toHaveAttribute("data-radiant-face", "true");
  });

  it("B29 is a portal into document.body, outside the caller's tree", () => {
    const { container } = render(<CardDetail def={defOf("core-043")} onClose={() => undefined} />);
    const detail = screen.getByTestId(INSPECT_DETAIL);
    expect(document.body.contains(detail)).toBe(true);
    expect(container.contains(detail)).toBe(false);
  });

  it("B29 the meta line reads #<index> · <set> · <rarity> · <type> · <tag>", () => {
    const def = defOf("core-043");
    expect(def.tags).toEqual(["Felinor"]);
    render(<CardDetail def={def} onClose={() => undefined} />);
    expect(screen.getByTestId(INSPECT_DETAIL)).toHaveTextContent(`${metaOf(def)}${SEP}Felinor`);
  });

  it("B29 a card with no tags ends its meta line at the type", () => {
    const def = defOf("core-019");
    expect(def.tags, "the fixture card is untagged").toEqual([]);
    render(<CardDetail def={def} onClose={() => undefined} />);
    const text = screen.getByTestId(INSPECT_DETAIL).textContent ?? "";
    expect(text).toContain(metaOf(def));
    expect(text).not.toContain(`${metaOf(def)}${SEP}`);
  });

  it("B29 a card with two tags names both after the type", () => {
    // No deckable Core card carries two tags; a token does, and the detail takes any def.
    const def = defOf("core-t-felinor");
    expect(def.tags).toEqual(["Felinor", "Token"]);
    render(<CardDetail def={def} onClose={() => undefined} />);
    const text = screen.getByTestId(INSPECT_DETAIL).textContent ?? "";
    const start = text.indexOf(`${metaOf(def)}${SEP}`);
    expect(start, "the meta line, with its tag separator").toBeGreaterThanOrEqual(0);
    const tail = text.slice(start + metaOf(def).length);
    expect(tail).toContain("Felinor");
    expect(tail).toContain("Token");
  });

  it("B29 the meta line of a Mythic names its rarity", () => {
    const def = defOf("core-100");
    expect(def.rarity).toBe("Mythic");
    render(<CardDetail def={def} onClose={() => undefined} />);
    expect(screen.getByTestId(INSPECT_DETAIL)).toHaveTextContent(metaOf(def));
  });

  it("B29 the glossary covers both faces: a keyword only the radiant face has is listed", () => {
    const def = defOf("core-011");
    expect(def.base.keywords.map((k) => k.kind)).not.toContain("Charge");
    expect(def.radiant.keywords.map((k) => k.kind)).toContain("Charge");
    render(<CardDetail def={def} onClose={() => undefined} />);
    const terms = termsInDetail();
    expect(terms).toContain("Rush");
    expect(terms).toContain("First Strike");
    expect(terms).toContain("Charge");
  });

  it("B29 the glossary covers both faces: a trigger only the radiant text names is listed", () => {
    const def = defOf("core-003");
    expect(def.base.text).not.toContain("Death:");
    expect(def.radiant.text).toContain("Death:");
    render(<CardDetail def={def} onClose={() => undefined} />);
    const terms = termsInDetail();
    for (const term of ["Taunt", "Divine Shield", "Reborn", "Death"]) expect(terms).toContain(term);
  });

  it("B29 a card whose faces name no term and carry no keyword renders no glossary", () => {
    const def = defOf("core-t-felinor");
    expect(def.base.text).toBe("");
    expect(def.radiant.text).toBe("");
    render(<CardDetail def={def} onClose={() => undefined} />);
    expect(within(screen.getByTestId(INSPECT_DETAIL)).queryByTestId(INSPECT_GLOSSARY)).toBeNull();
  });

  it("B29 renders the caller's meta and actions inside the dialog, before inspect-close", () => {
    render(
      <CardDetail
        def={defOf("core-043")}
        onClose={() => undefined}
        meta={<span data-testid="caller-meta">In Deck 2</span>}
        actions={
          <button type="button" data-testid="caller-action">
            Add
          </button>
        }
      />,
    );
    const detail = screen.getByTestId(INSPECT_DETAIL);
    const meta = within(detail).getByTestId("caller-meta");
    const action = within(detail).getByTestId("caller-action");
    const close = within(detail).getByTestId(INSPECT_CLOSE);
    expect(meta).toHaveTextContent("In Deck 2");
    expect(precedes(meta, close), "meta before inspect-close").toBe(true);
    expect(precedes(action, close), "actions before inspect-close").toBe(true);
  });

  it("B29 without actions or meta it still holds both faces and inspect-close", () => {
    render(<CardDetail def={defOf("core-084")} onClose={() => undefined} />);
    const detail = screen.getByTestId(INSPECT_DETAIL);
    expect(within(detail).getByTestId(INSPECT_FACE_BASE)).toBeInTheDocument();
    expect(within(detail).getByTestId(INSPECT_FACE_RADIANT)).toBeInTheDocument();
    expect(within(detail).getByTestId(INSPECT_CLOSE)).toBeInTheDocument();
  });

  it("B29 a radiant face that only restates the base text is still the radiant face", () => {
    const def = defOf("core-008");
    expect(def.radiant.text).toBe(def.base.text);
    render(<CardDetail def={def} onClose={() => undefined} />);
    expect(faceRoot(INSPECT_FACE_RADIANT)).toHaveAttribute("data-radiant-face", "true");
    // B7/B14: nothing new to say, so the radiant clause is not printed a second time.
    expect(faceRoot(INSPECT_FACE_RADIANT).querySelector(".cf-text-radiant")).toBeNull();
  });

  it("B29 the base face never prints the radiant clause; the radiant face does when it says something new", () => {
    const def = defOf("core-043");
    expect(def.radiant.text).not.toBe(def.base.text);
    render(<CardDetail def={def} onClose={() => undefined} />);
    expect(faceRoot(INSPECT_FACE_BASE).querySelector(".cf-text-radiant")).toBeNull();
    expect(faceRoot(INSPECT_FACE_RADIANT).querySelector(".cf-text-radiant")).toHaveTextContent(def.radiant.text);
  });

  it("B29 every catalog card opens a detail with its name on both faces and its #index in the meta", () => {
    for (const def of Object.values(CATALOG)) {
      const { unmount } = render(<CardDetail def={def} onClose={() => undefined} />);
      const detail = screen.getByTestId(INSPECT_DETAIL);
      expect(faceRoot(INSPECT_FACE_BASE).querySelector(".card-name"), def.id).toHaveTextContent(def.name);
      expect(faceRoot(INSPECT_FACE_RADIANT).querySelector(".card-name"), def.id).toHaveTextContent(def.name);
      expect(detail.textContent ?? "", def.id).toContain(metaOf(def));
      unmount();
    }
  });
});
