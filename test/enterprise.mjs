// Enterprise reader against canned facet and result pages. No live catalog is contacted.
//   node --test test/enterprise.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { libFromUrl, plan, page } from "../readers/enterprise.mjs";

// one facet value the way the left-hand navigator shows it
const facet = (name, label, count, code = label) =>
  `<span><a href="/client/en_US/x/search/results.navigatorclick?qf=${encodeURIComponent([name, name, code, label].join("\t")).replace(/%20/g, "+")}&amp;ps=2" title="${label}">${label}</a></span><div class="navigatorCount">(${count.toLocaleString("en-US")})</div>`;
const cell = (i, key, title, year = 2024) => `<div id="results_cell${i}" class="results_cell">
  <input type="hidden" value="ent://SD_ILS/0/SD_ILS:${key}"/>
  <a id="detailLink${i}" href="#">${title}</a>
  <div class="displayElementText text-p highlightMe PUBDATE">${year}</div>
</div>`;
const resultsPage = (hits, cells = "", facets = "") => `<div>${hits.toLocaleString("en-US")} Results Found</div>${facets}${cells}`;

function ctxFor(handler) {
  const calls = [];
  return {
    calls, log() {},
    async fetch(url, init) {
      calls.push(url);
      const body = /loadavailability/.test(url) ? "[]" : handler(new URL(url), init);
      return { ok: true, status: 200, url, async text() { return body; } };
    },
  };
}
const qfOf = (u) => decodeURIComponent((u.searchParams.get("qf") || "").replace(/\+/g, " ")).split("\t");

test("Detroit: no format facet, so films come from the 'videorecording' item categories and every electronic game category counts", async () => {
  const lib = libFromUrl("https://detp.ent.sirsi.net/client/en_US/default/");
  const facets = [
    facet("ITEMCAT1", "Nonfiction", 374950), facet("ITEMCAT1", "Feature videorecording", 25879), facet("ITEMCAT1", "Nonfeature videorecording", 5377),
    facet("ITEMCAT1", "Electronic game", 229), facet("ITEMCAT1", "Sony PlayStation 4 Electronic Game", 226), facet("ITEMCAT1", "EGame SW", 154),
    facet("ITEMCAT1", "1:EGAME-SW2", 5), facet("ITEMCAT1", "1:BOARDGAME", 4), facet("ITEMCAT1", "1:CARDGAME", 2), facet("ITEMCAT1", "Electronic reader or tablet", 19),
    facet("LOCATION", "Adult DVD/Bluray Video Collection", 13779),
  ].join("");
  const ctx = ctxFor((u) => {
    const [, , , label] = qfOf(u);
    if (!label) return resultsPage(3000000, "", facets);
    if (u.searchParams.get("qu") === "blu-ray" && u.searchParams.get("ps") === "2") return resultsPage(label === "Feature videorecording" ? 1123 : 32);
    return resultsPage(3, cell(0, "a1", "Juror #2 (DVD) [videorecording].") + cell(1, "a2", "Opera (Blu-ray) [videorecording].") + cell(2, "a3", "Heat [videorecording] / Michael Mann."));
  });
  const tasks = await plan(lib, ctx);
  const by = Object.fromEntries(tasks.map((t) => [t.f, t]));
  assert.deepEqual(Object.keys(by), ["d", "b", "g"]);
  assert.deepEqual(by.d.parts.map((p) => p.label), ["Feature videorecording", "Nonfeature videorecording"]);
  assert.equal(by.d.mixed, true);
  assert.equal(by.d.count, 31256);
  assert.deepEqual(by.b.parts.map((p) => [p.label, p.qu, p.count]), [["Feature videorecording", "blu-ray", 1123], ["Nonfeature videorecording", "blu-ray", 32]]);
  assert.deepEqual(by.g.parts.map((p) => [p.label, p.plat]),
    [["Electronic game", ""], ["Sony PlayStation 4 Electronic Game", "PS4"], ["EGame SW", "Switch"], ["1:EGAME-SW2", "Switch 2"]]);
  const dvd = await page(lib, by.d, 1, ctx);
  assert.deepEqual(dvd.map((r) => [r.id, r.title]), [["a1", "Juror #2"], ["a3", "Heat"]]);   // the Blu-ray is left to the b task
  const blu = await page(lib, by.b, 1, ctx);
  assert.deepEqual(blu.map((r) => [r.id, r.f, r.title]), [["a2", "b", "Opera"]]);
});

test("Pinellas: an ITYPE 'Electronic Game' is the games set, 'Boardgame' and 'Software' are not", async () => {
  const lib = libFromUrl("https://pplc.ent.sirsi.net/client/en_US/default/");
  const facets = [facet("ITYPE", "DVD", 51570), facet("ITYPE", "Blu-ray Disc", 7320), facet("ITYPE", "Electronic Game", 1876),
    facet("ITYPE", "Boardgame", 226), facet("ITYPE", "Software", 62), facet("FORMAT", "DVD", 52222), facet("FORMAT", "Blu-ray", 6990)].join("");
  const ctx = ctxFor(() => resultsPage(3000000, "", facets));
  const tasks = await plan(lib, ctx);
  assert.deepEqual(tasks.find((t) => t.f === "g").parts.map((p) => [p.label, p.count]), [["Electronic Game", 1876]]);
  assert.equal(ctx.calls.length, 1);
});

test("Westminster: games filed as 'Electronic Resource' are read from the 'Video games.' genre term", async () => {
  const lib = libFromUrl("https://westm.ent.sirsi.net/client/en_US/default/");
  const facets = [facet("FORMAT", "DVD", 9473), facet("FORMAT", "Electronic Resource", 1029),
    facet("ICE FP GENRE", "Video games.", 424), facet("ICE FP GENRE", "Educational games.", 150), facet("SUBJECT", "Video games", 90)].join("");
  const ctx = ctxFor(() => resultsPage(3000000, "", facets));
  const tasks = await plan(lib, ctx);
  const g = tasks.find((t) => t.f === "g");
  assert.deepEqual(g.parts.map((p) => [p.label, p.count]), [["Video games.", 424]]);
  assert.match(decodeURIComponent(g.parts[0].qf.replace(/\+/g, " ")), /^ICE FP GENRE\t/);
});

test("a library with a real game format does not fall back to the genre term", async () => {
  const lib = libFromUrl("https://x.ent.sirsi.net/client/en_US/default/");
  const facets = [facet("FORMAT", "DVD", 900), facet("FORMAT", "Video Game", 80), facet("GENRE", "Video games.", 70)].join("");
  const tasks = await plan(lib, ctxFor(() => resultsPage(10000, "", facets)));
  assert.deepEqual(tasks.find((t) => t.f === "g").parts.map((p) => p.label), ["Video Game"]);
});
