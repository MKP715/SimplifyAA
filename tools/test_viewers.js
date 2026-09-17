// Tests for the PDF viewer options in index.html.
//
//   node tools/test_viewers.js http://127.0.0.1:8765/index.html
//
// Covers the settings UI, each viewer method, the in-page reader on both a
// CORS-enabled file and a blocked one, persistence, and iPhone emulation
// (where a framed PDF renders blank and Automatic must avoid it).
// Set SHOTS to a directory for screenshots; CHROME_PATH for Chrome.

const puppeteer = require("puppeteer-core");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (n, c, d) => {
  console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? "  [" + d + "]" : ""));
  if (!c) fails++;
};
const URL = process.argv[2] || "http://127.0.0.1:8765/index.html";
const WIDEN = "mg-21_bridging_the_gap_online.pdf";
const SHOTS = process.env.SHOTS || ".";

async function boot(browser, iphone) {
  const p = await browser.newPage();
  if (iphone) {
    await p.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
      "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1");
    await p.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  } else {
    await p.setViewport({ width: 1500, height: 1000 });
  }
  await p.goto(URL, { waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 40000 });
  await sleep(500);
  return p;
}

async function preview(p, sub, search) {
  await p.evaluate((term) => {
    const q = document.querySelector("#q");
    q.value = term || ""; q.dispatchEvent(new Event("input"));
  }, search || "");
  await sleep(900);
  const ok = await p.evaluate((s) => {
    const btn = [...document.querySelectorAll("[data-preview]")]
      .find((b) => b.dataset.preview.includes(s));
    if (!btn) return false;
    btn.click();
    return true;
  }, sub);
  await sleep(1400);
  return ok;
}

const clickMethod = (p, re) => p.evaluate((r) => {
  const b = [...document.querySelectorAll("#previewMethods button")]
    .find((x) => new RegExp(r, "i").test(x.textContent));
  if (b) b.click();
  return !!b;
}, re);

