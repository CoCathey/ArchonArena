# Upstream sync: keyteki → Archon Arena

Archon Arena is built on [The Crucible Online (keyteki)](https://github.com/keyteki/keyteki).
These paths are kept as close to upstream as possible, so card fixes and new-set support can
be pulled in with minimal conflict:

| Path                                         | What it carries                                                                 |
| -------------------------------------------- | ------------------------------------------------------------------------------- |
| `server/game`                                | The engine and every card implementation                                        |
| `server/constants.js`, `client/constants.js` | Houses, keywords, and the expansion registry with its tide/token/prophecy flags |
| `test/server`                                | The card and engine test suite                                                  |
| `test/helpers`                               | The helpers those tests are built on                                            |
| `master-vault-data`                          | Card data                                                                       |

The two `constants.js` files are single files, not directories — the rest of `client/` is
ours. Everything else — branding, dependencies, CI, deployment — is ours and is never taken
from upstream.

## Provenance

|                 |                                            |
| --------------- | ------------------------------------------ |
| Upstream repo   | `https://github.com/keyteki/keyteki`       |
| Imported commit | `296c2742212db7e6652a0913ce21ae17b49d6e2e` |
| Imported date   | 2026-06-28 (upstream commit date)          |

**This repository is not a git fork.** It was created from a verbatim _snapshot_ of the
upstream tree, so the two repositories share no history. That one fact determines how syncing
has to work, and it is why the instructions below are not the usual fork workflow.

How far we have pulled in is recorded in [`upstream-sync.json`](../upstream-sync.json), which
is the single source of truth and is updated by the sync itself. The table above is history.

## Rules that keep syncing cheap

1. **Do not rename engine internals.** Rebranding is confined to user-visible strings,
   HTML/meta, and docs. `server/game/**` identifiers stay upstream-compatible.
2. **New Archon Arena systems live in new directories** (e.g. `server/services/**`), never
   interleaved into upstream files, except for minimal integration hooks.
3. **Integration hooks are marked** with `// ARCHON:` comments, so a conflict during a sync
   lands on a line that says what it is and why.

These have held. As of 2026-08-01, across the entire upstream-owned surface — every path in
the table above, both `constants.js` files included — exactly three files carry local changes:

| File                                        | Why                                                                  |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `server/game/game.js`                       | `ARCHON:` hooks — replay capture, tournament chains, broadcast delay |
| `server/game/gamesteps/GameWonPrompt.js`    | Rematch button labels                                                |
| `test/server/prompts/GameWonPrompt.spec.js` | The test for those labels                                            |

Everything else is byte-identical to upstream. Keep it that way and syncs stay mechanical.

## How to pull upstream fixes

```bash
npm run sync:upstream -- --dry-run   # what is pending, without touching the tree
npm run sync:upstream                # apply it
npm test                             # the gate - see below
```

The sync applies the diff between the recorded `syncedCommit` and upstream's latest, limited
to the tracked paths, with `git apply --3way`. Three-way matters: a hunk that no longer fits
becomes a marked conflict rather than a rejected patch or a silently wrong merge.

> **`git merge upstream/master` does not work here** and the older version of this document
> was wrong to suggest it. With no shared history, git treats it as a merge of unrelated
> histories: it refuses outright without `--allow-unrelated-histories`, and with that flag it
> conflicts on essentially every file in the repository. Cherry-picking an individual upstream
> commit does work, because a cherry-pick is a patch application — use it for a targeted card
> fix — but it will not advance the sync marker, so record it by hand.

### Outcomes

| Outcome      | Meaning                                                                        |
| ------------ | ------------------------------------------------------------------------------ |
| `up-to-date` | Nothing new, or nothing new in the tracked paths. The marker still advances.   |
| `applied`    | Changes are in the working tree. **Not yet verified** — run the gate.          |
| `conflict`   | Could not apply cleanly. The marker is left alone so the sync will be retried. |
| `error`      | The sync itself failed — network, or a marker upstream no longer has.          |

## The gate

`.github/workflows/upstream-sync.yml` runs the sync every Monday, and on demand from the
Actions tab. It runs typecheck, lint, build and the full test suite against the applied
changes — the same four checks any other pull request must clear — and then:

-   **all green** → opens a pull request labelled `upstream-sync`;
-   **conflict, or any check red** → files (or comments on) an issue labelled `upstream-sync`,
    leaves the marker alone, and fails the run.

It never merges to `main`. That is deliberate, and the distinction is worth being precise
about: **a green suite says the fork still works, not that the change is right for Archon
Arena.** Upstream changes gameplay behaviour on purpose sometimes, and the card suite will
happily pass a change this platform does not want — especially around Adaptive, chains, and
first-player selection, where Archon Arena has its own rules layered on top. Read the commits
in the PR body before merging.

After any sync, record the pass rate against the baseline in
[`TEST-BASELINE.md`](TEST-BASELINE.md).

## New sets

A new KeyForge set arrives in two halves, and the sync can only do one of them.

**Comes across on its own** — the card implementations (`server/game/cards/NN-CODE/`), their
tests, the card data, any new keyword or token support in the engine, and the set's entry in
both `constants.js` files with its tide/token/prophecy flags.

**Does not, and cannot** — everything in [`new-sets.md`](new-sets.md) that lives in a file
Archon Arena has diverged on: the lobby format list, the sealed random-pick, the `Expansions`
row and its migration, and the set icons. Taking upstream's version of those would overwrite
the fork.

So the sync detects the new set — by diffing the expansion registry between the two upstream
commits, and by spotting new card directories — and puts the outstanding checklist straight in
the pull request, which is titled `NEW SET …` and labelled `new-set`.

This is the one case where a green suite is actively misleading. **No test fails while a set
is unregistered**, because there is nothing to test: the cards exist, they work, and players
simply cannot pick them. Without the checklist a set release would look exactly like a routine
card fix.

## Re-anchoring

If upstream force-pushes or rewrites history, the recorded `syncedCommit` will no longer exist
and the sync reports `error` rather than guessing. Pick the nearest surviving upstream commit
that matches the tree we last took, write it into `upstream-sync.json` by hand, and run a
`--dry-run` to confirm the resulting diff is the size you expect.
