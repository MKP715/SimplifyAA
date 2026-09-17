// Debug audit for index.html: dangling id references, duplicate ids,
// accessibility gaps, keyboard shortcuts, render cost, and behaviour when
// localStorage is blocked or data/kits.csv is missing.
//
//   node tools/audit.js http://127.0.0.1:8765/index.html index.html
//
// Exits 0 either way; read the report. Set CHROME_PATH for Chrome.

// Static + runtime audit of index.html: dangling references, duplicate ids,
// accessibility gaps, resilience when storage is blocked, and render cost.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = process.argv[2] || "http://127.0.0.1:8765/index.html";
const FILE = process.argv[3];
let problems = 0;
const report = (label, list, show) => {
  if (!list.length) { console.log("  OK    " + label); return; }
  problems += list.length;
  console.log("  ISSUE " + label + " (" + list.length + ")");
  list.slice(0, show || 12).forEach((x) => console.log("          - " + x));
};

(async () => {
  // ---- static: ids referenced by the script vs ids present in the markup ----
  const html = fs.readFileSync(FILE, "utf8");
  const declared = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) declared.add(m[1]);
  const referenced = new Set();
  for (const m of html.matchAll(/(?:\$\(|querySelector\(|querySelectorAll\()"#([A-Za-z0-9_-]+)/g)) {
    referenced.add(m[1]);
  }
  for (const m of html.matchAll(/getElementById\("([^"]+)"\)/g)) referenced.add(m[1]);
  // ids created at runtime by the app
  const runtime = new Set(["kitAcc", "readerPages", "readerStatus", "kitsWrap"]);
  const dangling = [...referenced].filter((id) =>
    !declared.has(id) && !runtime.has(id) && !/^sec\d+$|^kit\d+$|^vm_/.test(id));
  report("script references an id that is not in the markup", dangling);

  const dupes = [];
  const seen = new Set();
  for (const m of html.matchAll(/\sid="([^"]+)"/g)) {
    // Skip ids the script builds by concatenation, e.g. id="' + id + '".
    if (/[+'"`]|\$\{/.test(m[1])) continue;
    if (seen.has(m[1])) dupes.push(m[1]);
    seen.add(m[1]);
  }
  report("duplicate id attributes", dupes);

  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new", args: ["--no-sandbox"],
  });

  // ---- runtime accessibility + structure ----
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  await page.goto(URL, { waitUntil: "networkidle2" });
  await page.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(900);

  // open everything so hidden controls are audited too
  await page.evaluate(() => {
    document.querySelector("#filterToggle").click();
    document.querySelectorAll("#tree .accordion-button").forEach((b) => b.click());
  });
  await sleep(900);

  const a11y = await page.evaluate(() => {
    const txt = (e) => (e.textContent || "").replace(/\s+/g, " ").trim();
    const name = (e) => txt(e) || e.getAttribute("aria-label") ||
      e.getAttribute("title") || (e.querySelector("i[class*=bi-]") ? "" : "");
    const out = { namelessControls: [], unlabelledFields: [], imgNoAlt: [],
                  emptyLinks: [], dupIds: [], badHeadings: [], nonEnglishNoLang: 0 };

    document.querySelectorAll("button, [role=button]").forEach((b) => {
      if (b.offsetParent === null) return;
      if (!name(b)) out.namelessControls.push(b.outerHTML.slice(0, 90));
    });
    document.querySelectorAll("input, select, textarea").forEach((f) => {
      if (f.type === "hidden") return;
      const id = f.id;
      const hasLabel = (id && document.querySelector('label[for="' + id + '"]')) ||
        f.closest("label") || f.getAttribute("aria-label") ||
        f.getAttribute("aria-labelledby") || f.getAttribute("title");
      if (!hasLabel) out.unlabelledFields.push((f.tagName + "#" + (id || "?")));
    });
    document.querySelectorAll("img").forEach((i) => {
      if (!i.hasAttribute("alt")) out.imgNoAlt.push(i.src.slice(-50));
    });
    document.querySelectorAll("a").forEach((a) => {
      if (a.offsetParent === null) return;
      if (!name(a) && !a.querySelector("i")) out.emptyLinks.push(a.outerHTML.slice(0, 80));
    });
    const ids = {};
    document.querySelectorAll("[id]").forEach((e) => {
      ids[e.id] = (ids[e.id] || 0) + 1;
    });
    Object.entries(ids).forEach(([k, v]) => { if (v > 1) out.dupIds.push(k); });

    // Cards whose title is not English but carry no lang attribute.
    document.querySelectorAll("#cardsWrap .sa-card").forEach((c) => {
      const t = c.querySelector(".sa-card-title");
      if (!t) return;
      const foreign = /[áéíóúñ¿¡çèêàûœ]/i.test(t.textContent);
      if (foreign && !t.closest("[lang]")) out.nonEnglishNoLang++;
    });
    return out;
  });

  console.log("\n=== ACCESSIBILITY ===");
  report("controls with no accessible name", a11y.namelessControls);
  report("form fields with no label", a11y.unlabelledFields);
  report("images without alt", a11y.imgNoAlt);
  report("links with no text", a11y.emptyLinks);
  report("duplicate ids in the live DOM", a11y.dupIds);
  if (a11y.nonEnglishNoLang) {
    console.log("  NOTE  " + a11y.nonEnglishNoLang +
      " non-English titles carry no lang attribute (screen-reader pronunciation)");
  } else {
    console.log("  OK    non-English titles marked with lang");
  }

  // ---- keyboard ----
  console.log("\n=== KEYBOARD ===");
  await page.evaluate(() => document.body.focus());
  await page.keyboard.press("/");
  const focused = await page.evaluate(() => document.activeElement.id);
  console.log((focused === "q" ? "  OK    " : "  ISSUE ") +
    "slash focuses the search box [" + focused + "]");
  if (focused !== "q") problems++;
  await page.keyboard.type("corrections");
  await sleep(600);
  await page.keyboard.press("Escape");
  await sleep(500);
  const cleared = await page.evaluate(() => document.querySelector("#q").value);
  console.log((cleared === "" ? "  OK    " : "  ISSUE ") +
    "escape clears the search box [" + JSON.stringify(cleared) + "]");
  if (cleared !== "") problems++;

  // ---- render cost at the largest page size ----
  console.log("\n=== PERFORMANCE ===");
  const timing = await page.evaluate(async () => {
    const sel = document.querySelector("#pageSizeSel");
    sel.value = "240"; sel.dispatchEvent(new Event("change"));
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 50));
    const t1 = performance.now();
    return { cards: document.querySelectorAll("#cardsWrap .sa-card").length,
             ms: Math.round(t1 - t0) };
  });
  console.log("  INFO  " + timing.cards + " cards rendered");
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType("navigation")[0] || {};
    return { dom: Math.round(n.domContentLoadedEventEnd || 0),
             load: Math.round(n.loadEventEnd || 0) };
  });
  console.log("  INFO  DOMContentLoaded " + nav.dom + "ms, load " + nav.load + "ms");

  // ---- resilience: storage blocked (private mode / blocked cookies) ----
  console.log("\n=== STORAGE BLOCKED ===");
  const p2 = await browser.newPage();
  const errs2 = [];
  p2.on("pageerror", (e) => errs2.push(e.message));
  p2.on("console", (m) => { if (m.type() === "error") errs2.push(m.text()); });
  await p2.evaluateOnNewDocument(() => {
    const boom = () => { throw new Error("storage blocked"); };
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() { return { getItem: boom, setItem: boom, removeItem: boom }; },
    });
  });
  await p2.goto(URL, { waitUntil: "networkidle2" });
  let usable = false;
  try {
    await p2.waitForFunction(
      () => !/loading/i.test(document.querySelector("#resultCount").textContent),
      { timeout: 25000 });
    usable = await p2.evaluate(() =>
      document.querySelectorAll("#cardsWrap .sa-card").length > 0);
  } catch (e) { usable = false; }
  console.log((usable ? "  OK    " : "  ISSUE ") +
    "app still works with localStorage blocked [cards=" + usable + "]");
  if (!usable) problems++;
  // favouriting must not throw when it cannot be saved
  const favErr = await p2.evaluate(() => {
    try { document.querySelector("[data-fav]").click(); return "no throw"; }
    catch (e) { return "threw: " + e.message; }
  });
  console.log((favErr === "no throw" ? "  OK    " : "  ISSUE ") +
    "starring a document with storage blocked [" + favErr + "]");
  if (favErr !== "no throw") problems++;
  report("errors with storage blocked", errs2.filter((e) => !/storage blocked/.test(e)));
  await p2.close();

  // ---- missing data file ----
  console.log("\n=== MISSING DATA ===");
  const p3 = await browser.newPage();
  await p3.setRequestInterception(true);
  p3.on("request", (r) => {
    if (/kits\.csv/.test(r.url())) r.abort();
    else r.continue();
  });
  const errs3 = [];
  p3.on("pageerror", (e) => errs3.push(e.message));
  await p3.goto(URL, { waitUntil: "networkidle2" });
  let okNoKits = false;
  try {
    await p3.waitForFunction(
      () => !/loading/i.test(document.querySelector("#resultCount").textContent),
      { timeout: 25000 });
    okNoKits = await p3.evaluate(() => ({
      cards: document.querySelectorAll("#cardsWrap .sa-card").length > 0,
      kitsHidden: document.querySelector('[data-view="kits"]').classList.contains("d-none"),
    }));
  } catch (e) { okNoKits = false; }
  console.log((okNoKits && okNoKits.cards ? "  OK    " : "  ISSUE ") +
    "app works when kits.csv is missing [" + JSON.stringify(okNoKits) + "]");
  if (!okNoKits || !okNoKits.cards) problems++;
  report("errors when kits.csv is missing", errs3);
  await p3.close();

  console.log("\n=== CONSOLE (main page) ===");
  report("runtime errors", errors);

  await browser.close();
  console.log("\n" + (problems ? "TOTAL ISSUES: " + problems : "NO ISSUES FOUND"));
})().catch((e) => { console.error("AUDIT CRASH", e); process.exit(1); });
