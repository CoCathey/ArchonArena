#!/usr/bin/env bash
# Archon Arena restore from an off-host backup.
#
#   bash deploy/restore.sh --verify-only /var/backups/archonarena/archonarena-....tar.enc
#   bash deploy/restore.sh --database archonarena_rehearsal s3://bucket/archonarena/archonarena-....tar.enc
#   bash deploy/restore.sh --yes s3://bucket/archonarena/archonarena-....tar.enc
#
# Three modes, in increasing order of consequence:
#
#   --verify-only   fetch, decrypt and check every checksum. Changes nothing.
#                   Safe against production, and the thing to run on a schedule
#                   if you want to know your backups are readable rather than
#                   merely present.
#   --database NAME restore into another database on the same server. This is
#                   how you rehearse without touching the live one.
#   (neither)       restore over the configured database. Destructive, refuses
#                   to proceed without --yes.
#
# The archive is a tar of gzipped members plus a manifest recording each one's
# size and SHA-256. Every member is checked against the manifest before anything
# is written, because a restore is the one operation where discovering the file
# was corrupt halfway through is worst.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

ENV_FILE="${ARCHON_ENV_FILE:-.env.production}"
DC="docker compose -f docker-compose.prod.yml --env-file $ENV_FILE"

VERIFY_ONLY=false
ASSUME_YES=false
SKIP_IMAGES=false
TARGET_DB=""
SOURCE=""

while [ $# -gt 0 ]; do
    case "$1" in
        --verify-only) VERIFY_ONLY=true ;;
        --yes) ASSUME_YES=true ;;
        --skip-images) SKIP_IMAGES=true ;;
        --database)
            TARGET_DB="${2:-}"
            shift
            ;;
        -h | --help)
            sed -n '2,25p' "$0" | sed 's/^# \?//'
            exit 0
            ;;
        -*) echo "Unknown option: $1" >&2 && exit 2 ;;
        *) SOURCE="$1" ;;
    esac
    shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
die() {
    printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
    exit 1
}

[ -n "$SOURCE" ] || die "No archive given. Pass a path or an s3:// URI; --help for the modes."
[ -f "$ENV_FILE" ] || die "No $ENV_FILE - restore needs BACKUP_PASSPHRASE and the database settings."

env_val() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'; }

BACKUP_PASSPHRASE="$(env_val BACKUP_PASSPHRASE)"
BACKUP_S3_ENDPOINT="$(env_val BACKUP_S3_ENDPOINT)"
DB_USER="$(env_val DB_USER)"; DB_USER="${DB_USER:-archonarena}"
DB_NAME="$(env_val DB_NAME)"; DB_NAME="${DB_NAME:-archonarena}"
PG_URI="$(env_val BACKUP_PG_URI)"; PG_URI="${BACKUP_PG_URI:-$PG_URI}"
IMAGE_ROOT="$(env_val BACKUP_IMAGE_ROOT)"; IMAGE_ROOT="${BACKUP_IMAGE_ROOT:-$IMAGE_ROOT}"

[ -n "$BACKUP_PASSPHRASE" ] || die "BACKUP_PASSPHRASE is not set. This is the passphrase the archive was encrypted with - it should be in your password manager."

RESTORE_DB="${TARGET_DB:-$DB_NAME}"
STARTED_AT="$(date -u +%s)"

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/archon-restore.XXXXXX")" || die "Cannot create a staging directory"
chmod 700 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

umask 077
PASSFILE="$STAGE/pass"
printf '%s' "$BACKUP_PASSPHRASE" >"$PASSFILE"

# --- fetch -------------------------------------------------------------------
step "Fetching the archive"
ARCHIVE="$STAGE/archive.enc"
case "$SOURCE" in
    s3://*)
        bucket="${SOURCE#s3://}"
        key="${bucket#*/}"
        bucket="${bucket%%/*}"
        docker run --rm \
            -e AWS_ACCESS_KEY_ID="$(env_val AWS_ACCESS_KEY_ID)" \
            -e AWS_SECRET_ACCESS_KEY="$(env_val AWS_SECRET_ACCESS_KEY)" \
            -e AWS_DEFAULT_REGION="$(env_val AWS_DEFAULT_REGION)" \
            -v "$STAGE:/restore" \
            amazon/aws-cli:latest ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} \
            s3 cp "s3://$bucket/$key" /restore/archive.enc >/dev/null ||
            die "Could not download $SOURCE"
        ;;
    *)
        [ -f "$SOURCE" ] || die "No such file: $SOURCE"
        cp "$SOURCE" "$ARCHIVE" || die "Could not read $SOURCE"
        ;;
