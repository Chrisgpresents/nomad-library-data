// Polaris reader against a fake PowerPAC (search -> process.search redirect -> ajaxResults). No live catalog is contacted.
//   node --test test/polaris.mjs
import assert from "node:assert/strict";
import test from "node:test";

// Fresh module per test: the reader caches limits, parts and sessions per library id.
let n = 0;
const load = () => import("../readers/polaris.mjs?t=" + n++);

const ICONS = { b: ["40", "Blu-ray Disc"], d: ["33", "DVD"], k: ["01", "Book"], g: ["35", "Video Game"] };
// one brief record the way ajaxResults.aspx shows it (cut down to the parts the reader reads)
const block = (cn, title, kind, year = 2020) => `<div class="search__position">
  <a class="nsm-brief-action-link" href="title.aspx?ctx=1.1033.0.0.1&cn=${cn}">${title}</a>
  <img class="c-title-detail-formats__img" src="https://pac.example.org/polaris/themes/shared/formats/formatid${ICONS[kind][0]}.gif" alt="${ICONS[kind][1]}" title="${ICONS[kind][1]}" border="0"/>
  <span class="nsm-brief-label">Publisher, Date:</span><span class="nsm-short-item nsm-e1">Burbank : Studio, ${year}.</span>
  <span class="nsm-brief-label">Available Copies At All Libraries:</span> <span class="nsm-brief-inline-subzone">2 (of 3)</span>
</div>`;
const list = (total, blocks) => `<span class="result-count">1 - ${Math.min(100, total)} of ${total.toLocaleString("en-US")}</span>` + blocks.join("\n");
const menu = (opts) => `<select id="dropdownLimitFilter"><option selected="selected" value="TOM=*">All formats</option>` +
  opts.map(([v, l]) => `<option value="${v.replace(/"/g, "&quot;")}">${l}</option>`).join("") + `</select>`;

// answers: (limit, term, page) -> html fragment
function pac(menuHtml, answers) {
  const calls = [];
  const res = (status, body = "", headers = {}) => ({
    status, ok: status < 300,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null, getSetCookie: () => (headers["set-cookie"] ? [headers["set-cookie"]] : []) },
    async text() { return body; },
  });
  return {
    calls, log() {},
    async fetch(url, init = {}) {
      calls.push(url);
      const u = new URL(url);
      if (/default\.aspx$/i.test(u.pathname)) return res(200, menuHtml);
      if (/searchresults\.aspx$/i.test(u.pathname) && u.searchParams.get("limit")) {
        const sid = encodeURIComponent(JSON.stringify([u.searchParams.get("limit"), u.searchParams.get("term")]));
        return res(302, "", { location: "/polaris/process.search?cmd=FIND", "set-cookie": `s=${sid}; path=/` });
      }
      if (/process\.search/i.test(u.pathname)) return res(302, "", { location: "/polaris/search/searchresults.aspx" });
      if (/ajaxResults\.aspx$/i.test(u.pathname)) {
        const [limit, term] = JSON.parse(decodeURIComponent((init.headers?.cookie || "").match(/s=([^;]*)/)[1]));
        return res(200, answers(limit, term, +u.searchParams.get("page")));
      }
      return res(404);
    },
  };
}
const EVERYTHING = list(100000, [block(1, "Some book", "k"), block(2, "Another book", "k")]);   // a filter the PAC ignores

test("Salt Lake County: no Blu-ray filter is honoured, so Blu-rays come from a keyword search kept by format icon", async () => {
  const R = await load();
  const lib = R.libFromUrl("https://catalog.slcolibrary.org/polaris/default.aspx?ctx=1.1033.0.0.1");
  const ctx = pac(menu([["TOM=bks", "Book"], ["TOM=dvd", "DVD"], ["TOM=mcd", "Music CD"]]), (limit, term, page) => {
    if (limit === "TOM=dvd") return list(250, [block(10, "Alien [videorecording]", "d", 1979)]);
    if (limit === "TOM=*" && term === "blu-ray")
      return list(200, [block(20, "Dune : part two", "b", 2024), block(21, "Blu-ray players explained", "k"), block(22, "Arrival", "b", 2016), block(23, "Heat", "b", 2017)]);
    return EVERYTHING;   // TOM=brd, TOM=vgm and TOM=* are all "the whole catalog" here
  });
  const plan = await R.plan(lib, ctx);
  assert.deepEqual(plan.map((t) => t.f), ["b", "d"]);
  const b = plan[0];
  assert.deepEqual(b.parts.map((p) => [p.lim, p.term, p.keep]), [["TOM=*", "blu-ray", "b"]]);
  assert.equal(b.pages, 2);
  assert.equal(b.count, 150);   // 200 hits x 3 of 4 rows with the Blu-ray icon
  assert.ok(ctx.calls.some((c) => /limit=TOM=brd/.test(c)), "tried the standard Blu-ray code first");
  assert.ok(ctx.calls.some((c) => /term=blu-ray&by=KW/.test(c)), "keyword search for blu-ray");
  const rows = await R.page(lib, b, 1, ctx);
  assert.deepEqual(rows.map((r) => [r.id, r.f, r.title, r.sub, r.disc]), [["20", "b", "Dune", "part two", 2024], ["22", "b", "Arrival", "", 2016], ["23", "b", "Heat", "", 2017]]);
  const d = await R.page(lib, plan[1], 1, ctx);
  assert.deepEqual(d.map((r) => [r.id, r.f, r.title]), [["10", "d", "Alien"]]);
});

