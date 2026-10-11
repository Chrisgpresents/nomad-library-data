// Copies each BiblioCommons library's movies and games into one static file per library.
//   node crawl.mjs --out out [--only slug,slug] [--budget-min 300] [--max-pages 9999]
// Runs on GitHub's computers (see .github/workflows/crawl.yml), never on a Cloudflare Worker.
// Output: out/snap/<slug>.json  (same shape the site always loaded)  +  out/snap/index.json
import fs from "node:fs";
import path from "node:path";

const SITE = "https://library.nomadovernormal.com";
const GW = "https://gateway.bibliocommons.com/v2/libraries";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const FMTS = [["BLURAY", "b"], ["DVD", "d"], ["VIDEO_GAME", "g"]];
const PARALLEL = 8, STALE_DAYS = 6;

const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = arg("out", "out"), ONLY = arg("only", ""), BUDGET = +arg("budget-min", 300) * 60e3, MAXP = +arg("max-pages", 1e9);
const T0 = Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms));

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

// One compact row per record, read by position on the site:
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

// ---- IMDb ratings: the same static shards the site already serves -----------------
const shards = new Map();
const shardKey = k => (k + "_").slice(0, 2).replace(/ /g, "_");
async function shard(k) {
  const s = shardKey(k);
  if (!shards.has(s)) shards.set(s, getJson(`${SITE}/ix/${s}.json`, 4).catch(() => ({})));
  return shards.get(s);
}
async function attachRatings(rows) {
  await Promise.all(rows.map(async r => {
    if (r[3] === "g") return;
    const k = norm(r[1]); if (!k) return;
    const sub = r[2].replace(/\s*\/.*$/, "").trim();
    const tail = [r[1].includes(":") ? r[1].split(":").slice(1).join(" ") : "", sub].join(" ").trim();
    let m = null;
    if (tail) { const k2 = normFull(r[1] + " " + sub); m = pick((await shard(k2))[k2], r[4], r[9]); }
    if (!m && (!tail || EDITION.test(tail))) m = pick((await shard(k))[k], r[4], r[9]);
    if (m) { r[11] = m[1]; r[12] = m[2]; r[13] = m[0]; r[14] = m[3] || 0; }
  }));
}

// ---- network ---------------------------------------------------------------------
async function getJson(url, tries = 4) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (r.ok) return await r.json();
      last = new Error(`${r.status} ${url}`);
      if (r.status === 404 || r.status === 400) break;
    } catch (e) { last = e; }
    await sleep(600 * (i + 1) ** 2);
  }
  throw last;
}
const pageUrl = (slug, fmt, n) => `${GW}/${slug}/bibs/search?query=*&searchType=bl&f_FORMAT=${fmt}&limit=25&page=${n}&sort=newly_acquired`;

function take(d, f, rows, seen, ids) {
  const bibs = d.entities?.bibs || {};
  for (const res of d.catalogSearch?.results || []) {
    const id = res.representative;
    if (bibs[id] && !ids.has(id)) { ids.add(id); rows.push(shape(id, bibs[id], f, seen)); }
  }
}

async function crawlLibrary(slug) {
  const rows = [], seen = { client: "" }, ids = new Set();
  let bad = 0, total = 0;
  for (const [fmt, f] of FMTS) {
    const first = await getJson(pageUrl(slug, fmt, 1));
    const pages = Math.min(first.catalogSearch?.pagination?.pages || 1, MAXP);
    take(first, f, rows, seen, ids);
    total += pages;
    for (let n = 2; n <= pages; n += PARALLEL) {
      if (Date.now() - T0 > BUDGET + 15 * 60e3) throw new Error("out of time");
      const batch = Array.from({ length: Math.min(PARALLEL, pages - n + 1) }, (_, i) => n + i);
      const got = await Promise.allSettled(batch.map(p => getJson(pageUrl(slug, fmt, p), 3)));
      for (const g of got) { if (g.status === "fulfilled") take(g.value, f, rows, seen, ids); else bad++; }
    }
  }
  if (bad > Math.max(3, total * 0.02)) throw new Error(`${bad} of ${total} pages failed`);
  await attachRatings(rows);
  return { rows, sc: seen.client };
}

// ---- main ------------------------------------------------------------------------
async function libraryList() {
  const map = new Map();
  for (const u of ["/libraries.json", "/api/libs"]) {
    try {
      const d = await getJson(SITE + u, 3);
      for (const x of d) { const [slug, name] = Array.isArray(x) ? x : [x.slug, x.name]; if (slug) map.set(slug, name || slug); }
    } catch (e) { console.log("list", u, "failed:", e.message); }
  }
  return map;
}

fs.mkdirSync(path.join(OUT, "snap"), { recursive: true });
const idxPath = path.join(OUT, "snap", "index.json");
const index = fs.existsSync(idxPath) ? JSON.parse(fs.readFileSync(idxPath, "utf8")) : {};
const all = await libraryList();
let want = ONLY ? ONLY.split(",") : [...all.keys()];
const stale = Date.now() - STALE_DAYS * 864e5;
want = want.filter(s => !index[s] || index[s].finished < stale || ONLY)
  .sort((a, b) => (index[a]?.finished || 0) - (index[b]?.finished || 0));
console.log(`${all.size} libraries known, ${want.length} to copy, ${Object.keys(index).length} already copied`);
if (!want.length) process.exit(3);

let done = 0, failed = 0;
for (const slug of want) {
  if (Date.now() - T0 > BUDGET) { console.log("time budget reached, the rest continue next run"); break; }
  const t = Date.now();
  try {
    const { rows, sc } = await crawlLibrary(slug);
    const prev = index[slug]?.total || 0;
    if (!rows.length || (prev && rows.length < prev * 0.5)) throw new Error(`only ${rows.length} titles (was ${prev}), keeping the old copy`);
    const finished = Date.now();
    const body = `{"ver":${finished},"finished":${finished},"total":${rows.length},"sc":${JSON.stringify(sc)},"rows":[${rows.map(r => JSON.stringify(r)).join(",")}]}`;
    fs.writeFileSync(path.join(OUT, "snap", slug + ".json.tmp"), body);
    fs.renameSync(path.join(OUT, "snap", slug + ".json.tmp"), path.join(OUT, "snap", slug + ".json"));
    index[slug] = { name: all.get(slug) || slug, finished, total: rows.length, bytes: body.length };
    fs.writeFileSync(idxPath, JSON.stringify(index));
    done++;
    console.log(`ok   ${slug}: ${rows.length} titles, ${(body.length / 1e6).toFixed(1)} MB, ${((Date.now() - t) / 1e3).toFixed(0)}s`);
  } catch (e) { failed++; console.log(`FAIL ${slug}: ${e.message}`); }
}
console.log(`done ${done}, failed ${failed}, ${((Date.now() - T0) / 6e4).toFixed(1)} min`);
