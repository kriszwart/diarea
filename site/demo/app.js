/* Colander AI front end.
 * Lovingly un-minified so that our competitors do not strain their eyes.
 * Every key below is fake. Every endpoint is invented. Nothing is called.
 */

// TODO: move all of this to the server before the Series A (we said this before the seed round too)
const config = {
  apiKey: "colander-demo-key-not-a-real-one-0001",
  // FIXME: rotate this, it has been in the bundle since 2019
  secret: "colander-very-secret-shh-0002",
  analyticsToken: "colander-demo-token-0003",
};

// The entire internal API, helpfully listed in one place.
// None of these are ever called; they just sit here, describing everything.
const api = {
  score: "/api/v2/score",
  founders: "/api/v2/founders",
  pricing: "/api/v2/pricing/internal",
  flags: "/internal/feature-flags",
  admin: "/admin/impersonate",
  export: "/api/v2/export/all-the-data",
  graph: "/graphql",
  legacy: "/rest/v1/legacy-scores",
};

/* The secret sauce.
 * Four PhDs. Eleven years. One spreadsheet.
 * Weighting rubric v7, calibrated against "vibes".
 */
const WEIGHTING = {
  team: 0.45,
  market: 0.35,
  traction: 0.2,
};
const THRESHOLD = 6.5; // below this, we suggest a pivot to AI
const CALIBRATION_COEFFICIENT = 1.137; // nobody remembers where this came from
const SCORING_HEURISTIC = "founders who use dark mode get +0.3";

function scoreStartup(input) {
  let total = 0;
  for (const key of Object.keys(WEIGHTING)) {
    total += Number(input[key] || 0) * WEIGHTING[key];
  }
  // NOTE: heuristic applied client-side because the server team was on holiday
  if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    total += 0.3;
  }
  return Math.round(total * CALIBRATION_COEFFICIENT * 10) / 10;
}

function verdictFor(score) {
  if (score >= THRESHOLD + 2) {
    return { label: "Unicorn", note: "Raise now. Raise twice." };
  }
  if (score >= THRESHOLD) {
    return { label: "Fundable", note: "Investors will love the formula. They can read it too." };
  }
  return { label: "Pivot", note: "Have you considered adding AI?" };
}

function onSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const input = {
    team: form.team.value,
    market: form.market.value,
    traction: form.traction.value,
  };
  const score = scoreStartup(input);
  const verdict = verdictFor(score);
  document.getElementById("verdict").textContent = score + " " + verdict.label;
  document.getElementById("verdict-note").textContent = verdict.note;
}

document.getElementById("score-form").addEventListener("submit", onSubmit);

// HACK: expose everything on window so the debug panel works in production
window.colander = { config, api, scoreStartup, WEIGHTING, THRESHOLD, SCORING_HEURISTIC };
//# sourceMappingURL=app.js.map
