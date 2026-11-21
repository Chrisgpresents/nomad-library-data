# Aspen Discovery reader (`aspen.mjs`)

Feasibility: YES when `GET /API/SearchAPI?method=search` returns JSON. NO on every live host tried on 11.20.26 (Cloudflare or Anubis). The reader does not solve those challenges. A walled host fails the copy. The copier then stops promising that library's shelf, and Check at still searches the catalog in the visitor's browser.

Tested with `node --test test/aspen.mjs` (canned JSON, no network) and `node readers/try-aspen.mjs <url>`.

## How it works
`GET {base}/API/SearchAPI?method=search&lookfor=*:*&searchIndex=Keyword&searchSource=local&pageSize=50&page=1&sort=title`

- `lookfor` cannot be empty (`initBasicSearch` rejects it). `*:*` is Aspen's match-all. If that answer is a parse error or has no hits and no facets, the reader tries `lookfor=*` once.
- `searchSource=local` is the same scope as the site's Check at link.
- `sort=title` is one of Aspen's built-in sorts, so pages do not drift with relevancy.
- Format tasks come from `facetSet.format` (or a scoped `format_*` field, not `format_category`). The filter is the one Aspen itself renders: `filter[]=format:"Blu-ray"`. Facet lists may be a JSON object keyed by value. A leading `12#` scope prefix is stripped.
- Labels: video game / PlayStation / Xbox / Nintendo / Switch / Wii first, then Blu-ray / 4K / UHD, then DVD. "Blu-ray + DVD" counts as Blu-ray. Anything else is skipped.
- If the format facet names no discs, `format_category` values that look like movies or games are used and each row is classified from its own `format`.
- Page size asked is 50. `plan()` then uses `paging.itemsPerPage` when the catalog reports a smaller size. Deep paging past Solr's window was not measured, because no live host returned JSON.
- Record link: `{base}/GroupedWork/{id}`. Cover: `{base}/bookcover.php?id={id}&size=medium&type=grouped_work`.
- The id is the grouped-work id, shared by Blu-ray and DVD of the same film. Tasks are ordered Blu-ray, then DVD, then games, and each task has its own key, so the copier keeps the Blu-ray row. Ids that are not `[A-Za-z0-9._-]` are dropped (the record link would break).
- Title: `title_short`, else `title_display`. Bracketed `[videorecording]` and a ` / director` tail are removed. A ` : ` split fills the subtitle when `subtitle_display` is empty.
- Year: latest plausible year in `publishDateSort` or `publishDate`. Subjects: `topic_facet`, else `subject_facet`, up to 8.
- Availability: `avail` is 1 only when `available_at` is non-empty. The default grouped-work field list does not include `available_at`, so copies are usually unknown and the snap is marked `na`. Holds: `total_holds` when it is a number.
- Library id: `aspen.<host>` with `www.` removed. `aspendiscovery.org`, `help.`, `community.` and `dev.` are the vendor's sites and are not libraries. This matches `readerId` in nomad-library `public/catalog.js`.
- `libraryName` reads the homepage `<title>` and keeps the part that says "library".

## When the catalog says no
`ctx.fetch` already treats HTTP 403 as permanent. Two different refusals show up:

- Cloudflare or Anubis. Anubis can be HTTP 200 HTML ("Making sure you're not a bot!"). If the body is not JSON and looks like that wall, the reader throws `aspen catalog answered with a bot wall` with `permanent: true`. It does not run the proof of work and it does not use a browser.
- Aspen's own API allow list. HTTP 403 HTML that says API requests from this address are forbidden. The reader throws `aspen catalog refused this address` and does not repeat the address.

## Measured 11.20.26 (Chrome user agent, no challenge solving, one request except where noted)
| Host | Answer |
|---|---|
| roxbury.aspendiscovery.org | HTTP 403, title "Attention Required! \| Cloudflare" |
| denville.aspendiscovery.org | HTTP 403, same Cloudflare challenge page |
| catalog.faylib.org | HTTP 403, same Cloudflare challenge page |
| mckinney.aspendiscovery.org | HTTP 403, same Cloudflare challenge page |
| opac.marmot.org | HTTP 403, title "Just a moment..." |
| boulder.marmot.org | HTTP 403, title "Just a moment..." |
| broomfield.marmot.org | HTTP 403, title "Just a moment..." |
| arlington.minlib.net | HTTP 403, same Cloudflare challenge page |
| americanfork.aspendiscovery.org | Cloudflare challenge page |
| grafton.cwmars.org | Cloudflare challenge page ("Just a moment...") |
| aspen.greenvillelibrary.org | HTTP 403, Aspen itself: API requests from this address are forbidden |
| srl.modiscovery.org | HTTP 403, same API allow-list page |
| catalog.library.nashville.org | HTTP 301 to catalog.library.nashville.gov |
| catalog.library.nashville.gov | HTTP 200 HTML, title "Making sure you're not a bot!", Anubis v1.27.0 |
| nl.catalog.lionlibraries.org | HTTP 500, empty body |

No format counts, page timings, or cover checks from a live catalog. Those are covered by the canned fixture in `test/aspen.mjs` (object facet list, grouped-work row, bot-wall HTML). A catalog that returns the Search API JSON can be copied with `node readers/try-aspen.mjs <url>`.
