# Fails (so GitHub emails the owner) when too many BiblioCommons copies are stale, which is what a gateway block looks like.
import json, os, sys, time, urllib.request
URL = os.environ.get("COPIES_URL", "https://nomad-library-copies.pages.dev") + "/snap/index.json"
MAX_DAYS = float(os.environ.get("MAX_DAYS", "8"))      # the weekly rotation tops up each copy every ~7 days
MAX_SHARE = float(os.environ.get("MAX_SHARE", "0.10"))  # more stale than this = blocked or broken
src = sys.argv[1] if len(sys.argv) > 1 else None
raw = open(src, encoding="utf-8").read() if src else urllib.request.urlopen(urllib.request.Request(URL, headers={"User-Agent": "NomadLibrary/1.0 (+https://library.nomadovernormal.com)"}), timeout=60).read().decode("utf-8")
idx, now = json.loads(raw), time.time() * 1000
bc = {k: v for k, v in idx.items() if "." not in k}   # reader copies have a dot in their id
age = {k: (now - max(v.get("topped", 0), v.get("finished", 0))) / 864e5 for k, v in bc.items()}
stale = sorted((d, k) for k, d in age.items() if d > MAX_DAYS)
print(f"{len(bc)} BiblioCommons copies, {len(stale)} older than {MAX_DAYS:g} days")
for d, k in stale[-10:]: print(f"  {k}: {d:.1f} days")
if bc and len(stale) / len(bc) > MAX_SHARE:
    print(f"::error::{len(stale)} of {len(bc)} BiblioCommons copies are stale. The gateway may be blocking the copier again: check the latest 'Copy library catalogs' run for 403s.")
    sys.exit(1)
