# Upstream sync: keyteki → Archon Arena

Archon Arena is a fork of [The Crucible Online (keyteki)](https://github.com/keyteki/keyteki).
The gameplay engine (`server/game`), card implementations (`server/game/cards`), and card
test suite (`test/server/cards`) are kept as close to upstream as possible so that card
fixes and new-set support can be pulled in with minimal conflict.

## Provenance

| | |
|---|---|
| Upstream repo | `https://github.com/keyteki/keyteki` |
| Imported commit | `296c2742212db7e6652a0913ce21ae17b49d6e2e` |
| Imported date | 2026-06-28 (upstream commit date) |

The import was a verbatim snapshot (shallow), not a git-history merge, to keep this
repository small. Upstream history remains available on GitHub.

## Rules that keep syncing cheap

1. **Do not rename engine internals.** Rebranding is confined to user-visible strings,
   HTML/meta, and docs. `server/game/**` identifiers stay upstream-compatible.
2. **New Archon Arena systems live in new directories** (e.g. `server/services/**`),
   never interleaved into upstream files, except for minimal integration hooks.
3. **Integration hooks are marked** with `// ARCHON:` comments so conflicts during sync
   are easy to resolve.

## How to pull upstream fixes

```bash
git remote add upstream https://github.com/keyteki/keyteki.git   # once
git fetch upstream master
# Review what changed in gameplay-critical paths:
git log --oneline HEAD..upstream/master -- server/game test/server
# Cherry-pick card/engine fixes, or merge and resolve ARCHON: hook conflicts:
git cherry-pick <sha>          # preferred for targeted card fixes
# or
git merge upstream/master      # for bulk sync; expect conflicts only at ARCHON: hooks
```

After any sync: run the full card test suite and record the pass rate against the
baseline in `docs/TEST-BASELINE.md` before merging.
