// Loads the "tab", then the real extension popup (whose chrome.* calls the
// renderer stubs to scan the tab frame), waits for the report, optionally
// opens one finding, then flags the page ready for its screenshot.
const tab = document.getElementById("tab");
const pop = document.getElementById("popup");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function afterPopup() {
  const doc = () => pop.contentDocument;
  for (let i = 0; i < 300 && !doc().querySelector(".report, .cannot"); i++) await sleep(100);
  const open = document.body.dataset.open;
  if (open !== undefined) {
    const f = doc().querySelectorAll(".finding")[Number(open)];
    if (f) { f.open = true; f.scrollIntoView({ block: "start" }); }
  }
  // Real popups shrink to their content; match that.
  const foot = doc().querySelector(".footer");
  if (foot) pop.style.height = Math.min(600, Math.ceil(foot.getBoundingClientRect().bottom)) + "px";
  await sleep(1200); // let the gauge settle
  window.ready = true;
}

tab.addEventListener("load", () => {
  pop.addEventListener("load", afterPopup, { once: true });
  pop.src = "../../extension/popup.html";
}, { once: true });
tab.src = tab.dataset.src;
