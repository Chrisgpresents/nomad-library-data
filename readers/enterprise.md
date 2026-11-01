# SirsiDynix Enterprise reader (`enterprise.mjs`)

**Feasibility: YES** for 9 of 10 test libraries. Griver (`search.griver.org`) is NO (see below).

## Endpoints (all plain GET/POST, no keys)
- Results: `{base}/search/results?qu=&qf=<facet>&ps=100&rw=<offset>`. `base` = `https://host/client/en_US/<profile>`
  (profile matters: default, FPL, als, boone; `/client/boone` redirects to `/client/en_US/boone`). `qu=` (empty) lists
  the whole catalog (`qu=*` returns 0). `rw` is a 0-based offset and `ps` is honoured (100 and 300 tested; 1000 gives 999).
  `ps=1` makes the server 302 to the record, so plan() uses `ps=2`. Order is stable across pages (0 dups on 400-row samples).
- Facets: same page lists every facet value with its count (`navigatorclick?qf=...` + `navigatorCount`), complete lists.
  plan() reads them from `qu=&ps=2` (1 request). The `qf=` string is reused verbatim.
- Availability and holds: HTML has an empty "Available:" span; the browser fills it with
  `POST {base}/search/results.displaypanel.any_0:loadavailability/<Tapestry-encoded JSON {"ILS":["ent://SD_ILS/0/SD_ILS:ID",...]}>`
  (`X-Requested-With: XMLHttpRequest`, empty body). Returns `availableCount, copyCount, holdCount` per title. No token or
  cookie needed. Ids go in the URL, so max about 100 per call (6 KB URL ok, 17 KB gives 414). Costs about 3-5 s per 100 ids.
  If the call fails the page still returns rows with avail 0, holds 0.
- RSS (`/client/rss/hitlist/<profile>/qu=...`): ignores `rw` and `ps`, always returns the first 300 hits, no availability,
  no covers except a "View cover art" link. Useless for a full copy; not used.
- Record link: `{base}/search/detailnonmodal/ent:$002f$002fSD_ILS$002f0$002fSD_ILS:{id}/one`. Row id = the SD_ILS title key.
  Only SD_ILS (shelf) records are kept; OverDrive/Hoopla/etc. records are skipped.

## Format filters (the hard part: every library differs)
plan() picks, from the facet list: DVD = Material Type/Format value whose label contains "DVD" (skipping ITEMCAT*, which
libraries use loosely, e.g. Broward tags books "Blu-ray"); else FORMAT=VIDEODISC. Blu-ray = a label matching blu-ray/UHD/4K;
if none, it searches `qu=blu-ray` inside the DVD set and keeps rows whose title/edition says Blu-ray (DVD rows with that text
are dropped from the DVD set: `mixed: true`). Games = labels like Video Games/Games/PlayStation/Switch/Xbox. Platform comes
from the facet label or the title "[PlayStation 5]". Several facet values per format (OCPL, Pratt, LAFLA, Boone) are
separate "parts": separate `qf` values AND together (not OR), so `pages` is the sum over parts and page(n) maps into a part.
Task objects carry `parts`/`mixed`; page() rebuilds them with plan() if missing.

## Row data
title, sub (split at ": " or ". "), disc year (Publication Date), cover ("View cover art" link, else Syndetics image URL,
which may be blank for unknown items), avail and holds (from the AJAX call). `subj` is not in the result list (always "").

## Per-library measurements (ps=100; requests = pages x 2 + ~3, s/req from the harness incl. availability calls)
| Library | DVD | Blu-ray | Games | requests (full) | s/req | notes |
|---|---|---|---|---|---|---|
| cbpl default | 11,387 | 501 | 0 | ~240 | 2.2 | clean facets |
| broward default | 30,093 (Video disc) | ~5 via text | 1,302 | ~660 | 1.8 | mixed; DVD set has some DVD-ROM junk |
| ocpl default | 28,491 (DVD ent. + nonfic) | 4,777 via text | none | ~680 | 2.1 | Blu-rays live inside DVD ITYPE |
| pratt default | 21,441 | 1,391 | 1,298 | ~490 | 3.7 | clean facets |
| lafla default | 25,565 | ~2,400 via text | 430 | ~590 | 1.8 | 4 DVD ITYPE codes |
| semc default | 3,257 | few via text | none | ~80 | 2.4 | Blu-rays mostly unlabelled: undercount |
| fullerton FPL | 8,637 (FORMAT=DVD) | ~100 via text | none | ~200 | 1.1 | year field is PUBDATE_260 |
| arrowhead als | 26,682 | 881 | 221 | ~600 | 0.75 | clean facets (custom ARROWHEAD_FORMAT) |
| boone | 17,208 (Video disc) | ~68 hits, few real | 1,365 | ~380 | 3.5 | no DVD label; games by platform values |
| griver | blocked | | | | | NO |

Counts for "via text" libraries and mixed sets are upper bounds (trailing pages can be short or empty).

## Griver: NO
`search.griver.org` answers every HTML results request with 403 and a "Checking your connection / Verifying your browser"
page (JS challenge), also on the availability POST. Only the RSS path (`/client/rss/hitlist/default/qu=...`) answers (200),
but it is capped at 300 hits with no offset or facet list, so a full copy is not possible without a browser.

## Quirks
- OCPL's home page also showed the same "Checking your connection" page once; results pages were fine. getText() throws on it.
- Blu-ray detection in mixed libraries is title/edition text only (precision over recall).
- A record carrying two facet values (e.g. two ITYPEs) in one library can appear in two parts: copier should dedupe by id.
