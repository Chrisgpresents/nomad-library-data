// Aspen Discovery reader. Public Search API: GET {base}/API/SearchAPI?method=search.
// Same grouped-work id covers every format of a title, so each format is its own task and Blu-ray is copied first
// (the copier keeps the first id). Shelf status is copied only when a record includes available_at; the default
// search fields omit it. A Cloudflare or Anubis page is a hard failure. This reader does not solve that wall.
export const system = "aspen";

const PAGE = 50;
const GAME = /game|playstation|\bps[2-5]\b|xbox|nintendo|switch|\bwii\b|game\s*boy|\b3ds\b/i;
const WALL = /cloudflare|anubis|just a moment|attention required|making sure you|proof.of.work|cf-browser-verification|cf-challenge/i;
const VENDOR = /^(aspendiscovery\.org|(help|community|dev)\.aspendiscovery\.org)$/;

export function libFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol) || !u.hostname.includes(".")) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  if (VENDOR.test(host)) return null;
  // Must match readerId() for system "aspen" in nomad-library public/catalog.js.
  const id = ("aspen." + host).replace(/[^a-z0-9._-]/g, "");
  if (!/^aspen\.[a-z0-9][a-z0-9.-]*$/.test(id)) return null;
  return { id, host, base: `${u.protocol}//${host}` };
}

