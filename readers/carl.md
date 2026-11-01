# CARL / LS2 PAC (TLC) reader: feasibility YES
Detect: `<title>CARL•Connect Discovery</title>`, `js/production.js?_=NNNN`, `Server: Jetty(...)`, hosts like ls2pac.*, *.tlcdelivers.com.
Endpoint: `POST {base}/search` (older builds such as lima.tlcdelivers.com have only this; newer ones also have /search/withFacets, slower because it computes facets), JSON `{searchTerm, hitsPerPage, startIndex, facetFilters:[], branchFilters:[], sortCriteria:"Title", dbCodes:[]}` (omit frbrSearch: Lima answers 400 to it) -> `{totalHits, facets, resources[]}`. No cookie/key needed (plain node fetch works).
Facet filter shape (not used): `{facetName:"Collection", facetValue:"DVD", facetDisplay:"DVD"}`.
Quirks: no match-all query and no format qualifier; "dvd" keyword catches every disc (subject "DVDs"/"Blu-ray DVDs"). Each resource has `format` ("DVD","Blu-Ray"), so rows are classified per row. plan() returns ONE entry f:"d" whose pages also yield f:"b" rows (copier must not filter rows by task.f). Games only if a "video game" search returns rows whose format looks like a game (none at Loudoun).
Page size: 50 (200 honoured but time scales; 1000 hangs). /search takes 0.1-0.4 s per request. Covers are not in the JSON (cover ""), holds not given (0). avail = any holding onshelf.
Record link: `{base}/#section=resource&resourceid={id}` (unverified in a browser).
Measured (rows are "dvd" hits, so counts overstate discs a little): Loudoun 19,625 hits, 393 req, 0.1 s; LAPL 42,508, 851 req, 0.3 s 0.3 s; Volusia 34,417, 689 req, 0.1 s. Lima = lima.tlcdelivers.com (9,908 "dvd" hits).
