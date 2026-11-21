// Corvina WebPac reader against a fake Saman-style server. No real library is contacted.
//   node test/corvina.mjs
import http from "node:http";
import * as R from "../readers/corvina.mjs";

let pass = 0, fail = 0;
const ok = (c, msg) => { if (c) { pass++; console.log("  pass:", msg); } else { fail++; console.log("  FAIL:", msg); } };

// ---- the fake catalog: the real server keeps the page size on the session, and answers 10 rows to a session it does not know
const DVD = Array.from({ length: 250 }, (_, i) => ({ id: 1000 + i, author: i % 7 ? "Rendez&odblac;, Valaki" : "---", cell: i % 3 ? `Film ${i} [DVD-felv&eacute;tel] = Original ${i} /` : `Magyar c&iacute;m ${i} [DVD-felv&eacute;tel] : Hungarian subtitle /`, year: i % 2 ? "cop. 2004" : "[2010]" }));
const BLU = [{ id: 5001, author: "---", cell: "Recept az er&odblac;szakhoz [DVD-felv&eacute;tel] : dokumentumfilm / ", year: "cop. 2025" }, { id: 5002, author: "Lucas, George", cell: "Star wars [Blu-ray] = Star wars /", year: "2019" }];
const sessions = new Map();           // JSESSIONID -> pagesize
let finds = 0, pages = 0, dropAt = 0;
const row = (r, n) => `<tr class="short_item_block"><td class="short_item_back">${n}.</td><td class="short_item_back"><div><input type="checkbox" name="basket${r.id}" id="basket${r.id}"></div></td>` +
  `<td class="short_item_back">${r.author === "---" ? "&nbsp;---&nbsp;" : `<a href="javascript:{document.mainform.submit()}" onclick="lookRecnum(${r.id},7)">${r.author}</a>`}</td>` +
  `<td class="short_item_back">${r.cell}</td><td class="short_item_back">${r.year}</td><td class="short_item_back">Film</td><td class="short_item_back"></td>` +
  `<td class="short_item_back"><script type="text/javascript"> onelongPaging_mark(${n},${r.id}); </script></td></tr>`;
