// Tests for the installable-app and new-document notification behaviour.
//
//   node tools/test_pwa.js http://127.0.0.1:8765/index.html
//
// Needs a secure context, so use 127.0.0.1/localhost or https. The test
// temporarily rewrites data/changes.json to simulate a new crawl run, then
// restores it. Set CHROME_PATH for Chrome, SHOTS for screenshots.

const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const URL_ = process.argv[2] || "http://127.0.0.1:8765/index.html";
const ROOT = path.resolve(__dirname, "..");
const CHANGES = path.join(ROOT, "data", "changes.json");
const SHOTS = process.env.SHOTS || ".";
let fails = 0;
const check = (n, c, d) => {
  console.log((c ? "  PASS  " : "  FAIL  ") + n + (d ? "  [" + d + "]" : ""));
  if (!c) fails++;
};

const ready = async (p) => {
  await p.waitForFunction(
    () => !/loading/i.test(document.querySelector("#resultCount").textContent),
    { timeout: 45000 });
  await sleep(700);
};

(async () => {
  const original = fs.readFileSync(CHANGES, "utf8");
  const origin = new URL(URL_).origin;
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_PATH ||
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: "new", args: ["--no-sandbox"],
  });

  try {
    await browser.defaultBrowserContext()
      .overridePermissions(origin, ["notifications"]);

    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });
    const errors = [];
    page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
    page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });

    console.log("=== MANIFEST ===");
    await page.goto(URL_, { waitUntil: "networkidle2" });
    await ready(page);
    const man = await page.evaluate(async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return null;
      const res = await fetch(link.href);
      return res.ok ? await res.json() : null;
    });
    check("manifest loads", !!man);
    check("manifest is installable (name, icons, start_url, display)",
      !!man && man.name && man.start_url && man.display === "standalone" &&
      man.icons.length >= 2, man ? man.name : "");
    check("has 192 and 512 icons",
      !!man && [192, 512].every((s) =>
        man.icons.some((i) => i.sizes === s + "x" + s)));
    check("has a maskable icon",
      !!man && man.icons.some((i) => (i.purpose || "").includes("maskable")));
    check("declares app shortcuts", !!man && (man.shortcuts || []).length >= 2,
      String((man && man.shortcuts || []).length));

    console.log("\n=== SERVICE WORKER ===");
    const swState = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      return { scope: reg.scope, active: !!reg.active,
               controller: !!navigator.serviceWorker.controller };
    });
    check("service worker active", swState.active, swState.scope);
    // The controller may only attach on the next load.
    await page.reload({ waitUntil: "networkidle2" });
    await ready(page);
    const controlled = await page.evaluate(() => !!navigator.serviceWorker.controller);
    check("page is controlled by the worker", controlled);

    console.log("\n=== OFFLINE ===");
    // Give the worker a moment to have cached the CDN assets it saw.
    await sleep(1500);
    await page.setOfflineMode(true);
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
    let offline = { cards: 0, count: "" };
    try {
      await ready(page);
      offline = await page.evaluate(() => ({
        cards: document.querySelectorAll("#cardsWrap .sa-card").length,
        count: document.querySelector("#resultCount").textContent.trim(),
      }));
    } catch (e) { /* reported below */ }
    check("app still works with no connection", offline.cards > 0,
      offline.cards + " cards, " + offline.count);
    await page.screenshot({ path: SHOTS + "/50-offline.png" });
    await page.setOfflineMode(false);
    await page.reload({ waitUntil: "networkidle2" });
    await ready(page);

    console.log("\n=== NOTIFICATIONS: BASELINE ===");
    await page.evaluate(() => Notification.requestPermission());
    const perm = await page.evaluate(() => Notification.permission);
    check("notification permission granted for the test", perm === "granted", perm);
    // First check just records where we are; it must not invent notifications.
    await page.evaluate(() => document.querySelector("#bellBtn").click());
    await sleep(600);
    await page.evaluate(() => document.querySelector("#notifyCheck").click());
    await sleep(2500);
    let hist = await page.evaluate(() =>
      document.querySelectorAll("#notifyList .sa-panel").length);
    check("no notification invented on a first check", hist === 0, hist + " entries");
    const statusText = await page.evaluate(() =>
      document.querySelector("#notifyStatus").textContent.replace(/\s+/g, " ").trim());
    check("status explains what this device can do", statusText.length > 40,
      statusText.slice(0, 84));

    console.log("\n=== NOTIFICATIONS: A NEW RUN APPEARS ===");
    const data = JSON.parse(original);
    const newRun = {
      generated_utc: "2099-01-01T00:00:00Z",
      total: (data.latest && data.latest.total || 0) + 2,
      first_run: false,
      added_count: 2,
      removed_count: 0,
      added: [
        { title: "Test Document One", url: "https://www.aa.org/test-one.pdf",
          item_code: "P-99", category: "Pamphlets & Booklets", language: "English" },
        { title: "Documento de prueba", url: "https://www.aa.org/test-two.pdf",
          item_code: "SP-99", category: "Pamphlets & Booklets", language: "Spanish" },
      ],
      removed: [],
    };
    const simulated = { latest: newRun, runs: [newRun].concat(data.runs || []) };
    fs.writeFileSync(CHANGES, JSON.stringify(simulated, null, 2));

    await page.evaluate(() => document.querySelector("#notifyCheck").click());
    await sleep(3000);
    const after = await page.evaluate(() => ({
      entries: document.querySelectorAll("#notifyList .sa-panel").length,
      firstTitle: (document.querySelector("#notifyList .fw-semibold") || {}).textContent || "",
      listed: [...document.querySelectorAll("#notifyList a")].map((a) => a.textContent.trim()),
      bell: document.querySelector("#bellCount").textContent,
    }));
    check("a notification is recorded for the new run", after.entries === 1,
      after.entries + " entries: " + after.firstTitle.trim());
    check("it names the new documents",
      after.listed.some((t) => /Test Document One/.test(t)) &&
      after.listed.some((t) => /Documento de prueba/.test(t)),
      after.listed.join(" | ").slice(0, 80));

    const shown = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      const ns = await reg.getNotifications();
      return ns.map((n) => ({ title: n.title, body: n.body }));
    });
    check("a real system notification was raised by the worker",
      shown.length > 0 && /new document/i.test(shown[0].title || ""),
      JSON.stringify(shown[0] || {}).slice(0, 96));

    console.log("\n=== NEW-DOCUMENTS VIEW ===");
    await page.evaluate(() => {
      bootstrap.Modal.getInstance(document.querySelector("#notifyModal")).hide();
    });
    await sleep(700);
    const quick = await page.evaluate(() => {
      const b = document.querySelector('[data-view="new"]');
      return { present: !!b, hidden: b ? b.classList.contains("d-none") : true,
               badge: (document.querySelector("#qvNew") || {}).textContent };
    });
    check("a New documents view appears", quick.present && !quick.hidden,
      "badge " + quick.badge);

    console.log("\n=== HISTORY PERSISTS, THEN CLEARS ===");
    await page.reload({ waitUntil: "networkidle2" });
    await ready(page);
    await page.evaluate(() => document.querySelector("#bellBtn").click());
    // The list is rendered from IndexedDB, so wait for the read rather than
    // guessing how long it takes.
    let persisted = 0;
    try {
      await page.waitForFunction(
        () => document.querySelectorAll("#notifyList .sa-panel").length > 0,
        { timeout: 8000 });
      persisted = await page.evaluate(() =>
        document.querySelectorAll("#notifyList .sa-panel").length);
    } catch (e) { persisted = 0; }
    check("history survives a restart", persisted >= 1, persisted + " entries");
    await page.screenshot({ path: SHOTS + "/51-notifications.png" });

    await page.evaluate(() => document.querySelector("#notifyClear").click());
    await sleep(1200);
    const cleared = await page.evaluate(() => ({
      entries: document.querySelectorAll("#notifyList .sa-panel").length,
      empty: /Nothing yet/.test(document.querySelector("#notifyList").textContent),
      bellHidden: document.querySelector("#bellCount").classList.contains("d-none"),
    }));
    check("clear empties the history", cleared.entries === 0 && cleared.empty);
    check("clearing resets the unread badge", cleared.bellHidden);

    console.log("\n=== CONSOLE ===");
    const real = errors.filter((e) => !/Failed to fetch|net::ERR|503|504/.test(e));
    check("no console errors", real.length === 0, real.length + "");
    real.slice(0, 6).forEach((e) => console.log("     - " + e.slice(0, 140)));

    await page.close();
  } finally {
    fs.writeFileSync(CHANGES, original);
    console.log("\n(data/changes.json restored)");
    await browser.close();
  }

  console.log("\n" + (fails ? "FAILURES: " + fails : "ALL APP CHECKS PASSED"));
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error("CRASH", e); process.exit(1); });
