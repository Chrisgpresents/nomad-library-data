# evergreen

Feasibility: YES for nccardinal.org and bridgeport.biblio.org (tested). NO today for gapines.org (504 after 60 s on every filtered search) and berks.sparkpa.org (empty reply to curl and Node-style clients; its /eg/opac pages sit behind an Anubis bot wall).

Endpoint: `GET {base}/opac/extras/opensearch/1.1/{org|-}/html-full/keyword?searchTerms=<q>&count=25&startIndex=<1+25*(n-1)>`
- Filters go inside searchTerms: DVD `search_format(dvd)`, Blu-ray `search_format(blu-ray)`, games `search_format(software) subject:video games` (best available, may include PC software). `item_type(g)` is DVD+Blu-ray+VHS and caps at 100,000, so it is not used.
- Page size: server hard-caps `count` at 25 (count=100/200 still returns 25).
- Deep paging works (startIndex 2001 fine). Do NOT send searchSort/searchSortDir: any sort value makes the result collapse to 7 hits. Order is the default relevance order, which is stable for one query.
- Total from "Results 1 to N of T". html-full gives title, subjects, "Available copies: x / Total copies", jacket image (`/opac/extras/ac/jacket/small/r/{id}`, reader rewrites to medium). No pub year (disc=0), no holds count.
- Record link: `{base}/eg/opac/record/{id}`.
- Why not the OPAC results page: Anubis bot wall on nccardinal/berks/bridgeport, JS redirect on gapines.
- Org scope: path segment takes an org SHORTNAME only (not locg number). Branch subdomains of nccardinal.org map to the upper-cased subdomain as shortname (unverified guess); `?org=` is also honoured. A numeric `locg=` link cannot be resolved without an org lookup, so it falls back to the whole consortium.

Quirks: slow. First query of a kind ~5-20 s, later pages 1-9 s. nccardinal.org intermittently serves an EXPIRED TLS certificate (curl code 60); tests here ran with NODE_TLS_REJECT_UNAUTHORIZED=0, the copier will need to retry that.

Measurements
- nccardinal.org: DVD 85,716 (3,429 requests), Blu-ray 6,905 (277), games 2,029 (82). ~7-13 s/request.
- bridgeport.biblio.org: DVD 57,602 (2,305), Blu-ray 5,436 (218), games ~1,087 (44). ~1-9 s/request.
- Covers yes, availability yes, subjects yes, year no.
