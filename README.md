# nomad-library-data
The library copier behind [Nomad Library](https://library.nomadovernormal.com). Site code, issues and the contributor guide: [Chrisgpresents/nomad-library](https://github.com/Chrisgpresents/nomad-library).

**Want your library's catalog system supported?** Write a reader: start with [readers/README.md](readers/README.md) (the interface) and a working reader like [readers/vega.mjs](readers/vega.mjs), test it with `node test/e2e.mjs`, and open a pull request here. Find your system's issue under [library-request](https://github.com/Chrisgpresents/nomad-library/labels/library-request). Readers must stay polite: pace requests (1 per second per host), and never get around bot protection a library has put up.

Licensed under the [GNU AGPL v3](LICENSE).

Weekly copies of public library catalogs for https://library.nomadovernormal.com.

## The weekly rotation (since 11.21.26)
The BiblioCommons gateway refuses GitHub's address after ~35 to 65 requests in a row, at any pace (since 11.10.26).
So the copier tiptoes instead of copying live:
- One burst of at most 30 gateway requests, then none for an hour; at most 300 a day (`GW_BURST`, `GW_GAP_MIN`, `GW_DAY_MAX`).
- Each day it tops up the oldest 1/7 of the BiblioCommons copies (198 libraries = 29 a day), plus any copy older than
  7 days, so every library gets its new Blu-rays, DVDs and games, and the shelf status and holds of those newest
  titles, about once a week (`ROTATION_DAYS`). A top-up reads each format newest first until a page brings nothing new,
  at most 10 pages a format, so one top-up fits in one burst.
- A top-up always rewrites the copy, so its `finished` time is when the library was last read: the site shows it as
  "updated <date>".
- A 403 ends the burst at once. No probing: the next burst waits 3 hours and is 5 requests smaller (never under 10).
  Every block is in `status.json` under `gateway.blocks`; each day's totals are under `gateway.rot` and `gateway.days`.
- No full BiblioCommons re-copies while rotating (about 1,000 requests each would never fit). Leftover burst room goes
  to new BiblioCommons libraries, which copy a burst at a time.
- Same `NomadLibrary/1.0` user agent, one runner at a time, no address tricks. `GW_BURST=0` turns the rotation off.
- Readers (Vega, Polaris, Aspen, ...) ask the library's own catalog, not the gateway, and still refresh every 2 days.
`crawl.mjs` runs daily on GitHub Actions and publishes `snap/<slug>.json` to GitHub Pages (branch gh-pages).
No keys, no servers, nothing on a Cloudflare Worker.

## Capacity (measured 10.11.26 on GitHub-hosted runners; out of date since 11.10.26, see the weekly rotation above)
- The library gateway allows an address about 480 requests, then answers 403 for about 3 minutes, then allows about 480 more (two cycles seen, no 429 or 5xx). Page size is capped at 25 titles whatever `limit` says, so a library costs about titles / 25 + 3 requests (Alameda: 25,393 titles = 1,018 requests).
- A steady 1.1 requests/s (with 2 in flight; slow libraries like New York need 4 so latency does not cap the rate) copied Alameda in 15.5 minutes with no 403 at all, the same speed as bursting and waiting out blocks (1.2/s average). That is the default. The copier still waits out a block with one probe a minute if one happens.
- Throughput is therefore about 95,000 requests a day, roughly 89 average libraries (mean 26,652 titles, 1,069 requests). 100 requested libraries take about a day, 300 about 3 days. Copies refresh every 14 days (a 300 library steady state uses about 22% of capacity).
- Not done on purpose: running several runners at once to get more addresses past the allowance.

## Other catalog systems (since 11.1.26)
- `readers/<system>.mjs` (vega, polaris, enterprise, carl, spydus, encore, open, corvina, aspen) follow `readers/README.md`. A wanted entry whose id has a dot
  (`vega.sdpl.na5.iiivega.com`) is copied by its reader through `ctx.fetch`, paced at READER_RATE (1/s) per library host,
  never through the BiblioCommons gateway. The wanted list carries the visitor's catalog link (4th field); it is kept in
  the state and in index.json for refreshes. Manual runs: `ONLY_URLS="id|url,..." node crawl.mjs --only id,...`.
- Reader copies go first in each 15 minute slice and refresh every 2 days (READER_STALE_DAYS). The schedule runs every
  15 minutes so a new request is copied soon; an idle run exits in seconds.
- Every row of a reader copy gets IMDb's genres (site `ix/genres.json`); snap files also carry `rec` (record link
  template, `{id}`) and `sys`.
- Measured 11.1.26: Vega 1,000 titles per request (Jefferson County 42k titles in 51 requests, 91 s; Vega stops at
  result 10,000, so big formats are split into year ranges; title order pages without repeats). Polaris 100 per
  request (53 to ~720 requests). Enterprise 100 per request plus one availability call per page. LS2 PAC 50 per request.
- Aspen Discovery (`readers/aspen.mjs`): `GET {base}/API/SearchAPI?method=search` with `lookfor=*:*`, `searchSource=local`,
  `sort=title` and one `filter[]=format:"…"` task per disc or game facet (Blu-ray tasks run first, because one grouped
  work id is shared by every format and the copier keeps the first). Page size asked is 50; the reader then uses the
  size the catalog reports, up to 50. Hosts tried on 11.20.26 answered Cloudflare 403 or an Anubis HTML wall (see
  `readers/aspen.md`). That is a hard failure. The reader does not solve the challenge. A catalog that returns JSON is
  copied. `available_at` is not in the default search fields, so avail stays unknown unless a record happens to include it.
