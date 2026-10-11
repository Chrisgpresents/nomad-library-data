// A fake library gateway + fake site for testing crawl.mjs without touching any real library.
//   node test/mock.mjs <port> <configfile>
// config.json: { libs: { slug: { BLURAY: pages, DVD: pages, VIDEO_GAME: pages, delayMs } }, wanted: [[slug,name,at]] | "old",
//                fail: { "slug:FMT:page": status | "always500" , once429: ["slug:FMT:page"] }, shardDir }
import http from "node:http";
import fs from "node:fs";
const [port, cfgPath] = [process.argv[2], process.argv[3]];
const hits = { pages: 0, byKey: {}, shard: 0, want: 0 }, seen429 = new Set();
const TITLES = ["Alien", "Jaws", "Heat", "Casablanca", "Vertigo", "Psycho", "Rocky", "Fargo", "Se7en", "Taxi Driver", "Gladiator", "Titanic", "Up", "Cars", "Coco", "Brave", "Her", "Drive", "Heat", "Ran"];
http.createServer((req, res) => {
  const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  const u = new URL(req.url, "http://x");
  const m = u.pathname.match(/^\/v2\/libraries\/([^/]+)\/bibs\/search$/);
  if (m) {
    const slug = m[1], fmt = u.searchParams.get("f_FORMAT"), page = +u.searchParams.get("page");
    const lib = cfg.libs[slug]; if (!lib) { res.writeHead(404); return res.end("{}"); }
    const key = `${slug}:${fmt}:${page}`;
    hits.pages++;
    if (cfg.blockAfter && hits.pages > cfg.blockAfter) { hits.blocked = (hits.blocked || 0) + 1; res.writeHead(403); return res.end("{}"); } hits.byKey[key] = (hits.byKey[key] || 0) + 1;
    const send = () => {
      const f = cfg.fail?.[key];
      if (f === "always500") { res.writeHead(500); return res.end("{}"); }
      if (cfg.once429?.includes(key) && !seen429.has(key)) { seen429.add(key); res.writeHead(429, { "retry-after": "1" }); return res.end("{}"); }
      const pages = lib[fmt] ?? 0;
      const results = [], bibs = {};
      if (pages && page <= pages) for (let i = 0; i < (lib.thin ? 5 : 25); i++) {
        const n = (page - 1) * 25 + i, id = `${slug}-${fmt[0]}-${n}`, t = TITLES[n % TITLES.length];
        results.push({ representative: id });
        bibs[id] = { briefInfo: { title: t, subtitle: "", publicationDate: "2012", subjectHeadings: ["Drama"], genreForm: [], jacket: { medium: `https://secure.syndetics.com/index.aspx?isbn=${n}/MC.GIF&client=testlib&type=xw12&oclc=&upc=${n}` } }, availability: { status: n % 3 ? "AVAILABLE" : "UNAVAILABLE", heldCopies: n % 4 } };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ catalogSearch: { pagination: { pages: Math.max(pages, 1), count: pages * 25 }, results }, entities: { bibs } }));
    };
    return lib.delayMs ? setTimeout(send, lib.delayMs) : send();
  }
  if (u.pathname === "/api/want") {
    hits.want++;
    if (cfg.wanted === "old") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify([["a", "A"]])); }
    res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ wanted: cfg.wanted || [] }));
  }
  if (u.pathname.startsWith("/ix/")) {
    hits.shard++;
    const f = `${cfg.shardDir}${u.pathname.slice(3)}`;
    if (fs.existsSync(f)) { res.writeHead(200, { "content-type": "application/json" }); return res.end(fs.readFileSync(f)); }
    res.writeHead(200, { "content-type": "text/html" }); return res.end("<html>home page fallback</html>");   // like the real site for a missing shard
  }
  if (u.pathname === "/__hits") { res.writeHead(200); return res.end(JSON.stringify(hits)); }
  res.writeHead(404); res.end();
}).listen(+port, () => console.log("mock on", port));
