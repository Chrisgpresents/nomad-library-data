// SirsiDynix Enterprise reader for Nomad Library.
// Reads the normal HTML results page (ps = page size, rw = 0-based offset) and the AJAX availability call
// (search/results.displaypanel.any_0:loadavailability) the same page makes in a visitor's browser.
// No keys, no logins. Facets (Material Type / Format / ...) are discovered per library in plan().

export const system = "enterprise";

const PS = 100;          // page size (300 is honoured too, but availability URLs cap at ~100 ids)
const LANG = "en_US";

// ---------- library identity ----------
export function libFromUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { try { u = new URL("https://" + String(url).trim()); } catch { return null; } }
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean);
  const ci = segs.indexOf("client");
  let profile = "default";
  if (ci >= 0) {
    const r = segs.slice(ci + 1);
    if (r[0] === "rss" && r[1] === "hitlist" && r[2]) profile = r[2];
    else if (/^[a-z]{2}_[A-Z]{2}$/.test(r[0] || "") && r[1]) profile = r[1];
    else if (r[0] && !/^(assets|search|rss|ctx|custom|ws|css)$/i.test(r[0])) profile = r[0];
  } else if (!/\.ent\.sirsi\.net$|sirsi|enterprise/i.test(host) && !segs.length) {
    // bare host of a non-sirsi domain: still a possible Enterprise catalog, caller decides
  }
  profile = decodeURIComponent(profile).replace(/[^A-Za-z0-9._-]/g, "-");
  const id = `${system}.${host}_${profile.toLowerCase()}`.replace(/[^a-z0-9._-]/g, "-");
  return { id, host, base: `${u.origin}/client/${LANG}/${profile}`, profile };
}

