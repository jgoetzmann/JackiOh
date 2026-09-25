// M5-T2 acceptance: one test per `PromptKind` (all ten), each rendering the picker, clicking an
// option and asserting the exact action. R81 splits them in two:
//
//   * `discover`, `target`, `mode`, `mulligan` and `hand` answer a `PendingChoice` that has paused
//     resolution, so they submit an `answer` (or, for the mulligan, §10.2's `mulligan` action);
//   * `zone`, `tribute`, `direction`, `x` and `embiggen` are the card's own play choices. Nothing
//     is paused and `view.pending` is null: they are driven by the in-flight `Interaction` and
//     they submit a `play`.
//
// Plus: the other seat sees "waiting for choice" and no options at all, a disabled confirm fires
// nothing, and `min`/`max` gate the confirm for `tribute` and `mulligan`.

import type { ActionBody, PlayerView } from "@jackioh/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Prompt from "./Prompt.tsx";
import { IDLE, type Interaction } from "./actions.ts";
import { baseView, card, emptySide, pendingFor, unit, waitingPending } from "../test/fixtures.ts";

afterEach(cleanup);

function viewWith(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hand: [card({ instanceId: "h1", defId: "core-002" }), card({ instanceId: "h2", defId: "core-019" })],
      units: [unit("p1", { instanceId: "u1" }), unit("p1", { instanceId: "u2" }), null, null, null],
    }),
    opponent: emptySide("p2", {
      hand: { count: 3 },
      units: [unit("p2", { instanceId: "e1" }), null, null, null, null],
    }),
    ...over,
  });
}

function playing(candidates: ActionBody[], instanceId = "h1"): Interaction {
  return { stage: "playing", instanceId, candidates, picked: {} };
}

function optionTestids(): string[] {
  return [...document.querySelectorAll("[data-testid^='prompt-option-']")].map(
    (node) => node.getAttribute("data-testid") ?? "",
  );
}

function kindOfModal(): string | null {
  return screen.getByTestId("prompt-modal").getAttribute("data-prompt-kind");
}

// ---------------------------------------------------------------------------------------------
// The five prompt-driven kinds: an open `PendingChoice`, answered with `answer` / `mulligan`.
// ---------------------------------------------------------------------------------------------

