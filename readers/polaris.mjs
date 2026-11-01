// Polaris PowerPAC reader (classic PowerPAC 7/8 on /polaris/ and *.polarislibrary.com hosts).
// Flow per format: GET search/searchresults.aspx (302, sets session cookie) -> GET process.search (runs the search,
// 302) -> GET search/components/ajaxResults.aspx?page=N&hpp=100 (HTML list of 100 brief records, session based).
export const system = "polaris";
const PAGE = 100; // hpp values offered by the PAC: 10,20,30,50,100. Anything higher is ignored (falls back to 10).

export function libFromUrl(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { try { u = new URL("https://" + String(url).trim()); } catch { return null; } }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  const host = u.hostname.toLowerCase();
  const m = u.pathname.match(/^(.*?\/polaris)(\/|$)/i);
  // hosted PowerPAC (*.polarislibrary.com) lives under /polaris; a bare host link (no path) means that
  const base = u.origin.toLowerCase() + (m ? m[1] : /^\/?$/.test(u.pathname) || /\.polarislibrary\.com$/i.test(u.hostname) ? "/polaris" : "");   // a bare host means the usual /polaris path
  const ctx = (u.searchParams.get("ctx") || "").toLowerCase();
  const scope = /^[0-9.]+$/.test(ctx) ? ctx.replace(/\./g, "-") : "";
  const id = "polaris." + host + (m && m[1].length > 8 ? "" : "") + (scope ? "_" + scope : "");
  return { id: id.replace(/[^a-z0-9._-]/g, "-"), host, base };
}

const ctxOf = (lib) => { const s = lib.id.split("_")[1]; return s ? s.replace(/-/g, ".") : ""; };
const ctxQ = (lib) => (ctxOf(lib) ? "ctx=" + ctxOf(lib) + "&" : "");

export function recordTemplate(lib) { return lib.base + "/search/title.aspx?" + ctxQ(lib) + "cn={id}"; }

