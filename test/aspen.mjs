// Aspen reader against canned Search API answers. No live catalog is contacted.
import assert from "node:assert/strict";
import test from "node:test";
import { libFromUrl, plan, page, recordTemplate, libraryName } from "../readers/aspen.mjs";

const LIB = libFromUrl("https://roxbury.aspendiscovery.org/?browseCategory=x");

function jsonRes(obj, status = 200) {
  return { ok: status >= 200 && status < 300, status, async text() { return typeof obj === "string" ? obj : JSON.stringify(obj); } };
}
function ctxFor(handler) {
  const calls = [];
  return { calls, log() {}, async fetch(url, init) { calls.push(url); return handler(url, init); } };
}
const facets = {
  format: {
    list: {
      Book: { value: "Book", count: 100 },
      DVD: { value: "DVD", count: 120 },
      "Blu-ray": { value: "Blu-ray", count: 40 },
      "4K Ultra HD": { value: "4K Ultra HD", count: 10 },
      "Blu-ray + DVD": { value: "Blu-ray + DVD", count: 5 },
      "PlayStation 5": { value: "PlayStation 5", count: 8 },
      "0#Video Game": { value: "0#Video Game", count: 3 },
    },
  },
};
function searchBody(url) {
  const u = new URL(url);
  const filter = u.searchParams.getAll("filter[]").join(" ");
  const lookfor = u.searchParams.get("lookfor");
  if (lookfor === "*:*" && !filter) {
    return { recordCount: 286, paging: { itemsPerPage: 25, totalItems: 286, totalPages: 12 }, facetSet: facets };
  }
  const row = {
    id: "gw-alien", title_short: "Alien [videorecording] : Covenant", subtitle_display: "",
    publishDateSort: "2017", format: ["Blu-ray", "DVD"], topic_facet: ["0#Science fiction films", "Horror films"],
    total_holds: "6",
  };
  if (filter.includes("available_at")) row.available_at = ["Main"];
  if (filter.includes("Video Game") || filter.includes("PlayStation")) {
    return { recordCount: 1, recordSet: [{ id: "gw-game", title_display: "Hades / Supergiant", format: ["PlayStation 5"], publishDate: ["2021"], total_holds: 2 }] };
  }
  if (filter.includes("bad/id")) return { recordCount: 1, recordSet: [{ id: "nope/1", title_short: "Skip", format: ["DVD"] }] };
  return { recordCount: 1, paging: { itemsPerPage: 25 }, recordSet: [row] };
}

test("libFromUrl matches the catalog.js id and skips the vendor's own sites", () => {
  assert.equal(LIB.id, "aspen.roxbury.aspendiscovery.org");
  assert.equal(LIB.host, "roxbury.aspendiscovery.org");
  assert.equal(LIB.base, "https://roxbury.aspendiscovery.org");
  assert.equal(libFromUrl("https://www.catalog.example.org/Search/Results?lookfor=alien").id, "aspen.catalog.example.org");
  assert.equal(libFromUrl("http://catalog.example.org/GroupedWork/abc").base, "http://catalog.example.org");
  assert.equal(libFromUrl("https://aspendiscovery.org/"), null);
  assert.equal(libFromUrl("https://help.aspendiscovery.org/"), null);
  assert.equal(libFromUrl("https://community.aspendiscovery.org/"), null);
  assert.equal(libFromUrl("https://dev.aspendiscovery.org/"), null);
  assert.equal(libFromUrl("not a url"), null);
  assert.equal(recordTemplate(LIB), "https://roxbury.aspendiscovery.org/GroupedWork/{id}");
});

test("plan reads format facets, honours the reported page size, and orders Blu-ray before DVD before games", async () => {
  const ctx = ctxFor(url => jsonRes(searchBody(url)));
  const tasks = await plan(LIB, ctx);
  assert.deepEqual(tasks.map(t => t.f), ["b", "b", "b", "d", "g", "g"]);
  assert.deepEqual(tasks.map(t => t.label), ["4K Ultra HD", "Blu-ray", "Blu-ray + DVD", "DVD", "PlayStation 5", "Video Game"]);
  assert.equal(tasks.find(t => t.label === "DVD").pages, Math.ceil(120 / 25));
  assert.equal(tasks.find(t => t.label === "DVD").per, 25);
  assert.equal(new Set(tasks.map(t => t.key)).size, tasks.length);
  assert.equal(ctx.calls.length, 1);
  assert.match(ctx.calls[0], /method=search/);
  assert.match(ctx.calls[0], /lookfor=\*%3A\*|lookfor=\*:?\*/);
  assert.match(ctx.calls[0], /searchSource=local/);
  assert.match(ctx.calls[0], /sort=title/);
});

test("a rejected match-all query is tried once as a star search", async () => {
  const ctx = ctxFor(url => jsonRes(new URL(url).searchParams.get("lookfor") === "*:*"
    ? { recordCount: 0, parseError: true }
    : { recordCount: 4, paging: { itemsPerPage: 50 }, facetSet: { format: { list: [{ value: "DVD", count: 4 }] } } }));
  const tasks = await plan(LIB, ctx);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].label, "DVD");
  assert.equal(ctx.calls.length, 2);
});

