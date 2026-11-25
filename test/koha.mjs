// Koha reader against canned public REST API answers (shapes recorded from catalog.cclsny.org and
// catalog.fargolibrary.org, 11.25.26). No live catalog is contacted.
//   node --test test/koha.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { libFromUrl, plan, page, recordTemplate } from "../readers/koha.mjs";

// a CCLS-like catalog: Blu-rays filed under the DVD item types, board games next to video games
const TYPES = [["DVD", "DVD"], ["GAMES", "Board and other non-electronic games"], ["NEW_DVD", "New DVD"], ["VIDEOGAME", "Video Game"]];
const item = (item_id, biblio_id, item_type_id, title, extra = {}, bib = {}) => ({
  item_id, biblio_id, item_type_id, callnumber: "DVD " + title.toUpperCase(), checked_out_date: null, not_for_loan_status: 0,
  effective_not_for_loan_status: 0, damaged_status: 0, lost_status: 0, withdrawn: 0, home_library_id: "FRANKLNVIL", ...extra,
  biblio: { biblio_id, title, subtitle: null, part_name: null, part_number: null, edition_statement: null, medium: "[videorecording] /", copyright_date: 2023, isbn: null, notes: null, ...bib },
});
const ITEMS = [
  item(1, 10, "NEW_DVD", "Creed III", { checked_out_date: "2026-12-01" }),
  item(2, 10, "DVD", "Creed III"),                                                     // second copy on the shelf
  item(3, 11, "DVD", "The mummy", { callnumber: "Blu-ray Mummy" }, { edition_statement: "Blu ray edition", copyright_date: 2012 }),
  item(4, 12, "DVD", "Shazam!", { checked_out_date: "2026-11-30" }, { subtitle: "simple science magic /", isbn: "9780807573327" }),
  item(5, 13, "DVD", "Ordered", { not_for_loan_status: -3 }),                           // on order: not on a shelf
];
const GAME = [item(9, 20, "VIDEOGAME", "LEGO Harry Potter", { callnumber: "VG WII LEGO" }, { subtitle: "Years 5-7", medium: "[electronic resource] :", copyright_date: 2011 })];

function ctxFor({ status = 200 } = {}) {
  const calls = [];
  return {
    calls, log() {},
    async fetch(url, init) {
      calls.push({ url, embed: init.headers["x-koha-embed"] || "" });
      const u = new URL(url), q = JSON.parse(u.searchParams.get("q") || "{}");
      const json = (body, total = body.length) => ({ ok: status < 400, status, headers: new Headers({ "content-type": "application/json", "x-total-count": String(total) }), async json() { return body; } });
      if (status >= 400) return json({ error: "Configuration prevents the usage of this endpoint by unprivileged users" });
      if (u.pathname.endsWith("/public/libraries")) return json([{ library_id: "FRANKLNVIL", name: "Blount Library" }, { library_id: "ALLEGANY", name: "Allegany Public Library" }]);
      if (q["-or"]) {   // type discovery: the first type not yet found
        const not = q.item_type_id?.["-not_in"] || [];
        const t = TYPES.find(([c]) => !not.includes(c));
        return json(t ? [{ item_type_id: t[0], _strings: { item_type_id: { str: t[1] } } }] : [], t ? 1 : 0);
      }
      const codes = q.item_type_id;
      const list = (codes.includes("VIDEOGAME") ? GAME : ITEMS).filter((i) => codes.includes(i.item_type_id) && (!q.home_library_id || i.home_library_id === q.home_library_id));
      return json(+u.searchParams.get("_per_page") === 1 ? list.slice(0, 1) : list, list.length);
    },
  };
}

test("links: host id, one member library by ?limit=branch:, record link", () => {
  assert.equal(libFromUrl("https://catalog.cclsny.org/").id, "koha.catalog.cclsny.org");
  assert.equal(libFromUrl("https://catalog.cclsny.org/cgi-bin/koha/opac-search.pl?q=x&limit=branch:FRANKLNVIL").id, "koha.catalog.cclsny.org_franklnvil");
  assert.equal(recordTemplate(libFromUrl("catalog.cclsny.org")), "https://catalog.cclsny.org/cgi-bin/koha/opac-detail.pl?biblionumber={id}");
});

test("plan: item types found by name, board games skipped, one task per format", async () => {
  const ctx = ctxFor();
  const tasks = await plan(libFromUrl("https://catalog.cclsny.org/"), ctx);
  assert.deepEqual(tasks.map((t) => [t.f, t.q.item_type_id, t.items, t.count, t.pages]), [["d", ["DVD", "NEW_DVD"], 5, 0, 1], ["g", ["VIDEOGAME"], 1, 0, 1]]);
  assert.deepEqual(tasks[0].q, { item_type_id: ["DVD", "NEW_DVD"], withdrawn: 0, lost_status: 0 });
});

test("page: one row per title, any copy in = on the shelf, Blu-ray by call number, games get a platform", async () => {
  const ctx = ctxFor(), lib = libFromUrl("https://catalog.cclsny.org/");
  const [d, g] = await plan(lib, ctx);
  const rows = await page(lib, d, 1, ctx);
  assert.deepEqual(rows.map((r) => [r.id, r.f, r.title, r.sub, r.disc, r.avail]), [
    ["10", "d", "Creed III", "", 2023, 1],
    ["11", "b", "The mummy", "", 2012, 1],
    ["12", "d", "Shazam!", "simple science magic", 2023, 0],
    ["13", "d", "Ordered", "", 2023, 0],
  ]);
  assert.equal(rows[2].cover, "https://images-na.ssl-images-amazon.com/images/P/0807573329.01.MZZZZZZZ.jpg");
  assert.match(ctx.calls.at(-1).url, /_per_page=1000&_page=1&_order_by=%2Bme\.biblio_id/);
  assert.equal(ctx.calls.at(-1).embed, "biblio");
  const games = await page(lib, g, 1, ctx);
  assert.deepEqual(games.map((r) => [r.f, r.title, r.sub, r.plat]), [["g", "LEGO Harry Potter", "Years 5-7", "Wii"]]);
});

test("one member library: items filtered by its own code", async () => {
  const ctx = ctxFor(), lib = libFromUrl("https://catalog.cclsny.org/?limit=branch:franklnvil");
  const [d] = await plan(lib, ctx);
  assert.equal(d.q.home_library_id, "FRANKLNVIL");
});

test("API turned off: a permanent error, no retries, no search pages", async () => {
  const ctx = ctxFor({ status: 401 });
  await assert.rejects(plan(libFromUrl("https://koha.example.org/"), ctx), (e) => e.permanent && /RESTPublicAPI/.test(e.message));
  assert.ok(ctx.calls.every((c) => c.url.includes("/api/v1/")));
});
