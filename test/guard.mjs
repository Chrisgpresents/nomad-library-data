// The public-address guard in crawl.mjs: visitor-supplied catalog links must never reach private or metadata addresses.
import fs from "node:fs"; import dns from "node:dns/promises"; import net from "node:net"; import http from "node:http";
const src = fs.readFileSync(new URL("../crawl.mjs", import.meta.url), "utf8");
const block = src.slice(src.indexOf("function privateIp("), src.indexOf("const READER_RATE ="));
const { assertPublic, publicFetch, cleanError } = new Function("dns", "net", "fetch", block + "; return { assertPublic, publicFetch, cleanError };")(dns, net, fetch);
let pass = 0, fail = 0; const ok = (c, m) => { c ? pass++ : fail++; console.log((c ? "  pass: " : "  FAIL: ") + m); };
const refused = async (u) => { try { await assertPublic(u); return false; } catch (e) { return /refused/.test(e.message); } };
for (const u of ["http://127.0.0.1/", "http://169.254.169.254/metadata", "http://10.0.0.5/", "http://192.168.1.1/", "http://172.20.0.1/",
  "http://100.64.0.1/", "http://0.0.0.0/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00::1]/", "http://localhost/",
  "http://127.0.0.1.nip.io/", "http://169.254.169.254.nip.io/", "file:///etc/passwd", "http://user:pw@example.com/"])
  ok(await refused(u), "refuses " + u);
ok(!(await refused("https://sdpl.na5.iiivega.com/")), "allows a real catalog");
// a public-looking first hop that redirects to a private address is refused at the hop
const srv = http.createServer((q, r) => { r.writeHead(302, { location: "http://169.254.169.254/latest" }); r.end(); }).listen(0);
await new Promise(r => srv.on("listening", r));
const s2 = block.replace("await assertPublic(cur);", "if (hop) await assertPublic(cur);");   // let hop 0 reach the local test server
const g2 = new Function("dns", "net", "fetch", s2 + "; return { publicFetch };")(dns, net, fetch);
try { await g2.publicFetch(`http://127.0.0.1:${srv.address().port}/`); ok(false, "redirect to metadata refused"); }
catch (e) { ok(/refused/.test(e.message), "redirect to metadata refused (" + e.message + ")"); }
srv.close();
ok(cleanError("no result list in answer (41022 bytes): <!doctype html><html>secret") === "no result list in answer", "page content never echoed");
ok(cleanError("HTTP 405 from x.spydus.co.uk") === "HTTP 405 from x.spydus.co.uk", "own messages kept");
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
