// End-to-end checks of crawl.mjs against a fake library gateway. No real library is contacted.
//   node test/e2e.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SHARDS = process.env.SHARD_DIR || path.join(os.homedir(), "nomad-library/public/ix");
let port = 19100, pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log("  pass:", msg); } else { fail++; console.log("  FAIL:", msg); } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const small = { BLURAY: 1, DVD: 1 };
const quick = { bclsnj: small, chipublib: small, seattle: small, nypl: small };

async function scenario(name, cfg, fn) {
  console.log(`\n== ${name}`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nlt-")), p = port++;
  const cfgPath = path.join(dir, "cfg.json");
  const setCfg = c => fs.writeFileSync(cfgPath, JSON.stringify({ shardDir: SHARDS, ...c }));
  setCfg(cfg);
  const mock = spawn("node", [path.join(ROOT, "test/mock.mjs"), String(p), cfgPath], { stdio: "ignore" });
  await sleep(400);
  const ctx = {
    dir, setCfg, out: path.join(dir, "out"), state: path.join(dir, "state"),
    run(args = [], env = {}) {
      const r = spawnSync("node", [path.join(ROOT, "crawl.mjs"), "--out", ctx.out, "--state", ctx.state, ...args], {
        encoding: "utf8", timeout: 120e3,
        env: { ...process.env, SITE_BASE: `http://127.0.0.1:${p}`, GATEWAY_BASE: `http://127.0.0.1:${p}/v2/libraries`, RETRY_BASE_MS: "30", PASS_WAIT_MS: "100", RATE: "400", PARALLEL: "4", ...env },
      });
      return { code: r.status, log: (r.stdout || "") + (r.stderr || "") };
    },
    async hits() { return (await fetch(`http://127.0.0.1:${p}/__hits`)).json(); },
    index: () => JSON.parse(fs.readFileSync(path.join(ctx.out, "snap/index.json"), "utf8")),
    status: () => JSON.parse(fs.readFileSync(path.join(ctx.out, "snap/status.json"), "utf8")),
    snap: slug => JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(ctx.out, "snap", slug + ".json.gz")))),
    has: f => fs.existsSync(f),
  };
  try { await fn(ctx); } finally { mock.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
}

await scenario("happy path, ratings, missing-shard fallback, files", { libs: { m1: { BLURAY: 8, DVD: 12, VIDEO_GAME: 0 } } }, async c => {
  const t = Date.now(), r = c.run(["--only", "m1"]);
  ok(r.code === 0, `exit 0 (got ${r.code})`);
  ok(Date.now() - t < 20e3, `finished quickly, optional ratings did not stall it (${Date.now() - t} ms)`);
  const s = c.snap("m1");
  ok(s.total === 500 && s.rows.length === 500, `500 unique titles (got ${s.rows.length})`);
  ok(s.rows.every(x => x.length === 15), "every row has 15 fields");
  ok(s.rows.filter(x => x[11]).length > 100, `ratings attached (${s.rows.filter(x => x[11]).length} rated)`);
  ok(s.sc === "testlib", "cover client id captured");
  ok(c.index().m1.total === 500 && c.index().m1.bytes < c.index().m1.rawBytes / 3, `index entry present, gzip ${c.index().m1.bytes} B vs raw ${c.index().m1.rawBytes} B`);
  ok(!c.has(path.join(c.state, "m1.json")), "progress file removed after publishing");
  ok(c.status().libraries.m1.state === "copied", "status lists it as copied");
  ok(!fs.readdirSync(path.join(c.out, "snap")).some(f => f.endsWith(".tmp")), "no half-written files");
});

await scenario("429 with Retry-After is honored and retried", { libs: { m2: { BLURAY: 3, DVD: 6 } }, once429: ["m2:DVD:3"] }, async c => {
  const r = c.run(["--only", "m2"]);
  ok(r.code === 0, `exit 0 (got ${r.code})`);
  ok(c.status().lastRun.http429 >= 1, `a 429 was seen and survived (${c.status().lastRun.http429})`);
  ok(c.snap("m2").total === 225, "complete copy published");
});

await scenario("budget runs out mid-library, then resumes without refetching", { libs: { m3: { BLURAY: 20, DVD: 20, delayMs: 90 } } }, async c => {
  const r1 = c.run(["--only", "m3", "--budget-min", "0.007"], { PARALLEL: "2" });
  ok(r1.code === 0 && /paused m3/.test(r1.log), `paused cleanly (exit ${r1.code})`);
  ok(c.has(path.join(c.state, "m3.json")), "progress saved");
  ok(!c.has(path.join(c.out, "snap/m3.json.gz")), "nothing published from a partial copy");
  const r2 = c.run(["--only", "m3"], { PARALLEL: "2" });
  ok(r2.code === 0, `resumed and finished (exit ${r2.code})`);
  const h = await c.hits(), mx = Math.max(...Object.values(h.byKey));
  ok(mx === 1, `no page was fetched twice across the interruption (max ${mx})`);
  const s = c.snap("m3");
  ok(s.rows.length === 1000 && new Set(s.rows.map(x => x[0])).size === 1000, "1000 unique titles after resume");
});

