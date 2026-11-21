// OCLC OPEN (formerly Bibliotheca.OPEN / "Katalogportal", ASP.NET + DNN) reader. Common in German and Austrian
// public libraries (Frankfurt am Main, Graz, ...). No API: the extended search form is posted once per media group,
// the catalog answers with a stable result link "Einfache-Suche?searchhash=OCLC_<sha1>", and every page of that
// result is a plain GET (&pageSize=50&page=n), no cookie needed. Availability is not in the result HTML (it is loaded
// per title by Ajax), so each group is searched twice: once with "nur verfügbare Medien" (rows avail 1) and once in
// full (avail 0). The copier keeps the first row per id, so the available pass runs first.
export const system = "open";
const PER = 50;   // the pager offers 10/20/50; larger values fall back to 10

export function libFromUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  return { id: "open." + host, host, base: "https://" + host };
}

const dec = s => String(s || "").replace(/<[^>]+>/g, "")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i")); return m ? (m[2] ?? m[3]) : null; };

async function getText(ctx, url, init = {}) {
  const r = await ctx.fetch(url, { ...init, headers: { accept: "text/html", ...(init.headers || {}) } });
  if (r.ok === false) throw new Error("open " + r.status);
  const t = await r.text();
  if (/cf-browser-verification|challenge-platform|Just a moment\.\.\./i.test(t)) throw new Error("bot wall");
  return { t, url: r.url || url };
}