describe("prompt-driven pickers answer the open PendingChoice (§10.6)", () => {
  it("discover shows exactly three options as cards and answers with the chosen def", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor("discover", [
        { key: "mode:core-043", label: "Flood", defId: "core-043" },
        { key: "mode:core-055", label: "Archivist", defId: "core-055" },
        { key: "mode:core-066", label: "Lava Golem", defId: "core-066" },
      ]),
    });

    render(<Prompt view={view} onAction={onAction} />);

    expect(kindOfModal()).toBe("discover");
    expect(optionTestids()).toHaveLength(3);

    fireEvent.click(screen.getByTestId("prompt-option-mode:core-055"));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "core-055" }],
    });
  });

  it("target lists its options and also marks the board", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor("target", [
        { key: "instance:e1", label: "Enemy unit", instanceId: "e1" },
        { key: "hero:p2", label: "Enemy hero", player: "p2" },
      ]),
    });

    render(<Prompt view={view} legal={[]} onAction={onAction} />);

    expect(kindOfModal()).toBe("target");
    const blessed = screen.getByTestId("prompt-modal").getAttribute("data-board-testids") ?? "";
    expect(blessed.split(" ")).toContain("card-e1");
    expect(blessed.split(" ")).toContain("hero-opponent");

    fireEvent.click(screen.getByTestId("prompt-option-instance:e1"));

    expect(onAction).toHaveBeenCalledWith({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "instance", instanceId: "e1" }],
    });
  });

  it("mode shows buttons and answers with the option string", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor("mode", [
        { key: "mode:Deal 3 damage", label: "Deal 3 damage" },
        { key: "mode:Draw a card", label: "Draw a card" },
      ]),
    });

    render(<Prompt view={view} onAction={onAction} />);

    expect(kindOfModal()).toBe("mode");

    fireEvent.click(screen.getByTestId("prompt-option-mode:Draw a card"));

    expect(onAction).toHaveBeenCalledWith({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "mode", option: "Draw a card" }],
    });
  });

  it("mulligan toggles per card and confirms with its own action type (§10.2)", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor(
        "mulligan",
        [
          { key: "h1", label: "One", instanceId: "h1" },
          { key: "h2", label: "Two", instanceId: "h2" },
        ],
        { min: 0, max: 2, prompt: "Keep which cards?" },
      ),
    });

    render(<Prompt view={view} onAction={onAction} />);

    expect(kindOfModal()).toBe("mulligan");

    // Every card opens kept (R9 names the cards kept), so a toggle marks one to go back. A toggle
    // alone sends nothing: the mulligan always waits for the confirm.
    fireEvent.click(screen.getByTestId("prompt-option-h2"));
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("prompt-submit"));

    expect(onAction).toHaveBeenCalledWith({ type: "mulligan", keep: ["h1"] });
  });

  it("hand shows the viewer's cards and answers with the instance", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor("hand", [
        { key: "instance:h1", label: "One", instanceId: "h1" },
        { key: "instance:h2", label: "Two", instanceId: "h2" },
      ]),
    });

    render(<Prompt view={view} onAction={onAction} />);

    expect(kindOfModal()).toBe("hand");

    fireEvent.click(screen.getByTestId("prompt-option-instance:h2"));

    expect(onAction).toHaveBeenCalledWith({
      type: "answer",
      choiceId: "ch1",
      selection: [{ pick: "instance", instanceId: "h2" }],
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The five R81 kinds: no prompt is open, and each submits a `play`.
// ---------------------------------------------------------------------------------------------

describe("R81 inline pickers submit a play with no PendingChoice at all", () => {
  it("zone shows a grid of the zones the candidates name", () => {
    const onAction = vi.fn();
    const onInteraction = vi.fn();
    const view = viewWith();
    const interaction = playing([
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 3 } },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 5 } },
    ]);

    render(
      <Prompt
        view={view}
        interaction={interaction}
        legal={interaction.stage === "playing" ? interaction.candidates : []}
        onAction={onAction}
        onInteraction={onInteraction}
      />,
    );

    expect(view.pending).toBeNull();
    expect(kindOfModal()).toBe("zone");
    expect(optionTestids()).toEqual(["prompt-option-units:3", "prompt-option-units:5"]);

    fireEvent.click(screen.getByTestId("prompt-option-units:5"));

    expect(onAction).toHaveBeenCalledWith({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 5 },
    });
    expect(onInteraction).toHaveBeenCalledWith(IDLE);
  });

  it("tribute is a multi-select gated by min and max", () => {
    const onAction = vi.fn();
    const view = viewWith();
    const interaction = playing([
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, tributes: ["u1", "u2"] },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, tributes: ["u1", "e1"] },
    ]);

    render(<Prompt view={view} interaction={interaction} onAction={onAction} />);

    expect(kindOfModal()).toBe("tribute");

    const confirm = screen.getByTestId("prompt-submit");
    expect(confirm).toHaveAttribute("aria-disabled", "true");

    fireEvent.click(screen.getByTestId("prompt-option-u1"));
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("prompt-option-u2"));
    expect(confirm).toHaveAttribute("aria-disabled", "false");

    fireEvent.click(confirm);

    expect(onAction).toHaveBeenCalledWith({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 1 },
      tributes: ["u1", "u2"],
    });
  });

  it("direction is two arrows and builds the play's modes", () => {
    const onAction = vi.fn();
    const view = viewWith();
    const interaction = playing([
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 2 }, modes: ["left"] },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 2 }, modes: ["right"] },
    ]);

    render(<Prompt view={view} interaction={interaction} onAction={onAction} />);

    expect(kindOfModal()).toBe("direction");
    expect(screen.getByTestId("direction-left")).toBeInTheDocument();
    expect(screen.getByTestId("direction-right")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("direction-left"));

    expect(onAction).toHaveBeenCalledWith({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 2 },
      modes: ["left"],
    });
  });

  it("a Choose one names the card asking and says what each option does, answering with the card's own option string", () => {
    // Integration QA: Pocket Chaos offered three bare buttons, "health", "board" and "library".
    const onAction = vi.fn();
    const view = viewWith({
      you: emptySide("p1", { hand: [card({ instanceId: "h3", defId: "core-087" })] }),
    });
    const interaction = playing(
      ["health", "board", "library"].map((mode): ActionBody => ({ type: "play", instanceId: "h3", modes: [mode] })),
      "h3",
    );

    render(<Prompt view={view} interaction={interaction} onAction={onAction} />);

    expect(kindOfModal()).toBe("mode");
    expect(document.querySelector(".prompt-title-source")).not.toBeNull();
    expect(document.querySelector(".prompt-title-ask")).toHaveTextContent("Choose one");
    const board = screen.getByTestId("prompt-option-board");
    expect(board).toHaveTextContent("Swap boards");
    expect(board).toHaveTextContent("Every zone changes sides");
    expect(screen.getByTestId("prompt-option-health")).toHaveTextContent("Swap hero Health");
    expect(screen.getByTestId("prompt-option-library")).toHaveTextContent("Swap libraries");
    for (const raw of ["health", "board", "library"]) {
      expect(screen.getByTestId(`prompt-option-${raw}`).textContent).not.toBe(raw);
    }

    fireEvent.click(board);
    expect(onAction).toHaveBeenCalledWith({ type: "play", instanceId: "h3", modes: ["board"] });
  });

  it("#24 Efficiency Dividend's options say X on its base face and 2X, 4X and X on its Radiant face (§8 #24)", () => {
    const modes = ["damage", "heal", "mana"];
    const pickerFor = (radiant: boolean): void => {
      const view = viewWith({
        you: emptySide("p1", { hand: [card({ instanceId: "h24", defId: "core-024", radiant })] }),
      });
      const interaction = playing(
        modes.map((mode): ActionBody => ({ type: "play", instanceId: "h24", x: 2, modes: [mode] })),
        "h24",
      );
      render(<Prompt view={view} interaction={interaction} onAction={vi.fn()} />);
    };

    pickerFor(false);
    expect(screen.getByTestId("prompt-option-damage")).toHaveTextContent("Deal X damage to a target.");
    expect(screen.getByTestId("prompt-option-heal")).toHaveTextContent("Heal a target by twice X.");
    cleanup();

    pickerFor(true);
    expect(screen.getByTestId("prompt-option-damage")).toHaveTextContent("Deal twice X damage to a target.");
    expect(screen.getByTestId("prompt-option-heal")).toHaveTextContent("Heal a target by four times X.");
    expect(screen.getByTestId("prompt-option-mana")).toHaveTextContent("Gain X mana next turn.");
  });

  it("an option no card text covers is its own word, capitalised", () => {
    const view = viewWith();
    const interaction = playing([
      { type: "play", instanceId: "h1", modes: ["alpha"] },
      { type: "play", instanceId: "h1", modes: ["beta"] },
    ]);
    render(<Prompt view={view} interaction={interaction} onAction={vi.fn()} />);
    expect(screen.getByTestId("prompt-option-alpha")).toHaveTextContent(/^Alpha$/);
  });

  it("x is a numeric stepper over the values the engine listed", () => {
    const onAction = vi.fn();
    const view = viewWith();
    const interaction = playing([
      { type: "play", instanceId: "h2", x: 0 },
      { type: "play", instanceId: "h2", x: 1 },
      { type: "play", instanceId: "h2", x: 2 },
    ]);

    render(<Prompt view={view} interaction={interaction} onAction={onAction} />);

    expect(kindOfModal()).toBe("x");
    expect(screen.getByTestId("x-stepper")).toBeInTheDocument();
    expect(screen.getByTestId("x-value")).toHaveTextContent("0");

    // The stepper never walks past the ends of the engine's list.
    fireEvent.click(screen.getByTestId("x-plus"));
    fireEvent.click(screen.getByTestId("x-plus"));
    fireEvent.click(screen.getByTestId("x-plus"));
    expect(screen.getByTestId("x-value")).toHaveTextContent("2");

    fireEvent.click(screen.getByTestId("prompt-submit"));

    expect(onAction).toHaveBeenCalledWith({ type: "play", instanceId: "h2", x: 2 });
  });

  it("x can also be picked straight off a chip", () => {
    const onAction = vi.fn();
    const interaction = playing([
      { type: "play", instanceId: "h2", x: 0 },
      { type: "play", instanceId: "h2", x: 1 },
    ]);

    render(<Prompt view={viewWith()} interaction={interaction} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("prompt-option-1"));

    expect(onAction).toHaveBeenCalledWith({ type: "play", instanceId: "h2", x: 1 });
  });

  it("embiggen is a two-way toggle", () => {
    const onAction = vi.fn();
    const view = viewWith();
    const interaction = playing([
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, embiggen: false },
      { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, embiggen: true },
    ]);

    render(<Prompt view={view} interaction={interaction} onAction={onAction} />);

    expect(kindOfModal()).toBe("embiggen");
    expect(screen.getByTestId("embiggen-toggle")).toBeInTheDocument();
    expect(optionTestids()).toEqual(["prompt-option-false", "prompt-option-true"]);

    fireEvent.click(screen.getByTestId("prompt-option-true"));

    expect(onAction).toHaveBeenCalledWith({
      type: "play",
      instanceId: "h1",
      zone: { row: "units", lane: 1 },
      embiggen: true,
    });
  });

  it("a declared target pick builds the play's targets, not an answer", () => {
    const onAction = vi.fn();
    const interaction = playing([
      { type: "play", instanceId: "h2", targets: [{ pick: "instance", instanceId: "e1" }] },
      { type: "play", instanceId: "h2", targets: [{ pick: "hero", player: "p2" }] },
    ]);

    render(<Prompt view={viewWith()} interaction={interaction} onAction={onAction} />);

    expect(kindOfModal()).toBe("target");
    fireEvent.click(screen.getByTestId("prompt-option-hero:p2"));

    expect(onAction).toHaveBeenCalledWith({
      type: "play",
      instanceId: "h2",
      targets: [{ pick: "hero", player: "p2" }],
    });
  });

  it("a play's zone, target and Tribute picks say to tap the board; prompt.css shows it only where the picker is a bar with no options", () => {
    const hint = (): string | null => document.querySelector(".prompt-board-hint")?.textContent ?? null;
    const cases: [ActionBody[], string][] = [
      [
        [
          { type: "play", instanceId: "h1", zone: { row: "units", lane: 3 } },
          { type: "play", instanceId: "h1", zone: { row: "units", lane: 5 } },
        ],
        "Tap a highlighted zone on the board.",
      ],
      [
        [
          { type: "play", instanceId: "h2", targets: [{ pick: "instance", instanceId: "e1" }] },
          { type: "play", instanceId: "h2", targets: [{ pick: "hero", player: "p2" }] },
        ],
        "Tap a highlighted target on the board.",
      ],
      [
        [
          { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, tributes: ["u1", "u2"] },
          { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 }, tributes: ["u1", "e1"] },
        ],
        "Tap a highlighted unit on the board.",
      ],
    ];
    for (const [candidates, text] of cases) {
      const instanceId = candidates[0]?.type === "play" ? candidates[0].instanceId : "h1";
      render(<Prompt view={viewWith()} interaction={playing(candidates, instanceId)} onAction={vi.fn()} />);
      expect(hint()).toBe(text);
      cleanup();
    }

    // An engine prompt keeps its sheet on every layout, so it has no hint.
    render(
      <Prompt
        view={viewWith({
          pending: pendingFor("zone", [{ key: "zone:p1:units:1", label: "Unit lane 1", player: "p1", row: "units", lane: 1 }]),
        })}
        onAction={vi.fn()}
      />,
    );
    expect(hint()).toBeNull();
  });

  it("renders nothing when the play in flight needs no further choice", () => {
    const { container } = render(
      <Prompt view={viewWith()} interaction={playing([{ type: "play", instanceId: "h2" }])} onAction={vi.fn()} />,
    );

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("prompt-modal")).toBeNull();
  });

  it("renders nothing with no prompt and no play in flight", () => {
    const { container } = render(<Prompt view={viewWith()} interaction={IDLE} onAction={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });
});