esac
info "$(du -h "$ARCHIVE" | cut -f1) from $SOURCE"

# --- decrypt and check -------------------------------------------------------
step "Decrypting"
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
    -in "$ARCHIVE" -out "$STAGE/archive.tar" -pass "file:$PASSFILE" 2>/dev/null ||
    die "Could not decrypt. Wrong BACKUP_PASSPHRASE, or the archive is damaged."

CONTENT="$STAGE/content"
mkdir -p "$CONTENT"
tar -xf "$STAGE/archive.tar" -C "$CONTENT" || die "The archive decrypted but will not unpack."
[ -f "$CONTENT/manifest.json" ] || die "No manifest in the archive - it was not written by deploy/backup.sh."

step "Checking the manifest"
created="$(grep -o '"createdAt": *"[^"]*"' "$CONTENT/manifest.json" | cut -d'"' -f4)"
commit="$(grep -o '"commit": *"[^"]*"' "$CONTENT/manifest.json" | cut -d'"' -f4)"
info "taken $created at commit ${commit:0:9}"

# Compare every member against the manifest before writing anything anywhere.
# One sed, emitting "name bytes sha" per member, rather than three greps over
# the same line - each of which is a chance to pick up a stray quote and call a
# good archive corrupt.
members="$(sed -n 's/^ *"\([A-Za-z0-9._-]*\)": { "bytes": \([0-9]*\), "sha256": "\([a-f0-9]*\)".*/\1 \2 \3/p' "$CONTENT/manifest.json")"
[ -n "$members" ] || die "The manifest lists no members."

bad=0
while read -r name want_bytes want_sha; do
    [ -n "$name" ] || continue

    if [ ! -f "$CONTENT/$name" ]; then
        printf '  \033[31mMISSING\033[0m %s\n' "$name"
        bad=$((bad + 1))
        continue
    fi

    got_bytes="$(stat -c%s "$CONTENT/$name")"
    got_sha="$(sha256sum "$CONTENT/$name" | cut -d' ' -f1)"

    if [ "$got_bytes" = "$want_bytes" ] && [ "$got_sha" = "$want_sha" ]; then
        printf '  \033[32mOK\033[0m      %s (%s bytes)\n' "$name" "$got_bytes"
    else
        printf '  \033[31mCORRUPT\033[0m %s\n' "$name"
        bad=$((bad + 1))
    fi
done <<<"$members"

[ "$bad" -eq 0 ] || die "$bad member(s) do not match the manifest. Do not restore this archive."

if $VERIFY_ONLY; then
    printf '\n\033[32mArchive is intact and decryptable (%ss). Nothing was changed.\033[0m\n' \
        "$(($(date -u +%s) - STARTED_AT))"
    exit 0
fi

# --- confirm -----------------------------------------------------------------
if [ "$RESTORE_DB" = "$DB_NAME" ] && ! $ASSUME_YES; then
    cat <<EOF

This will restore over the LIVE database "$DB_NAME". The dump drops and
recreates every object it contains, so anything written since $created is lost.

To rehearse instead, restore into a scratch database and change nothing live:
    bash deploy/restore.sh --database ${DB_NAME}_rehearsal "$SOURCE"

Re-run with --yes if you mean it.
EOF
    exit 1
fi

# --- database ----------------------------------------------------------------
step "Restoring the database into \"$RESTORE_DB\""
psql_run() { # database, [args...]
    local db="$1"
    shift
    if [ -n "$PG_URI" ]; then
        psql -v ON_ERROR_STOP=1 "$PG_URI/$db" "$@"
    else
        $DC exec -T postgres psql -v ON_ERROR_STOP=1 -U "$DB_USER" -d "$db" "$@"
    fi
}

# Restoring into a database that does not exist yet is the normal case when
# rehearsing, so create it rather than making that a manual prerequisite.
# `| grep -q` would be the obvious way to ask, and is a trap: under `pipefail`
# the quiet grep exits on its first hit, psql takes SIGPIPE, and "the database
# exists" comes back as a failed pipeline.
if [ -n "$PG_URI" ]; then
    exists="$(psql -tAc "SELECT 1 FROM pg_database WHERE datname='$RESTORE_DB'" "$PG_URI/postgres" 2>/dev/null | tr -dc '0-9')"
    [ "$exists" = "1" ] ||
        psql -q "$PG_URI/postgres" -c "CREATE DATABASE \"$RESTORE_DB\"" >/dev/null ||
        die "Could not create database \"$RESTORE_DB\"."
else
    exists="$($DC exec -T postgres psql -U "$DB_USER" -tAc "SELECT 1 FROM pg_database WHERE datname='$RESTORE_DB'" postgres 2>/dev/null | tr -dc '0-9')"
    [ "$exists" = "1" ] ||
        $DC exec -T postgres createdb -U "$DB_USER" "$RESTORE_DB" ||
        die "Could not create database \"$RESTORE_DB\"."
fi

# The dump carries DROP ... IF EXISTS for everything it recreates, so applying
# it to a schema-initialised database is expected and its notices are not
# errors. ON_ERROR_STOP is still on: a real failure stops here rather than
# leaving a half-restored database that looks like it worked.
gunzip -c "$CONTENT/database.sql.gz" | psql_run "$RESTORE_DB" >"$STAGE/restore.log" 2>&1
restore_status=("${PIPESTATUS[@]}")
if [ "${restore_status[1]}" -ne 0 ]; then
    tail -20 "$STAGE/restore.log" >&2
    die "psql failed while restoring. The database is in an unknown state; see above."
fi

rows() { psql_run "$RESTORE_DB" -tAc "SELECT COUNT(*) FROM \"$1\"" 2>/dev/null | tr -dc '0-9'; }
info "users: $(rows Users)   ratings: $(rows Ratings)   games: $(rows Games)   tournaments: $(rows Tournaments)"

# --- images ------------------------------------------------------------------
if $SKIP_IMAGES; then
    step "Skipping images (--skip-images)"
else
    step "Restoring uploaded images"
    restore_images() { # member, directory-under-img
        local file="$CONTENT/$1.tar.gz"

        if [ ! -f "$file" ]; then
            info "$1: not in this archive, skipped"
            return
        fi

        if [ -n "$IMAGE_ROOT" ]; then
            mkdir -p "$IMAGE_ROOT"
            tar -xzf "$file" -C "$IMAGE_ROOT" || die "Could not unpack $1"
        else
            $DC exec -T lobby tar -xz -C /usr/src/app/public/img <"$file" ||
                die "Could not unpack $1 into the lobby container."
        fi

        info "$1 restored"
    }

    restore_images avatars avatar
    restore_images backgrounds bgs
    restore_images card-art cards

    if [ ! -f "$CONTENT/card-art.tar.gz" ]; then
        info "card art was not in this archive - re-download it with: $DC exec lobby npm run fetchdata"
    fi
fi

elapsed=$(($(date -u +%s) - STARTED_AT))
printf '\n\033[32mRestored "%s" from %s in %ss.\033[0m\n' "$RESTORE_DB" "$created" "$elapsed"

if [ "$RESTORE_DB" = "$DB_NAME" ]; then
    # Every node, not just node-0: one left running holds pre-restore state in
    # memory while the lobby talks to a rebuilt database. And `restart` now
    # honours the game nodes' 95-minute stop_grace_period, so a node with a game
    # on it waits for that game rather than bouncing in seconds - hence the short
    # timeout here. A database was just restored underneath them; the games in
    # progress are already invalid.
    nodes="$($DC config --services 2>/dev/null | grep -E '^node-' | sort | tr '\n' ' ' || true)"

    cat <<EOF

Next:
    $DC stop -t 30 ${nodes:-node-0}
    $DC up -d lobby ${nodes:-node-0}
    bash deploy/healthcheck.sh
EOF
fi
