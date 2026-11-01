# Catalog reader interface (Nomad Library)

Nomad Library (library.nomadovernormal.com) shows a public library's DVDs, Blu-rays and video games as one browsable
shelf. BiblioCommons libraries already work. A GitHub Actions copier (Node 22, plain `fetch`, runs on GitHub-hosted
Ubuntu runners) copies a whole library's discs into a static file. We are adding readers for other catalog systems.

Each reader is ONE self-contained Node ESM file `readers/<system>.mjs` (no npm deps; regex/string parsing for HTML
is fine, `node:` built-ins are fine). It must export:

```js
export const system = "vega";               // the code from catalog.js
// Any link a visitor might paste (home page, search page, account page, record page) -> the library, or null.
// id: stable, lowercase, only [a-z0-9._-] (NO "~"), = "<system>.<host>", e.g. "vega.sdpl.na5.iiivega.com",
//     plus "_<scope>" only when the system needs one: "enterprise.cbpl.ent.sirsi.net_default", "polaris.x.org_1-1033-0-0-6".
export function libFromUrl(url) { return { id, host, base /* origin + any path prefix */ } }
// Plan the copy: one entry per format with the number of pages to fetch.
//   f: "b" Blu-ray (incl. 4K, Blu-ray+DVD combo), "d" DVD, "g" video game
export async function plan(lib, ctx) { return [{ f: "b", pages: 12, count: 11834 }, ...] }
// One page of one format -> rows. Must be idempotent (pages are retried and fetched out of order).
export async function page(lib, task, n /* 1-based */, ctx) { return [row, ...] }
// Link to one record on the library's own site, opened in the visitor's browser ({id} = row id).
export function recordTemplate(lib) { return "https://sdpl.na5.iiivega.com/search/card?id={id}&entityType=FormatGroup" }
// Optional: library's display name, if the catalog states it.
export async function libraryName(lib, ctx) { return "San Diego Public Library" }
```

`ctx.fetch(url, init)` is the only network call allowed (the copier paces and retries it; just call it and throw on
a bad answer). `ctx.log(...)` for notes.

A row:
```js
{ id: "abc123",            // record id, unique in this library, URL-safe, NO "~" in it
  title: "Alien",          // main title only, no "[videorecording]", no " / director..." tail
  sub: "Covenant",         // subtitle / part, "" if none
  f: "b" | "d" | "g",
  disc: 2017,              // publication year of the disc, 0 if unknown
  cover: "https://...",    // cover image URL or ""
  avail: 1 | 0,            // at least one copy on a shelf now (0 if unknown)
  holds: 0,                // holds/requests count if given, else 0
  subj: "Horror films | Science fiction films",  // subject headings / genres text if the result list gives it, else ""
  plat: ""                 // games only: "Switch", "PS5"... if easy, else ""
}
```

Rules
- Ask the catalog politely: at most 1 request per second while probing, never parallel bursts. These are libraries.
- No keys, no logins, no headless browsers. Plain HTTPS GET/POST a visitor's browser would also make.
- Prefer JSON/RSS/XML endpoints over HTML. Use the largest page size the system really honours (measure it).
- Find the format filter (DVD / Blu-ray / games). Codes can differ per library: discover them in plan() if needed.
- Test on at least 3 real libraries from the list you were given. For each, record: total counts per format,
  requests needed for a full copy, seconds per request, page size honoured, and whether covers/availability come back.
- If a system truly can't be read (bot wall, key required, captcha), say exactly what answered (status, body excerpt).
- Never spawn sub-agents.

Deliver
1. `readers/<system>.mjs` (working, tested with a tiny harness you write in the same folder: `node try-<system>.mjs <url>`
   prints plan + first page's first 3 rows).
2. `readers/<system>.md`: feasibility YES/NO, endpoints, filters, page size, quirks, per-library measurements.
3. A final reply of at most 200 words: verdict, which test libraries worked, anything I must know.
