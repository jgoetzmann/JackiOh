// docs/polish/5-sign-in.md B39 (and B15, B37 visually): at 360, 390, 768 and 1280 px wide, neither
// the landing page nor the invite code field overflows horizontally, and every landing CTA and the
// code input are on screen.
//
// jsdom has no layout engine, so this is the one place the claim can be measured. The mounts:
//
//   - `LandingRoute` on its own. It is the whole page at `/` (main.tsx renders nothing around it),
//     and with no session in storage its account slot settles on `landing-sign-in` without a
//     request, so no server is involved.
//   - `CodeField` inside `.app-shell.tavern > .panel--auth`, the container the invite screen gives
//     it, with a stateful wrapper so typing really fills it. `auth.css` and `tavern.css` are imported
//     for that container's rules (the tavern skin widens the gaps between groups, which is what
//     would overflow first); each component brings its own stylesheet, as Board.tsx does in
//     board-layout.cy.tsx.
//
// What is asserted at each viewport:
//
//   documentElement.scrollWidth <= innerWidth  and  body.scrollWidth <= innerWidth
//       `body { overflow-x: hidden }` in index.css hides the scrollbar but not this number
//       (board-layout.cy.tsx measured that).
//   every CTA and the input: `be.visible`, and a border box inside [0, innerWidth]
//       Because overflow-x is hidden, a CTA pushed past the right edge would still be "visible" to
//       Cypress while being cut off on a phone. The box check catches that.
//
// Measurements retry with `should`, because a viewport change relays out asynchronously and the
// fan deals in with an animation.

import { useState, type ReactElement } from "react";

import {
  CODE_ALPHABET,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
} from "../../../apps/server/src/config.ts";
import CodeField from "../../../apps/web/src/auth/CodeField.tsx";
import { holdRecoverySession, releaseRecoverySession } from "../../../apps/web/src/auth/redirect.ts";
import {
  codeFieldSegmentTestid,
  codeFieldTestid,
  inviteTestid,
  landingStepTestid,
  landingTestid,
  loginTestid,
  resetTestid,
} from "../../../apps/web/src/auth/testids.ts";
import LandingRoute from "../../../apps/web/src/routes/landing.tsx";
import LoginRoute from "../../../apps/web/src/routes/login.tsx";
import ResetPasswordRoute from "../../../apps/web/src/routes/reset-password.tsx";

import "../../../apps/web/src/auth/auth.css";
import "../../../apps/web/src/auth/tavern.css";

/** B39's four viewports. */
const VIEWPORTS = [
  { label: "small phone", width: 360, height: 740 },
  { label: "phone", width: 390, height: 844 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "desktop", width: 1280, height: 720 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

/** Every landing CTA B37 names. With no session the corner slot holds `landing-sign-in`. */
const LANDING_CTAS = [
  landingTestid.playAi,
  landingTestid.playOnline,
  landingTestid.buildDecks,
  landingTestid.signIn,
] as const;

const GROUPS = INVITE_CODE_LENGTH / INVITE_CODE_GROUP_SIZE;

/** A complete code over R104's alphabet, built from config rather than spelled. */
const LETTERS = CODE_ALPHABET.replace(/[0-9]/g, "");
const BARE_CODE = LETTERS.slice(0, INVITE_CODE_LENGTH);
function grouped(characters: string): string {
  const groups: string[] = [];
  for (let index = 0; index < characters.length; index += INVITE_CODE_GROUP_SIZE) {
    groups.push(characters.slice(index, index + INVITE_CODE_GROUP_SIZE));
  }
  return groups.join(INVITE_CODE_SEPARATOR);
}
const FULL_CODE = grouped(BARE_CODE);

function byTestid(testid: string): string {
  return `[data-testid="${testid}"]`;
}

function where(viewport: Viewport): string {
  return `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;
}

/** Nothing on the page is wider than the viewport. */
function expectNoHorizontalOverflow(viewport: Viewport): void {
  cy.window({ log: false }).should((win) => {
    expect(win.innerWidth, "the viewport is the one asked for").to.eq(viewport.width);
    expect(win.document.documentElement.scrollWidth, `the document fits ${where(viewport)}`).to.be.at.most(
      win.innerWidth,
    );
    expect(win.document.body.scrollWidth, `the body fits ${where(viewport)}`).to.be.at.most(win.innerWidth);
  });
}

/** The element is visible and its whole width is on screen. */
function expectOnScreen(testid: string, viewport: Viewport): void {
  cy.get(byTestid(testid)).should("be.visible");
  cy.get(byTestid(testid)).should(($element) => {
    const element = $element[0];
    expect(element, `${testid} is mounted`).to.not.eq(undefined);
    if (element === undefined) return;
    const win = element.ownerDocument.defaultView;
    const box = element.getBoundingClientRect();
    expect(box.width, `${testid} has width at ${where(viewport)}`).to.be.greaterThan(0);
    expect(box.height, `${testid} has height at ${where(viewport)}`).to.be.greaterThan(0);
    expect(Math.floor(box.left), `${testid} starts on screen at ${where(viewport)}`).to.be.at.least(0);
    expect(Math.ceil(box.right), `${testid} ends on screen at ${where(viewport)}`).to.be.at.most(
      win?.innerWidth ?? viewport.width,
    );
  });
}

function CodeFieldHarness(): ReactElement {
  const [value, setValue] = useState("");
  return (
    <div className="app-shell invite-screen tavern">
      <div className="panel panel--auth">
        <label htmlFor="invite-code">Invite code</label>
        <CodeField
          id="invite-code"
          value={value}
          onChange={(next) => {
            setValue(next.formatted);
          }}
        />
      </div>
    </div>
  );
}

beforeEach(() => {
  // No session, so the landing's corner slot settles on `landing-sign-in` with no request.
  cy.window({ log: false }).then((win) => {
    win.localStorage.clear();
  });
});

describe("B39 the landing page fits 360, 390, 768 and 1280 px", () => {
  for (const viewport of VIEWPORTS) {
    it(`B39 no horizontal overflow, and every CTA on screen, at ${where(viewport)}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.mount(<LandingRoute />);

      cy.get(byTestid(landingTestid.root)).should("be.visible");
      // B37: the anonymous corner slot, which is also the fourth CTA.
      cy.get(byTestid(landingTestid.root)).should("have.attr", "data-account", "anonymous");
      for (const cta of LANDING_CTAS) expectOnScreen(cta, viewport);
      // B38: the fan is drawn (decoratively) and is part of what must fit.
      cy.get(byTestid(landingTestid.fan)).should("exist");
      cy.get(byTestid(landingTestid.howItPlays)).should("be.visible");

      expectNoHorizontalOverflow(viewport);
    });
  }
});

