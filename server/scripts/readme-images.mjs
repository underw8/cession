// Renders docs/images/dashboard.png and the bar strip in docs/images/widget.png from public/index.html,
// fed fixed demo data in place of a server. Run with `make images`.
// The widget's desktop, VS Code and Slack backdrop isn't rendered here: only the strip's interior is
// repainted onto the existing widget.png, so its position below must match that image.
import { chromium } from "playwright";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const IMAGES = `${ROOT}docs/images`;
const html = fs.readFileSync(`${ROOT}server/public/index.html`, "utf8");
const NOW = Date.parse("2026-10-18T10:30:00Z");
const M = 60_000;

const s = (project, branch, machine, status, upMin, sinceMin, cost, workflow = null) => ({
  id: project, project, branch, machine, cwd: `/Users/me/code/${project}`, status,
  started_at: NOW - upMin * M, last_seen: NOW - sinceMin * M, last_event: NOW - sinceMin * M, ended_at: null,
  cost_usd: cost, tokens_in: 0, tokens_out: 0, tokens_cache_read: 0, tokens_cache_write: 0, workflow,
});
const snapshot = { sessions: [
  s("payments-api", "feat/refunds", "mbp", "needs_you", 52, 4, 2.41),
  s("docs-site", "main", "mac-mini", "working", 65, 2, 0.74),
  s("infra", "main", "code-server", "working", 109, 1, 6.12, { name: "dependency-audit", phase: "Verify", done: 5, started: 8 }),
  s("web-app", "fix/checkout-flash", "mbp", "working", 36, 0, 1.18),
  s("data-pipeline", "perf/batching", "mac-mini", "idle", 144, 16, 3.35),
] };
const history = [
  ["2026-10-12", 4, 115, 9.80, 3.3e6, 235.2e3, 13.3e6, 1.1e6], ["2026-10-13", 5, 310, 14.19, 4.8e6, 340.6e3, 19.3e6, 1.6e6],
  ["2026-10-14", 3, 205, 6.50, 2.2e6, 156e3, 8.8e6, 736.7e3], ["2026-10-15", 3, 238, 17.89, 6.1e6, 429.4e3, 24.3e6, 2e6],
  ["2026-10-16", 3, 259, 11.30, 3.8e6, 271.2e3, 15.4e6, 1.3e6], ["2026-10-17", 4, 215, 4.10, 1.4e6, 98.4e3, 5.6e6, 464.7e3],
  ["2026-10-18", 5, 384, 13.80, 4.9e6, 351e3, 19.4e6, 1.6e6],
].map(([key, sessions, min, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write]) =>
  ({ key, sessions, duration_ms: min * M, cost_usd, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write }));

async function open(browser, viewport, css) {
  const p = await browser.newPage({ viewport, deviceScaleFactor: 2, colorScheme: "dark", locale: "en-GB", reducedMotion: "reduce" });
  await p.clock.setFixedTime(NOW);
  await p.route("http://cession.test/**", (r) => {
    const { pathname } = new URL(r.request().url());
    if (pathname === "/") return r.fulfill({ contentType: "text/html", body: html.replace("</style>", `${css}</style>`) });
    if (pathname === "/api/history") return r.fulfill({ json: history });
    if (pathname === "/api/me") return r.fulfill({ json: { kind: "browser" } });
    return r.fulfill({ status: 404 });
  });
  await p.routeWebSocket("ws://cession.test/live", (ws) => ws.send(JSON.stringify(snapshot)));
  await p.goto("http://cession.test/");
  await p.waitForSelector(".row", { state: "attached" });
  await p.waitForFunction(() => document.querySelector("#today").textContent !== "—");
  return p;
}

const browser = await chromium.launch();

// Dashboard: the panel as a window with its shadow, on a transparent background, History open.
const dash = await open(browser, { width: 580, height: 900 },
  "html,body{background:transparent!important} body{padding:70px 60px!important} .panel{box-shadow:0 20px 50px #0005,0 0 0 1px #0004!important}");
await dash.click("summary");
await dash.waitForSelector("#history td.num");
await dash.screenshot({ path: `${IMAGES}/dashboard.png`, fullPage: true, omitBackground: true });

// Widget: the strip at its widget size, with the amber "needs you" tint fixed at the backdrop's colour.
const bar = await open(browser, { width: 920, height: 38 }, ".panel{background:rgb(45,32,5)!important} .panel::before{display:none!important}");
const strip = (await bar.screenshot()).toString("base64");
const base = fs.readFileSync(`${IMAGES}/widget.png`).toString("base64");
// The strip sits at (399, 789), 1840×76 px, in widget.png; the inset keeps its rounded border.
const page = await browser.newPage({ viewport: { width: 2640, height: 1080 }, deviceScaleFactor: 1 });
await page.setContent(`<style>body{margin:0;background:transparent}div{position:absolute;left:421px;top:791px;width:1796px;height:72px;
  background:url(data:image/png;base64,${strip}) -22px -2px/1840px 76px}</style>
  <img src="data:image/png;base64,${base}" style="display:block"><div></div>`);
await page.screenshot({ path: `${IMAGES}/widget.png`, omitBackground: true });

await browser.close();
