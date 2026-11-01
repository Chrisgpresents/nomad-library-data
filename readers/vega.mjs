// Vega Discover (Innovative / Clarivate, *.iiivega.com). Open JSON, no key: the same calls the library's own site makes.
// Measured 11.1.26 on San Diego: pageSize 1000 is honoured (2.4 s, 3.4 MB), so 45k discs = ~45 requests.
export const system = "vega";

const UID = "6e1a3c4b-8f2d-4c9a-9b7e-2d5f0a1c3e7b";   // Vega wants an anonymous visitor id; any uuid works
const PAGE = 1000;
const hdr = (h, v) => ({ "content-type": "application/json", accept: "application/json", "api-version": v,
  "iii-customer-domain": h, "iii-host-domain": h, "anonymous-user-id": UID });

export function libFromUrl(url) {
  let u; try { u = new URL(/^https?:/i.test(url) ? url : "https://" + url); } catch { return null; }
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9-]+\.[a-z0-9]+\.iiivega\.com$/.test(host)) return null;   // custom domains are resolved to this address by the site
  return { id: "vega." + host, host, base: "https://" + host };
}

// Material codes are the library's own (Sierra material types), so read them and sort them into formats.
async function formats(lib, ctx) {
  const r = await ctx.fetch(`${lib.base}/api/customization/material-types`, { headers: hdr(lib.host, "1") });
  const list = await r.json();
  const out = { b: [], d: [], g: [] };
  for (const m of list) {
    const d = String(m.description || "").toLowerCase();
    if (/book|stream|download|tape|vhs|laser|player|equipment|device|kit/.test(d)) continue;   // "Book + DVD", players, streaming
    if (/video ?game|console/.test(d)) out.g.push(m.code);
    else if (/blu-?ray|4k|uhd/.test(d)) out.b.push(m.code);
    else if (/\bdvd\b/.test(d)) out.d.push(m.code);
  }
  return out;
}

async function search(lib, ctx, task, pageNum, pageSize) {
  const body = { searchText: "*", searchType: "everything", pageNum, pageSize, resourceType: "FormatGroup",
    materialTypeIds: task.codes, sorting: "title", sortOrder: "asc" };   // title order pages cleanly; date order repeats ties across pages (measured 11.1.26)
  if (task.from) { body.dateFrom = String(task.from); body.dateTo = String(task.to); }
  const r = await ctx.fetch(`${lib.base}/api/search-result/search/format-groups`, { method: "POST", headers: hdr(lib.host, "2"), body: JSON.stringify(body) });
  const d = await r.json();
  if (!Array.isArray(d?.data)) throw new Error("Vega answered without a result list");
  return d;
}
const count = async (lib, ctx, task) => (await search(lib, ctx, task, 0, 1)).totalResults || 0;

// Vega (Elasticsearch) stops at result 10,000, so a big format is split into publication-year ranges that each fit.
const WINDOW = 9500, Y0 = 1880, Y1 = new Date().getFullYear() + 1;
async function slices(lib, ctx, f, codes, from, to, out) {
  const n = await count(lib, ctx, { codes, from, to });
  if (!n) return;
  if (n <= WINDOW || from === to) { out.push({ key: `${f}${from}-${to}`, f, codes, from, to, count: n, pages: Math.ceil(Math.min(n, 10000) / PAGE) }); return; }
  const mid = Math.floor((from + to) / 2);
  await slices(lib, ctx, f, codes, from, mid, out);
  await slices(lib, ctx, f, codes, mid + 1, to, out);
}

export async function plan(lib, ctx) {
  const F = await formats(lib, ctx);
  const out = [];
  for (const f of ["b", "d", "g"]) {
    if (!F[f].length) continue;
    const total = await count(lib, ctx, { codes: F[f] });
    if (!total) continue;
    if (total <= WINDOW) { out.push({ key: f, f, codes: F[f], count: total, pages: Math.ceil(total / PAGE) }); continue; }
    const parts = [];
    await slices(lib, ctx, f, F[f], Y0, Y1, parts);
    const dated = parts.reduce((n, t) => n + t.count, 0);
    if (dated < total * 0.97) ctx.log(`  vega ${lib.host} ${f}: year ranges hold ${dated} of ${total} (titles with no year are missed)`);
    out.push(...parts);
  }
  return out;
}

const clean = s => String(s || "").replace(/\s*\[(videorecording|video recording|electronic resource|game)\]\s*/gi, " ")
  .replace(/\s+\/\s.*$/, "").replace(/\s+/g, " ").trim().replace(/[.;,:/\s]+$/, "");
const yearOf = v => { const m = String(v || "").match(/(19|20)\d{2}/); return m ? +m[0] : 0; };
const LANG_OK = /^(eng|zxx|und|mul|)$/;

function cover(c) {
  const u = c?.medium || c?.large || c?.small || "";
  return u.replace(/&nicaption=[^&]*/i, "");
}

export async function page(lib, task, n, ctx) {
  const d = await search(lib, ctx, task, n - 1, PAGE);
  const want = new Set(task.codes);
  const rows = [];
  for (const g of d.data) {
    if (!g?.id) continue;
    const tab = (g.materialTabs || []).find(t => (t.materialTypes || []).some(c => want.has(c))) || g.materialTabs?.[0] || {};
    const full = String(g.title || "");
    const i = full.indexOf(" : ");
    const title = clean(i > 0 ? full.slice(0, i) : full), sub = i > 0 ? clean(full.slice(i + 3)) : "";
    const ed = (tab.editions || [])[0] || {};
    const avail = tab.availability?.status?.general === "Available" || ed.availabilityStatus === "Available" ||
      (tab.locations || []).some(l => l.availabilityStatus === "Available");
    const subj = [LANG_OK.test(g.language || "") ? "" : "foreign films", tab.name || ""].filter(Boolean).join(" | ");
    rows.push({ id: g.id, title, sub, f: task.f, disc: yearOf(ed.publicationDate || g.publicationDate), cover: cover(tab.coverUrl || g.coverUrl),
      avail: avail ? 1 : 0, holds: 0, subj, plat: task.f === "g" ? [full, tab.callNumber].join(" ") : "" });
  }
  return rows;
}

export function recordTemplate(lib) { return `${lib.base}/search/card?id={id}&entityType=FormatGroup`; }

export async function libraryName(lib, ctx) {
  try {
    const r = await ctx.fetch(`${lib.base}/api/search-result/customer`, { headers: hdr(lib.host, "1") });
    const d = await r.json();
    return d?.name || d?.displayName || "";
  } catch { return ""; }
}