function kind(label) {
  const f = String(label || "").replace(/^\d+#/, "");
  if (GAME.test(f)) return "g";
  if (/blu|uhd|\b4k\b/i.test(f)) return "b";
  if (/dvd/i.test(f)) return "d";
  return "";
}

const slug = s => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "x";

function searchUrl(lib, { page = 1, per = PAGE, field = "", label = "", lookfor = "*:*" } = {}) {
  const q = new URLSearchParams({
    method: "search", lookfor, searchIndex: "Keyword", searchSource: "local",
    pageSize: String(per), page: String(page), sort: "title",
  });
  if (field && label) q.append("filter[]", `${field}:"${label}"`);
  return `${lib.base}/API/SearchAPI?${q}`;
}

async function getJson(ctx, url) {
  const r = await ctx.fetch(url, { headers: { accept: "application/json" } });
  const txt = await r.text();
  if (r && r.ok === false) {
    // Some Aspen sites allowlist who may call the API. Say so without repeating the address they named.
    if (/API requests?\s+from\s+\S+\s+are forbidden/i.test(txt)) throw Object.assign(new Error("aspen catalog refused this address"), { permanent: true });
    const wall = r.status === 401 || r.status === 403 || WALL.test(txt);
    throw Object.assign(new Error(wall ? "aspen catalog answered with a bot wall" : "aspen search " + r.status), { permanent: r.status !== 429 && r.status < 500 });
  }
  const body = txt.trimStart();
  if (!body.startsWith("{") && !body.startsWith("[")) {
    if (WALL.test(body)) throw Object.assign(new Error("aspen catalog answered with a bot wall"), { permanent: true });
    throw new Error("aspen: not JSON");
  }
  try { return JSON.parse(body); } catch { throw new Error("aspen: not JSON"); }
}

function facetItems(set, name) {
  const list = set?.[name]?.list ?? set?.[name];
  if (!list) return [];
  return (Array.isArray(list) ? list : Object.values(list)).map(item => {
    const value = String(item?.value ?? item?.display ?? "").replace(/^\d+#/, "").replace(/\s+/g, " ").trim();
    return { value, count: +item?.count || 0 };
  }).filter(x => x.value && !x.value.includes('"') && x.value.length <= 80);
}

function formatField(set) {
  const names = Object.keys(set || {});
  if (names.includes("format")) return "format";
  return names.find(n => /^format_/.test(n) && !n.startsWith("format_category")) || "";
}

function pageSize(data) {
  const n = +data?.paging?.itemsPerPage;
  if (n >= 1 && n <= 200) return Math.min(PAGE, n);
  return PAGE;
}

async function probe(lib, ctx) {
  const first = await getJson(ctx, searchUrl(lib, { lookfor: "*:*" }));
  if (!first.parseError && ((+first.recordCount > 0) || first.facetSet)) return first;
  const second = await getJson(ctx, searchUrl(lib, { lookfor: "*" }));
  return second.parseError ? first : second;
}

export async function plan(lib, ctx) {
  const data = await probe(lib, ctx);
  const per = pageSize(data);
  const facets = data.facetSet || {};
  const field = formatField(facets);
  const specs = [];
  const push = (f, facet, label, count, classify) => {
    if (!f || !(count > 0)) return;
    specs.push({ f, field: facet, label, count, classify });
  };
  if (field) for (const item of facetItems(facets, field)) push(kind(item.value), field, item.value, item.count, false);
  if (!specs.length) {
    const cat = Object.keys(facets).find(n => n === "format_category" || n.startsWith("format_category_"));
    if (cat) for (const item of facetItems(facets, cat)) {
      const game = GAME.test(item.value), movie = /movie|video|film|dvd|blu/i.test(item.value);
      if (game || movie) push(game ? "g" : "d", cat, item.value, item.count, true);
    }
  }
  const rank = { b: 0, d: 1, g: 2 };
  specs.sort((a, b) => rank[a.f] - rank[b.f] || a.label.localeCompare(b.label));
  const seen = new Set();
  return specs.map(s => {
    let key = `${s.f}-${slug(s.label)}`;
    while (seen.has(key)) key += "x";
    seen.add(key);
    return { key, f: s.f, field: s.field, label: s.label, classify: s.classify, count: s.count, per, pages: Math.max(1, Math.ceil(s.count / per)) };
  });
}

const arr = v => v == null || v === "" ? [] : (Array.isArray(v) ? v : [v]);
const decode = s => String(s || "").replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
const clean = s => decode(s).replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+\/\s.*$/, "").replace(/\s+/g, " ").trim();

function yearOf(rec) {
  const src = arr(rec.publishDateSort).concat(arr(rec.publishDate)).join(" ");
  const now = new Date().getFullYear() + 1;
  const years = [...src.matchAll(/\b(19\d\d|20\d\d)\b/g)].map(m => +m[1]).filter(y => y >= 1900 && y <= now);
  return years.length ? Math.max(...years) : 0;
}

function subjects(rec) {
  const raw = arr(rec.topic_facet).length ? arr(rec.topic_facet) : arr(rec.subject_facet);
  const out = [];
  for (const s of raw) {
    const t = decode(s).replace(/^\d+#/, "").trim();
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= 8) break;
  }
  return out.join(" | ");
}

function toRow(lib, rec, task) {
  const id = String(rec.id || "").trim();
  if (!/^[A-Za-z0-9._-]+$/.test(id)) return null;
  const formats = arr(rec.format).map(x => decode(x).replace(/^\d+#/, ""));
  let f = task.classify ? "" : task.f;
  if (task.classify) {
    const kinds = formats.map(kind).filter(Boolean);
    f = task.f === "g" ? (kinds.includes("g") ? "g" : "") : (kinds.find(k => k === "b" || k === "d") || "");
  }
  if (!f) return null;
  let title = clean(rec.title_short || rec.title_display || rec.title || "");
  let sub = clean(rec.subtitle_display || "");
  if (!sub) {
    const i = title.indexOf(" : ");
    if (i > 0) { sub = title.slice(i + 3).replace(/[\s.:,]+$/, "").trim(); title = title.slice(0, i).trim(); }
  }
  title = title.replace(/[\s.:,]+$/, "");
  if (!title) return null;
  const avail = arr(rec.available_at).some(x => String(x).trim()) ? 1 : 0;
  const plat = f === "g" ? (formats.find(x => kind(x) === "g") || task.label || "") : "";
  return {
    id, title, sub, f, disc: yearOf(rec),
    cover: `${lib.base}/bookcover.php?id=${encodeURIComponent(id)}&size=medium&type=grouped_work`,
    avail, holds: Math.max(0, parseInt(rec.total_holds, 10) || 0), subj: subjects(rec), plat,
  };
}

export async function page(lib, task, n, ctx) {
  const data = await getJson(ctx, searchUrl(lib, { page: n, per: task.per || PAGE, field: task.field, label: task.label }));
  const records = data.recordSet || [];
  const rows = [];
  for (const rec of (Array.isArray(records) ? records : Object.values(records))) {
    const row = rec && toRow(lib, rec, task);
    if (row) rows.push(row);
  }
  return rows;
}

export function recordTemplate(lib) {
  return lib.base + "/GroupedWork/{id}";
}

export async function libraryName(lib, ctx) {
  try {
    const r = await ctx.fetch(lib.base + "/", { headers: { accept: "text/html" } });
    if (r?.ok === false) return "";
    const t = await r.text();
    const title = decode((t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "");
    if (!title || (WALL.test(t) && !/librar/i.test(title))) return "";
    const parts = title.split(/\s*[|·–—]\s*|\s+-\s+/);
    const hit = parts.find(p => /librar/i.test(p)) || (/librar/i.test(title) ? title : "");
    return hit.trim().slice(0, 80);
  } catch { return ""; }
}