const view = (all, set, start, per) => `<html><head><title>Találati lista | &nbsp;Fake Library</title></head><body><form name="mainform"><input type="hidden" name="actualsearchset" value="${set}">` +
  `<div class="result-size">Összesen ${all.length} találat.</div><table>${all.slice(start, start + per).map((r, i) => row(r, start + i + 1)).join("")}</table></form></body></html>`;
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x"), q = u.searchParams, cookie = /JSESSIONID=(\w+)/.exec(req.headers.cookie || "")?.[1];
  if (u.pathname !== "/WebPac/CorvinaWeb") { res.writeHead(404); return res.end(); }
  if (q.get("action") === "advancedsearchpage") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<title>Összetett keresés | &nbsp;Fake K&ouml;nyvt&aacute;r</title>"); }
  if (q.get("action") === "find") {
    finds++;
    const sid = Math.random().toString(16).slice(2, 10); sessions.set(sid, +q.get("pagesize") || 10);
    const blu = /blu/i.test(q.get("text0")), all = blu ? BLU : DVD, set = blu ? "FIND HDZA &quot;blu ray&quot; and TYPE &quot;F&quot;" : "FIND HDZA &quot;DVD&quot; and TYPE &quot;F&quot;";
    res.writeHead(200, { "content-type": "text/html", "set-cookie": [`JSESSIONID=${sid}; Path=/WebPac; Secure; HttpOnly`, "serverTime=1; Path=/"] });
    return res.end(view(all, set, 0, sessions.get(sid)));
  }
  if (q.get("action") === "page") {
    pages++;
    if (dropAt && pages === dropAt) sessions.clear();                // the session expires in the middle of a copy
    const set = q.get("actualsearchset") || "", per = sessions.get(cookie) || 10, all = /blu/i.test(set) ? BLU : DVD;
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(set ? view(all, set.replace(/"/g, "&quot;"), +q.get("page") * per, per) : "<div class=\"alert alert-danger row\">Nincs megadva keresés.</div>");
  }
  res.writeHead(400); res.end();
});
await new Promise(r => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/WebPac/CorvinaWeb`;
const ctx = { log() {}, fetch: async (url, init) => { const r = await fetch(url, init); if (!r.ok) throw new Error("HTTP " + r.status); return r; } };
const lib = { id: "corvina.test", host: "127.0.0.1", base };

console.log("\n== address -> library");
ok(R.libFromUrl("https://saman.fszek.hu/WebPac/CorvinaWeb?action=advancedsearchpage")?.id === "corvina.saman.fszek.hu", "standard install: id is corvina.<host>");
ok(R.libFromUrl("https://saman.fszek.hu/WebPac/CorvinaWeb")?.base === "https://saman.fszek.hu/WebPac/CorvinaWeb", "base keeps the path prefix");
ok(R.libFromUrl("https://x.hu/katalogus/CorvinaWeb;jsessionid=AB12?action=find")?.id === "corvina.x.hu_katalogus-corvinaweb", "another path prefix is part of the id; ';jsessionid' ignored");
ok(R.libFromUrl("https://x.hu/")?.base === "https://x.hu/WebPac/CorvinaWeb", "a bare host gets the usual path");
ok(R.libFromUrl("ftp://x.hu/") === null && R.libFromUrl("not a url") === null, "not a web address -> null");
ok(R.recordTemplate(lib).endsWith("?action=onelong&showtype=longlong&recnum={id}"), "record link is a direct GET");

console.log("\n== titles");
const t = (raw) => JSON.stringify(R.splitTitle(raw));
ok(t("M&aacute;trix forradalmak [DVD-felv&eacute;tel] = The Matrix revolutions / &iacute;rták") === '{"title":"The Matrix revolutions","sub":""}', "original title after '=' wins");
ok(t("Tchaikovsky [DVD-felv&eacute;tel] : vol. 3 /") === '{"title":"Tchaikovsky","sub":"vol. 3"}', "volume numbers stay as the subtitle");
ok(t("Soul kitchen [DVD-felv&eacute;tel] : Fatih Akin filmje") === '{"title":"Soul kitchen","sub":""}', "a Hungarian subtitle is dropped so the title can still match IMDb");
ok(t("Magasfesz&uuml;lts&eacute;g [DVD-felv&eacute;tel] = Haute tension : horror /") === '{"title":"Haute tension","sub":"horror"}', "the original title's own subtitle stays");
ok(t("Ani<span class=\"highlight\">m&aacute;trix</span> [Videofelv&eacute;tel] = Animatrix") === '{"title":"Animatrix","sub":""}', "search highlighting tags are removed");

console.log("\n== a full copy");
const lines = await R.libraryName(lib, ctx);
ok(lines === "Fake Könyvtár", `library name from the page title (${lines})`);
const plan = await R.plan(lib, ctx);
ok(JSON.stringify(plan) === JSON.stringify([{ f: "d", pages: 3, count: 250 }, { f: "b", pages: 1, count: 2 }]), `plan: 250 DVDs in 3 pages, 2 Blu-rays in 1 (${JSON.stringify(plan)})`);
const got = new Map();
for (const task of plan) {
  const order = Array.from({ length: task.pages }, (_, i) => task.pages - i);            // out of order, two at a time, like the copier
  for (let i = 0; i < order.length; i += 2) for (const rows of await Promise.all(order.slice(i, i + 2).map(n => R.page(lib, task, n, ctx)))) for (const r of rows) if (!got.has(r.id)) got.set(r.id, r);
}
ok(got.size === 252, `every record arrives once (${got.size})`);
ok(got.has("5001") && got.get("5001").title === "Recept az erőszakhoz", "a row with no author link still gets its id");
ok(got.get("5002").f === "b" && got.get("1000").f === "d", "formats are kept per search");
ok(got.get("1001").title === "Original 1" && got.get("1001").disc === 2004 && got.get("1000").disc === 2010, "original title and publication year (cop. 2004, [2010])");
ok([...got.values()].every(r => r.avail === 0 && r.cover === "" && r.holds === 0), "no availability or covers claimed");
ok(finds === 2, `one search per format, page 1 comes from it (${finds} searches, ${pages} page requests for pages 2 and 3)`);
ok(pages === 2, "only pages 2 and 3 of the DVDs are fetched separately");

console.log("\n== session lost mid-copy");
sessions.clear(); dropAt = pages + 1;                                                    // next page request finds the session gone
const again = await R.page(lib, { f: "d", pages: 3, count: 250 }, 2, ctx).catch(e => e);
ok(Array.isArray(again) && again.length === 100, `page re-asked on a fresh session (${Array.isArray(again) ? again.length : again.message} rows)`);

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
