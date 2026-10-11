// Copies BiblioCommons libraries into one compressed static file each (snap/<slug>.json.gz).
//   node crawl.mjs --out out --state state [--budget-min 15] [--only slug,slug] [--dry]
// Runs on GitHub's computers (see .github/workflows/crawl.yml), never on a Cloudflare Worker.
//
// Guarantees:
//  - Resumable. Progress for a library is saved to --state after batches, so a time budget or crash loses nothing.
//  - A copy is published only when every page of every format is in and validation passes. A failed or paused
//    refresh leaves the previous complete copy untouched.
//  - Honest exit status: 0 = ok, 3 = nothing left to do, 4 = a library failed, 5 = the library gateway blocked us (run stops, progress kept).
//  - --dry writes to --out but never touches index.json, for experiments.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const SITE = process.env.SITE_BASE || "https://library.nomadovernormal.com";
const GW = process.env.GATEWAY_BASE || "https://gateway.bibliocommons.com/v2/libraries";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FMTS = [["BLURAY", "b"], ["DVD", "d"], ["VIDEO_GAME", "g"]];
const PAR = +(process.env.PARALLEL || 4);
const STALE_MS = +(process.env.STALE_DAYS || 14) * 864e5;
const MAX_ATTEMPTS = 8;                      // after this many failed runs a library is parked as "stuck" and shown in status
const backoffMs = n => Math.min(6 * 36e5 * n, 48 * 36e5);   // 6 h, 12 h, 18 h ... capped at 48 h between tries of a failing library
// Scheduled copies come only from visitor requests. --only is an explicit manual override.

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "out"), STATE = arg("state", "state"), ONLY = arg("only", ""), DRY = process.argv.includes("--dry");
const BUDGET_MS = +arg("budget-min", 15) * 60e3, T0 = Date.now(), DEADLINE = T0 + BUDGET_MS;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const COOL_PROBE_MS = +(process.env.COOL_PROBE_MS || 60000);   // while blocked, one cheap probe per minute
const RETRY_BASE = +(process.env.RETRY_BASE_MS || 1000), PASS_WAIT = +(process.env.PASS_WAIT_MS || 20000);
const log = (...a) => console.log(...a);

