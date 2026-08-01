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
                `files=${result.fileCount || 0}\n`
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
    const summary = `Upstream commits (${commitCount}):\n${commitLog}\n\nFiles (${fileCount}):\n${changedFiles}`;

    console.log(summary);

    if (dryRun) {
        return report('applied', {
            from: syncedCommit,
            to: target,
            commitCount,
            fileCount,
            summary,
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
        message:
            `Applied cleanly. The changes are in the working tree and have NOT been verified - ` +
            'run the full suite before trusting them.'
    });
}

try {
    main();
} catch (err) {
    report('error', { message: err.stack || String(err) });
}