// ---------- helpers ----------
async function getText(ctx, url, init) {
  const res = await ctx.fetch(url, init);
  if (res && res.ok === false) throw new Error(`HTTP ${res.status} for ${url}`);
  const t = await res.text();
  if (/<title>\s*Checking your connection/i.test(t)) throw new Error("bot wall (Checking your connection) at " + url);
  return t;
}
const unent = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
const strip = (s) => unent(String(s).replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

function parseFacets(html) {
  const out = [];
  const re = /navigatorclick\?qf=([^&"]*)[^"]*"[^>]*>[^<]*<\/a>\s*<\/span>\s*<div class="navigatorCount">\s*\(([\d,]+)\)/g;
  let m;
  while ((m = re.exec(html))) {
    const raw = m[1];
    let d;
    try { d = decodeURIComponent(unent(raw).replace(/\+/g, " ")).split("\t"); } catch { continue; }
    if (d.length < 4) continue;
    out.push({ name: d[0], title: d[1], code: d[2], label: d[3], qf: unent(raw), count: +m[2].replace(/,/g, "") });
  }
  return out;
}
function hitCount(html) {
  const m = html.match(/([\d,]+)\s+Results? Found/i) || html.match(/of\s+([\d,]+)\s+(?:Results|titles|items)/i);
  return m ? +m[1].replace(/,/g, "") : 0;
}
const qfOf = (p) => (p.qf ? "&qf=" + p.qf : "");
const searchUrl = (lib, p, rw, ps) =>
  `${lib.base}/search/results?qu=${p.qu ? encodeURIComponent(p.qu) : ""}${qfOf(p)}&ps=${ps}${rw ? "&rw=" + rw : ""}`;

// facet names we look inside for a format
const FACET_OK = /TYPE|FORMAT|ITEMCAT|MEDIA|COLLECTION|MATERIAL/i;
const FACET_NO = /^(ERC_FORMAT|EREADER)$|SERIES|SUBJECT|AUTHOR|GENRE|LANGUAGE|LIBRARY|LOCATION|PUBDATE/i;
const RE_BLU = /blu.?ray|\buhd\b|\b4k\b|ultra hd/i;
const RE_GAME = /video ?games?|^games?$|playstation|xbox|nintendo|\bwii\b|\bswitch\b|\bps[2-5]\b|\b3ds\b|\bds\b|pc games?|gaming/i;
const RE_GAME_NO = /board|toys?|fun & games|playaway|self-playing|wonderbook|launchpad|equipment|console|e-?video|children'?s? category/i;
const RE_GAMEROW = /playstation|xbox|nintendo|\bwii\b|\bps[2-5]\b|\b3ds\b|computer (?:chip )?cartridge/i;
const RE_DVD = /\bdvd/i;
const RE_DVD_NO = /blu|player|ppr|public performance|^1:/i;

function platOf(label) {
  const s = label.toLowerCase();
  if (/switch ?2/.test(s)) return "Switch 2";
  if (/switch/.test(s)) return "Switch";
  if (/wii ?u/.test(s)) return "Wii U";
  if (/wii/.test(s)) return "Wii";
  if (/3ds/.test(s)) return "3DS";
  if (/\bds\b/.test(s)) return "DS";
  if (/(playstation|ps) ?5/.test(s)) return "PS5";
  if (/(playstation|ps) ?4/.test(s)) return "PS4";
  if (/(playstation|ps) ?3/.test(s)) return "PS3";
  if (/(playstation|ps) ?2/.test(s)) return "PS2";
  if (/xbox ?(series|x)|xboxx/.test(s)) return "Xbox Series X";
  if (/xbox ?(one|1)/.test(s)) return "Xbox One";
  if (/xbox ?360/.test(s)) return "Xbox 360";
  if (/xbox/.test(s)) return "Xbox";
  if (/\bpc\b/.test(s)) return "PC";
  return "";
}

// choose the facet whose matching values cover a format best
function pick(facets, test, minPick) {
  const byName = new Map();
  for (const f of facets) {
    if (!FACET_OK.test(f.name) || FACET_NO.test(f.name)) continue;
    if (!test(f)) continue;
    if (!byName.has(f.name)) byName.set(f.name, []);
    byName.get(f.name).push(f);
  }
  let best = null, bestTot = 0;
  for (const [, list] of byName) {
    const tot = list.reduce((a, f) => a + f.count, 0);
    if (!best || tot > bestTot * 1.1 || (tot >= bestTot * 0.9 && list.length < best.length)) { best = list; bestTot = tot; }
  }
  return best && bestTot >= (minPick || 1) ? best : null;
}

// ---------- plan ----------
export async function plan(lib, ctx) {
  let html = await getText(ctx, `${lib.base}/search/results?qu=&ps=2`);
  let facets = parseFacets(html);
  if (!facets.length && lib.profile === "default") {
    // a bare address (no /client/en_US/<profile>): the site's front door redirects to its real profile
    const r = await ctx.fetch(new URL(lib.base).origin + "/");
    const m = String(r.url || "").match(/\/client\/([a-z]{2}_[A-Z]{2})\/([^/?#]+)/);
    if (m && m[2] !== "default") {
      lib.base = `${new URL(lib.base).origin}/client/${m[1]}/${m[2]}`;
      html = await getText(ctx, `${lib.base}/search/results?qu=&ps=2`);
      facets = parseFacets(html);
    }
  }
  if (!facets.length) throw new Error("no facets found on " + lib.base);
  const gamesF = pick(facets, (f) => RE_GAME.test(f.label) && !RE_GAME_NO.test(f.label));
  // ITEMCAT* facets are per-copy tags that libraries use loosely (junk like books tagged "Blu-ray"), so try them last.
  const noCat = (f) => !/^ITEMCAT/i.test(f.name);
  let dvdF = pick(facets, (f) => noCat(f) && RE_DVD.test(f.label) && !RE_DVD_NO.test(f.label));
  let mixed = false; // DVD set also holds Blu-rays/games (no clean facet) -> split by title text
  if (!dvdF) {
    dvdF = pick(facets, (f) => /^video ?disc$/i.test(f.label) && f.name === "FORMAT");
    mixed = true;
  }
  if (!dvdF) dvdF = pick(facets, (f) => RE_DVD.test(f.label) && !RE_DVD_NO.test(f.label));
  // one facet set for both ("DVD / Blu-ray / Video Rated R"): read it as the DVD set, Blu-rays split out by title text
  if (!dvdF) { dvdF = pick(facets, (f) => RE_DVD.test(f.label) && RE_BLU.test(f.label) && !/player|ppr|public performance/i.test(f.label)); if (dvdF) mixed = true; }
  let bluF = pick(facets, (f) => noCat(f) && RE_BLU.test(f.label));
  if (!bluF && !dvdF) bluF = pick(facets, (f) => RE_BLU.test(f.label));
  if (!bluF) mixed = true;
  const out = [];
  const add = (f, parts) => {
    parts = parts.filter((p) => p.count > 0);
    const count = parts.reduce((a, p) => a + p.count, 0);
    if (!count) return;
    let pages = 0;
    for (const p of parts) { p.pages = Math.ceil(p.count / PS); p.start = pages; pages += p.pages; }
    out.push({ f, pages, count, parts, mixed });
  };
  const partOf = (v, extra) => ({ qf: v.qf, count: v.count, label: v.label, ...extra });
  if (dvdF) add("d", dvdF.map((v) => partOf(v)));
  if (bluF) add("b", bluF.map((v) => partOf(v)));
  else if (dvdF) {
    // no Blu-ray facet: Blu-rays sit inside the DVD/video-disc set; ask the search box for them
    const parts = [];
    for (const v of dvdF) {
      const p = partOf(v, { qu: "blu-ray" });
      const h = await getText(ctx, searchUrl(lib, p, 0, 2));
      p.count = hitCount(h);
      parts.push(p);
    }
    add("b", parts);
  }
  if (gamesF) add("g", gamesF.map((v) => partOf(v, { plat: platOf(v.label) })));
  if (!out.length) throw new Error("no DVD/Blu-ray/game format found in facets of " + lib.base);
  for (const t of out) t.base = lib.base;   // so page() reads the same profile
  return out;
}

// ---------- page ----------
function cleanTitle(t) {
  t = strip(t);
  t = t.replace(/\s*\[[^\]]*(?:videorecording|video ?recording|video ?disc|blu-?ray|dvd|4k|uhd|electronic resource|sound recording|game|playstation|xbox|nintendo|switch|wii|ps[2-5]|3ds|pc)[^\]]*\]/gi, "");
  t = t.replace(/\s*\((?:blu-?ray|dvd|4k|uhd|ultra hd|widescreen|full screen)[^)]*\)\s*$/i, "");
  t = t.replace(/\s*\/\s.*$/, "").replace(/\s*[\/:;,.\s]+$/, "").trim();
  return t;
}
function splitTitle(t) {
  // "Alien. Romulus" or "Alien : covenant" -> main/sub (first split only)
  const m = t.match(/^(.{2,}?)\s*(?::|\.\s)\s*(.+)$/);
  if (m) m[2] = m[2].replace(/^[\s:;.,\/-]+/, "");
  if (m && m[2].length > 1 && m[1].length > 3 && !/\b(dr|mr|mrs|ms|st|vs|jr|sr|no|vol|pt)$/i.test(m[1])) return [m[1].replace(/[.\s]+$/, ""), m[2]];
  return [t, ""];
}
function field(cell, cls) {
  const m = cell.match(new RegExp(`class="displayElementText[^"]*\\b${cls}"[^>]*>([\\s\\S]*?)</div>`));
  return m ? strip(m[1]) : "";
}

function parseCells(html) {
  const parts = html.split(/<div id="results_cell\d+"/).slice(1);
  const rows = [];
  for (const c0 of parts) {
    const c = c0.split(/<div class="cell_wrapper|<div aria-live="polite" class="hidden" id="otherResultsSection"/)[0];
    let idm = c.match(/value="ent:\/\/([A-Za-z0-9_]+)\/0\/\1:([^"]+)"/) ||
      c.match(/ent:\$002f\$002f([A-Za-z0-9_]+)\$002f0\$002f\1:([^\/?"&]+)/) ||
      c.match(/ent%3A%2F%2F([A-Za-z0-9_]+)%2F0%2F\1%3A([^%&"]+)/);
    if (!idm) continue;
    const src = idm[1], key = idm[2];
    if (src !== "SD_ILS") continue; // e-resources (OverDrive, Hoopla...) are not shelf discs
    const tag = c.match(/<a[^>]*id="detailLink\d+"[^>]*>([\s\S]*?)<\/a>/);
    const title = tag ? tag[1] : "";
    const edition = field(c, "EDITION");
    const pubm = c.match(/displayElementText[^"]*\bPUBDATE\w*"[^>]*>\s*([^<]*)</);
    const yr = pubm ? (pubm[1].match(/(19|20)\d\d/) || [])[0] : "";
    let cover = "";
    const cm = c.match(/View cover art[\s\S]*?href="([^"]+)"/);
    if (cm) cover = unent(cm[1]);
    else {
      const im = c.match(/<img[^>]*class="results_img"[^>]*src="([^"]+)"/) || c.match(/<img[^>]*src="([^"]+)"[^>]*class="results_img"/);
      if (im) cover = unent(im[1]);
    }
    if (cover.startsWith("//")) cover = "https:" + cover;
    if (cover.startsWith("http://")) cover = "https://" + cover.slice(7);
    const physical = field(c, "PHYSICAL_DESC");
    const subj = field(c, "SUBJECT") || field(c, "GENRE_TERM");
    rows.push({ key, title, edition, physical, yr: yr ? +yr : 0, cover, subj });
  }
  return rows;
}

async function availability(lib, ctx, keys) {
  if (!keys.length) return {};
  const body = JSON.stringify({ ILS: keys.map((k) => `ent://SD_ILS/0/SD_ILS:${k}`) });
  const enc = encodeURIComponent(body).replace(/%/g, "$00").replace(/\$003A/g, ":");
  // encodeURIComponent leaves !'()* alone; Tapestry decodes those fine
  const url = `${lib.base}/search/results.displaypanel.any_0:loadavailability/${enc}?ps=${PS}`;
  let t;
  try {
    t = await getText(ctx, url, { method: "POST", headers: { "X-Requested-With": "XMLHttpRequest", Accept: "application/json" }, body: "" });
    const arr = JSON.parse(t);
    const out = {};
    for (const a of arr) {
      const n = parseInt(a.availableCount, 10);
      if (!Number.isFinite(n) && out[a.titleId]) continue;
      const h = parseInt(a.holdCount, 10);
      out[a.titleId] = { avail: n > 0 ? 1 : 0, holds: Number.isFinite(h) ? h : 0 };
    }
    return out;
  } catch (e) {
    ctx.log && ctx.log("availability failed: " + e.message);
    return {};
  }
}

export async function page(lib, task, n, ctx) {
  if (task.base) lib.base = task.base;     // the profile plan() found behind a bare address
  let parts = task.parts;
  if (!parts) { // task lost its plan data: rebuild
    const again = (await plan(lib, ctx)).find((p) => p.f === task.f);
    if (!again) return [];
    parts = again.parts;
  }
  const p = parts.find((x) => n > x.start && n <= x.start + x.pages);
  if (!p) return [];
  const html = await getText(ctx, searchUrl(lib, p, (n - p.start - 1) * PS, PS));
  const cells = parseCells(html);
  const av = await availability(lib, ctx, cells.map((c) => c.key));
  const rows = [];
  const seen = new Set();
  for (const c of cells) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    const hay = `${c.title} ${c.edition}`;
    if (task.f !== "g" && RE_GAMEROW.test(`${c.edition} ${c.physical}`)) continue; // game cartridge/disc inside a video set
    if (task.mixed && task.f === "d" && RE_BLU.test(hay)) continue;          // Blu-ray inside the DVD set
    if (task.mixed && task.f === "b" && !RE_BLU.test(hay)) continue;         // search hit that is not a Blu-ray
    const [title, sub] = splitTitle(cleanTitle(c.title));
    if (!title) continue;
    const a = av[c.key] || { avail: 0, holds: 0 };
    rows.push({
      id: c.key.toLowerCase().replace(/[^a-z0-9._-]/g, "-"),
      title, sub, f: task.f, disc: c.yr, cover: c.cover,
      avail: a.avail, holds: a.holds, subj: c.subj, plat: task.f === "g" ? (p.plat || platOf(`${(c.title.match(/\[[^\]]*\]/g) || []).join(" ")} ${c.edition} ${c.physical}`)) : "",
    });
  }
  return rows;
}

export function recordTemplate(lib) {
  return `${lib.base}/search/detailnonmodal/ent:$002f$002fSD_ILS$002f0$002fSD_ILS:{id}/one`;
}

export async function libraryName(lib, ctx) {
  try {
    const t = await getText(ctx, lib.base);
    const m = t.match(/<title>([^<]*)<\/title>/i);
    let s = m ? strip(m[1]) : "";
    s = s.replace(/\s*[-|:]?\s*(online )?(library )?catalog(ue)?( search)?\s*$/i, (x, a, b) => (b ? " Library" : "")).trim();
    if (!s || s.toUpperCase() === lib.profile.toUpperCase() || /^default|checking|search results|sirsi|enterprise|csplus|home$/i.test(s)) return null;
    return s;
  } catch { return null; }
}
