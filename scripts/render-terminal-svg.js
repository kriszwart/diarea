/* Turns real `diarea scan --no-color` output into an animated terminal SVG for
 * the README, so the demo is a recording of the tool, not a mock-up.
 *
 *   node bin/diarea.js scan <target> --no-color | node scripts/render-terminal-svg.js "<command shown>" > docs/assets/scan.svg
 *
 * Keeps the header, each finding's title and its first piece of evidence that
 * is not a full URL (so a local recording shows no localhost addresses), and
 * the footer, then reveals them line by line on a loop.
 */
import fs from "node:fs";

const shown = process.argv[2] || "npx diarea scan https://your-site.com";
const raw = fs.readFileSync(0, "utf8").split("\n");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const lines = [{ text: "$ " + shown, cls: "cmd" }, { text: "", cls: "" }];
let evidenceTaken = true;
for (const l of raw) {
  const t = l.replace(/\s+$/, "");
  if (/💩 diarea/.test(t)) lines.push({ text: t.trim(), cls: "head" });
  else if (/^\s*Leak Score/.test(t)) lines.push({ text: t.trim(), cls: "score" });
  else if (/^\s*\d+ critical/.test(t)) lines.push({ text: t.trim(), cls: "counts" }, { text: "", cls: "" });
  else if (/^\s*\[(CRIT|WARN|INFO)\]/.test(t)) {
    const sev = t.match(/\[(CRIT|WARN|INFO)\]/)[1].toLowerCase();
    lines.push({ text: t.trim(), cls: sev });
    evidenceTaken = false;
  } else if (!evidenceTaken && /^\s+- /.test(t) && !/^\s+- https?:\/\//.test(t)) {
    lines.push({ text: "       " + t.trim(), cls: "ev" });
    evidenceTaken = true;
  } else if (/^\s*mode:/.test(t)) lines.push({ text: "", cls: "" }, { text: t.trim(), cls: "foot" });
}

const W = 860, PAD = 22, TOP = 52, LH = 21;
const H = TOP + lines.length * LH + PAD;
const T = 14; // seconds per loop
const start = 0.6, gap = 0.18, firstOut = 1.6;

const css = [];
const rows = lines.map((ln, i) => {
  const at = i === 0 ? start : firstOut + (i - 1) * gap;
  const p = ((at / T) * 100).toFixed(2);
  css.push(`.l${i}{animation:k${i} ${T}s steps(1,end) infinite}@keyframes k${i}{0%,${p}%{opacity:0}${(+p + 0.01).toFixed(2)}%,96%{opacity:1}100%{opacity:0}}`);
  let text = esc(ln.text);
  if (ln.cls === "crit" || ln.cls === "warn" || ln.cls === "info") {
    text = text.replace(/^\[(\w+)\]/, `<tspan class="${ln.cls}">[$1]</tspan><tspan class="title">`) + "</tspan>";
  } else if (ln.cls === "counts") {
    text = text.replace(/(\d+ critical)/, '<tspan class="crit">$1</tspan>')
      .replace(/(\d+ exposed)/, '<tspan class="warn">$1</tspan>')
      .replace(/(\d+ minor)/, '<tspan class="info">$1</tspan>');
  } else if (ln.cls === "score") {
    text = text.replace(/(Leak Score \d+\/100)\s+(\w+)\s+(.*)/, '<tspan class="title">$1</tspan>  <tspan class="crit">$2</tspan>  <tspan class="ev">$3</tspan>');
  }
  return `<text x="${PAD}" y="${TOP + i * LH}" class="l${i} ${ln.cls}" xml:space="preserve">${text}</text>`;
});

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Diarea scanning a deliberately leaky demo site and scoring it Gushing">
<style>
text{font:14px ui-monospace,SFMono-Regular,Menlo,Consolas,"DejaVu Sans Mono",monospace;fill:#d9d4c7}
.cmd{fill:#f3efe6}.head{fill:#e58cff;font-weight:700}.title{fill:#f3efe6;font-weight:700}
.crit{fill:#ff6b6b}.warn{fill:#f5b041}.info{fill:#5fd0e0}.ev,.foot{fill:#8a857a}
${css.join("\n")}
</style>
<rect width="${W}" height="${H}" rx="12" fill="#191714"/>
<circle cx="22" cy="20" r="6" fill="#ff5f57"/><circle cx="42" cy="20" r="6" fill="#febc2e"/><circle cx="62" cy="20" r="6" fill="#28c840"/>
${rows.join("\n")}
</svg>
`;
process.stdout.write(svg);