// ---- row shaping (identical rows to the site's original crawler) ---------------------------------
const GENRES = [
  ["superhero", "superhero"], ["science fiction", "scifi"], ["horror", "horror"], ["romantic comed", "romcom"],
  ["comedy", "comedy"], ["comedies", "comedy"], ["animated", "animation"], ["animation", "animation"],
  ["children's", "family"], ["juvenile", "family"], ["family", "family"], ["fantasy", "fantasy"],
  ["war films", "war"], ["war ", "war"], ["western", "western"], ["musical", "musical"],
  ["biographical", "biography"], ["documentary", "documentary"], ["historical", "history"],
  ["thriller", "thriller"], ["suspense", "thriller"], ["crime", "crime"], ["detective", "crime"],
  ["mystery", "crime"], ["martial arts", "action"], ["action", "action"], ["adventure", "action"],
  ["sports", "sports"], ["romance", "romance"], ["foreign", "foreign"], ["television", "tv"], ["drama", "drama"],
];
const PLATFORMS = [
  [/switch\s*2/i, "Switch 2"], [/nintendo switch|\bswitch\b/i, "Switch"], [/playstation\s*5|\bps5\b/i, "PS5"],
  [/playstation\s*4|\bps4\b/i, "PS4"], [/xbox series|series x/i, "Xbox Series"], [/xbox one/i, "Xbox One"],
  [/\bxbox\b/i, "Xbox"], [/\bwii u\b/i, "Wii U"], [/\bwii\b/i, "Wii"], [/3ds/i, "3DS"],
];
const yearOf = v => { const m = String(v || "").match(/(19|20)\d{2}/); return m ? +m[0] : 0; };
const ART = /^(the|a|an|le|la|les|el|los|il)\s+/i;
const norm = t => String(t || "").toLowerCase().trim().replace(/\s*[:(\[].*$/, "").replace(/&/g, " and ")
  .replace(/[^a-z0-9 ]+/g, " ").replace(ART, "").replace(/\s+/g, " ").trim();
const normFull = t => String(t || "").toLowerCase().replace(/\(.*?\)|\[.*?\]/g, " ").replace(/&/g, " and ")
  .replace(/[^a-z0-9 ]+/g, " ").replace(ART, "").replace(/\s+/g, " ").trim();
const EDITION = /edition|widescreen|full ?screen|collector|anniversary|season|series|volume|vol\.|director|cut|remaster|restored|special|deluxe|criterion|blu-?ray|dvd|4k|uhd|motion picture|film|movie/i;

function pick(c, disc, tv) {
  if (!c?.length) return null;
  if (disc) {
    const ok = c.filter(r => !r[3] || r[3] <= disc + 1); if (ok.length) c = ok;
    const recent = c.filter(r => r[3] && disc - r[3] <= 2 && r[2] >= c[0][2] * 0.15);
    if (recent.length) c = recent;
  }
  const typed = c.filter(r => r[4] === (tv ? "s" : "m"));
  if (typed.length && typed[0][2] >= c[0][2] * 0.2) c = typed;
  return c[0];
}
function coverOf(url, seen) {
  if (!url) return "";
  try {
    const u = new URL(url);
    if (u.hostname === "secure.syndetics.com" && u.searchParams.get("type") === "xw12") {
      const client = u.searchParams.get("client") || "";
      if (!seen.client) seen.client = client;
      if (client === seen.client)
        return "~" + (u.searchParams.get("isbn") || "").replace(/\/[A-Z]+\.(GIF|JPG)$/i, "") + "~" + (u.searchParams.get("upc") || "") + "~" + (u.searchParams.get("oclc") || "");
    }
  } catch {}
  return url;
}
// [id, title, sub, fmt, discYear, cover, onShelf, holds, genres, tv, platform, rating, votes, imdb, filmYear]
function shape(id, b, f, seen) {
  const br = b.briefInfo || {}, av = b.availability || {}, j = br.jacket || {};
  const subj = [...(br.subjectHeadings || []), ...(br.genreForm || [])].join(" | ").toLowerCase();
  const genres = [];
  for (const [needle, g] of GENRES) if (subj.includes(needle) && !genres.includes(g)) genres.push(g);
  const tv = /television|season \d|complete (series|season)/.test(subj + " " + (br.title || "") + " " + (br.subtitle || "")) ? 1 : 0;
  let plat = "";
  if (f === "g") { const hay = [br.title, br.subtitle, br.edition, br.callNumber].join(" "); for (const [re, p] of PLATFORMS) if (re.test(hay)) { plat = p; break; } }
  return [id, (br.title || "").trim(), (br.subtitle || "").trim(), f, yearOf(br.publicationDate),
    coverOf(j.medium || j.large || j.small || "", seen), (av.status === "AVAILABLE" || (av.availableCopies || 0) > 0) ? 1 : 0,
    av.heldCopies || 0, genres.slice(0, 4).join(","), tv, plat, 0, 0, "", 0];
}

// ---- network with bounded retries --------------------------------------------------------------
const RATE = +(process.env.RATE || 1.1);    // gateway requests per second. Measured 10.11.26: the gateway allows ~480 requests then blocks an address for ~3 min; a steady 1.1/s ran 1,018 requests with no block
let nextSlot = 0;
async function slot() { const now = Date.now(), at = Math.max(nextSlot, now); nextSlot = at + 1000 / RATE; if (at > now) await sleep(at - now); }
const stats = { pages: 0, requests: 0, retries: 0, http429: 0, http403: 0, http5xx: 0, timeouts: 0, busyMs: 0 };
async function getJson(url, { tries = 4, timeout = 25e3, limit = false } = {}) {
  let delay = RETRY_BASE, last;
  for (let i = 0; i < tries; i++) {
    try {
      if (limit) { await slot(); stats.requests++; }
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(timeout) });
      if (r.ok) return await r.json();
      last = new Error(`HTTP ${r.status}`);
      if (r.status === 403) { stats.http403++; last.blocked = true; throw last; }   // do not hammer a block: report it to the caller
      if (r.status === 429 || r.status >= 500) {
        stats[r.status === 429 ? "http429" : "http5xx"]++;
        const ra = Number(r.headers.get("retry-after"));
        delay = ra > 0 ? Math.min(ra * 1000, 60e3) : delay;
      } else { last.permanent = true; throw last; }
    } catch (e) {
      if (e.permanent || e.blocked) throw e;
      if (e.name === "TimeoutError" || e.name === "AbortError") stats.timeouts++;
      last = last && last.message.startsWith("HTTP") ? last : e;
    }
    if (i < tries - 1) { stats.retries++; await sleep(delay); delay = Math.min(delay * 3, 60e3); }
  }
  throw last;
}
const pageUrl = (slug, fmt, n) => `${GW}/${slug}/bibs/search?query=*&searchType=bl&f_FORMAT=${fmt}&limit=25&page=${n}&sort=newly_acquired`;

