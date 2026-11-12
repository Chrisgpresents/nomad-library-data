# corvina

Corvina WebPac (Monguz Kft.), the Java catalog behind addresses like `https://saman.fszek.hu/WebPac/CorvinaWeb`.

Feasibility: YES for saman.fszek.hu (Fővárosi Szabó Ervin Könyvtár, Budapest). Only that library was tested.

Endpoints (base = `https://host/WebPac/CorvinaWeb`; the path prefix can differ per install)
- Search: `GET {base}?action=find&index0=HDZO&text0=DVD&textlogic0=and&pagesize=100&TYPE=F`. `HDZO` is the physical medium index, `TYPE=F` is visual material (film). Blu-ray: `text0=blu-ray`. The total is in `Összesen N találat.`
- The page size lives in the session cookie (`JSESSIONID`) that the search sets. Without it a page holds 10 rows.
- Later pages: `GET {base}?action=page&page=<n-1>&perpage=100&pagesize=100&actualsearchset=<string from page 1>&actualsort=0&currentpage=result&resultview=short&resultsize=N`. `actualsearchset` (e.g. `FIND HDZA "DVD" and TYPE "F"`) is a hidden field of the results form, and the server honours it over the session's own search, so any session with the page size set can fetch any page, in any order.
- Record link: `{base}?action=onelong&showtype=longlong&recnum={id}` (plain GET, 200).
- Library name: `<title>` of `?action=advancedsearchpage` ("... | Fővárosi Szabó Ervin Könyvtár").

Rows
- id = record number (`name="basket<id>"`; rows with no author have no `lookRecnum` link).
- Title cell: `Mátrix forradalmak [DVD-felvétel] = The Matrix revolutions / ...`. The part after `=` is the original title and is what the reader publishes, because the site matches IMDb on a-z/0-9 only. Records without it keep the Hungarian title (these mostly show unrated).
- Year from `cop. 2004` / `[2010]` / `2018`. No covers, no availability, no holds, no subjects in the list (the copier then marks the copy "no shelf status").
- Accents arrive as named entities (`&aacute;`, `&odblac;`) and as raw UTF-8.

Quirks
- The backend is Oracle and fragile. `pagesize=2000` answers `ORA-01795: maximum number of expressions in a list is 1000`. A year filter (`DATEstart`/`DATEend`) together with `HDZO` timed out (HTTP 500 after 20 s). Stay with page size 100, no date filters.
- The first search is slow (~8 s for DVDs); pages are ~4.5 s each.
- The session lasts 30 minutes. The reader keeps one per format and starts a new one when a page comes back short.
- Blu-ray is nearly empty (2 records with `TYPE=F`) and there are no game records worth reading, so the reader copies DVD (`d`) and Blu-ray (`b`) only.

Measurements (saman.fszek.hu, 12.11.26)
- DVD 11,959 records = 120 pages of 100 (1 search + 119 page requests), ~125 KB each, ~15 MB for a full copy. Blu-ray 2 records (1 search).
- At the copier's 1 request/s that is about 10 minutes, mostly waiting on the server.

The library also runs a newer catalog (`fszekonline.fszek.hu`, Liferay + Solr) on the same data; see the site repo for how links to it are handled.