// The values a browser would send for the page's form: hidden + text inputs, checked boxes/radios, selected options.
function formFields(html) {
  const f = html.match(/<form[\s\S]*?<\/form>/i)?.[0] || html, out = [];
  for (const m of f.matchAll(/<input\b[^>]*>/gi)) {
    const tag = m[0], name = attr(tag, "name"), type = (attr(tag, "type") || "text").toLowerCase();
    if (!name || /^(submit|image|button|reset|file)$/.test(type)) continue;
    if (/^(checkbox|radio)$/.test(type) && !/\schecked\b/i.test(tag)) continue;
    out.push([name, dec(attr(tag, "value") ?? (type === "checkbox" ? "on" : ""))]);
  }
  for (const m of f.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    const name = attr(m[1], "name"); if (!name) continue;
    const opts = [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
    const sel = opts.find(o => /\sselected\b/i.test(o[1])) || opts[0];
    if (sel) out.push([name, dec(attr(sel[1], "value") ?? sel[2])]);
  }
  return out;
}
function selectOptions(html, suffix) {
  const m = [...html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)].find(x => (attr(x[1], "name") || "").endsWith(suffix));
  if (!m) return null;
  return { name: attr(m[1], "name"), opts: [...m[2].matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map(o => ({ value: dec(attr(o[1], "value") ?? o[2]), label: dec(o[2]) })) };
}
const inputName = (html, suffix) => [...html.matchAll(/<input\b[^>]*>/gi)].map(m => attr(m[0], "name") || "").find(n => n.endsWith(suffix)) || "";

// Media groups are named by each library. Films: DVD/Blu-ray/Spielfilm/Sach-/Musikfilm. Games: Konsolenspiel/Videospiel.
// Not: streaming (filmfriend), board games ("Spiel"), PC software, video cassettes.
const GAME = /konsol|video\s*-?spiel|videogame|playstation|nintendo|xbox|\bwii\b|\bswitch\b|\bps[345]\b/i;
const FILM = /film|dvd|blu-?ray|\bvideo\b|\bbd\b/i;
const NOT = /filmfriend|stream|online|onleihe|digital|kassette|vhs|brett|gesellschaft|software|pc-?spiel|cd-?rom|tonie|\bbuch\b/i;
function classify(label) {
  if (NOT.test(label)) return "";
  if (GAME.test(label)) return "g";
  if (FILM.test(label)) return /blu-?ray|\bbd\b|4k|uhd/i.test(label) ? "b" : "d";
  return "";
}
const slug = s => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "x";

async function extendedPage(lib, ctx) {
  if (lib._ext) return lib._ext;
  // portals name the page differently (Frankfurt "/Mediensuche/ErweiterteSuche.aspx", Graz "/Mediensuche/Erweiterte-Suche",
  // where the .aspx name never answers), so take the link from the home page and fall back to the usual names
  const { t: home } = await getText(ctx, lib.base + "/");
  const found = [...home.matchAll(/href="([^"]*Erweiterte-?Suche[^"]*)"/gi)].map(m => new URL(dec(m[1]), lib.base + "/").href.replace(/^http:/, "https:"))
    .filter(u => new URL(u).host === lib.host);
  for (const url of [...new Set([...found, lib.base + "/Mediensuche/Erweiterte-Suche", lib.base + "/Mediensuche/ErweiterteSuche.aspx"])]) {
    let html = "";
    try { ({ t: html } = await getText(ctx, url)); } catch { continue; }
    if (selectOptions(html, "$DdlMediaGroupValue")) return (lib._ext = { url, html });
  }
  throw new Error("no extended search with a media group list");
}

// Post the extended search for one media group -> { hash, path, count }.
async function search(lib, ctx, group, onlyAvail) {
  const { url, html } = await extendedPage(lib, ctx);
  const sel = selectOptions(html, "$DdlMediaGroupValue"), btn = inputName(html, "$BtnSearch"), avail = inputName(html, "$cbOnlyAvailable");
  const fields = formFields(html).filter(([n]) => n !== sel.name && n !== avail);
  fields.push([sel.name, group]);
  if (onlyAvail) { if (!avail) return null; fields.push([avail, "on"]); }
  if (btn) fields.push([btn, "Suchen"]);
  const body = fields.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&");
  const { t, url: at } = await getText(ctx, url, { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } });
  const hash = at.match(/searchhash=(OCLC_[0-9a-f]+)/i)?.[1] || t.match(/searchhash=(OCLC_[0-9a-f]+)/i)?.[1];
  if (!hash) throw new Error("search gave no result link");
  const path = new URL(at).pathname.includes("Suche") ? new URL(at).pathname : "/Mediensuche/Einfache-Suche";
  const esc = group.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/&/g, "&(?:amp;)?");
  let count = +(t.match(new RegExp(`title="${esc} \\((\\d+)\\)"`))?.[1] || 0);
  if (!count) {
    const last = +(t.match(/aLast"[^>]*href="[^"]*[?&;]page=(\d+)/)?.[1] || 0);
    const n = (t.match(/_divMedium"/g) || []).length;
    count = last ? last * 10 : n;
  }
  return { hash, path, count };
}

export async function plan(lib, ctx) {
  const { html } = await extendedPage(lib, ctx);
  const groups = selectOptions(html, "$DdlMediaGroupValue").opts.map(o => ({ ...o, f: classify(o.label) })).filter(o => o.f && !/^alle$/i.test(o.value));
  const av = [], all = [];
  for (const g of groups) {
    const s = await search(lib, ctx, g.value, false);
    if (!s.count) continue;
    const key = slug(g.value);
    all.push({ f: g.f, key, group: g.value, hash: s.hash, path: s.path, av: 0, pages: Math.ceil(s.count / PER), count: s.count });
    const a = await search(lib, ctx, g.value, true).catch(() => null);
    if (a && a.count) av.push({ f: g.f, key: key + "-av", group: g.value, hash: a.hash, path: a.path, av: 1, pages: Math.ceil(a.count / PER), count: a.count });
  }
  return [...av, ...all];   // available rows first: the copier keeps the first row it sees for an id
}

const MARK = /\s*\[(?:[^\]]*?(blu-?ray|4k|uhd|dvd)[^\]]*)\]\s*/i;
export function parseResults(t, task) {
  const parts = t.split(/<div id="[^"]*_mdv(\d+)_divMedium"/), rows = [];
  for (let i = 1; i < parts.length; i += 2) {
    const id = parts[i], h = parts[i + 1];
    let title = dec(h.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1]);
    if (!title) continue;
    let f = task.f;
    const mk = title.match(MARK);
    if (mk && f !== "g") f = /dvd/i.test(mk[1]) ? "d" : "b";
    title = title.replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s+/g, " ").trim();
    const sub = dec(h.match(/<\/h3>\s*<\/a>\s*<\/div>\s*<div>\s*([^<]*?)\s*<\/div>/)?.[1]);
    const yr = h.match(/Jahr:\s*<\/span>\s*(\d{4})/)?.[1];
    const srcs = (h.match(/data-sources="([^"]*)"/)?.[1] || "").replace(/&amp;/g, "&");
    const cover = (srcs.match(/SetSimpleCover\|a\|(https?:\/\/cover\.ekz\.de\/[^|]+)/)?.[1] ||
      srcs.split("|c|").map(x => x.split("|a|")).find(x => x[0] === "SetSimpleCover" && /^https?:\/\//.test(x[1] || "") && !/\/Portals\/|Fallbacks|emptyURL/i.test(x[1]))?.[1] || "")
      .replace(/^http:\/\/cover\.ekz\.de/, "https://cover.ekz.de").replace(/ /g, "%20");
    const subj = dec(h.match(/Interessenkreis:\s*<\/span>([\s\S]*?)<\/div>/)?.[1]);
    rows.push({ id, title, sub, f, disc: yr ? +yr : 0, cover, avail: task.av ? 1 : 0, holds: 0, subj, plat: "" });
  }
  return rows;
}

export async function page(lib, task, n, ctx) {
  const url = `${lib.base}${task.path || "/Mediensuche/Einfache-Suche"}?searchhash=${task.hash}&top=y&pageSize=${PER}&page=${n}`;
  let { t } = await getText(ctx, url);
  let rows = parseResults(t, task);
  if (!rows.length && n <= task.pages) {
    // the stored search may have been dropped by the catalog: post it again (the hash is the same for the same search)
    const s = await search(lib, ctx, task.group, !!task.av);
    if (s && s.hash) { task.hash = s.hash; ({ t } = await getText(ctx, url.replace(/searchhash=[^&]+/, "searchhash=" + s.hash))); rows = parseResults(t, task); }
    if (!rows.length) throw new Error(`empty result page ${n}`);
  }
  return rows;
}

export function recordTemplate(lib) { return `${lib.base}/Permalink.aspx?id={id}`; }

export async function libraryName(lib, ctx) {
  const { t } = await getText(ctx, lib.base + "/");
  const title = dec(t.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  return title.split(/\s+[>|–—-]\s+/).map(s => s.trim()).find(s => /biblio|büch|bücher|librar/i.test(s) && !/^(katalog|katalogportal|startseite)$/i.test(s)) || null;
}
