# sierra

Feasibility: YES (coolcat.org = Springfield-Greene County Library, tested).
- Search: `/search/X?SEARCH=%2A&searchscope=1&m=x&SORT=AX` (`*` matches everything; m=x is DVD for this library; reader reads the `m` select from `/search/X` and picks /blu/, /^dvd/, /game/ labels). Total: "N results found". 19,644 DVDs.
- Page size 50 (fixed). Page n: `/search~S1?/X*&searchscope=1&m=x&SORT=AX/X*&searchscope=1&m=x&SORT=AX&SUBKEY=*/<start>%2C<total>%2C<total>%2CB/browse` with start=1+50*(n-1). URL-only, no cookie. 393 requests, ~7-10 s each.
- Row: id b#######, title, year, syndetics cover, material icon. Availability is not on the list (avail=0). No subjects.
- This library has no Blu-ray or game material type (m choices: DVD, CD-ROM, Videocassettes...). Blu-ray discs are typed DVD; reader flags f="b" when the text says Blu-ray.
- Record link: `/record={id}~S1` (200, verified).
