// CARL (TLC) LS2 PAC / "CARL.Connect Discovery" reader. POST JSON to <base>/search.
export const system = "carl";

export function libFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  const host = u.hostname.toLowerCase();
  return { id: "carl." + host.replace(/[^a-z0-9._-]/g, "-"), host, base: u.origin };
}

const PAGE = 50; // 200 is honoured too but costs 4x the time per request, so no gain
const GAME = /game|playstation|ps[2-5]\b|xbox|nintendo|switch|\bwii/i;

async function search(lib, ctx, term, startIndex, hits, filters = []) {
  const body = JSON.stringify({
    searchTerm: term, hitsPerPage: hits, startIndex, facetFilters: filters, branchFilters: [],
    sortCriteria: "Title", dbCodes: [],
  });
  const r = await ctx.fetch(lib.base + "/search", {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8", accept: "application/json" },
    body,
  });
  if (!r.ok) throw new Error("carl search " + r.status);
  const txt = await r.text();
  try { return JSON.parse(txt); } catch { throw new Error("carl: not JSON: " + txt.slice(0, 120)); }
}

function kind(fmt) {
  const f = String(fmt || "");
  if (/blu|uhd|4k/i.test(f)) return "b";
  if (/dvd/i.test(f)) return "d";
  if (GAME.test(f)) return "g";
  return "";
}

// Disc search term: LS2 PAC has no "match all" or format qualifier; "dvd" hits every DVD/Blu-ray (subject
// "DVDs"/"Blu-ray DVDs" + call number). Each resource carries its own `format`, so we classify per row.
export async function plan(lib, ctx) {
  const d = await search(lib, ctx, "dvd", 0, 1);
  const out = [];
  const total = d.totalHits || 0;
  // one entry; page() returns both DVD and Blu-ray rows from the same stream (rows carry their own f)
  if (total) out.push({ f: "d", pages: Math.ceil(total / PAGE), count: total, q: "dvd", note: "rows include f:b too" });
  const g = await search(lib, ctx, "video game", 0, 20);
  const gn = (g.resources || []).filter(r => kind(r.format) === "g").length;
  if (gn >= 3) out.push({ f: "g", pages: Math.ceil((g.totalHits || 0) / PAGE), count: g.totalHits || 0, q: "video game" });
  return out;
}

const clean = s => String(s || "").replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s*[\/:;,.]\s*$/, "").replace(/\s+/g, " ").trim();

export async function page(lib, task, n, ctx) {
  const d = await search(lib, ctx, task.q || "dvd", (n - 1) * PAGE, PAGE);
  const rows = [];
  for (const r of d.resources || []) {
    if (r.rtype && r.rtype !== 1) continue;
    const f = kind(r.format);
    if (!f) continue;
    if (task.f === "g" ? f !== "g" : f === "g") continue;
    const year = parseInt(r.publicationDate && r.publicationDate.publicationDate, 10) || 0;
    const avail = (r.holdingsInformations || []).some(h => h.onshelf && !h.hideFromPublic) ? 1 : 0;
    rows.push({
      id: String(r.id), title: clean(r.shortTitle), sub: "", f, disc: year, cover: "",
      avail, holds: 0, subj: r.mainSeries || "", plat: f === "g" ? String(r.format) : "",
    });
  }
  return rows;
}

export function recordTemplate(lib) {
  return lib.base + "/#section=resource&resourceid={id}&pageIndex=0&pageSize=10";
}

export async function libraryName(lib, ctx) { return null; }
