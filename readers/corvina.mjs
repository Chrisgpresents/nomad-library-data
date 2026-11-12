// Corvina WebPac (Monguz) reader, e.g. saman.fszek.hu/WebPac/CorvinaWeb (Fővárosi Szabó Ervin Könyvtár, Budapest).
// Search = GET CorvinaWeb?action=find with form fields (the server keeps the page size in a session cookie).
// Later pages = GET action=page&page=<n-1> with the search string the results form carries (actualsearchset), so any
// session with the page size set can fetch any page, in any order.
// Hungarian records read "Mátrix forradalmak [DVD-felvétel] = The Matrix revolutions / ...": the part after "=" is the
// original title. The site matches IMDb on a-z/0-9 only, so we publish the original title when the record has one.
export const system = "corvina";
const PER = 100;
const DEFAULT_PREFIX = "/WebPac/CorvinaWeb";
const SESSION_MS = 20 * 60e3;               // the server's session lasts 30 minutes
// HDZO = physical medium. TYPE=F = visual material (film). The server is slow and fragile (Oracle): small pages, no date filters.
const SEARCH = { b: "blu-ray", d: "DVD" };
const sessions = new Map();                 // lib.id + format -> Promise<{ jar, set, at }>

export function libFromUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const m = u.pathname.match(/^(.*?\/CorvinaWeb)/i);
  const prefix = m ? m[1] : DEFAULT_PREFIX;
  const id = ("corvina." + host + (prefix === DEFAULT_PREFIX ? "" : "_" + prefix.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase())).replace(/[^a-z0-9._-]/g, "");
  return { id, host, base: "https://" + host + prefix };
}

// The catalog writes accented letters as named entities (&aacute; &odblac; ...) as well as raw UTF-8.
const ENT = { aacute: "á", eacute: "é", iacute: "í", oacute: "ó", ouml: "ö", odblac: "ő", uacute: "ú", uuml: "ü", udblac: "ű",
  Aacute: "Á", Eacute: "É", Iacute: "Í", Oacute: "Ó", Ouml: "Ö", Odblac: "Ő", Uacute: "Ú", Uuml: "Ü", Udblac: "Ű",
  agrave: "à", egrave: "è", ecirc: "ê", acirc: "â", ccedil: "ç", ntilde: "ñ", auml: "ä", szlig: "ß", amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
const dec = s => s.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&([a-z]+);/gi, (m, k) => ENT[k] ?? m).replace(/\s+/g, " ").trim();

function cookiesFrom(res, jar) {
  const list = res.headers.getSetCookie ? res.headers.getSetCookie() : (res.headers.get("set-cookie") || "").split(/,(?=\s*[\w.-]+=)/);
  for (const c of list) { const m = c.match(/^\s*([^=;\s]+)=([^;]*)/); if (m) jar[m[1]] = m[2]; }
}
const cookieHeader = jar => Object.entries(jar).map(([k, v]) => k + "=" + v).join("; ");
async function getText(ctx, url, jar) {
  const r = await ctx.fetch(url, { headers: { "user-agent": "Mozilla/5.0 NomadLibrary", accept: "text/html", cookie: cookieHeader(jar) } });
  cookiesFrom(r, jar);
  const t = await r.text();
  if (/<title>[^<]*(error|hiba)/i.test(t)) throw new Error("corvina error page");
  return t;
}
const total = t => +((t.match(/Összesen\s+([\d\s.]+?)\s+találat/) || t.match(/Összesen\s+(\d+)/) || [])[1] || "0").replace(/\D/g, "");
const rowsOf = t => t.split('<tr class="short_item_block">').slice(1);

