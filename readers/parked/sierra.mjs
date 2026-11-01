// Sierra / Millennium classic WebPAC reader. Search "*" limited by material type (m=), 50 per page, paging by start index in the URL.
export const system = "sierra";
const PER = 50;
export function libFromUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  let scope = u.searchParams.get("searchscope") || (u.pathname.match(/\/search~S(\d+)/) || [])[1] || "";
  if (!/^\d+$/.test(scope)) scope = "";
  const id = "sierra." + host + (scope && scope !== "1" ? "_s" + scope : "");
  return { id, host, base: "https://" + host, scope: scope || "1" };
}
const dec = s => s.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
async function getText(ctx, url) {
  const r = await ctx.fetch(url, { headers: { "user-agent": "Mozilla/5.0 NomadLibrary" } });
  if (r.ok === false) throw new Error("sierra " + r.status);
  return await r.text();
}
async function codes(lib, ctx) {
  if (lib._m) return lib._m;
  const t = await getText(ctx, `${lib.base}/search/X`);
  const sel = t.match(/<select[^>]*name="?m"?[^>]*>([\s\S]*?)<\/select>/i)?.[1] || "";
  const opts = [...sel.matchAll(/<option[^>]*value="?([^">]*)"?[^>]*>([^<]*)/gi)].map(m => ({ v: m[1], l: dec(m[2]) })).filter(o => o.v);
  const sort = (t.match(/<option[^>]*value="(AX)"/i) || [])[1] || "D";
  return (lib._m = {
    sort,
    b: opts.find(o => /blu/i.test(o.l))?.v,
    d: opts.find(o => /^dvd/i.test(o.l.trim()))?.v,
    g: opts.find(o => /game/i.test(o.l))?.v,
  });
}
const q = (lib, m, sort) => `/X*&searchscope=${lib.scope}&m=${m}&SORT=${sort}`;
export async function plan(lib, ctx) {
  const c = await codes(lib, ctx), out = [];
  for (const f of ["b", "d", "g"]) {
    if (!c[f]) continue;
    const t = await getText(ctx, `${lib.base}/search/X?SEARCH=%2A&searchscope=${lib.scope}&m=${c[f]}&SORT=${c.sort}`);
    const count = +((t.match(/([\d,]+)\s+results?\s+found/i) || [])[1] || "0").replace(/,/g, "");
    if (count) out.push({ f, pages: Math.ceil(count / PER), count, m: c[f], sort: c.sort });
  }
  return out;
}
export async function page(lib, task, n, ctx) {
  const c = await codes(lib, ctx), m = task.m || c[task.f], sort = task.sort || c.sort, total = task.count;
  const Q = q(lib, m, sort);
  const url = n === 1 ? `${lib.base}/search/X?SEARCH=%2A&searchscope=${lib.scope}&m=${m}&SORT=${sort}`
    : `${lib.base}/search~S${lib.scope}?${Q}${Q}&SUBKEY=*/${(n - 1) * PER + 1}%2C${total}%2C${total}%2CB/browse`;
  const t = await getText(ctx, url);
  const rows = [];
  for (const row of t.split('class="briefCitRow"').slice(1)) {
    const id = row.match(/name="save" value="(b\d+)"/)?.[1];
    const tm = row.match(/<td align="left" valign="top" width="65%">[\s\S]*?<a href="[^"]*">([\s\S]*?)<\/a>/);
    if (!id || !tm) continue;
    let full = dec(tm[1]).replace(/\s*\[[^\]]*\]\s*/g, " ");
    let title = full.replace(/\s*\/.*$/, "").replace(/[\s.:;,]+$/, "").trim(), sub = "";
    const ci = title.indexOf(" : "); if (ci > 0) { sub = title.slice(ci + 3); title = title.slice(0, ci); }
    const body = dec(row.match(/width="65%">([\s\S]*?)<\/td>/)?.[1] || "");
    const yr = row.match(/<b>\s*((?:1[89]|20)\d\d)\s*<\/b>/)?.[1] || body.match(/\b((?:1[89]|20)\d\d)\b/)?.[1];
    const cv = row.match(/<img src="(https:\/\/secure\.syndetics\.com[^"]*)"/)?.[1]?.replace(/&amp;/g, "&").replace("/SC.GIF", "/MC.GIF") || "";
    const blu = /blu-?ray/i.test(full + " " + body);
    rows.push({ id, title, sub, f: task.f === "d" && blu ? "b" : task.f, disc: yr ? +yr : 0, cover: cv, avail: 0, holds: 0, subj: "", plat: "" });
  }
  return rows;
}
export function recordTemplate(lib) { return `${lib.base}/record={id}~S${lib.scope}`; }
export async function libraryName(lib, ctx) {
  const t = await getText(ctx, `${lib.base}/search/X`);
  const m = t.match(/<title>([^<]*)<\/title>/i); return m ? dec(m[1]).replace(/^Hosted:\s*/i, "").replace(/\s*\/.*$/, "").trim() || null : null;
}
