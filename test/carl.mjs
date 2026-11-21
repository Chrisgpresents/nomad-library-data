// CARL reader against canned /search answers. No live catalog is contacted.
//   node --test test/carl.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { libFromUrl, plan, page } from "../readers/carl.mjs";

const LIB = libFromUrl("https://handleyregional.tlcdelivers.com/#/search/ls?view=list");
const res = (id, format, shortTitle, year = "2020") => ({ id, rtype: 1, format, shortTitle, publicationDate: { publicationDate: year }, holdingsInformations: [{ onshelf: true }] });
// recorded from Handley's "video game" search (first hits, trimmed)
const VIDEO_GAME = [
  res(1, "Software", "1-2-Switch [Nintendo Switch electronic game (chip)].", "2017"),
  res(2, "Book", "1:35 A.M."),
  res(3, "DVD", "101 Dalmatians II : Patch's London adventure [electronic resource]"),
  res(4, "Software", "Animal crossing : new horizons [Nintendo Switch electronic game (chip)].", "2020"),
  res(5, "Software", "Halo infinite [Xbox Series X electronic game (disc)].", "2021"),
  res(6, "Software", "Typing tutor [computer program]."),
  res(7, "Book", "25 Scratch 3 games for kids : a playful guide to coding"),
];
function ctxFor() {
  const calls = [];
  return {
    calls, log() {},
    async fetch(url, init) {
      const q = JSON.parse(init.body);
      calls.push(q.searchTerm);
      const body = q.searchTerm === "video game" ? { totalHits: 1771, resources: VIDEO_GAME } : { totalHits: 2, resources: [res(10, "DVD", "Heat"), res(11, "Blu-Ray", "Dune")] };
      return { ok: true, status: 200, async text() { return JSON.stringify(body); } };
    },
  };
}

test("Handley: games filed as 'Software' are found by their [... electronic game] title note", async () => {
  const ctx = ctxFor();
  const tasks = await plan(LIB, ctx);
  assert.deepEqual(tasks.map((t) => [t.f, t.q]), [["d", "dvd"], ["g", "video game"]]);
  const rows = await page(LIB, tasks[1], 1, ctx);
  assert.deepEqual(rows.map((r) => [r.id, r.f, r.title, r.plat]), [
    ["1", "g", "1-2-Switch", "Nintendo Switch electronic game (chip)"],
    ["4", "g", "Animal crossing : new horizons", "Nintendo Switch electronic game (chip)"],
    ["5", "g", "Halo infinite", "Xbox Series X electronic game (disc)"],
  ]);
});

test("discs keep their own format, and software without a game note is not a game", async () => {
  const ctx = ctxFor();
  const tasks = await plan(LIB, ctx);
  const rows = await page(LIB, tasks[0], 1, ctx);
  assert.deepEqual(rows.map((r) => [r.id, r.f]), [["10", "d"], ["11", "b"]]);
  const g = await page(LIB, tasks[1], 1, ctx);
  assert.ok(!g.some((r) => r.id === "6" || r.id === "3"));
});
