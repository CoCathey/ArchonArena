#!/usr/bin/env bash
# Archon Arena production update.
#
#   cd /opt/archonarena && bash deploy/update.sh
#
# Why this exists: deploying by hand is a five-command sequence where skipping
# or mistyping any one of them fails silently rather than loudly.
#
#   * `git fetch` instead of `git pull` moves only the remote-tracking pointer.
#     The build then rebuilds the code already on disk, reports success, and
#     leaves the site on the old version. That is not a hypothetical - it kept a
#     production deployment 31 commits behind for a month.
#   * Forgetting `npm run migrate` leaves the code ahead of the schema. Features
#     that touch a missing table fail one at a time, and best-effort paths (like
#     rating a finished game) fail *silently* - the game still ends, it just
#     never reaches the ladder.
#
# So this does the whole sequence, in order, and stops at the first failure.
# It changes nothing that `git pull` would not, and every step is one you could
# run by hand.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
BRANCH="${DEPLOY_BRANCH:-main}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die() {
    printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
    exit 1
}

# --- preflight ---------------------------------------------------------------
# Refuse rather than deploy something other than what is committed. A dirty tree
# means the running site would not match any commit, so no rollback target.
step "Checking the working tree"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    git status --short --untracked-files=no
    die "Uncommitted changes. Commit or stash them; a deploy must be reproducible."
fi

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" != "$BRANCH" ]; then
    die "On '$current_branch', expected '$BRANCH'. Set DEPLOY_BRANCH to override."
fi

before="$(git rev-parse HEAD)"
echo "  clean, on $BRANCH at ${before:0:9}"

# --- code --------------------------------------------------------------------
step "Pulling $BRANCH"
# --ff-only: if the server has commits of its own this stops instead of making a
# merge nobody asked for.
git pull --ff-only origin "$BRANCH" || die "Pull failed. Resolve by hand."

after="$(git rev-parse HEAD)"

if [ "$before" = "$after" ]; then
    echo "  already at ${after:0:9} - nothing new"
else
    echo "  ${before:0:9} -> ${after:0:9}"
    git --no-pager log --oneline "$before..$after" | sed 's/^/    /'
fi

# --- build and restart -------------------------------------------------------
# Delegated to the rolling deploy, which replaces the lobby and then each game
# node in turn, draining each one first.
#
# This step used to be `$DC up -d --build`, and that is now actively wrong in two
# ways. It recreates every container at once, so every game in progress dies -
# which was always true, but there was no alternative before. And since the game
# nodes were given a 95-minute stop_grace_period (so their drain can actually
# finish rather than being SIGKILLed after 10 seconds), the same command now
# blocks for up to 90 minutes with the whole fleet standing down and players
# unable to start a game, with no output explaining why.
#
# --skip-migrations because this script runs them itself below, with the ledger
# guidance that the plain runner does not print.
step "Building and rolling out"
# Plain relative path: this script has already cd'd to the repo root above, and
# `$(dirname "$0")` is relative to the directory it was *invoked* from, which is
# no longer where we are.
bash deploy/rolling-deploy.sh --skip-migrations --yes || die "Build or rollout failed."

# --- schema ------------------------------------------------------------------
# After the containers are up, because it runs inside the lobby.
step "Applying database migrations"
migrate_output="$($DC exec -T lobby npm run migrate 2>&1)"
migrate_status=$?
echo "$migrate_output" | sed 's/^/  /'

if [ $migrate_status -ne 0 ]; then
    if echo "$migrate_output" | grep -q 'no migration ledger'; then
        cat <<'EOF'

This database predates the migration ledger. Work out how far it has actually
got, then seed the ledger only that far - a full --baseline would mark every
migration applied without running any, and the missing tables would stay
missing:

    docker compose -f docker-compose.prod.yml --env-file .env.production \
      exec lobby npm run migrate -- --status
    docker compose -f docker-compose.prod.yml --env-file .env.production \
      exec lobby npm run migrate -- --baseline-through 21

Then run this script again. See docs/DEPLOYMENT.md.
EOF
    fi
    die "Migrations did not complete. The site is running new code against an old schema."
fi

# --- verify ------------------------------------------------------------------
step "Health check"
bash deploy/healthcheck.sh
health_status=$?

# --- unrated games -----------------------------------------------------------
# A schema that was behind will have left finished games unrated, and nothing
# retries them on its own. Report, never fix silently: rating writes to the
# ladder and that is the operator's call.
step "Checking for unrated games"
backfill_output="$($DC exec -T lobby npm run backfill:ratings 2>&1)"
if echo "$backfill_output" | grep -q 'have no rating rows'; then
    echo "$backfill_output" | grep -E 'have no rating rows|^  #' | sed 's/^/  /'
    cat <<'EOF'

  These finished games were never rated. To rate them now:
      docker compose -f docker-compose.prod.yml --env-file .env.production \
        exec lobby npm run backfill:ratings -- --commit
EOF
else
    echo "  none"
fi

if [ $health_status -ne 0 ]; then
    die "Deployed, but the health check reported problems - see above."
fi

printf '\n\033[32mUpdated to %s and healthy.\033[0m\n' "${after:0:9}"
