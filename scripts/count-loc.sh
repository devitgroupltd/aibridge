#!/usr/bin/env bash
# Lines-of-code count per package, plus a repo-wide total. Exists as a fixed, reviewed script
# rather than something a session composes fresh each time - a live 2026-08-10 permission prompt
# was for exactly this ad-hoc shape (find | xargs wc -l | tail, wrapped in a for loop over
# packages/*), which can't be auto-approved: compound-permission.ts never decomposes `for` loops
# (control-flow syntax, not a flat &&/;/| chain - see its own doc comment), and `find`/`xargs`
# aren't safe to blanket-allow standalone either (`-exec`/`-delete`, "run whatever trails xargs").
# This script is the fix: a single fixed invocation (`Bash(bash scripts/count-loc.sh)`) that *can*
# go in settings.ts's allow list, because there's no open-ended shell left for anything to hide in.
set -euo pipefail
cd "$(dirname "$0")/.."

find packages -name '*.ts' -not -path '*/node_modules/*' -not -name '*.test.ts' | xargs wc -l | tail -1
echo "---per-package---"
for p in bridge channel-server hook-client protocol stub-telegram; do
  echo "$p: $(find "packages/$p" -name '*.ts' -not -path '*/node_modules/*' -not -name '*.test.ts' | xargs wc -l 2>/dev/null | tail -1)"
done