// ---------------------------------------------------------------------------------------------
// The five R81 kinds are still valid prompt kinds (§10.6 keeps them for later sets).
// ---------------------------------------------------------------------------------------------

describe("the R81 kinds render the same picker when the engine does open them as prompts", () => {
  const cases: [string, Parameters<typeof pendingFor>[1], string][] = [
    ["zone", [{ key: "zone:p1:units:1", label: "Unit lane 1", player: "p1", row: "units", lane: 1 }], "prompt-option-zone:p1:units:1"],
    ["tribute", [{ key: "instance:u1", label: "One", instanceId: "u1" }], "prompt-option-instance:u1"],
    ["direction", [{ key: "mode:left", label: "left" }, { key: "mode:right", label: "right" }], "direction-left"],
    ["x", [{ key: "0", label: "0" }, { key: "1", label: "1" }], "x-stepper"],
    ["embiggen", [{ key: "false", label: "Normal" }, { key: "true", label: "Embiggened" }], "embiggen-toggle"],
  ];

  for (const [kind, options, present] of cases) {
    it(`${kind} keeps its picker and its data-prompt-kind`, () => {
      const onAction = vi.fn();
      const view = viewWith({
        pending: pendingFor(kind as Parameters<typeof pendingFor>[0], options),
      });

      render(<Prompt view={view} onAction={onAction} />);

      expect(kindOfModal()).toBe(kind);
      expect(screen.getByTestId(present)).toBeInTheDocument();
    });
  }
});