describe("B39 the invite code field fits 360, 390, 768 and 1280 px", () => {
  for (const viewport of VIEWPORTS) {
    it(`B39 no horizontal overflow, empty and full, and the input on screen, at ${where(viewport)}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.mount(<CodeFieldHarness />);

      // Empty.
      expectOnScreen(inviteTestid.input, viewport);
      cy.get(byTestid(codeFieldTestid.root)).should("have.attr", "data-complete", "false");
      expectNoHorizontalOverflow(viewport);

      // Typed full, as spec 10 types it: no `force`, so a segment drawn over the input fails here.
      cy.get(byTestid(inviteTestid.input)).type(BARE_CODE.toLowerCase());
      cy.get(byTestid(inviteTestid.input)).should("have.value", FULL_CODE);
      cy.get(byTestid(codeFieldTestid.root)).should("have.attr", "data-complete", "true");

      // B15: four segments, each complete, each inside the viewport.
      for (let index = 0; index < GROUPS; index += 1) {
        cy.get(byTestid(codeFieldSegmentTestid(index))).should("have.attr", "data-state", "complete");
        cy.get(byTestid(codeFieldSegmentTestid(index))).should(($segment) => {
          const segment = $segment[0];
          expect(segment, `segment ${String(index)} is mounted`).to.not.eq(undefined);
          if (segment === undefined) return;
          const box = segment.getBoundingClientRect();
          expect(Math.floor(box.left), `segment ${String(index)} starts on screen`).to.be.at.least(0);
          expect(Math.ceil(box.right), `segment ${String(index)} ends on screen`).to.be.at.most(viewport.width);
        });
      }
      cy.get(byTestid(codeFieldSegmentTestid(GROUPS))).should("not.exist");
      cy.get(byTestid(codeFieldTestid.progress)).should("be.visible");

      expectOnScreen(inviteTestid.input, viewport);
      expectNoHorizontalOverflow(viewport);
    });
  }

  it("B39 a refused character's hint fits the narrowest viewport too", () => {
    const narrowest = VIEWPORTS[0];
    cy.viewport(narrowest.width, narrowest.height);
    cy.mount(<CodeFieldHarness />);

    // An excluded character: the hint is the longest line the field ever shows.
    cy.get(byTestid(inviteTestid.input)).type(`${BARE_CODE.slice(0, INVITE_CODE_GROUP_SIZE)}0`);
    cy.get(byTestid(codeFieldTestid.hint)).should("have.attr", "data-kind", "excluded");
    expectOnScreen(codeFieldTestid.hint, narrowest);
    expectOnScreen(inviteTestid.input, narrowest);
    expectNoHorizontalOverflow(narrowest);
  });
});

// iOS Safari zooms the whole page into a focused text field whose font is smaller than 16px, and
// the player has to pinch back out. The shell's text is 15px and `.form-card input` inherits it, so
// every sign-in, sign-up and reset field needs its own 16px (the code field already has it).
const IOS_NO_ZOOM_FONT_PX = 16;

function expectNoFocusZoom(testid: string): void {
  cy.get(byTestid(testid)).should(($input) => {
    const input = $input[0];
    expect(input, `${testid} is mounted`).to.not.eq(undefined);
    if (input === undefined) return;
    const size = Number.parseFloat(window.getComputedStyle(input).fontSize);
    expect(size, `${testid} font-size`).to.be.at.least(IOS_NO_ZOOM_FONT_PX);
  });
}

describe("the auth fields do not make iOS zoom the page", () => {
  const phone = VIEWPORTS[1];

  it("sign-in's email and password are 16px or larger on a phone", () => {
    cy.viewport(phone.width, phone.height);
    cy.mount(<LoginRoute />);
    expectNoFocusZoom(loginTestid.email);
    expectNoFocusZoom(loginTestid.password);
  });

  it("the reset form's password fields are 16px or larger on a phone", () => {
    cy.viewport(phone.width, phone.height);
    holdRecoverySession({ accessToken: "a.b.c", refreshToken: "r", expiresAt: 4_000_000_000_000 }, "p@example.com");
    cy.mount(<ResetPasswordRoute />);
    expectNoFocusZoom(resetTestid.password);
    expectNoFocusZoom(resetTestid.confirm);
    cy.then(() => {
      releaseRecoverySession();
    });
  });

  it("the invite code field is 16px or larger on a phone", () => {
    cy.viewport(phone.width, phone.height);
    cy.mount(<CodeFieldHarness />);
    expectNoFocusZoom(inviteTestid.input);
  });
});

// A phone held sideways has 390 px of height, and the keyboard takes most of it once a field is
// tapped. The auth boards set their title beside the form there (auth/tavern.css, "a phone on its
// side"), so the button that sends the form is on the first screen, without a scroll.

const LANDSCAPE_PHONE = { label: "phone on its side", width: 844, height: 390 } as const;

/** The element's whole box is inside the first screen, with the page scrolled to the top. */
function expectAboveTheFold(testid: string): void {
  cy.window({ log: false }).then((win) => {
    win.scrollTo(0, 0);
  });
  cy.get(byTestid(testid)).should(($element) => {
    const element = $element[0];
    expect(element, `${testid} is mounted`).to.not.eq(undefined);
    if (element === undefined) return;
    const win = element.ownerDocument.defaultView;
    const box = element.getBoundingClientRect();
    expect(Math.ceil(box.bottom), `${testid} ends inside the first screen`).to.be.at.most(
      win?.innerHeight ?? LANDSCAPE_PHONE.height,
    );
  });
}

describe("a phone on its side reaches each auth form's button without scrolling", () => {
  it("sign-in, then create-account", () => {
    cy.viewport(LANDSCAPE_PHONE.width, LANDSCAPE_PHONE.height);
    cy.mount(<LoginRoute />);
    expectAboveTheFold(loginTestid.submit);
    cy.get(byTestid(loginTestid.mode)).click();
    cy.get(byTestid(loginTestid.form)).should("have.attr", "data-mode", "signUp");
    expectAboveTheFold(loginTestid.submit);
    cy.window({ log: false }).should((win) => {
      expect(win.document.documentElement.scrollWidth, "no horizontal scroll").to.be.at.most(win.innerWidth);
    });
  });

  it("the reset form", () => {
    cy.viewport(LANDSCAPE_PHONE.width, LANDSCAPE_PHONE.height);
    holdRecoverySession({ accessToken: "a.b.c", refreshToken: "r", expiresAt: 4_000_000_000_000 }, "p@example.com");
    cy.mount(<ResetPasswordRoute />);
    expectAboveTheFold(resetTestid.submit);
    cy.then(() => {
      releaseRecoverySession();
    });
  });
});

// "How it plays" is four tiles. Rows of unequal length (three and one) read as a tile left over,
// so every row holds the same number of tiles, at each width the grid changes near.

const STEP_TILES = 4;
const STEP_WIDTHS = [
  { label: "phone", width: 390, height: 844 },
  { label: "tablet", width: 768, height: 1024 },
  { label: "phone on its side", width: 844, height: 390 },
  { label: "small laptop", width: 1000, height: 700 },
  { label: "desktop", width: 1280, height: 720 },
] as const;

describe("the landing's four steps never lay out three and one", () => {
  for (const viewport of STEP_WIDTHS) {
    it(`every row of steps is the same length at ${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.mount(<LandingRoute />);
      cy.get(byTestid(landingStepTestid(STEP_TILES - 1))).should("be.visible");
      cy.document().should((doc) => {
        const rows = new Map<number, number>();
        for (let index = 0; index < STEP_TILES; index += 1) {
          const tile = doc.querySelector(byTestid(landingStepTestid(index)));
          expect(tile, `step ${String(index)} is mounted`).to.not.eq(null);
          if (tile === null) return;
          const top = Math.round(tile.getBoundingClientRect().top);
          rows.set(top, (rows.get(top) ?? 0) + 1);
        }
        const lengths = [...rows.values()];
        expect(new Set(lengths).size, `row lengths ${lengths.join(", ")}`).to.eq(1);
      });
    });
  }
});
