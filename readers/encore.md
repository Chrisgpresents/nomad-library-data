# encore

Feasibility: YES for encore.delco.lib.pa.us (tested). NO for find.minlib.net (Cloudflare 403 challenge on every path).

Endpoint: `{base}/search/C__S%2A__Ff%3Afacetmediatype%3Ag%3Ag%3ADVD%3A%3A[__P<n-1>]__Orightresult__U__X0?lang=eng&suite=def` where `*` is the query and facet `facetmediatype:g` = "DVD/BLU-RAY" (combined). 25 results per page, `__P` is 0-based. Total in "1 - 25 of 15070". Dropping `suite=cobalt` from the usual URL matters (it 500s).
- Needs a `Referer` header and the JSESSIONID: without cookies the first call 302s to set it, and a plain "Mozilla/5.0" User-Agent gets Apache 403. The reader follows redirects by hand and keeps the cookie.
- Parsed: record id (b#######), title, year, "Available" flag, cover (BibImage URL). Blu-ray only identifiable by "[blu-ray]" in the title (then f="b"). Games: facet code unknown, not read.
- Record link: `{base}/record/C__R{id}?lang=eng&suite=def`.
- Delco: 15,070 discs, 603 requests, 1-4 s each.
