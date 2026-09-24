// Polish 6, slice A: `<CardArt>`'s DOM contract (docs/polish/6-cards.md, Surface A "DOM contract",
// behaviour B6). The `manifest` prop is injected, so real art is exercised without any file in
// apps/web/public/art/.

import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef } from "@jackioh/shared";

import { CardArt, artUrl, themeFor, type ArtManifest, type ArtShape, type CardArtProps } from "./index.ts";

afterEach(cleanup);

const SHAPES: readonly ArtShape[] = ["portrait", "window", "arch", "notched", "oval", "strip"];

function def(id: string): CardDef {
  const found = CATALOG[id];
  if (found === undefined) throw new Error(`the catalog has no ${id}`);
  return found;
}

/** Render one card's art and return the `.cf-art` span, which must be the root CardArt draws. */
function renderArt(id: string, over: Partial<CardArtProps> = {}): HTMLElement {
  const card = def(id);
  const { container } = render(
    <CardArt defId={card.id} radiant={false} tags={card.tags} type={card.type} shape="portrait" {...over} />,
  );
  const art = container.querySelector<HTMLElement>(".cf-art");
  if (art === null) throw new Error("CardArt rendered no .cf-art");
  expect(container.firstElementChild).toBe(art);
  return art;
}

function backgroundOf(art: HTMLElement): string {
  return art.style.backgroundImage;
}