(async () => {
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new", args: ["--no-sandbox"],
  });

  console.log("=== SETTINGS UI ===");
  let p = await boot(browser, false);
  const s = await p.evaluate(() => ({
    gear: !!document.querySelector('[data-bs-target="#settingsModal"]'),
    options: [...document.querySelectorAll("#settingsMethods input[name=viewerMethod]")]
      .map((i) => i.value),
    checked: (document.querySelector("#settingsMethods input:checked") || {}).value,
    note: document.querySelector("#settingsDeviceNote").textContent.trim().slice(0, 60),
    slider: !!document.querySelector("#previewHeight"),
  }));
  check("settings button in navbar", s.gear);
  check("six viewer options offered", s.options.length === 6, s.options.join(","));
  check("Automatic is the default", s.checked === "auto", s.checked);
  check("device note shown", s.note.length > 20, s.note);
  check("preview size control present", s.slider);

  console.log("\n=== DESKTOP: automatic -> browser viewer ===");
  check("found a Widen document to preview", await preview(p, WIDEN, "mg-21"));
  let v = await p.evaluate(() => ({
    shown: document.querySelector("#previewModal").classList.contains("show"),
    methods: [...document.querySelectorAll("#previewMethods button")]
      .map((b) => b.textContent.trim()),
    kind: document.querySelector("#previewBody").firstElementChild
      ? document.querySelector("#previewBody").firstElementChild.tagName : "NONE",
    src: (document.querySelector("#previewBody iframe") || {}).src || "",
    note: document.querySelector("#previewMethodNote").textContent.trim(),
  }));
  check("preview opens", v.shown);
  check("viewer switcher visible in preview", v.methods.length === 5,
    v.methods.join("|").replace(/\s+/g, ""));
  check("automatic picked the browser viewer", v.kind === "IFRAME" && /mg-21/.test(v.src), v.kind);
  check("bar explains the choice", /Automatic/.test(v.note), v.note);

  console.log("\n=== SWITCH: embedded object ===");
  await clickMethod(p, "Embedded");
  await sleep(900);
  v = await p.evaluate(() => ({
    kind: document.querySelector("#previewBody").firstElementChild.tagName,
    data: (document.querySelector("#previewBody object") || {}).data || "",
    saved: JSON.parse(localStorage.getItem("simplifyaa.settings") || "{}").viewer,
  }));
  check("embedded uses an object element", v.kind === "OBJECT" && /mg-21/.test(v.data), v.kind);
  check("choice persisted to localStorage", v.saved === "object", v.saved);

  console.log("\n=== SWITCH: in-page reader on a CORS-enabled file ===");
  await clickMethod(p, "reader");
  await sleep(7000);
  v = await p.evaluate(() => ({
    canvases: document.querySelectorAll("#readerPages canvas").length,
    w: (document.querySelector("#readerPages canvas") || {}).width || 0,
    h: (document.querySelector("#readerPages canvas") || {}).height || 0,
    err: /cannot open/.test(document.querySelector("#previewBody").textContent),
  }));
  check("reader renders real pages", v.canvases > 0 && v.w > 100 && v.h > 100,
    v.canvases + " canvases " + v.w + "x" + v.h);
  check("reader shows no error", !v.err);
  await p.screenshot({ path: SHOTS + "/21-reader.png" });

  console.log("\n=== READER on an aa.org file (no CORS) ===");
  await p.evaluate(() => {
    const q = document.querySelector("#q");
    q.value = "box 4-5-9"; q.dispatchEvent(new Event("input"));
  });
  await sleep(1000);
  const opened = await p.evaluate(() => {
    const btn = [...document.querySelectorAll("[data-preview]")]
      .find((b) => /www\.aa\.org/.test(b.dataset.preview));
    if (!btn) return false;
    btn.click();
    return true;
  });
  check("found an aa.org-hosted document", opened);
  await sleep(2500);
  v = await p.evaluate(() => ({
    body: document.querySelector("#previewBody").textContent.replace(/\s+/g, " ").trim().slice(0, 160),
    fallbacks: [...document.querySelectorAll("#previewBody [data-fallback-here] button")]
      .map((b) => b.textContent.trim()),
    readerDisabled: !!document.querySelector("#previewMethods button.opacity-50"),
  }));
  check("explains why the reader cannot work here",
    /does not allow|cannot open/i.test(v.body), v.body.slice(0, 95));
  check("offers working alternatives instead", v.fallbacks.length >= 2, v.fallbacks.join(","));
  check("reader button marked unavailable for this file", v.readerDisabled);

  console.log("\n=== SWITCH: google viewer ===");
  await clickMethod(p, "Google");
  await sleep(1200);
  v = await p.evaluate(() => ({
    src: (document.querySelector("#previewBody iframe") || {}).src || "",
  }));
  check("google viewer URL is correct",
    /^https:\/\/docs\.google\.com\/viewer\?embedded=true&url=https%3A%2F%2F/.test(v.src),
    v.src.slice(0, 72));

  console.log("\n=== PREVIEW HEIGHT ===");
  await clickMethod(p, "Browser");
  await sleep(800);
  const h1 = await p.evaluate(() => document.querySelector("#previewBody iframe").style.height);
  await p.evaluate(() => {
    const sl = document.querySelector("#previewHeight");
    sl.value = "48";
    sl.dispatchEvent(new Event("input"));
  });
  await sleep(800);
  const h2 = await p.evaluate(() => document.querySelector("#previewBody iframe").style.height);
  check("height setting changes the preview", h1 !== h2, h1 + " -> " + h2);

  console.log("\n=== PERSISTENCE ACROSS RELOAD ===");
  await p.reload({ waitUntil: "networkidle2" });
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent), { timeout: 40000 });
  await sleep(700);
  v = await p.evaluate(() => ({
    checked: (document.querySelector("#settingsMethods input:checked") || {}).value,
    height: (document.querySelector("#previewHeight") || {}).value,
  }));
  check("viewer choice survives reload", v.checked === "iframe", v.checked);
  check("height survives reload", v.height === "48", v.height);

  console.log("\n=== CLEAR SETTINGS ===");
  await p.evaluate(() => document.querySelector("#clearSettings").click());
  await sleep(800);
  v = await p.evaluate(() => ({
    checked: (document.querySelector("#settingsMethods input:checked") || {}).value,
  }));
  check("clear resets to Automatic", v.checked === "auto", v.checked);
  await p.close();

  console.log("\n=== IPHONE: automatic avoids the blank frame ===");
  const ip = await boot(browser, true);
  const note = await ip.evaluate(() =>
    document.querySelector("#settingsDeviceNote").textContent.replace(/\s+/g, " ").trim());
  check("iPhone detected", /iPhone or iPad/.test(note), note.slice(0, 58));
  await preview(ip, WIDEN, "mg-21");
  const ipp = await ip.evaluate(() => ({
    shown: document.querySelector("#previewModal").classList.contains("show"),
    active: ((document.querySelector("#previewMethods button.active") || {}).textContent || "").trim(),
    area: !!document.querySelector("#readerPages, #readerStatus"),
  }));
  check("iPhone automatic uses the in-page reader",
    /reader/i.test(ipp.active) && ipp.area, ipp.active + " / area=" + ipp.area);
  await sleep(7000);
  const ipc = await ip.evaluate(() => document.querySelectorAll("#readerPages canvas").length);
  check("reader draws pages at iPhone width", ipc > 0, ipc + " canvases");
  await ip.screenshot({ path: SHOTS + "/20-iphone-reader.png" });

  // On iPhone, an aa.org file cannot use the reader, so automatic must not
  // silently show a blank frame.
  // Close the open preview first, or the backdrop swallows the next click.
  await ip.keyboard.press("Escape");
  await sleep(900);
  await ip.evaluate(() => {
    window.__opened = [];
    window.open = (u) => { window.__opened.push(u); return null; };
    const q = document.querySelector("#q");
    q.value = "box 4-5-9"; q.dispatchEvent(new Event("input"));
  });
  await sleep(1000);
  const clicked = await ip.evaluate(() => {
    const btn = [...document.querySelectorAll("[data-preview]")]
      .find((b) => /www\.aa\.org/.test(b.dataset.preview));
    if (!btn) return false;
    btn.click();
    return true;
  });
  await sleep(1500);
  const res = await ip.evaluate(() => ({
    opened: window.__opened || [],
    modal: document.querySelector("#previewModal").classList.contains("show"),
  }));
  check("iPhone found an aa.org document", clicked);
  check("iPhone + aa.org file opens a new tab instead of a blank frame",
    res.opened.some((u) => /aa\.org/.test(u || "")) && !res.modal,
    "opened=" + res.opened.length + " modal=" + res.modal);
  await ip.close();

  await browser.close();
  console.log("\n" + (fails ? "FAILURES: " + fails : "ALL VIEWER CHECKS PASSED"));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