// ---- IMDb ratings: the static shards the site already serves. Optional, never allowed to stall a copy ----
const shardCache = new Map();
const shardKey = k => (k + "_").slice(0, 2).replace(/ /g, "_");
let shardFailures = 0;
async function shard(k) {
  const s = shardKey(k);
  if (!shardCache.has(s)) shardCache.set(s, (async () => {
    for (let i = 0; i < 3; i++) {
      try {
        const r = await fetch(`${SITE}/ix/${s}.json`, { signal: AbortSignal.timeout(15e3) });
        if (r.ok && /json/i.test(r.headers.get("content-type") || "")) return await r.json();
        if (r.ok || r.status === 404) return {};     // the site answers a missing shard with its home page: no ratings live there
      } catch {}
      await sleep(500 * 3 ** i);
    }
    shardFailures++;
    return null;                                      // a real failure, counted and surfaced
  })());
  return shardCache.get(s);
}
async function attachRatings(rows) {
  let degraded = 0;
  await Promise.all(rows.map(async r => {
    if (r[3] === "g") return;
    const k = norm(r[1]); if (!k) return;
    const sub = r[2].replace(/\s*\/.*$/, "").trim();
    const tail = [r[1].includes(":") ? r[1].split(":").slice(1).join(" ") : "", sub].join(" ").trim();
    let m = null, broken = false;
    if (tail) { const k2 = normFull(r[1] + " " + sub); const sh = await shard(k2); if (sh === null) broken = true; else m = pick(sh[k2], r[4], r[9]); }
    if (!m && !broken && (!tail || EDITION.test(tail))) { const sh = await shard(k); if (sh === null) broken = true; else m = pick(sh[k], r[4], r[9]); }
    if (broken) degraded++;
    if (m) { r[11] = m[1]; r[12] = m[2]; r[13] = m[0]; r[14] = m[3] || 0; }
  }));
  return degraded;
}

// ---- state ------------------------------------------------------------------------------------
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const writeAtomic = (p, data) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p + ".tmp", data); fs.renameSync(p + ".tmp", p); };
const toRanges = set => { const a = [...set].sort((x, y) => x - y), out = []; for (const n of a) { const l = out[out.length - 1]; if (l && n === l[1] + 1) l[1] = n; else out.push([n, n]); } return out; };
const fromRanges = rs => { const s = new Set(); for (const [a, b] of rs || []) for (let n = a; n <= b; n++) s.add(n); return s; };

function loadState(slug) {
  const j = readJson(path.join(STATE, slug + ".json"), null);
  if (!j) return null;
  const ids = new Set(j.rows.map(r => r[0]));
  return { ...j, ids, done: Object.fromEntries(Object.entries(j.fmts).map(([f, v]) => [f, fromRanges(v.done)])) };
}
function saveState(st) {
  const fmts = {};
  for (const [f, v] of Object.entries(st.fmts)) fmts[f] = { pages: v.pages, count: v.count, done: toRanges(st.done[f]) };
  const { ids, done, ...rest } = st;
  writeAtomic(path.join(STATE, st.slug + ".json"), JSON.stringify({ ...rest, fmts }));
}

