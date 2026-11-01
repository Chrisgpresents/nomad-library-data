// Innovative Encore reader: Encore search "*" with the DVD facet (facetmediatype:g = "DVD/BLU-RAY"), 25 per page, __P<n> 0-based paging in the URL.
// Needs a Referer and a JSESSIONID (first hit 302s to set it) - handled here by hand because ctx.fetch has no cookie jar.
export const system = "encore";
const PER = 25;
export function libFromUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const m = u.pathname.match(/^(.*?\/iii\/encore)/i);
  return { id: "encore." + host, host, base: "https://" + host + (m ? m[1] : "/iii/encore") };
}
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const dec = s => s.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
async function getText(lib, ctx, url) {
  let u = url;
  for (let hop = 0; hop < 5; hop++) {
    const r = await ctx.fetch(u, { redirect: "manual", headers: { "user-agent": UA, referer: lib.base + "/", accept: "text/html", ...(lib._ck ? { cookie: lib._ck } : {}) } });
    const sc = r.headers.get("set-cookie");
    if (sc) { const jar = new Map((lib._ck || "").split("; ").filter(Boolean).map(x => x.split(/=(.*)/s).slice(0, 2))); for (const c of sc.split(/,(?=\s*[A-Za-z0-9_-]+=)/)) { const [k, v] = c.trim().split(";")[0].split(/=(.*)/s); if (k) jar.set(k, v); } lib._ck = [...jar].map(([k, v]) => `${k}=${v}`).join("; "); }
    if (r.status >= 300 && r.status < 400) { u = new URL(r.headers.get("location"), u).href; continue; }
    if (r.status !== 200) throw new Error("encore " + r.status);
    return await r.text();
  }
  throw new Error("encore redirect loop");
}
const searchUrl = (lib, p) => `${lib.base}/search/C__S%2A__Ff%3Afacetmediatype%3Ag%3Ag%3ADVD%3A%3A${p ? "__P" + p : ""}__Orightresult__U__X0?lang=eng&suite=def`;
export async function plan(lib, ctx) {
  const t = await getText(lib, ctx, searchUrl(lib, 0));
  const count = +((t.match(/[\d,]+\s*-\s*[\d,]+\s*of\s*([\d,]+)/) || [])[1] || "0").replace(/,/g, "");
  return count ? [{ f: "d", pages: Math.ceil(count / PER), count }] : [];
}
export async function page(lib, task, n, ctx) {
  const t = await getText(lib, ctx, searchUrl(lib, n - 1));
  const rows = [];
  for (const blk of t.split('class="dpBibTitle"').slice(1)) {
    const link = blk.match(/<a id="recordDisplayLink2Component[^"]*" href="[^"]*record\/C__R(b\d+)[^"]*">([\s\S]*?)<\/a>/);
    if (!link) continue;
    let full = dec(link[2]);
    const blu = /blu-?ray/i.test(full);
    full = full.replace(/\s*\[[^\]]*\]\s*/g, " ");
    let title = full.replace(/\s*[\/;].*$/, "").replace(/[\s.:,]+$/, "").trim(), sub = "";
    const ci = title.indexOf(" : "); if (ci > 0) { sub = title.slice(ci + 3); title = title.slice(0, ci); }
    const yr = dec(blk.match(/itemMediaYear[^>]*>([^<]*)/)?.[1] || "").match(/\b(1[89]\d\d|20\d\d)\b/)?.[1];
    const avail = /Available">\s*Available/.test(blk) ? 1 : 0;
    // cover image sits just before dpBibTitle in the previous chunk; recover it from the preceding split part
    rows.push({ id: link[1], title, sub, f: blu ? "b" : "d", disc: yr ? +yr : 0, cover: "", avail, holds: 0, subj: "", plat: "" });
  }
  // covers: one <img ... service=BibImage ...> per result, in order
  const imgs = [...t.matchAll(/src="(\/iii\/encore\/home\?image_size=thumb[^"]*)"/g)].map(m => lib.base.replace(/\/iii\/encore$/, "") + m[1].replace(/&amp;/g, "&"));
  if (imgs.length === rows.length) rows.forEach((r, i) => { if (/(isxn|upc)=\d{8,}/.test(imgs[i])) r.cover = imgs[i]; });
  return rows;
}
export function recordTemplate(lib) { return `${lib.base}/record/C__R{id}?lang=eng&suite=def`; }
export async function libraryName() { return null; }
