// Koha reader (Koha 22+ with the public REST API on: system preference RESTPublicAPI).
// Reads items, not searches: GET {base}/api/v1/public/items?q=<item types>&_per_page=1000 with the header
// "x-koha-embed: biblio" answers 1,000 items with their title record, in one JSON list. Many Koha catalogs put their
// search pages behind a bot gate (Chautauqua's answers 429 "Please try again | Library access") but publish this API;
// a library that turns RESTPublicAPI off answers 401/403 and the reader stops, it never tries the search pages.
// Formats: the library's own item type codes, found from their names ("Blu-ray", "New DVD", "Video Game"). Many
// libraries file Blu-rays under a DVD item type: those rows are moved to Blu-ray when the call number, title or
// edition says Blu-ray. One row per title record (biblio_id); a title is on the shelf when any of its copies is.
export const system = "koha";
const PAGE = 1000;   // measured on catalog.cclsny.org 11.25.26: 1,000 honoured, ~16 s per page with the title embedded

export function libFromUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { try { u = new URL("https://" + String(url).trim()); } catch { return null; } }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  const host = u.hostname.toLowerCase();
  // one library of a shared catalog: ?branch=X, ?limit=branch:X or ?multibranchlimit is not one library
  const lim = [u.searchParams.get("branch"), ...u.searchParams.getAll("limit").map(l => (l.match(/^(?:homebranch|holdingbranch|branch):(.+)$/i) || [])[1])]
    .find(x => x && /^[A-Za-z0-9_-]{1,20}$/.test(x)) || "";
  const id = ("koha." + host + (lim ? "_" + lim.toLowerCase() : "")).replace(/[^a-z0-9._-]/g, "-");
  return { id, host, base: "https://" + u.host.toLowerCase() };
}

const branchOf = (lib) => lib.id.split("_").slice(1).join("_");
export function recordTemplate(lib) { return lib.base + "/cgi-bin/koha/opac-detail.pl?biblionumber={id}"; }

const enc = (q) => encodeURIComponent(JSON.stringify(q));
async function api(lib, path, ctx, embed) {
  const res = await ctx.fetch(lib.base + "/api/v1" + path, { headers: { accept: "application/json", ...(embed ? { "x-koha-embed": embed } : {}) } });
  if (res.status === 401 || res.status === 403 || res.status === 404) {
    const e = new Error(`public API answered ${res.status}: the library has RESTPublicAPI off or the API blocked`);
    e.permanent = true; throw e;
  }
  if (res.status >= 400) throw new Error("HTTP " + res.status + " " + path.split("?")[0]);
  if (!/json/i.test(res.headers.get("content-type") || "")) {
    const e = new Error("public API did not answer JSON (bot gate or not Koha)"); e.permanent = true; throw e;
  }
  return { list: await res.json(), total: +(res.headers.get("x-total-count") || 0) };
}

// ---- one library of a shared catalog (CCLS: 30+ member libraries in one Koha)
const BRANCH = new Map();
async function branchCode(lib, ctx) {
  const want = branchOf(lib);
  if (!want) return "";
  if (BRANCH.has(lib.id)) return BRANCH.get(lib.id);
  const { list } = await api(lib, "/public/libraries?_per_page=1000", ctx);
  const hit = list.find(l => String(l.library_id).toLowerCase() === want);
  if (!hit) { const e = new Error(`no library ${want} in this catalog`); e.permanent = true; throw e; }
  BRANCH.set(lib.id, hit.library_id);
  return hit.library_id;
}
export async function libraryName(lib, ctx) {
  const b = await branchCode(lib, ctx);
  const { list } = await api(lib, "/public/libraries?_per_page=1000", ctx);
  if (b) return list.find(l => l.library_id === b)?.name || "";
  return list.length === 1 ? list[0].name || "" : "";
}

// ---- formats: find the item type codes by name. Each probe names one new code (NOT IN the ones found), so a
// catalog with 6 video types costs about 8 small requests.
const LIKE = ["%DVD%", "%BLU%", "%BD%", "%BR%", "%VID%", "%GAME%", "%MOV%", "%FILM%", "%DVR%", "%4K%", "%UHD%", "%CONSOLE%"];
function kind(code, name) {
  const s = (code + " " + (name || "")).toLowerCase();
  if (/board|card game|table ?top|puzzle|vhs|cassette|book|audio|music|\bcd\b|kit|equipment|player|projector|console only|laptop|hotspot|launchpad|playaway/.test(s) && !/video ?game/.test(s)) return "";
  if (/video ?game|\bgames?\b.*(switch|xbox|playstation|ps\d|wii|nintendo)|(switch|xbox|playstation|wii|nintendo)/.test(s)) return "g";
  if (/blu|\bbd\b|\bbr\b|bluray|4k|uhd/.test(s)) return "b";
  if (/dvd|video|movie|film|\bdvr\b/.test(s)) return "d";
  return "";
}
const TYPES = new Map();
async function types(lib, ctx) {
  if (TYPES.has(lib.id)) return TYPES.get(lib.id);
  const found = new Map();   // code -> format
  for (let i = 0; i < 30; i++) {
    const q = { "-or": LIKE.map(p => ({ item_type_id: { "-like": p } })) };
    if (found.size) q.item_type_id = { "-not_in": [...found.keys()] };
    const { list } = await api(lib, "/public/items?_per_page=1&q=" + enc(q), ctx, "+strings");
    if (!list.length) break;
    const it = list[0];
    found.set(it.item_type_id, kind(it.item_type_id, it._strings?.item_type_id?.str));
    ctx.log(`  koha ${lib.host}: item type ${it.item_type_id} "${it._strings?.item_type_id?.str || ""}" -> ${found.get(it.item_type_id) || "skipped"}`);
  }
  const out = { b: [], d: [], g: [] };
  for (const [c, f] of found) if (f) out[f].push(c);
  TYPES.set(lib.id, out);
  return out;
}
async function filter(lib, codes, ctx) {
  const q = { item_type_id: codes, withdrawn: 0, lost_status: 0 };
  const b = await branchCode(lib, ctx);
  if (b) q.home_library_id = b;
  return q;
}

