#!/usr/bin/env node
/*
 * Pull gameplay changes from keyteki (The Crucible Online) into Archon Arena.
 *
 * Archon Arena was created from a verbatim *snapshot* of the upstream tree, not
 * a git fork, so the two repositories share no history. `git merge upstream/master`
 * therefore cannot work - it would be a merge of unrelated histories and would
 * conflict on essentially every file. What does work is applying the diff
 * between two upstream commits, restricted to the paths we deliberately keep
 * upstream-compatible, with a three-way apply so genuine conflicts surface as
 * conflicts rather than as silent wrong answers.
 *
 * The paths are the point. Upstream also changes its own client, branding,
 * dependencies and CI, and taking those would fight the rebrand. We take the
 * gameplay engine, the card tests that prove it, the shared test helpers those
 * tests use, and the card data - nothing else.
 *
 * This script only ever produces a working tree. It does not commit, push, or
 * decide anything: whether the result is acceptable is the test suite's call
 * and then a human's. See .github/workflows/upstream-sync.yml.
 *
 * Usage:
 *   node server/scripts/upstream-sync.js            # apply, leave changes staged
 *   node server/scripts/upstream-sync.js --dry-run  # report what is pending, touch nothing
 *   node server/scripts/upstream-sync.js --to <sha> # stop at a specific upstream commit
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const STATE_FILE = path.join(REPO_ROOT, 'upstream-sync.json');
const REMOTE_NAME = 'upstream';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const toIndex = args.indexOf('--to');
const explicitTarget = toIndex >= 0 ? args[toIndex + 1] : null;

const git = (...gitArgs) =>
    execFileSync('git', gitArgs, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024
    });

/** git that is allowed to fail, for commands whose exit code is the answer. */
const gitStatus = (...gitArgs) => {
    try {
        return { ok: true, out: git(...gitArgs) };
    } catch (err) {
        return {
            ok: false,
            out: `${err.stdout || ''}${err.stderr || ''}`,
            status: typeof err.status === 'number' ? err.status : 1
        };
    }
};

const readState = () => JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));

/**
 * The expansions registered in one of the two constants files, at a given commit.
 *
 * Both files list the same sets in slightly different shapes - `id: 341` server
 * side, `value: '341'` client side - and both spread an entry across several
 * lines or keep it on one depending on length, so the text is flattened before
 * matching rather than trying to write a regex that copes with both layouts.
 *
 * Returns a Map of id -> label. An empty Map means the file could not be read
 * or its shape changed; callers treat that as "cannot tell", never as "no sets".
 */
const parseExpansions = (source) => {
    const found = new Map();

    if (!source) {
        return found;
    }

    const flat = source.replace(/\s+/g, ' ');
    const block = /\{([^{}]*?(?:id|value)\s*:\s*'?\d+'?[^{}]*?)\}/g;
    let match;

    while ((match = block.exec(flat)) !== null) {
        const id = /(?:\bid|\bvalue)\s*:\s*'?(\d+)'?/.exec(match[1]);
        const label = /\blabel\s*:\s*'([^']+)'/.exec(match[1]);

        if (id && label) {
            found.set(id[1], label[1]);
        }
    }

    return found;
};

/** parseExpansions against a file as it stood at some upstream commit. */
const expansionsAt = (commit, file) => {
    const read = gitStatus('show', `${commit}:${file}`);

    return read.ok ? parseExpansions(read.out) : new Map();
};

/** Card directories (`server/game/cards/14-DM`) present at a given commit. */
const cardSetDirsAt = (commit) => {
    const listed = gitStatus('ls-tree', '--name-only', `${commit}:server/game/cards`);

    if (!listed.ok) {
        return new Set();
    }

    return new Set(
        listed.out
            .split('\n')
            .map((line) => line.trim().replace(/\/$/, ''))
            .filter((line) => /^\d+-/.test(line))
    );
};