// Wait out a block. Returns seconds waited, or null if the run's time budget ran out first.
async function coolDown(slug) {
  const t0 = Date.now(), asked = stats.requests - reqsAtRecovery;
  log(`  gateway blocked us after ${asked} requests since the last block; probing once a minute`);
  while (Date.now() + COOL_PROBE_MS < DEADLINE) {
    await sleep(COOL_PROBE_MS);
    try { await getJson(pageUrl(slug, "DVD", 1), { tries: 1, limit: true }); }
    catch (e) { if (e.blocked) continue; else continue; }
    const secs = Math.round((Date.now() - t0) / 1e3);
    status.gateway.blocks.push({ at: new Date(t0).toISOString(), requestsBefore: asked, blockedSeconds: secs, recovered: true });
    status.gateway.blocks = status.gateway.blocks.slice(-40);
    reqsAtRecovery = stats.requests;
    log(`  gateway let us back in after ${secs} s (it had allowed ${asked} requests)`);
    return secs;
  }
  status.gateway.blocks.push({ at: new Date(t0).toISOString(), requestsBefore: asked, blockedSeconds: Math.round((Date.now() - t0) / 1e3), recovered: false });
  status.gateway.blocks = status.gateway.blocks.slice(-40);
  return null;
}

// ---- one library ------------------------------------------------------------------------------
// returns { result: "done" | "paused" | "failed", ... }
async function crawlLibrary(slug, st) {
  const seen = { client: st.sc || "" };
  const take = (d, f) => {
    const bibs = d.entities?.bibs || {};
    for (const res of d.catalogSearch?.results || []) {
      const id = res.representative;
      if (bibs[id] && !st.ids.has(id)) { st.ids.add(id); st.rows.push(shape(id, bibs[id], f, seen)); }
    }
    st.sc = seen.client;
  };
  let lastSave = Date.now(), blockedBatches = 0;
  for (const [fmt, f] of FMTS) {
    if (!st.fmts[fmt]) {
      const first = await getJson(pageUrl(slug, fmt, 1), { limit: true });
      const pg = first.catalogSearch?.pagination || {};
      st.fmts[fmt] = { pages: Math.max(1, pg.pages || 1), count: pg.count || 0 };
      st.done[fmt] = new Set([1]); take(first, f); stats.pages++;
    }
    const F = st.fmts[fmt], done = st.done[fmt];
    for (let pass = 0; pass < 2; pass++) {
      const todo = []; for (let n = 1; n <= F.pages; n++) if (!done.has(n)) todo.push(n);
      if (!todo.length) break;
      if (pass === 1) { log(`  ${slug} ${fmt}: retrying ${todo.length} page(s) once more`); await sleep(PASS_WAIT); }
      for (let i = 0; i < todo.length; i += PAR) {
        if (Date.now() > DEADLINE) { saveState(st); return { result: "paused" }; }
        const batch = todo.slice(i, i + PAR), tb = Date.now();
        const got = await Promise.allSettled(batch.map(n => getJson(pageUrl(slug, fmt, n), { tries: 4, limit: true })));
        got.forEach((g, k) => { if (g.status === "fulfilled") { take(g.value, f); done.add(batch[k]); stats.pages++; } });
        stats.busyMs += Date.now() - tb;
        // The gateway answering 403 to a whole batch (twice running) means this address is blocked. Stop asking,
        // wait with one cheap probe a minute until it lets us back in, then carry on. The pages that failed are
        // retried in the second pass. Records every block so the real sustainable rate is known, not guessed.
        if (got.every(g => g.status === "rejected" && g.reason?.blocked)) {
          if (++blockedBatches >= 2) {
            saveState(st);
            const cool = await coolDown(slug);
            if (cool === null) return { result: "blocked", error: `the library gateway kept answering 403 (blocked); gave up waiting after ${stats.requests} requests this run` };
            blockedBatches = 0;
          }
        } else blockedBatches = 0;
        if (Date.now() - lastSave > 60e3) { saveState(st); lastSave = Date.now(); }
      }
    }
    const missing = F.pages - done.size;
    if (missing > 0) { saveState(st); return { result: "failed", error: `${missing} of ${F.pages} ${fmt} pages still failing after retries` }; }
  }
  return { result: "done" };
}

function validate(rows, st, prev) {
  const problems = [];
  const expected = Object.values(st.fmts).reduce((n, v) => n + v.count, 0);
  if (!rows.length) problems.push("no titles");
  const bad = rows.filter(r => !Array.isArray(r) || r.length !== 15 || !r[0] || !r[1]).length;
  if (bad > rows.length * 0.02) problems.push(`${bad} malformed rows`);
  // several results can share one representative record, so unique rows run 5 to 15 percent under the catalog's count
  if (expected && rows.length < expected * 0.7) problems.push(`only ${rows.length} unique titles for a catalog of ${expected}`);
  if (prev?.total && rows.length < prev.total * 0.6) problems.push(`${rows.length} titles is far below the previous copy (${prev.total})`);
  return problems;
}