const findUrl = (lib, f) => `${lib.base}?action=find&index0=HDZO&text0=${encodeURIComponent(SEARCH[f])}&textlogic0=and&pagesize=${PER}&TYPE=F`;
// One session per library and format: a search sets the page size on the session and hands back page 1.
function session(lib, ctx, f, fresh = false) {
  const key = lib.id + f, old = sessions.get(key);
  if (old && !fresh) return old.then(s => (Date.now() - s.at < SESSION_MS ? s : session(lib, ctx, f, true)));
  const p = (async () => {
    const jar = {}, html = await getText(ctx, findUrl(lib, f), jar);
    const set = (html.match(/name="actualsearchset"\s+value="([^"]*)"/) || [])[1];
    if (!set) throw new Error("corvina: no search string in results");
    return { jar, set: dec(set), at: Date.now(), html, count: total(html) };
  })();
  sessions.set(key, p);
  p.catch(() => sessions.get(key) === p && sessions.delete(key));
  return p;
}

export async function plan(lib, ctx) {
  const out = [];
  for (const f of ["d", "b"]) {   // DVD first: a record both searches find stays a DVD
    const s = await session(lib, ctx, f, true);
    if (s.count) out.push({ f, pages: Math.ceil(s.count / PER), count: s.count });
  }
  return out;
}

// "Mátrix forradalmak [DVD-felvétel] = The Matrix revolutions / írták ..." -> { title: "The Matrix revolutions", sub: "" }
// The original title (after "=") wins because only it can match IMDb. A Hungarian subtitle ("Soul kitchen : Fatih Akin filmje") is
// dropped, since the site gives up on a rating when the subtitle isn't part of the film's name; volume and part numbers stay.
const KEEP_SUB = /^(vol|volume|part|pt|disc|season|\d|évad|rész|kötet)/i;
export function splitTitle(raw) {
  const s = dec(raw).replace(/\s*\/.*$/, "").replace(/\s*\[[^\]]*\]/g, " ").replace(/\s+/g, " ").trim();   // drop "/ responsibility" and "[DVD-felvétel]"
  const eq = s.indexOf(" = "), hasOriginal = eq > 0;
  const base = hasOriginal ? s.slice(eq + 3) : s, ci = base.indexOf(" : ");
  const clean = x => x.replace(/[\s,;:.=]+$/, "").trim();
  const title = clean(ci > 0 ? base.slice(0, ci) : base);
  const sub = ci > 0 ? clean(base.slice(ci + 3)) : "";
  return { title, sub: sub && (hasOriginal || KEEP_SUB.test(sub)) ? sub : "" };
}

export async function page(lib, task, n, ctx) {
  let s = await session(lib, ctx, task.f), html;
  if (n === 1) html = s.html;
  else {
    const url = `${lib.base}?action=page&page=${n - 1}&perpage=${PER}&pagesize=${PER}&actualsearchset=${encodeURIComponent(s.set)}&actualsort=0&currentpage=result&resultview=short&resultsize=${s.count}`;
    html = await getText(ctx, url, s.jar);
    if (rowsOf(html).length < Math.min(PER, task.count - (n - 1) * PER)) {   // session lost its page size: start a new one and ask again
      s = await session(lib, ctx, task.f, true);
      html = await getText(ctx, url, s.jar);
    }
  }
  const out = [];
  for (const r of rowsOf(html)) {
    const body = r.replace(/<script[\s\S]*?<\/script>/g, "");
    const id = (body.match(/name="basket(\d+)"/) || body.match(/lookRecnum\((\d+),/))?.[1];   // rows without an author have no lookRecnum link
    const cells = [...body.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
    if (!id || cells.length < 6) continue;
    const { title, sub } = splitTitle(cells[3]);
    if (!title) continue;
    const yr = dec(cells[4]).match(/\b(1[89]\d\d|20\d\d)\b/);
    out.push({ id, title, sub, f: task.f, disc: yr ? +yr[1] : 0, cover: "", avail: 0, holds: 0, subj: "", plat: "" });
  }
  return out;
}

export function recordTemplate(lib) { return `${lib.base}?action=onelong&showtype=longlong&recnum={id}`; }
export async function libraryName(lib, ctx) {
  const t = await getText(ctx, `${lib.base}?action=advancedsearchpage`, {});
  const m = t.match(/<title>([^<]*)<\/title>/);
  return m ? dec(m[1]).split("|").map(x => x.trim()).filter(Boolean).pop() || null : null;
}