/**
 * ARCHON: whether this sync brings a new KeyForge set, and what is left to do.
 *
 * This is the part the sync deliberately cannot finish. A new set's *engine*
 * side - card implementations, their tests, the card data, and the tide/token/
 * prophecy flags - is upstream-owned and arrives on its own. Its *registration*
 * side is not: the lobby format list, the sealed random-pick, the Expansions
 * table and its migration, and the set icons all live in files Archon Arena has
 * diverged on, and taking upstream's version of those would overwrite the fork.
 *
 * So the sync says so, in the pull request, with the list from docs/new-sets.md.
 * The alternative is a PR that looks complete, passes every test - because no
 * test covers a set that is not registered - and quietly ships a set players
 * cannot pick.
 */
const detectNewSets = (from, to) => {
    const before = expansionsAt(from, 'server/constants.js');
    const after = expansionsAt(to, 'server/constants.js');
    const beforeClient = expansionsAt(from, 'client/constants.js');
    const afterClient = expansionsAt(to, 'client/constants.js');

    // Either file registering a set we did not have counts. They are meant to
    // agree; if upstream updates one and not the other, that is worth seeing.
    const added = [];
    for (const [id, label] of after) {
        if (!before.has(id)) {
            added.push({ id, label, where: 'server/constants.js' });
        }
    }
    for (const [id, label] of afterClient) {
        if (!beforeClient.has(id) && !added.some((entry) => entry.id === id)) {
            added.push({ id, label, where: 'client/constants.js' });
        }
    }

    const dirsBefore = cardSetDirsAt(from);
    const newCardDirs = [...cardSetDirsAt(to)].filter((dir) => !dirsBefore.has(dir));

    if (added.length === 0 && newCardDirs.length === 0) {
        return null;
    }

    const names = added.length
        ? added.map((entry) => `${entry.label} (id ${entry.id})`).join(', ')
        : newCardDirs.join(', ');

    const checklist = [
        `### New set detected: ${names}`,
        '',
        added.length
            ? `Registered upstream in: ${[...new Set(added.map((e) => e.where))].join(', ')}`
            : 'Detected from new card directories only - upstream may not have registered it yet.',
        newCardDirs.length ? `New card directories: ${newCardDirs.join(', ')}` : '',
        '',
        'The engine side of this set came across with the sync — card implementations,',
        'their tests, the card data, and the tide/token/prophecy flags.',
        '',
        '**The registration side did not, and cannot.** These files are Archon Arena’s and',
        'would be overwritten by upstream’s version, so they are left for a human',
        '(see `docs/new-sets.md`):',
        '',
        '-   [ ] `client/Components/Games/GameFormats.jsx` — add the set to the lobby list',
        '-   [ ] `client/Components/Games/NewGame.jsx` — add the key and the sealed-format check',
        '-   [ ] `server/services/DeckService.js` — add the ExpansionId to the sealed random pick',
        '-   [ ] `server/db/schema/99 - Data.sql` — add the `Expansions` row and bump the sequence',
        '-   [ ] `server/db/schema/migrations/NN - <CODE>.sql` — the same insert, next number',
        '-   [ ] `client/assets/img/idbacks/<id>.png` and `client/assets/img/<id>.png` — set icons',
        '-   [ ] `npm run fetchdata` — import the cards once the pack file exists',
        '',
        'Until those land the set will not be selectable, and **no test will catch it** —',
        'nothing covers a set that was never registered.'
    ]
        .filter((line) => line !== '')
        .join('\n');

    return { names, checklist };
};

