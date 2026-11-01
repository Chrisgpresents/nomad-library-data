# koha

Feasibility: NO (no reader written). Both test hosts refuse plain HTTP clients.
- catalog.cclsny.org: every request (RSS, home, API) answers 429 with an HTML "Please try again | Library access" page (bot gate), even with browser User-Agent and Accept headers.
- catalog.hmcpl.org: 403 Cloudflare "Attention Required!" / "Just a moment..." JS challenge on every path.
The RSS lead (`opac-search.pl?...&format=rss&count=100`) could not be reached, so itype codes and page size are unmeasured. If a Koha library is not behind such a gate the lead is probably fine; retry with a different Koha host before building.
