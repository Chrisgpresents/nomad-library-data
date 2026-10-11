# nomad-library-data
Weekly copies of public library catalogs for https://library.nomadovernormal.com.
`crawl.mjs` runs daily on GitHub Actions and publishes `snap/<slug>.json` to GitHub Pages (branch gh-pages).
No keys, no servers, nothing on a Cloudflare Worker.

## Capacity (measured 10.11.26 on GitHub-hosted runners)
- The library gateway allows an address about 480 requests, then answers 403 for about 3 minutes, then allows about 480 more (two cycles seen, no 429 or 5xx). Page size is capped at 25 titles whatever `limit` says, so a library costs about titles / 25 + 3 requests (Alameda: 25,393 titles = 1,018 requests).
- A steady 1.1 requests/s (with 2 in flight; slow libraries like New York need 4 so latency does not cap the rate) copied Alameda in 15.5 minutes with no 403 at all, the same speed as bursting and waiting out blocks (1.2/s average). That is the default. The copier still waits out a block with one probe a minute if one happens.
- Throughput is therefore about 95,000 requests a day, roughly 89 average libraries (mean 26,652 titles, 1,069 requests). 100 requested libraries take about a day, 300 about 3 days. Copies refresh every 14 days (a 300 library steady state uses about 22% of capacity).
- Not done on purpose: running several runners at once to get more addresses past the allowance.
