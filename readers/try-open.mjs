// node readers/try-open.mjs <catalog url>  -> plan + first page's first 3 rows of each task (paced 1 request/s)
import * as R from "./open.mjs";
const lib = R.libFromUrl(process.argv[2] || "https://katalog.stadtbuecherei.frankfurt.de/");
let last = 0, n = 0;
const ctx = { log: console.log, async fetch(url, init = {}) {
  const wait = last + 1000 - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait)); last = Date.now(); n++;
  return fetch(url, { ...init, headers: { "User-Agent": "Mozilla/5.0 NomadLibrary", ...(init.headers || {}) } });
} };
console.log(lib, "\nname:", await R.libraryName(lib, ctx));
const plan = await R.plan(lib, ctx);
console.table(plan.map(({ key, f, group, av, count, pages }) => ({ key, f, group, av, count, pages })));
for (const t of plan) { const t0 = Date.now(); const rows = await R.page(lib, t, 1, ctx); console.log(t.key, rows.length, "rows,", Date.now() - t0, "ms"); console.log(rows.slice(0, 3)); }
console.log("requests:", n, " full copy needs about", plan.reduce((s, t) => s + t.pages, 0) + n, "requests");
console.log("record link:", R.recordTemplate(lib));
