# open (OCLC OPEN, formerly Bibliotheca.OPEN)

Feasibility: YES. Plain HTML pages, no API key, no login, no cookie, no bot wall on the libraries tried.
OPEN ("Katalogportal", ASP.NET on DNN) runs many public libraries in Germany and Austria, so this one reader opens
a large part of the German-speaking requests.

How a library is recognised
- Catalog links contain `/Mediensuche/` (e.g. `/Mediensuche/Einfache-Suche?id=…`) or `/Permalink.aspx?id=…`, and
  the pages load `/DesktopModules/OCLC.OPEN.PL.DNN.*`. Library id: `open.<host>` (one portal per host).

Endpoints (base = `https://<host>`)
- Extended search form: linked from the home page (`/Mediensuche/ErweiterteSuche.aspx` in Frankfurt,
  `/Mediensuche/Erweiterte-Suche` in Graz). The reader takes the link from the home page and posts the form back with
  the page's own hidden fields (`__VIEWSTATE`, `__EVENTVALIDATION`, …), one media group selected
  (`…$DdlMediaGroupValue`) and optionally `…$cbOnlyAvailable=on`. No search words are needed.
- The answer redirects to `<path>?searchhash=OCLC_<sha1>`. The hash is the same for the same search every time and
  works without a cookie, so it is kept in the plan.
- Pages: `GET <path>?searchhash=…&top=y&pageSize=50&page=n`. 50 is the largest size honoured (10/20/50 in the pager;
  100 and more fall back to 10). Pages can be fetched out of order. Order: newest record first.
- Total per group: the media group facet `title="<group> (N)"`.
- Record link: `/Permalink.aspx?id={id}` (redirects to the record). Title search for "Check at":
  `/Permalink.aspx?search={q}`.

Formats
- Media groups are named by each library and read from the form: film groups (`Spielfilm`, `Sach-/Musikfilm`, `DVD`,
  `Blu-ray`, …) and game groups (`Konsolenspiel`, …). Not taken: `filmfriend`/onleihe (streaming), `Spiel` (board
  games), `Software`, cassettes.
- Blu-ray vs DVD: Frankfurt marks Blu-rays in the title (`The invite [Blu-Ray]`); the mark is removed from the title
  and sets `f: "b"`. A group named Blu-ray/4K/UHD gives `b` as well.

Row data
- id (`mdv<nr>`), title, subtitle (line under the title), year (`Jahr:`), cover (ekz cover service, switched to https;
  older records often have none), media group.
- Availability is not in the result HTML (each title asks `SearchService.asmx/GetAvailability` by Ajax). Instead each
  group is searched twice: "nur verfügbare Medien" first (rows `avail: 1`), then everything (`avail: 0`). The copier
  keeps the first row per id, so a title on a shelf somewhere keeps `avail: 1`. Costs about 90% more pages than one pass
  and avoids one request per title.
- No holds, no subjects and no game platform in the list.

Measurements (10.11.26, from a browser, 1 request per second)
- Stadtbücherei Frankfurt am Main (katalog.stadtbuecherei.frankfurt.de): Spielfilm 15,311 (307 pages), available
  13,634 (273); Sach-/Musikfilm 3,533 (71), available 3,340 (67); Konsolenspiel 1,538 (31), available 1,167 (24).
  Plan 13 requests, full copy about 786 requests, ~13 minutes. 0.3–1.3 s per page of 50 (~1.5 MB HTML).
  First and last pages of every task checked: 50 rows each (last page 11/38/33 rows as the counts predict), Blu-rays
  recognised, covers on recent titles.
- Stadtbibliothek Graz (stadtbibliothek.graz.at), also OPEN: NOT verified. Its extended search lives at
  `/Mediensuche/Erweiterte-Suche` (the `.aspx` name answered only after a minute with a page whose media group list held
  just "Alle"), and on 10.11.26 the catalog stopped answering at all (even a title search timed out after 20 s), so the
  test stopped there. If its static form has no media groups, plan() returns no tasks and the copier reports "the
  catalog lists no DVDs, Blu-rays or games" instead of guessing. Worth a second look on a quiet day.

Quirks
- New records are added at the front, so a copy that runs while the library catalogues new discs can miss or repeat a
  title at a page boundary. Repeats are dropped by id; a missed title comes back with the next refresh.
- Multi-part records sometimes have a part title only (`3.; Episode 7 - 9`).
- `try-open.mjs <url>` prints the plan and the first rows of every task.