export async function plan(lib, ctx) {
  const t = await types(lib, ctx), out = [];
  for (const f of ["b", "d", "g"]) {   // Blu-ray codes first: the copier keeps the first row for a title
    if (!t[f].length) continue;
    const q = await filter(lib, t[f], ctx);
    const { total } = await api(lib, "/public/items?_per_page=1&q=" + enc(q), ctx);
    // count: titles are unknown until read (a title has a copy at each member library: CCLS 79,788 items = 31,343
    // titles), and the copier checks titles against count, so 0 = unknown. items is for the log.
    if (total) out.push({ f, pages: Math.ceil(total / PAGE), count: 0, items: total, q });
  }
  return out;
}

// ---- rows
const BLU = /\bblu[- ]?ray\b|\b4k\b|\buhd\b/i;
const PLAT = [[/switch 2/i, "Switch 2"], [/switch/i, "Switch"], [/playstation ?5|\bps5\b/i, "PS5"], [/playstation ?4|\bps4\b/i, "PS4"],
  [/playstation ?3|\bps3\b/i, "PS3"], [/xbox series/i, "Xbox Series X"], [/xbox one/i, "Xbox One"], [/xbox 360/i, "Xbox 360"],
  [/\bwii u\b/i, "Wii U"], [/\bwii\b/i, "Wii"], [/\b3ds\b/i, "3DS"], [/\bnintendo ds\b/i, "DS"]];
const clean = (s) => String(s || "").replace(/\s*\[[^\]]*\]/g, "").replace(/\s*[\/:;=,.]+\s*$/, "").replace(/\s+/g, " ").trim();
function isbn10(raw) {
  const s = String(raw || "").split(/[\s|(]/)[0].replace(/-/g, "");
  if (/^\d{9}[\dX]$/i.test(s)) return s.toUpperCase();
  if (/^97[89]\d{10}$/.test(s)) { const b = s.slice(3, 12); let t = 0; for (let i = 0; i < 9; i++) t += (10 - i) * +b[i]; const c = (11 - (t % 11)) % 11; return b + (c === 10 ? "X" : c); }
  return "";
}
const onShelf = (it) => !it.checked_out_date && !+it.not_for_loan_status && !+it.effective_not_for_loan_status && !+it.damaged_status && !+it.lost_status && !+it.withdrawn;

export async function page(lib, task, n, ctx) {
  const q = task.q || (await plan(lib, ctx)).find(t => t.f === task.f)?.q;
  if (!q) return [];
  const { list } = await api(lib, `/public/items?_per_page=${PAGE}&_page=${n}&_order_by=%2Bme.biblio_id&_order_by=%2Bme.item_id&q=` + enc(q), ctx, "biblio");
  const by = new Map();
  for (const it of list) {
    const b = it.biblio; if (!b || !b.title) continue;
    let r = by.get(it.biblio_id);
    if (!r) {
      const hay = [it.callnumber, b.title, b.subtitle, b.part_name, b.edition_statement, b.medium].join(" ");
      let f = task.f;
      if (f === "d" && BLU.test(hay)) f = "b";
      let plat = "";
      if (f === "g") for (const [re, p] of PLAT) if (re.test(hay + " " + (b.notes || ""))) { plat = p; break; }
      const i10 = isbn10(b.isbn);
      r = { id: String(it.biblio_id), title: clean(b.title), sub: clean([b.subtitle, b.part_number, b.part_name].filter(Boolean).join(" ")), f,
        disc: +b.copyright_date || +b.publication_year || 0, cover: i10 ? `https://images-na.ssl-images-amazon.com/images/P/${i10}.01.MZZZZZZZ.jpg` : "",
        avail: 0, holds: 0, subj: "", plat };
      by.set(it.biblio_id, r);
    } else if (r.f === "d" && BLU.test(it.callnumber || "")) r.f = "b";
    if (onShelf(it)) r.avail = 1;
  }
  return [...by.values()].filter(r => r.title);
}