await scenario("a failing page: no publish, old copy kept, only that page retried later", { libs: { m4: { BLURAY: 5, DVD: 5 } } }, async c => {
  ok(c.run(["--only", "m4"]).code === 0, "first copy published");
  const idx = c.index(); idx.m4.finished -= 10 * 864e5; fs.writeFileSync(path.join(c.out, "snap/index.json"), JSON.stringify(idx));
  const before = crypto.createHash("sha1").update(fs.readFileSync(path.join(c.out, "snap/m4.json.gz"))).digest("hex");
  c.setCfg({ libs: { m4: { BLURAY: 5, DVD: 5 } }, fail: { "m4:DVD:3": "always500" } });
  const r = c.run(["--only", "m4"]);
  ok(r.code === 4, `refresh exits 4 when a page keeps failing (got ${r.code})`);
  const after = crypto.createHash("sha1").update(fs.readFileSync(path.join(c.out, "snap/m4.json.gz"))).digest("hex");
  ok(before === after, "the previous complete copy is untouched");
  ok(c.has(path.join(c.state, "m4.json")), "progress kept");
  ok(c.status().libraries.m4.state === "failing" && c.status().libraries.m4.attempts === 1, "status shows failing, attempt 1");
  const mid = (await c.hits()).byKey["m4:BLURAY:2"];
  c.setCfg({ libs: { m4: { BLURAY: 5, DVD: 5 } } });
  const r2 = c.run(["--only", "m4"]);
  ok(r2.code === 0, `recovers once the page works (exit ${r2.code})`);
  ok((await c.hits()).byKey["m4:BLURAY:2"] === mid, "already-saved pages were not fetched again");
  ok(c.index().m4.finished > idx.m4.finished + 5 * 864e5, "refreshed copy published");
});

await scenario("fair queue: a failing library backs off and does not starve a newer request", { libs: { m4: { BLURAY: 2, DVD: 2 }, m5: { BLURAY: 2, DVD: 2 }, ...quick }, fail: { "m4:DVD:1": "always500" }, wanted: [["m4", "Mock Four", 1], ["m5", "Mock Five", 2]] }, async c => {
  const r = c.run();
  ok(r.code === 4, `run is red because m4 failed (exit ${r.code})`);
  ok(c.has(path.join(c.out, "snap/m5.json.gz")), "m5, asked for later, still got copied");
  const h1 = (await c.hits()).byKey["m4:DVD:1"];
  const r2 = c.run();
  ok(/waiting out a backoff|nothing to do/.test(r2.log) && (await c.hits()).byKey["m4:DVD:1"] === h1, "m4 is not hammered again right away");
});

await scenario("403 block: stop quickly, keep progress, exit 5", { libs: { m6: { BLURAY: 40, DVD: 40 } }, blockAfter: 14 }, async c => {
  const r = c.run(["--only", "m6"]);
  ok(r.code === 5, `exit 5 = blocked (got ${r.code})`);
  ok(/BLOCKED/.test(r.log), "log says BLOCKED");
  const h = await c.hits();
  ok(h.blocked <= 12, `did not keep hammering after the block (${h.blocked} blocked requests)`);
  ok(c.has(path.join(c.state, "m6.json")) && !c.has(path.join(c.out, "snap/m6.json.gz")), "progress saved, nothing published");
  ok(/blocked/.test(c.status().libraries.m6.state), "status says blocked");
});

await scenario("thin catalog fails validation instead of publishing", { libs: { m9: { BLURAY: 6, DVD: 6, thin: true } } }, async c => {
  const r = c.run(["--only", "m9"]);
  ok(r.code === 4 && /validation/.test(r.log), `rejected (exit ${r.code})`);
  ok(!c.has(path.join(c.out, "snap/m9.json.gz")), "nothing published");
});

await scenario("old unfiltered list format is refused, not read as 'copy everything'", { libs: { zz: small, ...quick }, wanted: "old" }, async c => {
  const r = c.run();
  ok(/wanted list unavailable/.test(r.log), "warns that the wanted list is unusable");
  const h = await c.hits();
  ok(!h.byKey["a:BLURAY:1"] && Object.keys(h.byKey).every(k => ["bclsnj", "chipublib", "seattle", "nypl"].includes(k.split(":")[0])), "only the four quick picks were touched");
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
