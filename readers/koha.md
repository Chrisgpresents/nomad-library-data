# koha

Feasibility: YES (11.25.26), through Koha's public REST API, not the search pages.

- Endpoint: `GET {base}/api/v1/public/items?q=<json>&_per_page=1000&_page=N&_order_by=+me.biblio_id&_order_by=+me.item_id`
  with header `x-koha-embed: biblio` (each item carries its title record). Needs the system preference
  **RESTPublicAPI** on (default on in recent Koha). Off answers 401/403: the copier stops for that library (permanent
  error), it never falls back to the search pages.
- `_order_by=+biblio_id` answers 500 when the title is embedded (ambiguous column): it must be `me.biblio_id`.
- Formats: item type codes are found by name. Each probe asks for one item whose `item_type_id` is LIKE
  %DVD%/%BLU%/%VID%/%GAME%/... and NOT IN the codes found so far (`x-koha-embed: +strings` gives the type's name), so
  a catalog costs about 1 probe per video type. Board games, VHS, kits and players are skipped by name.
- Many libraries file Blu-rays under a DVD type (CCLS): a row moves to Blu-ray when its call number, title, edition or
  medium says Blu-ray/4K/UHD.
- Rows: one per title record (`biblio_id`), items grouped; on the shelf when any copy has no `checked_out_date` and no
  not-for-loan/damaged/lost/withdrawn status (negative not-for-loan = on order). Withdrawn and lost items are filtered
  out in the query. No holds count in the public API (0). Cover: Amazon image by ISBN when the record has one
  (what Koha's own OPAC does); otherwise the site's title card.
- One member library of a shared catalog: a link with `?limit=branch:CODE` (or `?branch=CODE`) gives the id
  `koha.<host>_<code>`, filtered on `home_library_id`.
- Polite: 1 request a second per host (copier), ~10-16 s per 1,000-item page, one page in flight is plenty.

Measured 11.25.26 (try-koha.mjs: plan + first page of each format):

| Library | Items (b / d / g) | Requests for a full copy | Notes |
|---|---|---|---|
| Chautauqua-Cattaraugus (catalog.cclsny.org), ~30 member libraries | 0 / 79,164 / 623 | ~96 | search pages answer 429 "Library access" gate, API open; Blu-rays inside DVD types (call number "Blu-ray ...") |
| Fargo (catalog.fargolibrary.org) | 1,309 / 15,649 / 1,883 | ~34 | own Blu-ray types, platforms from the title |
| Bossier Parish (catalog.bossierlibrary.org) | 0 / 28,239 / 0 | ~36 | "GAME" types are board/in-library games |
| Ottumwa (catalog.ottumwapubliclibrary.org) | 0 / 5,869 / 0 | ~12 | |

Old notes (11.1.26): catalog.cclsny.org answered every search with 429 and catalog.hmcpl.org with a Cloudflare
challenge; the search/RSS route is still blocked there, the API route is what works.
