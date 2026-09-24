// Polish task 2 (docs/polish/2-sound.md), behaviour B53: the HUD mute toggle as a real browser lays
// it out, inside the `.app-shell` every Game screen renders in (routes/dev/hotseat.tsx,
// routes/match.tsx).
//
//   B53  Inside `.app-shell`, the toggle computes to a 44 px circle (border-radius 50%, padding 0)
//        with its 22 x 22 icon, at desktop and phone widths.
//
// index.css's `.app-shell button` rule (0,1,1) once beat a bare `.audio-toggle` (0,1,0) and turned
// the toggle into a padded, rounded square around a squashed 10 px icon; jsdom has no cascade, so
// only a browser can see it. The support file imports index.css, as main.tsx does.
//
// Run it with:
//   E2E_COMPONENT_PORT=5282 pnpm --dir e2e exec cypress run --component --browser chrome \
//     --spec cypress/component/audio-toggle.cy.tsx

import AudioToggle from "../../../apps/web/src/audio/AudioToggle.tsx";

const SIZE_PX = 44;
const ICON_PX = 22;
const VIEWPORTS = [
  [1280, 720],
  [390, 844],
] as const;

describe("polish 2 — B53 the mute toggle inside .app-shell", () => {
  for (const [width, height] of VIEWPORTS) {
    it(`B53 at ${String(width)}x${String(height)} it is a ${String(SIZE_PX)} px circle with a ${String(ICON_PX)} px icon`, () => {
      cy.viewport(width, height);
      cy.mount(
        <div className="app-shell app-shell--wide">
          <AudioToggle />
        </div>,
      );
      cy.get('[data-testid="audio-toggle"]').then(($button) => {
        const button = $button[0] as HTMLButtonElement;
        const style = getComputedStyle(button);
        const box = button.getBoundingClientRect();
        const icon = button.querySelector("svg")?.getBoundingClientRect();
        cy.task("layout:report", {
          b53: `${String(width)}x${String(height)}`,
          borderRadius: style.borderRadius,
          padding: style.padding,
          box: [box.width, box.height],
          icon: icon === undefined ? null : [icon.width, icon.height],
        });
        expect(style.borderRadius, "a circle").to.eq("50%");
        expect(style.padding, "no padding squeezing the icon").to.eq("0px");
        expect(box.width).to.be.closeTo(SIZE_PX, 0.5);
        expect(box.height).to.be.closeTo(SIZE_PX, 0.5);
        expect(icon?.width).to.be.closeTo(ICON_PX, 0.5);
        expect(icon?.height).to.be.closeTo(ICON_PX, 0.5);
      });
    });
  }
});