async function finishLibrary(slug, st, name, index) {
  const rows = st.rows;
  const films = rows.filter(r => r[3] !== "g").length;
  const degraded = await attachRatings(rows);
  const problems = validate(rows, st, index[slug]);
  if (films >= 500) {
    const rated = rows.filter(r => r[3] !== "g" && r[11]).length;
    if (rated < films * 0.25) problems.push(`only ${rated} of ${films} films got a rating`);
  }
  if (degraded > rows.length * 0.02) problems.push(`ratings lookup failed for ${degraded} titles`);
  if (problems.length) return { result: "failed", error: "validation: " + problems.join("; ") };
  const finished = Date.now();
  const raw = `{"ver":${finished},"finished":${finished},"total":${rows.length},"sc":${JSON.stringify(st.sc || "")},"rows":[${rows.map(r => JSON.stringify(r)).join(",")}]}`;
  const gz = zlib.gzipSync(raw, { level: 9 });
  if (!DRY) {
    writeAtomic(path.join(OUT, "snap", slug + ".json.gz"), gz);
    index[slug] = { name, finished, total: rows.length, bytes: gz.length, rawBytes: raw.length, expected: Object.values(st.fmts).reduce((n, v) => n + v.count, 0), pages: Object.values(st.fmts).reduce((n, v) => n + v.pages, 0) };
  } else writeAtomic(path.join(OUT, "dry", slug + ".json.gz"), gz);
  return { result: "done", total: rows.length, bytes: gz.length };
}

// ---- which libraries, in what order ------------------------------------------------------------
async function wantedList() {
  try {
    const d = await getJson(SITE + "/api/want", { tries: 3 });
    if (!Array.isArray(d?.wanted)) throw new Error("answer is not the wanted-list format (old site still deployed?)");
    return d.wanted;
  } catch (e) { log(`::warning::wanted list unavailable (${e.message}); no automatic copies will be started`); return null; }
}

// ---- main ---------------------------------------------------------------------------------------
fs.mkdirSync(path.join(OUT, "snap"), { recursive: true }); fs.mkdirSync(STATE, { recursive: true });
const idxPath = path.join(OUT, "snap", "index.json"), statusPath = path.join(OUT, "snap", "status.json");
const index = readJson(idxPath, {});
const status = readJson(statusPath, { libraries: {} });
status.gateway = status.gateway || { blocks: [] };
let reqsAtRecovery = 0;
const now = Date.now();

const wanted = await wantedList();
if (wanted === null && !ONLY) process.exit(4);
const names = new Map(), asked = new Map();
for (const [slug, name, at] of wanted || []) { names.set(slug, name || slug); asked.set(slug, at || 1); }
// libraries already copied stay fresh even if nobody has "requested" them lately (they were requested once)
for (const [slug, e] of Object.entries(index)) if (!names.has(slug)) { names.set(slug, e.name || slug); asked.set(slug, 0); }
let candidates = ONLY ? ONLY.split(",") : [...names.keys()];
const queue = [], waiting = [];
for (const slug of candidates) {
  const st0 = readJson(path.join(STATE, slug + ".json"), null);
  const meta = status.libraries[slug] || {};
  const idx = index[slug];
  const need = !idx ? "new" : (idx.finished < now - STALE_MS ? "refresh" : null);
  if (!need) continue;
  if (meta.attempts >= MAX_ATTEMPTS && !ONLY) { status.libraries[slug] = { ...meta, state: "stuck" }; continue; }
  if (meta.lastFailAt && now < meta.lastFailAt + backoffMs(meta.attempts || 1) && !ONLY) { waiting.push(slug); continue; }
  queue.push({ slug, need, askedAt: asked.get(slug) ?? 0, finished: idx?.finished || 0, resume: !!st0 });
}
// new requests first (oldest request first, so nobody starves), then refreshes oldest copy first
queue.sort((a, b) => (a.need === b.need ? (a.need === "new" ? a.askedAt - b.askedAt : a.finished - b.finished) : a.need === "new" ? -1 : 1));
log(`${candidates.length} candidate libraries, ${queue.length} to work on (${queue.filter(q => q.need === "new").length} new, ${queue.filter(q => q.need === "refresh").length} refresh), ${waiting.length} waiting out a backoff, ${Object.keys(index).length} copied, budget ${(BUDGET_MS / 6e4).toFixed(0)} min, parallel ${PAR}`);
if (!queue.length) {
  for (const s of waiting) status.libraries[s] = { ...status.libraries[s], state: "waiting after failures" };
  writeStatus(0); log("nothing to do right now"); process.exit(3);
}

