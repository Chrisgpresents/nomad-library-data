// Offline checks of readers/open.mjs (OCLC OPEN) against a fake portal. No library is contacted.
//   node test/open.mjs
import * as R from "../readers/open.mjs";
import assert from "node:assert/strict";
const item = (id, title, sub, year, cover) => `<div id="dnn_ctr376_MainView_UcSearchResult_DataPagerRepeater1_mdv${id}_divMedium" style="x"> <div class="coverRegion"><img data-sources="SetSimpleCover|a|/DesktopModules/x/emptyURL.gif|a||c|SetSimpleCover|a|${cover}|a|${cover}|c|SetNoCover|a|/x.gif|a|"></div> <div class="oclc-searchmodule-mediumview-content"> <div class="boldText"> <a href="#"><h3 class='oclc-override-heading'>${title}</h3></a> </div> <div> ${sub} </div> <div> <span class="oclc-module-label">Jahr: </span> ${year} </div> <span class="itemtype video-film"><mark>Spielfilm</mark></span></div></div>`;
const html = item("2470185", "The invite [Blu-Ray]", "alles kommt auf den Tisch", 2026, "http://cover.ekz.de/004061229744812.jpg") + item("0142450", "Das Leben ist sch&#246;n", "", 2011, "");
const rows = R.parseResults(html, { f: "d", av: 1 });
assert.equal(rows.length, 2);
assert.deepEqual(rows[0], { id: "2470185", title: "The invite", sub: "alles kommt auf den Tisch", f: "b", disc: 2026, cover: "https://cover.ekz.de/004061229744812.jpg", avail: 1, holds: 0, subj: "", plat: "" });
assert.equal(rows[1].title, "Das Leben ist schön"); assert.equal(rows[1].f, "d"); assert.equal(rows[1].cover, "");
assert.equal(R.libFromUrl("https://katalog.stadtbuecherei.frankfurt.de/Mediensuche/Einfache-Suche?id=1").id, "open.katalog.stadtbuecherei.frankfurt.de");
assert.equal(R.recordTemplate(R.libFromUrl("https://katalog.stadtbuecherei.frankfurt.de/")), "https://katalog.stadtbuecherei.frankfurt.de/Permalink.aspx?id={id}");
// plan + page against a fake OPEN portal (form post -> searchhash redirect -> paged GETs)
const groups = ["Alle", "Buch", "Spielfilm", "Sach-/Musikfilm", "Konsolenspiel", "Spiel", "filmfriend", "Software"];
const form = `<form><input type="hidden" name="__VIEWSTATE" value="abc" /><select name="dnn$ctr377$MainView$DdlMediaGroupValue">${groups.map(g => `<option value="${g}">${g}</option>`).join("")}</select><input type="checkbox" name="dnn$ctr377$MainView$cbOnlyAvailable" /><input type="submit" name="dnn$ctr377$MainView$BtnSearch" value="Suchen" /></form>`;
const posted = [];
const ctx = { log() {}, async fetch(url, init = {}) {
  const u = new URL(url);
  if (u.pathname === "/") return new Response(`<a href="http://${u.host}/Mediensuche/ErweiterteSuche.aspx">Erweiterte Suche</a>`);
  if (u.pathname.endsWith("ErweiterteSuche.aspx") && !init.method) return new Response(form);
  if (init.method === "POST") {
    const b = new URLSearchParams(init.body); posted.push(b);
    const g = b.get("dnn$ctr377$MainView$DdlMediaGroupValue"), av = b.get("dnn$ctr377$MainView$cbOnlyAvailable") === "on";
    const n = { Spielfilm: av ? 120 : 130, "Sach-/Musikfilm": av ? 0 : 3, Konsolenspiel: 7 }[g] || 0;
    const res = new Response(`<li title="${g} (${n})"></li>`); Object.defineProperty(res, "url", { value: `https://${u.host}/Mediensuche/Einfache-Suche?searchhash=OCLC_${(g + av).length}ab&module=3` }); return res;
  }
  if (u.pathname === "/Mediensuche/Einfache-Suche") return new Response(item(u.searchParams.get("page") + "1", "Film " + u.searchParams.get("page"), "", 2020, ""));
  throw new Error("unexpected " + url);
} };
const lib = R.libFromUrl("https://katalog.example.de/");
const plan = await R.plan(lib, ctx);
assert.deepEqual(plan.map(t => [t.key, t.f, t.av, t.count, t.pages]), [["spielfilm-av", "d", 1, 120, 3], ["konsolenspiel-av", "g", 1, 7, 1], ["spielfilm", "d", 0, 130, 3], ["sach-musikfilm", "d", 0, 3, 1], ["konsolenspiel", "g", 0, 7, 1]]);
assert.equal(posted[0].get("__VIEWSTATE"), "abc"); assert.equal(posted[0].get("dnn$ctr377$MainView$BtnSearch"), "Suchen");
const p2 = await R.page(lib, plan[0], 2, ctx);
assert.deepEqual([p2[0].id, p2[0].title, p2[0].avail, p2[0].f], ["21", "Film 2", 1, "d"]);
console.log("open reader unit tests: all passed");