test("page maps a grouped work and keeps the real id", async () => {
  const ctx = ctxFor(url => jsonRes(searchBody(url)));
  const tasks = await plan(LIB, ctx);
  const blu = tasks.find(t => t.label === "Blu-ray");
  const rows = await page(LIB, blu, 2, ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, "gw-alien");
  assert.equal(rows[0].title, "Alien");
  assert.equal(rows[0].sub, "Covenant");
  assert.equal(rows[0].f, "b");
  assert.equal(rows[0].disc, 2017);
  assert.equal(rows[0].avail, 0);
  assert.equal(rows[0].holds, 6);
  assert.equal(rows[0].subj, "Science fiction films | Horror films");
  assert.match(rows[0].cover, /bookcover\.php\?id=gw-alien/);
  assert.match(ctx.calls.at(-1), /page=2/);
  assert.match(ctx.calls.at(-1), /filter%5B%5D=format%3A%22Blu-ray%22|filter\[\]=format%3A%22Blu-ray%22/);
});

test("available_at marks a copy on the shelf, and an id with a slash is skipped", async () => {
  const ctx = ctxFor(url => {
    const filter = new URL(url).searchParams.getAll("filter[]").join(" ");
    if (filter.includes("DVD")) return jsonRes({ recordSet: [{ id: "ok", title_short: "Ok", format: ["DVD"], available_at: ["Main"], publishDate: ["1890", "2001"] }, { id: "bad/id", title_short: "No", format: ["DVD"] }] });
    return jsonRes({ recordCount: 1, paging: { itemsPerPage: 50 }, facetSet: { format: { list: [{ value: "DVD", count: 1 }] } } });
  });
  const [task] = await plan(LIB, ctx);
  const rows = await page(LIB, task, 1, ctx);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].avail, 1);
  assert.equal(rows[0].disc, 2001);
});

test("games take the platform from the format label", async () => {
  const ctx = ctxFor(url => jsonRes(searchBody(url)));
  const tasks = await plan(LIB, ctx);
  const rows = await page(LIB, tasks.find(t => t.label === "PlayStation 5"), 1, ctx);
  assert.equal(rows[0].f, "g");
  assert.equal(rows[0].plat, "PlayStation 5");
  assert.equal(rows[0].title, "Hades");
});

test("format_category is used only when format facets name no discs", async () => {
  const body = {
    recordCount: 9,
    paging: { itemsPerPage: 50 },
    facetSet: { format_category: { list: [{ value: "Movies", count: 9 }, { value: "Books", count: 40 }] } },
  };
  const ctx = ctxFor(url => {
    const filter = new URL(url).searchParams.getAll("filter[]").join(" ");
    if (!filter) return jsonRes(body);
    return jsonRes({ recordSet: [
      { id: "film", title_short: "Arrival", format: ["Blu-ray"] },
      { id: "book", title_short: "Dune", format: ["Book"] },
    ] });
  });
  const tasks = await plan(LIB, ctx);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].classify, true);
  const rows = await page(LIB, tasks[0], 1, ctx);
  assert.deepEqual(rows.map(r => [r.id, r.f]), [["film", "b"]]);
});

test("an HTML bot wall is a permanent failure, including HTTP 200", async () => {
  const wall = ctxFor(() => jsonRes("<html><title>Just a moment...</title>Checking your browser</html>"));
  await assert.rejects(() => plan(LIB, wall), e => e.permanent === true && /bot wall/.test(e.message));
  const denied = ctxFor(() => jsonRes("nope", 403));
  await assert.rejects(() => plan(LIB, denied), e => e.permanent === true && /bot wall/.test(e.message));
  const allow = ctxFor(() => jsonRes("<h1>Forbidden</h1><p>API requests from 203.0.113.5 are forbidden.</p>", 403));
  await assert.rejects(() => plan(LIB, allow), e => e.permanent === true && e.message === "aspen catalog refused this address" && !/203\.0\.113\.5/.test(e.message));
  const html = ctxFor(() => jsonRes("<html>maintenance</html>"));
  await assert.rejects(() => plan(LIB, html), e => !e.permanent && /not JSON/.test(e.message));
});

test("libraryName reads a title that names the library and ignores a wall", async () => {
  const ok = ctxFor(() => jsonRes("<html><title>Catalog | Roxbury Public Library</title></html>"));
  assert.equal(await libraryName(LIB, ok), "Roxbury Public Library");
  const wall = ctxFor(() => jsonRes("<html><title>Just a moment...</title>cloudflare</html>"));
  assert.equal(await libraryName(LIB, wall), "");
  const down = ctxFor(() => { throw Object.assign(new Error("HTTP 403"), { permanent: true }); });
  assert.equal(await libraryName(LIB, down), "");
});
