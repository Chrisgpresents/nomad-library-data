// node readers/try-aspen.mjs <catalog-url>
// node readers/try-aspen.mjs --fixture
// Prints the plan and the first three rows of the first page. Live catalogs are read with one request at a time.
import { libFromUrl, plan, page, recordTemplate, libraryName } from "./aspen.mjs";

const FIXTURE = {
  recordCount: 3,
  paging: { itemsPerPage: 50, totalItems: 3, totalPages: 1, currentPage: 1 },
  facetSet: {
    format: {
      list: {
        DVD: { value: "DVD", display: "DVD", count: 2 },
        "Blu-ray": { value: "Blu-ray", display: "Blu-ray", count: 1 },
      },
    },
  },
  recordSet: [{
    id: "gw1", title_display: "Alien [videorecording] : Covenant / someone", title_short: "Alien [videorecording] : Covenant",
    publishDate: ["2017"], format: ["Blu-ray"], topic_facet: ["Science fiction films"], total_holds: 4,
  }],
};

function fixtureFetch(url) {
  const u = new URL(url);
  if (u.pathname === "/" || u.pathname === "") return { ok: true, status: 200, text: async () => "<title>Sample Public Library Catalog</title>" };
  const filter = u.searchParams.get("filter[]") || "";
  const body = { ...FIXTURE, recordSet: filter.includes("Blu-ray") ? FIXTURE.recordSet : [] };
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

const arg = process.argv[2];
if (!arg) {
  console.error("usage: node readers/try-aspen.mjs <catalog-url>");
  console.error("       node readers/try-aspen.mjs --fixture");
  process.exit(1);
}

const live = arg !== "--fixture";
const lib = libFromUrl(live ? arg : "https://sample.aspendiscovery.org/");
if (!lib) { console.error("not an aspen catalog address"); process.exit(1); }
const ctx = {
  log: (...a) => console.log(...a),
  fetch: async (url, init) => {
    if (!live) return fixtureFetch(url);
    const r = await fetch(url, init);
    return r;
  },
};

console.log(lib);
console.log("record", recordTemplate(lib));
try {
  const tasks = await plan(lib, ctx);
  console.log("plan", tasks);
  const name = await libraryName(lib, ctx);
  if (name) console.log("name", name);
  if (!tasks.length) { console.log("no disc or game formats"); process.exit(0); }
  const rows = await page(lib, tasks[0], 1, ctx);
  console.log("page", rows.slice(0, 3));
} catch (e) {
  console.error(e.permanent ? "permanent: " + e.message : e.message);
  process.exit(1);
}
