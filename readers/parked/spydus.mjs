// Spydus (Civica) reader. Search = GET BIBENQ with form fields; later pages = GET PAGE/<session>/<n> (session id lives in the URL, no cookie needed).
export const system = "spydus";
const PER = 100;
const KW = { b: "blu-ray", d: "dvd", g: "" };
const sessions = new Map(); // search key -> { sid, at }

export function libFromUrl(url) {
  let u; try { u = new URL(url); } catch { return null; }
  if (!/^https?:$/.test(u.protocol)) return null;
  const host = u.hostname.toLowerCase();
  const m = u.pathname.match(/^(.*?\/cgi-bin\/spydus\.exe)/i);
  const prefix = m ? m[1] : "/cgi-bin/spydus.exe";
  const id = ("spydus." + host + (prefix === "/cgi-bin/spydus.exe" ? "" : "_" + prefix.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase())).replace(/[^a-z0-9._-]/g, "");
  return { id, host, base: "https://" + host + prefix };
}
const dec = s => s.replace(/<[^>]+>/g, "").replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
async function getText(ctx, url) {
  const r = await ctx.fetch(url, { headers: { "user-agent": "Mozilla/5.0 NomadLibrary", accept: "text/html" } });
  if (r.ok === false) throw new Error("spydus " + r.status);
  const t = await r.text();
  if (/Human Verification|awsWaf|gokuProps/.test(t)) throw new Error("AWS WAF human verification wall");
  return t;
}
async function recfmtCodes(lib, ctx) {
  if (lib._rc) return lib._rc;
  const t = await getText(ctx, `${lib.base}/MSGTRN/OPAC/COMB`);
  const sel = t.match(/<select name="RECFMT".*?<\/select>/s)?.[0] || "";
  const opts = [...sel.matchAll(/<option value="([^"*]*)\*([^"]*)"/g)].map(m => ({ code: m[1], label: dec(m[2]) }));
  const pm = opts.find(o => /dvd/i.test(o.label)), gm = opts.find(o => /game/i.test(o.label));
  return (lib._rc = { b: pm?.code, d: pm?.code, g: gm?.code });
}
function searchUrl(lib, f, code) {
  const kw = KW[f];
  const q = `SETLVL=&RECFMT=${encodeURIComponent(code)}&NRECS=${PER}&SORTS=HBT.SOVR` + (kw ? `&ENTRY1_NAME=BS&ENTRY1=${encodeURIComponent(kw)}&ENTRY1_TYPE=K` : "");
  return `${lib.base}/ENQ/OPAC/BIBENQ?${q}`;
}
export async function plan(lib, ctx) {
  const rc = await recfmtCodes(lib, ctx), out = [];
  for (const f of ["b", "d", "g"]) {
    if (!rc[f]) continue;
    const t = await getText(ctx, searchUrl(lib, f, rc[f]).replace(`NRECS=${PER}`, "NRECS=5"));
    const count = +(t.match(/searchCount\s*=\s*(\d+)/)?.[1] || (t.match(/Showing\s+\d+\s*-\s*\d+\s+of\s+([\d,]+)/)?.[1] || "0").replace(/,/g, "") || 0);
    if (count) out.push({ f, pages: Math.ceil(count / PER), count });
  }
  return out;
}
export async function page(lib, task, n, ctx) {
  const rc = await recfmtCodes(lib, ctx), key = lib.id + task.f;
  let t;
  if (n === 1) t = await getText(ctx, searchUrl(lib, task.f, rc[task.f]));
  else {
    let s = sessions.get(key);
    if (!s || Date.now() - s.at > 8 * 60e3) {
      const first = await getText(ctx, searchUrl(lib, task.f, rc[task.f]).replace(`NRECS=${PER}`, "NRECS=" + PER));
      const sid = first.match(/PAGE\/OPAC\/BIBENQ\/(\d+)\/\d+/)?.[1];
      if (!sid) throw new Error("no session id in results");
      s = { sid, at: Date.now() }; sessions.set(key, s);
    }
    try { t = await getText(ctx, `${lib.base}/PAGE/OPAC/BIBENQ/${s.sid}/${n}`); }
    catch (e) { sessions.delete(key); throw e; }
  }
  const rows = [];
  for (const c of t.split('<fieldset class="card card-list">').slice(1)) {
    const idm = c.match(/name="SVL" id="listCheck\d+" value="(\d+)"/) || c.match(/<a name="(\d+)"/);
    const tm = c.match(/<h3 class="card-title">([\s\S]*?)<\/h3>/);
    if (!idm || !tm) continue;
    let title = dec(tm[1]).replace(/\s*\[[^\]]*\]\s*/g, " ").replace(/\s*\/.*$/, "").trim(), sub = "";
    const ci = title.indexOf(" : "); if (ci > 0) { sub = title.slice(ci + 3); title = title.slice(0, ci); }
    const det = c.match(/class="card-text recdetails">([\s\S]*?)<\/div>/);
    const yr = det && dec(det[1]).match(/\b(1[89]\d\d|20\d\d)\b/);
    const av = c.match(/Available:\s*<\/span><span class="availability-val">(\d+)/);
    const urls = (c.match(/data-imgurls="([^"]*)"/)?.[1] || "").replace(/&amp;/g, "&").split("**");
    const cover = urls.find(u => /(upc|isbn)=\d{8,}/i.test(u) && !/civicatest/.test(u)) || urls.find(u => /(upc|isbn)=\d{8,}/i.test(u)) || "";
    rows.push({ id: idm[1], title, sub, f: task.f, disc: yr ? +yr[1] : 0, cover, avail: av && +av[1] > 0 ? 1 : 0, holds: 0, subj: "", plat: "" });
  }
  return rows;
}
export function recordTemplate(lib) { return `${lib.base}/ENQ/OPAC/BIBENQ?BRN={id}`; }
export async function libraryName(lib, ctx) {
  const t = await getText(ctx, `${lib.base}/MSGTRN/OPAC/HOME`);
  const m = t.match(/<title>([^<]*)<\/title>/); return m ? dec(m[1]).replace(/^(Home|Search results)\s*[|\-]\s*/i, "") : null;
}