test("Onondaga: a DVD option labelled 'DVD - All Libraries' is read as DVD", async () => {
  const R = await load();
  const lib = R.libFromUrl("https://catalog.onlib.org/polaris/");
  const ctx = pac(menu([["TOM=brd", "Blu-ray Disc - All Libraries"], ["TOM=dvd", "DVD - All Libraries"], ["TOM=vgm", "Video Game"],
    ["TOM=bdv", "Blu-ray + DVD"], ["TOM=bkv", "Book + DVD"], ["(TOM=mcd OR TOM=msr) AND AB=*", "Music - All Libraries"]]), (limit) => {
    const one = { "TOM=brd": ["b", 30], "TOM=dvd": ["d", 40], "TOM=vgm": ["g", 5], "TOM=bdv": ["b", 7] }[limit];
    return one ? list(one[1], [block(limit.length * 100 + one[1], "Title " + limit, one[0])]) : EVERYTHING;
  });
  const plan = await R.plan(lib, ctx);
  assert.deepEqual(plan.map((t) => [t.f, t.count, t.parts.map((p) => p.lim).join(",")]), [["b", 37, "TOM=brd,TOM=bdv"], ["d", 40, "TOM=dvd"], ["g", 5, "TOM=vgm"]]);
  assert.ok(!ctx.calls.some((c) => /limit=TOM=bkv|AB=/.test(c)), "Book + DVD and music are not searched");
});

test("DVD labels: plain and scoped ones count, combos and audiobooks do not", async () => {
  const R = await load();
  const lib = R.libFromUrl("https://pac.example.org/polaris/");
  const labels = [["TOM=dvd", "DVDs"], ["TOM=dv2", "DVD (all branches)"], ["TOM=bkv", "Book + DVD"], ["TOM=adv", "Audiobook on DVD"], ["TOM=dvx", "DVD and Blu-ray"]];
  const ctx = pac(menu(labels), (limit) => (limit === "TOM=*" ? EVERYTHING : list(3, [block(limit.charCodeAt(5), "X", "d")])));
  const plan = await R.plan(lib, ctx);
  assert.deepEqual(plan.find((t) => t.f === "d").parts.map((p) => p.lim), ["TOM=dvd", "TOM=dv2"]);
});

test("Arlington: '(TOM=dvd) not (TOM=brd)' does not count as listing Blu-ray, so TOM=brd is tried; a 1000-hit list is logged as cut", async () => {
  const R = await load();
  const lib = R.libFromUrl("https://polarisweb.arlingtonlibrary.org/polaris/default.aspx");
  const notes = [];
  const ctx = pac(menu([["(TOM=dvd) not (TOM=brd)", "DVD"], ["TOM=vgm", "Video Game"], ["TOM=bdv", "Blu-ray + DVD"]]), (limit) => {
    if (limit === "(TOM=dvd) not (TOM=brd)") return list(1000, [block(5, "Moonstruck", "d")]);
    if (limit === "TOM=brd") return list(400, [block(6, "Creed II", "b")]);
    if (limit === "TOM=bdv") return list(28, [block(7, "Toy story 5", "b")]);
    if (limit === "TOM=vgm") return list(9, [block(8, "Halo", "g")]);
    return EVERYTHING;
  });
  ctx.log = (...a) => notes.push(a.join(" "));
  const plan = await R.plan(lib, ctx);
  assert.deepEqual(plan.map((t) => [t.f, t.count]), [["b", 428], ["d", 1000], ["g", 9]]);
  assert.deepEqual(plan[0].parts.map((p) => p.lim), ["TOM=bdv", "TOM=brd"]);
  assert.equal(plan[1].parts.length, 1, "a 1000 cap is not re-sorted (every sort reorders the same 1000)");
  assert.ok(notes.some((x) => /stops at 1000 hits/.test(x)));
});

test("a library with real Blu-ray and game filters gets no extra probes or keyword searches", async () => {
  const R = await load();
  const lib = R.libFromUrl("https://pac.example.org/polaris/");
  const ctx = pac(menu([["TOM=brd", "Blu-ray"], ["TOM=dvd", "DVD"], ["TOM=vgm", "Video games"]]), (limit) =>
    limit === "TOM=*" ? EVERYTHING : list(12, [block(limit.charCodeAt(4), "X", "d")]));
  const plan = await R.plan(lib, ctx);
  assert.deepEqual(plan.map((t) => t.f), ["b", "d", "g"]);
  assert.ok(!ctx.calls.some((c) => /term=blu-ray/.test(c)));
  assert.equal(ctx.calls.filter((c) => /searchresults\.aspx/.test(c)).length, 4);   // TOM=* once, then one search per format
});
