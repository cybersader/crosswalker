// Crosswalker smoke under OpenClast's browser-native host (shimmed Obsidian in
// headless Chromium). Same install mechanism as OpenClast's own
// plugin-probe/plugin-probe.mjs: write the three plugin files through
// window.require("fs") into /vault/.obsidian/plugins, set the enable-plugin
// flag, reload. Then, in the tab:
//   1. openTier2(): info().vfs === "opfs-sahpool", info().persistent === true
//   2. write a marker row, reload the tab, read the marker back
//   3. capture the Settings "Search index" line text
// Inputs come from run-smoke.sh (OC_DIR, CW_ROOT, OUT_DIR, OC_URL). Exits 1 when
// an assertion fails, 2 on a harness error.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const OC_DIR = process.env.OC_DIR;
const CW = process.env.CW_ROOT;
const OUT = process.env.OUT_DIR;
if (!OC_DIR || !CW || !OUT) { console.error("Run through tests/openclast/run-smoke.sh"); process.exit(2); }
const require = createRequire(path.join(OC_DIR, "package.json"));
const { chromium } = require("playwright");
const URL = (process.env.OC_URL || "http://127.0.0.1:8712/") + "index-shimmed-opfs.html";
const ID = "crosswalker";
const MARKER_TABLE = "openclast_persistence_probe";

const files = {};
for (const f of ["manifest.json", "main.js", "styles.css"]) files[f] = fs.readFileSync(path.join(CW, f), "utf8");

const lines = [];
const log = (...a) => { const s = "[cw-probe] " + a.map(x => typeof x === "string" ? x : JSON.stringify(x)).join(" "); console.log(s); lines.push(s); };
const report = { url: URL, mainJsBytes: Buffer.byteLength(files["main.js"]) };
const failures = [];
const check = (name, ok, detail) => { if (!ok) failures.push(name + (detail === undefined ? "" : " " + JSON.stringify(detail))); };

