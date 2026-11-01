# Polaris PowerPAC reader (`polaris.mjs`)

Feasibility: YES (no keys, no login, plain GET + a session cookie). Tested with `node try-polaris.mjs <url> [x]` (x also fetches each last page) and `node sum.mjs <url>`.

## How it works
1. `GET {base}/search/searchresults.aspx?[ctx=..&]type=Advanced&term=*&by=KW&sort=PD&page=0&limit=TOM=dvd` -> 302 + `Set-Cookie` (ASP.NET session), then 302 to `{base}/process.search?cmd=FIND...` (this runs the search and stores it in the session), then 302 back to searchresults.aspx (an empty shell, results load by ajax; we skip it).
2. `GET {base}/search/components/ajaxResults.aspx?page=N&hpp=100` with the cookie -> HTML fragment: "1 - 100 of 34459" plus 100 brief records. Needs the session; `hpp` sticks in the session, we send it every time. Some hosts 301 to lowercase `ajaxresults.aspx` (Inland); fetch must follow it.
3. The reader keeps the cookie in memory per (library, limit, sort) and reuses it, so a page costs 1 request (3 only to open or re-open a session; it re-opens itself when the answer lacks a result list).
- Page size: 100 is the max (menu offers 10/20/30/50/100; 200 silently falls back to 10). A 100-record page is 0.9 MB, 0.7 to 1.6 s.
- Term `*` with `by=KW` matches everything; empty term returns nothing. `sort=PD` works (newest first).
- No RSS, no JSON found; ajaxResults is HTML. PAPI not used.
- Record link: `{base}/search/title.aspx?[ctx=..&]cn={id}` (id = bib record number).

## Format filter
`limit=TOM=<code>`. Codes read in `plan()` from the Advanced search page `<option value="TOM=xxx">label`: label Blu-ray -> b (brd, and bdv "Blu-ray + DVD"), DVD -> d (dvd), Video game(s) -> g (vgm). Labels may start with "-- " (CLC). "OR"/"AND" inside `limit` is NOT honoured (CLC: `TOM=brd OR TOM=bdv` returned the whole catalog), so each code is its own search and the reader maps page numbers onto the codes in turn (`task.parts`). Dallas's own "Blu-ray and DVD" combo option is skipped. SLCO and Fairfax have no Blu-ray or game code; Blu-ray is mixed into DVD there.

## Row fields
title/sub: from the title link (strips `[videorecording]`, ` / ...`, splits on `: `). disc: first year in "Publisher, Date", else the pub-year badge; years > next year or < 1900 become 0. cover: syndetics/chilifresh URL from the record (empty when no UPC; the URL itself may still return a blank image). avail: first number of "Local Availability: 3 (of 5)" or "Available Copies ...", else 0. holds: "Holds:" line, else 0 (many libraries do not show it). subj: not in the brief list at any library, always "". plat: guessed from title/call number for games (Switch, PS5, Xbox Series X ...), often "".

## Quirks
- 10000 result cap (Inland; CLC "100000+" only when the limit was ignored): a list is cut at exactly 10000. The reader then re-runs the same search under sort TI, CALL and AU_PD, giving up to 4 x 10000 rows with overlap (Inland DVD: 800 pages fetched gave ~645 unique ids per 800 sampled rows). `count`/`pages` for such a format are inflated; the copier must dedupe by id. Full coverage of a capped format is not guaranteed.
- ctx: kept in the id as `_1-1033-0-0-1` (dots -> dashes). Without ctx the PAC adds the default ctx itself (fwpl, aberdeen, klamath, knox). CLC `ctx=34` is accepted.
- Base keeps the path case the visitor used (`/POLARIS`, `/Polaris`); the server redirects to lowercase `/polaris`, fine.
- Zero hits returns a bare fragment with no result-count (handled as 0).
- ctx.fetch must pass `init` through (`redirect:"manual"`, `headers.cookie`) and expose `res.headers.getSetCookie()` (standard Node fetch does).
- Availability is a snapshot at copy time; Fairfax, HCPLC (DVD), Klamath show no availability in brief results (avail 0 = unknown).

## Measured (1 req/s pacing, ~0.4 to 1.0 s/request answer time)
| Library | b | d | g | requests for full copy (pages) | covers / avail / holds |
|---|---|---|---|---|---|
| slcolibrary (ctx 1.1033.0.0.1) | none (in DVD) | 34,459 | none | 345 | yes / yes / yes |
| dallaslibrary (ctx ...0.6) | 10,568 | 53,456 | none | 641 | yes / yes / yes |
| hcplc | 3 | 45,091 | 1 | 453 | yes / DVD no / yes |
| clcohio (ctx=34) | 8,870 | 59,545 | 3,173 | 718 | yes / yes / yes |
| knox | 2,385 | 18,151 | 1,426 | 222 | yes / yes / no |
| fwpl | 7,559 | 24,121 | 1,010 | 329 | mostly / yes / yes |
| alexandria | 6 | 10,584 | none | 107 | yes / yes / no |
| aberdeensd | 266 | 4,977 | 0 | 53 | yes / yes / no |
| klamath | 898 | 19,966 | 2,088 | 230 | yes / no / no |
| inland | 2,460 | 10,000 (capped) | 649 | 33 + up to 400 for capped slices | yes / yes / no |
| fairfax (host root, ctx 1.1033.0.0.1) | none | 5,535 | none | 56 | yes / no / yes |
(Counts include every item with that material type, not only the ones listed here; hcplc "Videorecording" vid and CLC vid are not read.) Plan costs 3 to 4 requests per TOM code.
