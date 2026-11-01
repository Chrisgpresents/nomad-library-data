# spydus

Feasibility: YES for innerwest.spydus.com and wcl.spydus.co.nz. NO for cardiff.spydus.co.uk and dublincity.spydus.ie (405 AWS WAF "Human Verification" page on every path).

Endpoints (base = `https://host/cgi-bin/spydus.exe`)
- Format codes: read `{base}/MSGTRN/OPAC/COMB`, select RECFMT, option `PM*DVDs and BluRay` (code PM). Games: no such option on either library (reader looks for /game/).
- First page: `{base}/ENQ/OPAC/BIBENQ?SETLVL=&RECFMT=PM&NRECS=100&SORTS=HBT.SOVR[&ENTRY1_NAME=BS&ENTRY1=dvd&ENTRY1_TYPE=K]`. NRECS 100 honoured (max in the form). Total from `searchCount = N` (innerwest) or "Showing 1 - 5 of N" (wcl).
- Later pages: `{base}/PAGE/OPAC/BIBENQ/<sessionId>/<n>`; the session id is in the first result's links, no cookie needed, pages fetchable out of order. Reader caches the session id for 8 min and re-searches when needed.
- DVD vs Blu-ray: PM mixes them with no format index. Keyword `blu-ray` gives the b list (innerwest 33, wcl 1,081); keyword `dvd` gives d. Some overlap or misses are possible (innerwest dvd 10,979 vs PM 11,171).
- Row data: id (BRN), title, year, availability count, cover from syndetics `data-imgurls`. No subjects or holds in the list.
- Record link: `{base}/ENQ/OPAC/BIBENQ?BRN={id}` (200 from curl; content not visually verified).
- wcl.spydus.co.nz serves the same CGI as catalogue.wcl.govt.nz.

Measurements: ~1 MB per page, 8-20 s per request (first search ~16 s, PAGE ~10 s).
- innerwest: Blu-ray 33 (1 req), DVD 10,979 (110).
- wcl: Blu-ray 1,081 (11), DVD 9,607 (97).