// ---- session handling (cookies kept by hand; redirects followed by hand)
const sessions = new Map();
function cookiesFrom(res, jar) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get("set-cookie") || "").split(/,(?=\s*[\w.-]+=)/);
  for (const c of list) { const kv = c.split(";")[0].trim(); const i = kv.indexOf("="); if (i > 0) jar[kv.slice(0, i)] = kv.slice(i + 1); }
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
async function hop(ctx, url, jar, extra = {}) {
  let cur = url;
  for (let i = 0; i < 6; i++) {
    const res = await ctx.fetch(cur, { redirect: "manual", headers: { cookie: cookieHeader(jar), accept: "text/html", ...extra } });
    cookiesFrom(res, jar);
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      cur = new URL(res.headers.get("location"), cur).href;
      if (/process\.search/i.test(cur) || i === 0) continue; // run the search, then stop
      return null;
    }
    if (res.status >= 400) throw new Error("HTTP " + res.status + " " + cur);
    return res;
  }
  return null;
}
function searchUrl(lib, limit, sort) {
  return lib.base + "/search/searchresults.aspx?" + ctxQ(lib) + "type=Advanced&term=*&by=KW&sort=" + sort + "&page=0&limit=" + encodeURIComponent(limit).replace(/%3D/g, "=");
}
async function openSearch(lib, limit, ctx, sort) {
  const jar = {};
  // hop 1 gives the cookie + redirect to process.search; hop 2 runs the search (we do not need its html page)
  let url = searchUrl(lib, limit, sort);
  for (let i = 0; i < 4; i++) {
    const res = await ctx.fetch(url, { redirect: "manual", headers: { cookie: cookieHeader(jar), accept: "text/html" } });
    cookiesFrom(res, jar);
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      url = new URL(loc, url).href;
      if (/process\.search/i.test(url)) continue;
      break; // redirect back to searchresults.aspx: search is stored in the session now
    }
    if (res.status >= 400) throw new Error("HTTP " + res.status + " " + url);
    break;
  }
  return jar;
}
const r_isCap = (t) => t >= 10000 && t % 10000 === 0; // a list cut at the retrieval limit reports exactly 10000 (or 100000)
async function results(lib, limit, n, ctx, fresh, sort = "PD") {
  const key = lib.id + "|" + limit + "|" + sort;
  let jar = !fresh && sessions.get(key);
  if (!jar) { jar = await openSearch(lib, limit, ctx, sort); sessions.set(key, jar); }
  const res = await ctx.fetch(lib.base + "/search/components/ajaxResults.aspx?page=" + n + "&hpp=" + PAGE,
    { headers: { cookie: cookieHeader(jar), accept: "text/html", "x-requested-with": "XMLHttpRequest" } });
  if (res.status >= 400) throw new Error("HTTP " + res.status + " ajaxResults");
  const html = await res.text();
  const m = html.match(/result-count">\s*(?:\d[\d,]*)\s*-\s*(?:\d[\d,]*)\s*of\s*([\d,]+)/i);
  if (!m) {
    if (!/title\.aspx\?[^"]*\bcn=\d+/i.test(html) && html.length < 20000 && fresh) return { html, total: 0 }; // zero hits answers a bare fragment
    if (!fresh) return results(lib, limit, n, ctx, true, sort); // session expired
    throw new Error("no result list in answer (" + html.length + " bytes): " + html.replace(/\s+/g, " ").slice(0, 400));
  }
  return { html, total: +m[1].replace(/,/g, ""), partial: r_isCap(+m[1].replace(/,/g, "")) };
}

// ---- formats
const LIMIT_CACHE = new Map();
async function limits(lib, ctx) {
  if (LIMIT_CACHE.has(lib.id)) return LIMIT_CACHE.get(lib.id);
  const res = await ctx.fetch(lib.base + "/search/default.aspx?" + ctxQ(lib) + "type=Advanced", { headers: { accept: "text/html" } });
  if (res.status >= 400) throw new Error("HTTP " + res.status + " advanced search page");
  const html = await res.text();
  const out = { b: [], d: [], g: [] };
  for (const m of html.matchAll(/<option[^>]*value="TOM=([a-z0-9]{2,4})"[^>]*>\s*([^<]*)/gi)) {
    const code = m[1].toLowerCase(), label = m[2].replace(/^[-\s]+/, "").replace(/\s+/g, " ").trim();
    if (/blu/i.test(label) && !/\band\b.*dvd|dvd.*\band\b/i.test(label)) out.b.push(code);
    else if (/^dvd$/i.test(label)) out.d.push(code);
    else if (/video ?games?/i.test(label)) out.g.push(code);
  }
  const lim = {};
  for (const f of ["b", "d", "g"]) if (out[f].length) lim[f] = out[f].map((c) => "TOM=" + c); // one search per code ("OR" is not honoured everywhere)
  LIMIT_CACHE.set(lib.id, lim);
  return lim;
}

const PARTS = new Map();
async function partsOf(lib, f, ctx) {
  const key = lib.id + "|" + f;
  if (PARTS.has(key)) return PARTS.get(key);
  const lim = await limits(lib, ctx);
  const parts = [];
  for (const l of lim[f] || []) {
    const r = await results(lib, l, 1, ctx, true);
    if (!r.total) continue;
    parts.push({ lim: l, sort: "PD", pages: Math.ceil(r.total / PAGE), count: r.total });
    // The PAC stops a result list at its retrieval limit (10000 at some libraries, flagged "--partial"). Re-run the
    // same search under other sort orders: each shows a different first 10000, so the union reaches further.
    if (r.partial) for (const sort of ["TI", "CALL", "AU_PD"]) parts.push({ lim: l, sort, pages: Math.ceil(r.total / PAGE), count: r.total });
  }
  PARTS.set(key, parts);
  return parts;
}

export async function plan(lib, ctx) {
  const out = [];
  for (const f of ["b", "d", "g"]) {
    const parts = await partsOf(lib, f, ctx);
    if (parts.length) out.push({ f, pages: parts.reduce((a, p) => a + p.pages, 0), count: parts.reduce((a, p) => a + p.count, 0), parts });
  }
  return out;
}

const dec = (s) => s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/&#(\d+);/g, (_, c) => String.fromCharCode(+c));
const text = (s) => dec(s.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
const PLAT = [[/nintendo switch 2|switch 2/i, "Switch 2"], [/switch/i, "Switch"], [/playstation ?5|\bps5\b/i, "PS5"], [/playstation ?4|\bps4\b/i, "PS4"], [/playstation ?3|\bps3\b/i, "PS3"],
  [/xbox series/i, "Xbox Series X"], [/xbox one/i, "Xbox One"], [/xbox 360/i, "Xbox 360"], [/\bwii u\b/i, "Wii U"], [/\bwii\b/i, "Wii"], [/\b3ds\b/i, "3DS"], [/\bnintendo ds\b/i, "DS"], [/\bpc\b|windows/i, "PC"]];

function splitTitle(raw) {
  let t = raw.replace(/\s*\[[^\]]*\]/g, "").replace(/\s+\/\s.*$/, "").replace(/\s*\/$/, "").trim();
  let sub = "";
  const i = t.search(/\s:\s|:\s/);
  if (i > 2) { sub = t.slice(i).replace(/^\s*:\s*/, ""); t = t.slice(0, i); }
  return [t.replace(/[\s.,;:]+$/, ""), sub.replace(/[\s.,;:/]+$/, "")];
}

export async function page(lib, task, n, ctx) {
  const parts = task.parts || (await partsOf(lib, task.f, ctx));
  let local = n, part = null;
  for (const p of parts) { if (local <= p.pages) { part = p; break; } local -= p.pages; }
  if (!part) return [];
  const { html } = await results(lib, part.lim, local, ctx, false, part.sort || "PD");
  const blocks = html.split(/<div class="search__position">/).slice(1);
  const rows = [];
  for (const b of blocks) {
    const cn = b.match(/title\.aspx\?[^"]*?\bcn=(\d+)/i);
    if (!cn) continue;
    const link = b.match(/<a class="nsm-brief-action-link"[^>]*>([\s\S]*?)<\/a>/i);
    const rawTitle = link ? text(link[1]) : "";
    if (!rawTitle) continue;
    const [title, sub] = splitTitle(rawTitle);
    let disc = 0;
    const pd = b.match(/Publisher, Date:[\s\S]*?nsm-short-item[^>]*>([\s\S]*?)<\/span>/i);
    const yrs = pd ? (text(pd[1]).match(/\b(19|20)\d\d\b/g) || []) : [];
    const py = b.match(/c-title-detail__pub-year">\s*(\d{4})/);
    if (yrs.length) disc = +yrs[0]; else if (py) disc = +py[1];
    if (disc > new Date().getFullYear() + 1 || disc < 1900) disc = 0; // catalogers' typos (2105, 9999)
    let cover = "";
    const im = b.match(/<img[^>]*id="hover_image_\d+"[^>]*src="([^"]+)"/i);
    if (im && !/upc=&|isbn=&upc=&issn=&/.test(im[1]) && !/nocover|blank|default/i.test(im[1])) cover = dec(im[1]);
    const hm = b.match(/nsm-e8">\s*(\d+)/);
    const am = b.match(/nsm-brief-label[^>]*>\s*(?:Local Availability|Available Copies[^<]*|Availability)\s*:[\s\S]{0,300}?nsm-brief-inline-subzone">\s*(\d+)\s*\(of/i);
    const sm = b.match(/Subject[^<]*<\/span>[\s\S]*?nsm-short-item[^>]*>([\s\S]*?)<\/span>\s*<\/div>/i);
    let plat = "";
    if (task.f === "g") { const hay = rawTitle + " " + text(b.match(/Call Number[\s\S]{0,300}/)?.[0] || ""); for (const [re, nm] of PLAT) if (re.test(hay)) { plat = nm; break; } }
    rows.push({ id: cn[1], title, sub, f: task.f, disc, cover, avail: am ? (+am[1] > 0 ? 1 : 0) : 0, holds: hm ? +hm[1] : 0, subj: sm ? text(sm[1]) : "", plat });
  }
  return rows;
}