let failed = 0, doneCount = 0, paused = false, blocked = false;
for (const q of queue) {
  if (Date.now() > DEADLINE) { paused = true; break; }
  const { slug } = q, name = names.get(slug) || slug, t = Date.now(), p0 = stats.pages;
  let st = loadState(slug);
  if (st && q.need === "refresh" && st.startedAt < index[slug]?.finished) st = null;   // state older than the current copy
  if (!st) st = { slug, startedAt: Date.now(), sc: "", rows: [], ids: new Set(), fmts: {}, done: {} };
  const meta = status.libraries[slug] || { attempts: 0 };
  let r;
  try {
    r = await crawlLibrary(slug, st);
    if (r.result === "done") r = await finishLibrary(slug, st, name, index);
  } catch (e) { saveState(st); r = e.blocked ? { result: "blocked", error: `the library gateway answered 403 (blocked) after ${stats.requests} requests this run` } : { result: "failed", error: e.message }; }
  const secs = ((Date.now() - t) / 1e3).toFixed(0);
  if (r.result === "done") {
    doneCount++; fs.rmSync(path.join(STATE, slug + ".json"), { force: true });
    status.libraries[slug] = { state: "copied", finished: index[slug]?.finished || Date.now(), total: r.total, name };
    if (!DRY) writeAtomic(idxPath, JSON.stringify({ ...index }));
    log(`ok     ${slug}: ${r.total} titles, ${(r.bytes / 1e6).toFixed(2)} MB gz, ${stats.pages - p0} pages, ${secs}s`);
  } else if (r.result === "paused") {
    const have = Object.entries(st.fmts).reduce((n, [f, v]) => n + st.done[f].size, 0), tot = Object.values(st.fmts).reduce((n, v) => n + v.pages, 0);
    status.libraries[slug] = { ...meta, state: "in progress", name, pagesDone: have, pagesKnown: tot, formatsKnown: Object.keys(st.fmts).length };
    log(`paused ${slug}: ${have} pages saved, will resume next run`);
    paused = true; break;
  } else if (r.result === "blocked") {
    blocked = true; failed++;
    status.libraries[slug] = { ...meta, state: "in progress, run blocked by the library gateway", name, error: r.error, blockedAt: new Date().toISOString() };
    log(`::error::BLOCKED while copying ${slug}: ${r.error}. Progress is saved; stopping this run.`);
    break;
  } else {
    failed++;
    status.libraries[slug] = { state: "failing", name, attempts: (meta.attempts || 0) + 1, lastFailAt: Date.now(), error: r.error };
    log(`::error::${slug} failed (attempt ${(meta.attempts || 0) + 1}): ${r.error}`);
  }
}
for (const s of waiting) status.libraries[s] = { ...status.libraries[s], state: "waiting after failures" };
writeStatus(failed);
log(`summary: ${doneCount} copied, ${failed} failed, ${paused ? "paused at time budget" : "queue finished"}, ${stats.pages} pages in ${((Date.now() - T0) / 6e4).toFixed(1)} min, ${stats.retries} retries, ${stats.http429} x 429, ${stats.http403} x 403, ${stats.http5xx} x 5xx, ${stats.timeouts} timeouts`);
process.exit(blocked ? 5 : failed ? 4 : 0);

function writeStatus(failedCount) {
  if (DRY) return;
  const secs = (Date.now() - T0) / 1e3;
  status.updated = new Date().toISOString();
  status.lastRun = { pages: stats.pages, requests: stats.requests, http403: stats.http403, rate: RATE, seconds: Math.round(secs), pagesPerSecond: secs > 5 ? +(stats.pages / secs).toFixed(2) : null, retries: stats.retries, http429: stats.http429, http5xx: stats.http5xx, timeouts: stats.timeouts, parallel: PAR, failed: failedCount };
  writeAtomic(statusPath, JSON.stringify(status));
  writeAtomic(idxPath, JSON.stringify(index));
}
