// Evergreen ILS reader: OpenSearch html-full feed (the only open listing; OPAC results page is behind Anubis/JS-redirect on several hosts).
export const system = "evergreen";
const PER = 25; // server hard-caps count at 25 (measured)
const PREFIX = { b: "search_format(blu-ray)", d: "search_format(dvd)", g: 'search_format(software) subject:video games' };

// Consortium branch subdomains map to an org-unit SHORTNAME used in the opensearch path (best guess: subdomain upper-cased).
export function libFromUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (!/\/eg\/|\/opac\/|\/eg2\//.test(u.pathname) && u.pathname !== "/") return null;
  const host = u.hostname.toLowerCase();
  const parts = host.split(".");
  let base = host, scope = "";
  if (host.endsWith(".nccardinal.org") && parts.length > 2) { base = "nccardinal.org"; scope = parts[0].toUpperCase(); }
  const org = u.searchParams.get("org") || u.searchParams.get("locg_shortname");
  if (org && /^[A-Za-z0-9_-]+$/.test(org)) scope = org.toUpperCase();
  const id = ("evergreen." + base + (scope ? "_" + scope.toLowerCase() : "")).replace(/[^a-z0-9._-]/g, "");
  return { id, host: base, base: "https://" + base, scope };
}
const feed = (lib, fmt, n) => `${lib.base}/opac/extras/opensearch/1.1/${lib.scope || "-"}/html-full/keyword?searchTerms=${encodeURIComponent(PREFIX[fmt])}&count=${PER}&startIndex=${(n - 1) * PER + 1}`;
async function get(lib, fmt, n, ctx) {
  const r = await ctx.fetch(feed(lib, fmt, n), { headers: { "user-agent": "Mozilla/5.0 NomadLibrary" } });
  if (r.ok === false) throw new Error("evergreen " + r.status);
  const t = await r.text();
  if (/Making sure you.re not a bot/i.test(t)) throw new Error("anubis bot wall");
  if (!/Search results for/.test(t)) throw new Error("not an opensearch page");
  return t;
}
export async function plan(lib, ctx) {
  const out = [];
  for (const f of ["b", "d", "g"]) {
    const t = await get(lib, f, 1, ctx);
    const m = t.match(/Results\s+\d+\s+to\s+\d+\s+of\s+([\d,]+)/);
    const count = m ? +m[1].replace(/,/g, "") : 0;
    if (count) out.push({ f, pages: Math.ceil(count / PER), count });
  }
  return out;
}
const dec = s => s.replace(/<[^>]+>/g, "").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
export async function page(lib, task, n, ctx) {
  const t = await get(lib, task.f, n, ctx);
  const rows = [];
  for (const blk of t.split(/<dt>/).slice(1)) {
    const idm = blk.match(/biblio-record_entry\/(\d+)/);
    if (!idm) continue;
    const a = blk.match(/<a [^>]*>([\s\S]*?)<\/a>/);
    let full = dec(a ? a[1] : "");
    full = full.replace(/\[[^\]]*\]/g, " ").replace(/\s+/g, " ").replace(/\s*[\/:;,.]+\s*$/, "").trim();
    let title = full, sub = "";
    const ci = full.indexOf(" : ");
    if (ci > 0) { title = full.slice(0, ci); sub = full.slice(ci + 3).replace(/\s*\/.*$/, "").trim(); }
    title = title.replace(/\s*\/.*$/, "").trim();
    const av = blk.match(/Available copies:\s*(\d+)/);
    const subs = [...blk.matchAll(/html-full\/subject\?[^>]*>([^<]*)<\/a>/g)].map(x => dec(x[1]).replace(/\.$/, "")).filter(Boolean);
    const jk = blk.match(/src="([^"]*jacket[^"]*)"/);
    let cover = jk ? jk[1].replace("/small/", "/medium/") : "";
    if (cover.startsWith("/")) cover = lib.base + cover;
    rows.push({ id: idm[1], title, sub, f: task.f, disc: 0, cover, avail: av && +av[1] > 0 ? 1 : 0, holds: 0, subj: subs.join(" | "), plat: "" });
  }
  return rows;
}
export function recordTemplate(lib) { return `${lib.base}/eg/opac/record/{id}`; }
export async function libraryName(lib, ctx) {
  const r = await ctx.fetch(feed(lib, "d", 1).replace("html-full", "html"));
  const m = (await r.text()).match(/<title>Search results for \[[^\]]*\] at ([^<]+)<\/title>/);
  return m ? dec(m[1]) : null;
}