const waitForPlugin = page => page.waitForFunction(id => !!window.app?.plugins?.plugins?.[id], ID, { timeout: 60000 });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on("console", m => lines.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", e => lines.push(`[pageerror] ${e.message}\n${e.stack || ""}`));
page.on("requestfailed", r => lines.push(`[requestfailed] ${r.url().slice(0, 200)} ${r.failure()?.errorText}`));
let harnessError = false;
try {
  await page.goto(URL, { waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__opfsHydrated === true, { timeout: 30000 });
  report.env = await page.evaluate(() => ({
    appId: window.app?.appId,
    crossOriginIsolated: self.crossOriginIsolated,
    SAB: typeof SharedArrayBuffer,
    syncAccessHandleOnMainThread: typeof FileSystemFileHandle !== "undefined" && "createSyncAccessHandle" in FileSystemFileHandle.prototype,
    ua: navigator.userAgent,
  }));
  log("env", report.env);

  // Install the three plugin files and enable the plugin, then reload.
  await page.evaluate(id => localStorage.setItem("enable-plugin-" + id, "true"), report.env.appId);
  await page.evaluate(({ id, files }) => {
    const f = window.require("fs");
    if (!f.existsSync("/vault/.obsidian/plugins")) f.mkdirSync("/vault/.obsidian/plugins");
    const dir = "/vault/.obsidian/plugins/" + id;
    if (!f.existsSync(dir)) f.mkdirSync(dir);
    for (const [n, c] of Object.entries(files)) f.writeFileSync(dir + "/" + n, c);
    f.writeFileSync("/vault/.obsidian/community-plugins.json", JSON.stringify([id]));
  }, { id: ID, files });
  await page.waitForFunction(() => window.__opfsPendingWrites() === 0, { timeout: 30000 });
  lines.push("===== RELOAD 1 (install) =====");
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__opfsHydrated === true, { timeout: 30000 });
  await waitForPlugin(page);

  // 1 + 2a: open the index, report where it lives, write a marker row.
  const marker = `marker-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  report.before = await page.evaluate(async ({ id, marker, table }) => {
    const plugin = window.app.plugins.plugins[id];
    try {
      const t0 = performance.now();
      const h = await plugin.openTier2();
      const openMs = Math.round(performance.now() - t0);
      const info = h.info();
      await h.db.exec(`CREATE TABLE IF NOT EXISTS ${table} (marker TEXT NOT NULL)`);
      await h.db.exec(`DELETE FROM ${table}`);
      await h.db.exec({ sql: `INSERT INTO ${table} (marker) VALUES ($m)`, bind: { $m: marker } });
      return { ok: true, openMs, vfs: info.vfs, persistent: info.persistent, filename: info.filename, sqliteVersion: h.sqliteVersion() };
    } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
  }, { id: ID, marker, table: MARKER_TABLE });
  report.markerWritten = marker;
  log("before reload", report.before);
  await page.screenshot({ path: path.join(OUT, "01-before-reload.png") });

  // 2b: reload the tab like a user would, then read the marker back.
  lines.push("===== RELOAD 2 (persistence) =====");
  await page.reload({ waitUntil: "load", timeout: 30000 });
  await page.waitForFunction(() => window.__opfsHydrated === true, { timeout: 30000 });
  await waitForPlugin(page);
  report.after = await page.evaluate(async ({ id, table }) => {
    const plugin = window.app.plugins.plugins[id];
    try {
      const t0 = performance.now();
      const h = await plugin.openTier2();
      const openMs = Math.round(performance.now() - t0);
      const info = h.info();
      let markers = [], readError = null;
      try {
        const rows = await h.db.exec({ sql: `SELECT marker FROM ${table}`, rowMode: "array", returnValue: "resultRows" });
        markers = rows.map(r => String(r[0]));
      } catch (e) { readError = String((e && e.message) || e); }
      return { ok: true, openMs, vfs: info.vfs, persistent: info.persistent, filename: info.filename, markers, readError };
    } catch (e) { return { ok: false, error: String((e && e.stack) || e) }; }
  }, { id: ID, table: MARKER_TABLE });
  report.markerReadBack = Array.isArray(report.after?.markers) && report.after.markers.includes(marker);
  log("after reload", report.after);

  // 3: the Settings "Search index" line.
  // The line sits in the Advanced section of the settings card grid.
  await page.evaluate(id => { window.app.setting.open(); window.app.setting.openTabById(id); }, ID);
  await page.getByText("Advanced", { exact: true }).first().click({ timeout: 15000 });
  report.settingsLine = await page.evaluate(async () => {
    for (let i = 0; i < 50; i++) {
      const el = document.querySelector(".crosswalker-search-index-status");
      if (el) {
        const d = el.closest("details"); if (d) d.open = true;
        el.scrollIntoView({ block: "center" });
        return el.textContent;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    return null;
  });
  await page.waitForTimeout(500);
  log("settings line", String(report.settingsLine));
  await page.screenshot({ path: path.join(OUT, "02-settings-search-index.png") });

  report.fallbackConsole = lines.filter(l => /OPFS unavailable|falling back|tier2|worker/i.test(l) && l.startsWith("[console")).slice(0, 40);

  check("before.ok", report.before?.ok === true, report.before?.error);
  check("before.vfs === opfs-sahpool", report.before?.vfs === "opfs-sahpool", report.before?.vfs);
  check("before.persistent === true", report.before?.persistent === true, report.before?.persistent);
  check("after.vfs === opfs-sahpool", report.after?.vfs === "opfs-sahpool", report.after?.vfs);
  check("after.persistent === true", report.after?.persistent === true, report.after?.persistent);
  check("marker read back after reload", report.markerReadBack === true, report.after?.markers);
  check("settings line says stored on this device", report.settingsLine === "Search index: stored on this device", report.settingsLine);
} catch (e) {
  harnessError = true;
  report.fatal = String((e && e.stack) || e);
  log("FATAL", report.fatal);
} finally {
  await browser.close();
}
report.failures = failures;
report.pass = !harnessError && failures.length === 0;
fs.writeFileSync(path.join(OUT, "console-raw.log"), lines.join("\n"));
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
process.exit(harnessError ? 2 : failures.length ? 1 : 0);