describe("B6: CardArt", () => {
  it("B6 an unlisted id renders procedural art: a span with a data:image/svg+xml background, cover, and no img", () => {
    const art = renderArt("core-002", { manifest: {} });
    expect(art.tagName).toBe("SPAN");
    expect(art.getAttribute("data-art")).toBe("procedural");
    expect(backgroundOf(art)).toContain("data:image/svg+xml");
    expect(art.style.backgroundSize).toBe("cover");
    expect(art.querySelector("img")).toBeNull();
    expect(art.querySelector(".cf-art-tint")).toBeNull();
  });

  it("B6 the span carries the shape class, the theme and the variant, is aria-hidden and holds no text", () => {
    for (const shape of SHAPES) {
      const card = def("core-012");
      const art = renderArt(card.id, { shape, manifest: {} });
      expect(art.classList.contains("cf-art"), shape).toBe(true);
      expect(art.classList.contains(`cf-art--${shape}`), shape).toBe(true);
      expect(art.getAttribute("data-art-theme"), shape).toBe(themeFor(card.tags, card.type));
      expect(art.getAttribute("data-art-variant"), shape).toBe("base");
      expect(art.getAttribute("aria-hidden"), shape).toBe("true");
      expect(art.textContent, shape).toBe("");
      cleanup();
    }
  });

  it("B6 the theme attribute follows themeFor for a spread of catalog cards", () => {
    for (const id of ["core-095", "core-090-1", "core-051-1", "core-t-rush", "core-018", "core-006", "core-041"]) {
      const card = def(id);
      const art = renderArt(id, { manifest: {} });
      expect(art.getAttribute("data-art-theme"), id).toBe(themeFor(card.tags, card.type));
      cleanup();
    }
  });

  it("B6 the radiant variant is marked and draws a different background from the base", () => {
    const base = backgroundOf(renderArt("core-011", { manifest: {} }));
    cleanup();
    const radiant = renderArt("core-011", { radiant: true, manifest: {} });
    expect(radiant.getAttribute("data-art-variant")).toBe("radiant");
    expect(backgroundOf(radiant)).toContain("data:image/svg+xml");
    expect(backgroundOf(radiant)).not.toBe(base);
  });

  it("B6 two different cards draw different procedural backgrounds", () => {
    const first = backgroundOf(renderArt("core-002", { manifest: {} }));
    cleanup();
    const second = backgroundOf(renderArt("core-003", { manifest: {} }));
    expect(second).not.toBe(first);
  });

  it("B6 a listed id renders real art: img.cf-art-img, alt empty, lazy, async, not draggable, data-art=real", () => {
    const manifest: ArtManifest = { "core-002": { base: true } };
    const art = renderArt("core-002", { manifest });
    expect(art.getAttribute("data-art")).toBe("real");
    const img = art.querySelector<HTMLImageElement>("img");
    expect(img).not.toBeNull();
    expect(img?.classList.contains("cf-art-img")).toBe(true);
    expect(img?.getAttribute("alt")).toBe("");
    expect(img?.getAttribute("loading")).toBe("lazy");
    expect(img?.getAttribute("decoding")).toBe("async");
    expect(img?.getAttribute("draggable")).toBe("false");
    expect(img?.getAttribute("src")).toBe(artUrl("core-002", false, manifest)?.src);
    expect(art.querySelector(".cf-art-tint")).toBeNull();
    // Still decoration: hidden from assistive tech, and no text a name lookup could match.
    expect(art.getAttribute("aria-hidden")).toBe("true");
    expect(art.textContent).toBe("");
  });

  it("B6 a radiant request with only the base listed shows the base img plus the gold tint", () => {
    const manifest: ArtManifest = { "core-002": { base: true } };
    const art = renderArt("core-002", { radiant: true, manifest });
    expect(art.getAttribute("data-art")).toBe("real");
    expect(art.getAttribute("data-art-variant")).toBe("radiant");
    expect(art.querySelector("img")?.getAttribute("src")).toBe(`${import.meta.env.BASE_URL}art/core-002.webp`);
    expect(art.querySelector("span.cf-art-tint")).not.toBeNull();
  });

  it("B6 a listed radiant file renders without a tint", () => {
    const manifest: ArtManifest = { "core-002": { base: true, radiant: true } };
    const art = renderArt("core-002", { radiant: true, manifest });
    expect(art.querySelector("img")?.getAttribute("src")).toBe(`${import.meta.env.BASE_URL}art/core-002-radiant.webp`);
    expect(art.querySelector(".cf-art-tint")).toBeNull();
  });

  it("B6 an error on the real img switches to procedural art", () => {
    const manifest: ArtManifest = { "core-002": { base: true } };
    const art = renderArt("core-002", { manifest });
    const img = art.querySelector("img");
    expect(img).not.toBeNull();
    if (img === null) return;

    const container = art.parentElement;
    fireEvent.error(img);

    // Re-read from the container: the swap may re-create the span rather than patch it.
    const after = container?.querySelector<HTMLElement>(".cf-art") ?? null;
    expect(after).not.toBeNull();
    if (after === null) return;
    expect(container?.querySelector("img")).toBeNull();
    expect(after.getAttribute("data-art")).toBe("procedural");
    expect(backgroundOf(after)).toContain("data:image/svg+xml");
    expect(after.getAttribute("aria-hidden")).toBe("true");
    expect(after.textContent).toBe("");
  });

  it("B6 a manifest listing a different id leaves this card procedural", () => {
    const art = renderArt("core-002", { manifest: { "core-003": { base: true, radiant: true } } });
    expect(art.getAttribute("data-art")).toBe("procedural");
    expect(art.querySelector("img")).toBeNull();
  });

  it("B6 with no manifest prop the shipped, empty ART_MANIFEST gives procedural art", () => {
    for (const id of ["core-001", "core-051", "core-100", "core-t-bread"]) {
      const art = renderArt(id);
      expect(art.getAttribute("data-art"), id).toBe("procedural");
      expect(art.querySelector("img"), id).toBeNull();
      cleanup();
    }
  });

  it("B6 className is added to the span alongside the cf-art classes", () => {
    const art = renderArt("core-002", { manifest: {}, className: "extra-art" });
    expect(art.classList.contains("extra-art")).toBe(true);
    expect(art.classList.contains("cf-art")).toBe(true);
  });
});