// ---------------------------------------------------------------------------------------------
// The other seat, and the confirm gate.
// ---------------------------------------------------------------------------------------------

describe("the seat that is only watching (§10.6, §10.8)", () => {
  it("shows 'waiting for choice' and not one option", () => {
    const onAction = vi.fn();
    const view = viewWith({ pending: waitingPending });

    render(<Prompt view={view} onAction={onAction} />);

    expect(screen.getByTestId("prompt-modal")).toHaveTextContent(/waiting for choice/i);
    expect(optionTestids()).toEqual([]);
    expect(screen.queryByTestId("prompt-submit")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("min and max gate the confirm, and both came from the view", () => {
  it("mulligan: two of two before the confirm is live", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor(
        "mulligan",
        [
          { key: "h1", label: "One", instanceId: "h1" },
          { key: "h2", label: "Two", instanceId: "h2" },
        ],
        { min: 2, max: 2 },
      ),
    });

    render(<Prompt view={view} onAction={onAction} />);
    const confirm = screen.getByTestId("prompt-submit");

    // Both cards open kept, so two of two holds at once; marking one to go back drops below min.
    expect(confirm).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(screen.getByTestId("prompt-option-h1"));
    expect(confirm).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(confirm);
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("prompt-option-h1"));
    expect(confirm).toHaveAttribute("aria-disabled", "false");
    fireEvent.click(confirm);
    expect(onAction).toHaveBeenCalledWith({ type: "mulligan", keep: ["h1", "h2"] });
  });

  it("will not select past max", () => {
    const onAction = vi.fn();
    const view = viewWith({
      pending: pendingFor(
        "tribute",
        [
          { key: "instance:u1", label: "One", instanceId: "u1" },
          { key: "instance:u2", label: "Two", instanceId: "u2" },
          { key: "instance:e1", label: "Three", instanceId: "e1" },
        ],
        { min: 1, max: 2 },
      ),
    });

    render(<Prompt view={view} onAction={onAction} />);

    fireEvent.click(screen.getByTestId("prompt-option-instance:u1"));
    fireEvent.click(screen.getByTestId("prompt-option-instance:u2"));
    fireEvent.click(screen.getByTestId("prompt-option-instance:e1"));
    fireEvent.click(screen.getByTestId("prompt-submit"));

    expect(onAction).toHaveBeenCalledWith({
      type: "answer",
      choiceId: "ch1",
      selection: [
        { pick: "instance", instanceId: "u1" },
        { pick: "instance", instanceId: "u2" },
      ],
    });
  });

  it("offers cancel only when the caller can cancel", () => {
    const view = viewWith({
      pending: pendingFor("mode", [{ key: "mode:a", label: "A" }]),
    });
    const onCancel = vi.fn();

    const { unmount } = render(<Prompt view={view} onAction={vi.fn()} onCancel={onCancel} />);
    fireEvent.click(screen.getByTestId("prompt-cancel"));
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();

    render(<Prompt view={view} onAction={vi.fn()} />);
    expect(screen.queryByTestId("prompt-cancel")).toBeNull();
  });
});
