// Audio as the integration branch wires it into Game (docs/polish/reference.md, "audio x cards"):
//
//  - the board's `CatalogContext` reaches the sound director, so a Legendary or Mythic unit enters
//    with its sting (beside task 1's light rays), a unit's thud carries its family's accent and a
//    spell rings in its family's chimes; with no catalog, or for a card behind the sentinel (R203),
//    every card keeps its plain sounds;
//  - a voice line holding the channel marks the board `data-speaking`, the attribute practice's
//    pacing holds the AI on (SPEC §9.9).

import type { GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { CATALOG } from "@jackioh/cards";

import { HIDDEN_DEF_ID } from "./constants.ts";
import { setAudioEngineForTests } from "./engine.ts";
import { resetAudioSettingsForTests } from "./settings.ts";
import type { AudioEngine, SfxId, SfxParams } from "./types.ts";
import { durationFor } from "../game/animations.ts";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import Game from "../game/Game.tsx";
import { baseView, withEvents } from "../test/fixtures.ts";

type FakeEngine = { [K in keyof AudioEngine]: Mock<AudioEngine[K]> } & { say(on: boolean): void };

/** A stand-in for the singleton that records every cue and speaks when told to. */
function fakeEngine(): FakeEngine {
  let speaking = false;
  const listeners = new Set<() => void>();
  const engine: FakeEngine = {
    state: vi.fn<AudioEngine["state"]>(() => "running"),
    unlock: vi.fn<AudioEngine["unlock"]>(),
    preloadVoices: vi.fn<AudioEngine["preloadVoices"]>(),
    setBusy: vi.fn<AudioEngine["setBusy"]>(),
    log: vi.fn<AudioEngine["log"]>(() => []),
    clearLog: vi.fn<AudioEngine["clearLog"]>(),
    contextsCreated: vi.fn<AudioEngine["contextsCreated"]>(() => 1),
    speaking: vi.fn<AudioEngine["speaking"]>(() => speaking),
    subscribeSpeaking: vi.fn<AudioEngine["subscribeSpeaking"]>((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    dispose: vi.fn<AudioEngine["dispose"]>(),
    playSfx: vi.fn<AudioEngine["playSfx"]>(() => true),
    playVoice: vi.fn<AudioEngine["playVoice"]>(() => true),
    say(on) {
      speaking = on;
      for (const listener of [...listeners]) listener();
    },
  };
  return engine;
}

const lookup = lookupFromDefs(CATALOG);

function game(view: PlayerView, withCatalog: boolean): ReactElement {
  const board = <Game view={view} legal={[]} onAction={() => undefined} />;
  return withCatalog ? <CatalogContext.Provider value={lookup}>{board}</CatalogContext.Provider> : board;
}

/** Feeds one burst of events to a mounted Game and lets the runner play all of it. */
function play(events: GameEvent[], withCatalog = true): void {
  const first = baseView();
  const { rerender } = render(game(first, withCatalog));
  rerender(game(withEvents(first, events), withCatalog));
  act(() => {
    vi.advanceTimersByTime(10_000);
  });
}

function sfx(engine: FakeEngine, id: SfxId): (SfxParams | undefined)[] {
  return engine.playSfx.mock.calls.filter((call) => call[0] === id).map((call) => call[1]);
}

const summoned = (defId: string, instanceId = "u9"): GameEvent => ({
  type: "summoned",
  player: "p1",
  instanceId,
  defId,
  row: "units",
  lane: 2,
});

/** #52 and #100: a Legendary and a Mythic Unit. #95 a Call to Chaos Spell, #93 a Field Spell. */
const LEGENDARY_UNIT = "core-052";
const MYTHIC_UNIT = "core-100";

let engine: FakeEngine;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetAudioSettingsForTests();
  engine = fakeEngine();
  setAudioEngineForTests(engine);
});

afterEach(() => {
  cleanup();
  setAudioEngineForTests(null);
  resetAudioSettingsForTests();
  vi.useRealTimers();
  localStorage.clear();
});

describe("the board's catalog reaches the sound director", () => {
  it("the fixtures are what they say: #52 a Legendary Unit and #100 a Mythic one", () => {
    expect([CATALOG[LEGENDARY_UNIT]?.type, CATALOG[LEGENDARY_UNIT]?.rarity]).toEqual(["Unit", "Legendary"]);
    expect([CATALOG[MYTHIC_UNIT]?.type, CATALOG[MYTHIC_UNIT]?.rarity]).toEqual(["Unit", "Mythic"]);
  });

  it("a Legendary unit enters with the brass sting and a Mythic with the prismatic one, as their entries start", () => {
    play([summoned(LEGENDARY_UNIT, "u1"), summoned(MYTHIC_UNIT, "u2")]);
    expect(sfx(engine, "entrance")).toEqual([undefined, { mythic: true }]);
  });

  it("the sting starts with its summon's entry, with the rays, not when the view arrives", () => {
    const first = baseView();
    const { rerender } = render(game(first, true));
    rerender(game(withEvents(first, [{ type: "turnStarted", player: "p1", turn: 3 }, summoned(LEGENDARY_UNIT)]), true));
    expect(sfx(engine, "entrance"), "the turn banner is still animating").toEqual([]);
    act(() => {
      vi.advanceTimersByTime(durationFor("turnStarted", false));
    });
    expect(sfx(engine, "entrance")).toEqual([undefined]);
  });

  it("a unit's thud carries its family: #52 is a Human", () => {
    play([summoned(LEGENDARY_UNIT)]);
    expect(sfx(engine, "summon").at(-1)).toMatchObject({ timbre: "human" });
  });

  it("a cast spell rings in its family's chimes: Call to Chaos, and a Field Spell's own", () => {
    play([
      { type: "cardPlayed", player: "p1", instanceId: "c1", defId: "core-095", costPaid: 3 },
      { type: "cardPlayed", player: "p1", instanceId: "c2", defId: "core-093", costPaid: 3 },
    ]);
    expect(sfx(engine, "spell")).toEqual([{ timbre: "chaos" }, { timbre: "field" }]);
  });

  it("with no catalog on the board every card keeps its plain sounds", () => {
    play([summoned(LEGENDARY_UNIT)], false);
    expect(sfx(engine, "entrance")).toEqual([]);
    expect(sfx(engine, "summon").every((params) => params?.timbre === undefined)).toBe(true);
  });

  it("R203 a unit behind the sentinel gets no sting and no family, whatever the catalog holds", () => {
    play([summoned(HIDDEN_DEF_ID)]);
    expect(sfx(engine, "entrance")).toEqual([]);
    expect(sfx(engine, "summon").every((params) => params?.timbre === undefined)).toBe(true);
  });
});

describe("data-speaking follows the voice channel", () => {
  it("the board carries data-speaking exactly while a line holds the channel", () => {
    render(game(baseView(), true));
    const board = screen.getByTestId("game");
    expect(board).not.toHaveAttribute("data-speaking");

    act(() => {
      engine.say(true);
    });
    expect(board).toHaveAttribute("data-speaking", "true");

    act(() => {
      engine.say(false);
    });
    expect(board).not.toHaveAttribute("data-speaking");
  });

  it("a Game unmounted mid-line stops listening", () => {
    const { unmount } = render(game(baseView(), true));
    expect(engine.subscribeSpeaking).toHaveBeenCalled();
    unmount();
    expect(() => {
      engine.say(true);
    }).not.toThrow();
  });
});