const writeState = (state) => {
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 4)}\n`);
};

/**
 * Emit a machine-readable result for the workflow, and a human-readable one for
 * whoever is reading the log. `outcome` is the whole contract:
 *
 *   up-to-date  nothing new upstream
 *   applied     changes are in the working tree, still to be judged by the tests
 *   conflict    the diff could not be applied cleanly; a human has to look
 *   error       the sync itself failed (network, bad state file)
 */
const report = (outcome, detail) => {
    const result = Object.assign({ outcome }, detail);

    console.log(`\n=== upstream sync: ${outcome} ===`);
    if (result.message) {
        console.log(result.message);
    }

    if (process.env.GITHUB_OUTPUT) {
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `outcome=${outcome}\n` +
                `from=${result.from || ''}\n` +
                `to=${result.to || ''}\n` +
                `commits=${result.commitCount || 0}\n` +
                `files=${result.fileCount || 0}\n` +
                `newsets=${result.newSets || ''}\n`
        );
        // The body is multi-line, so it needs the heredoc form.
        fs.appendFileSync(
            process.env.GITHUB_OUTPUT,
            `summary<<UPSTREAM_EOF\n${result.summary || ''}\nUPSTREAM_EOF\n`
        );
    }

    process.exit(outcome === 'conflict' || outcome === 'error' ? 1 : 0);
};

function main() {
    let state;
    try {
        state = readState();
    } catch (err) {
        return report('error', { message: `Could not read ${STATE_FILE}: ${err.message}` });
    }

    const { remote, branch, syncedCommit, paths } = state;
    if (!remote || !branch || !syncedCommit || !Array.isArray(paths) || paths.length === 0) {
        return report('error', {
            message:
                'upstream-sync.json must set remote, branch, syncedCommit and a non-empty paths array.'
        });
    }

    // The remote is configured here rather than assumed, so a fresh clone (or a
    // CI runner) works with no manual setup.
    const remotes = git('remote')
        .split('\n')
        .map((line) => line.trim());
    if (!remotes.includes(REMOTE_NAME)) {
        git('remote', 'add', REMOTE_NAME, remote);
    } else {
        git('remote', 'set-url', REMOTE_NAME, remote);
    }

    console.log(`Fetching ${remote} ${branch} ...`);
    const fetched = gitStatus('fetch', '--no-tags', REMOTE_NAME, branch);
    if (!fetched.ok) {
        return report('error', { message: `Could not fetch upstream:\n${fetched.out}` });
    }

    const target = (explicitTarget || git('rev-parse', 'FETCH_HEAD')).trim();

    // A missing base commit means the state file points at something this clone
    // does not have - worth saying plainly rather than failing inside git diff.
    const baseKnown = gitStatus('cat-file', '-e', `${syncedCommit}^{commit}`);
    if (!baseKnown.ok) {
        return report('error', {
            message:
                `The recorded syncedCommit ${syncedCommit} is not present after fetching. ` +
                'If upstream force-pushed or the history was rewritten, re-anchor it by hand.'
        });
    }

    if (target === syncedCommit) {
        return report('up-to-date', {
            from: syncedCommit,
            to: target,
            message: `Already at upstream ${syncedCommit.slice(0, 9)}; nothing to pull.`
        });
    }

    const range = `${syncedCommit}..${target}`;
    const pathArgs = ['--', ...paths];

    // `git apply --3way` needs the working tree to match the index for every
    // file it touches; against a dirty tree it bails with the notably unhelpful
    // "does not match index", *after* having already applied the files it got to
    // first. Refusing up front turns that into a clear message and, more
    // importantly, keeps the rule that upstream is never applied on top of
    // unfinished local work. CI always has a clean tree, so this only ever fires
    // locally, where it is exactly the right thing to say.
    if (!dryRun) {
        const dirty = git('status', '--porcelain', ...pathArgs).trim();

        if (dirty) {
            return report('error', {
                message:
                    'There are uncommitted changes in the paths this sync writes to:\n' +
                    `${dirty}\n\n` +
                    'Commit or stash them first. Upstream changes must land on a clean tree so ' +
                    'that a conflict is between upstream and Archon Arena, not between upstream ' +
                    'and work in progress.'
            });
        }
    }

    // What changed upstream *in the paths we track*. Commits that only touch
    // upstream's client or CI are correctly invisible here.
    const commitLog = git('log', '--oneline', '--no-decorate', range, ...pathArgs).trim();
    const changedFiles = git('diff', '--name-status', syncedCommit, target, ...pathArgs).trim();

    if (!changedFiles) {
        const allCommits = git('log', '--oneline', '--no-decorate', range).trim();
        const skipped = allCommits ? allCommits.split('\n').length : 0;

        // Still advance the marker: those commits are genuinely not for us, and
        // leaving the marker behind would re-examine them every single run.
        if (!dryRun) {
            writeState(
                Object.assign({}, state, {
                    syncedCommit: target,
                    syncedDate: new Date().toISOString().slice(0, 10),
                    note: `No tracked-path changes in the ${skipped} upstream commit(s) up to this point.`
                })
            );
        }

        return report('up-to-date', {
            from: syncedCommit,
            to: target,
            message:
                `${skipped} upstream commit(s) since ${syncedCommit.slice(0, 9)}, none touching ` +
                `${paths.join(', ')}. Marker advanced to ${target.slice(0, 9)}.`
        });
    }

    const fileCount = changedFiles.split('\n').length;
    const commitCount = commitLog ? commitLog.split('\n').length : 0;
    const newSets = detectNewSets(syncedCommit, target);
    const summary =
        `Upstream commits (${commitCount}):\n${commitLog}\n\n` +
        `Files (${fileCount}):\n${changedFiles}` +
        (newSets ? `\n\n${newSets.checklist}` : '');

    console.log(summary);

    if (dryRun) {
        return report('applied', {
            from: syncedCommit,
            to: target,
            commitCount,
            fileCount,
            summary,
            newSets: newSets && newSets.names,
            message: 'Dry run: nothing was written.'
        });
    }

    // Three-way, so a hunk that does not apply cleanly becomes a marked conflict
    // instead of a rejected patch or - much worse - a silently wrong merge. The
    // pre-image blobs it needs are present because we just fetched upstream.
    const patch = git('diff', '--binary', syncedCommit, target, ...pathArgs);
    const patchFile = path.join(REPO_ROOT, '.upstream-sync.patch');
    fs.writeFileSync(patchFile, patch);

    const applied = gitStatus('apply', '--3way', '--whitespace=nowarn', patchFile);
    fs.unlinkSync(patchFile);

    // `git apply --3way` reports conflicts on stderr AND leaves markers in the
    // tree, so check the tree rather than trusting the exit code alone.
    const conflicted = git('diff', '--name-only', '--diff-filter=U').trim();

    if (!applied.ok || conflicted) {
        // A partly-applied tree is the dangerous outcome: the marker stays put,
        // so the next run would try to apply the same diff again on top of the
        // files that already took it. Say exactly what the tree looks like and
        // how to get back to zero, rather than leaving that to be discovered.
        const touched = git('status', '--porcelain', ...pathArgs).trim();

        return report('conflict', {
            from: syncedCommit,
            to: target,
            commitCount,
            fileCount,
            newSets: newSets && newSets.names,
            summary:
                `${summary}\n\nConflicting files:\n${conflicted || '(none marked)'}\n\n` +
                `${applied.out}\nWorking tree now:\n${touched || '(unchanged)'}`,
            message:
                'The upstream diff did not apply cleanly.\n\n' +
                `Conflicting files:\n${
                    conflicted || '(none marked - see the git output below)'
                }\n\n` +
                `${applied.out}\n` +
                'The sync marker was NOT advanced. The apply is three-way, so it may have\n' +
                'applied some files and left others conflicted - the working tree now shows:\n' +
                `${touched || '(unchanged)'}\n\n` +
                `To abandon it entirely:  git checkout -- ${paths.join(' ')}`
        });
    }

    writeState(
        Object.assign({}, state, {
            syncedCommit: target,
            syncedDate: new Date().toISOString().slice(0, 10),
            note: `Applied ${commitCount} upstream commit(s) touching ${fileCount} file(s).`
        })
    );

    return report('applied', {
        from: syncedCommit,
        to: target,
        commitCount,
        fileCount,
        summary,
        newSets: newSets && newSets.names,
        message:
            `Applied cleanly. The changes are in the working tree and have NOT been verified - ` +
            'run the full suite before trusting them.' +
            (newSets
                ? `\n\nThis sync brings a NEW SET (${newSets.names}) - see the checklist above.`
                : '')
    });
}

// Only run when invoked as a script, so the parsing above can be unit-tested
// without a git remote - see test/server/scripts/upstreamSync.spec.js.
if (require.main === module) {
    try {
        main();
    } catch (err) {
        report('error', { message: err.stack || String(err) });
    }
}

module.exports = { parseExpansions, detectNewSets, expansionsAt, cardSetDirsAt };
