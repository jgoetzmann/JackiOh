// Probe: does the mulligan prompt exist when cy.keepMulligans() looks for it?

describe("probe", () => {
  for (let i = 0; i < 6; i += 1) {
    it(`mulligan race ${i}`, () => {
      cy.seedGame({ seed: "11-radiant", a: "11-radiant-a", b: "11-radiant-b" });
      cy.gameState().should((state) => {
        expect(state.phase, "mulligans answered").to.not.eq("mulligan");
        expect(state.turn).to.be.at.least(1);
      });
    });
  }
});
