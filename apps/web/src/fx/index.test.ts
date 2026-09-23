// docs/polish/1-animations.md S9: `fx/index.ts` is the barrel task 7's settings panel and the
// integration branch import from. It re-exports `FxLayer` (default and named), everything in
// `settings.ts`, and the types in `types.ts`, and nothing else.

import { describe, expect, it } from "vitest";

import FxLayerDefault, { FxLayer as FxLayerNamed } from "./FxLayer.tsx";
import * as fx from "./index.ts";
import * as settings from "./settings.ts";

describe("S9 the fx barrel", () => {
  it("S9 index re-exports FxLayer as its default and as a named export", () => {
    expect(fx.default).toBe(FxLayerDefault);
    expect(fx.FxLayer).toBe(FxLayerNamed);
    expect(fx.default).toBe(fx.FxLayer);
  });

  it("S9 index re-exports every value settings.ts exports, as the same binding", () => {
    for (const [name, value] of Object.entries(settings)) {
      expect(fx[name as keyof typeof fx]).toBe(value);
    }
  });

  it("S9 index exports no other value: FxLayer, and settings.ts", () => {
    expect(Object.keys(fx).sort()).toEqual(["FxLayer", "default", ...Object.keys(settings)].sort());
  });

  it("S9 index carries the settings and contract types (checked by tsc)", () => {
    const current: fx.FxSettings = { ...fx.DEFAULT_FX_SETTINGS, intensity: "high" satisfies fx.FxIntensity };
    const anchor: fx.FxAnchor = { kind: "viewport", at: { x: 0.5, y: 0.45 } };
    const cue: fx.FxCue = { kind: "shake", trauma: 0.5, delayMs: 0 };
    const recipe: fx.FxDescriptor = { recipe: "impact" };
    const props: Pick<fx.FxLayerProps, "seams"> = { seams: {} satisfies Partial<fx.FxSeams> };

    expect(current.intensity).toBe("high");
    expect(anchor.kind).toBe("viewport");
    expect(cue.kind).toBe("shake");
    expect(recipe.recipe).toBe("impact");
    expect(props.seams).toEqual({});
  });
});
