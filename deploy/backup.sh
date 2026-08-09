#!/usr/bin/env bash
# Archon Arena off-host backup.
#
#   cd /opt/archonarena && bash deploy/backup.sh
#
# Produces one encrypted archive holding the database and the uploaded images,
# ships it to object storage (or a second host), verifies what arrived, prunes
# old copies, and records the run so deploy/healthcheck.sh can tell you when it
# stops happening.
#
# Why it is a script and not a cron one-liner: the one-liner in DEPLOYMENT.md
# wrote a plain dump to /var/backups on the same disk as the database, with a
# note saying to copy it off-host by hand. A backup that depends on somebody
# remembering is not a backup, and a backup on the disk you are protecting
# against is not one either.
#
# Three things here are not optional and are the reason this is worth reading:
#
#   * The archive is verified by decrypting it again and comparing checksums
#     before the run is called a success. A truncated write is discovered now,
#     not during the restore you are doing because the server is gone.
#   * The upload is verified by asking the remote for the object's size. "The
#     upload command exited 0" is not evidence the bytes are there.
#   * BACKUP_PASSPHRASE has to exist somewhere other than this machine. It is
#     the one input that cannot be reconstructed, and an encrypted backup you
#     cannot decrypt is an elaborate way of having no backup. Put it in a
#     password manager the day you set it.
#
# What is NOT in here, deliberately:
#
#   * .env.production. It holds SECRET, HMAC_SECRET, the database password and
#     the third-party keys - shipping it to the same bucket as the data would
#     mean one compromised bucket gives up both the backup and everything
#     needed to read it. Keep it in your password manager.
#   * Redis. It holds rate-limit counters and socket adapter state, all of which
#     regenerate. Nothing durable lives there.
#   * Card art, unless BACKUP_INCLUDE_CARD_ART=true. It is ~6k images that
#     `npm run fetchdata` re-downloads, so it is re-derivable bulk rather than
#     player data. Avatars and custom backgrounds are NOT re-derivable and are
#     always included.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DRY_RUN=false
[ "${1:-}" = "--dry-run" ] && DRY_RUN=true

# The env file is overridable so a staging stack - and the restore rehearsal in
# test/deploy/backupRestore.spec.js - can point at their own settings instead of
# the production one.
ENV_FILE="${ARCHON_ENV_FILE:-.env.production}"
DC="docker compose -f docker-compose.prod.yml --env-file $ENV_FILE"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
die() {
    printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
    exit 1
}

# --- configuration -----------------------------------------------------------
# Read from .env.production rather than the environment so a cron entry needs no
# secrets of its own: `0 5 * * * cd /opt/archonarena && bash deploy/backup.sh`.
env_val() { grep -E "^$1=" "$ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^"//;s/"$//'; }

[ -f "$ENV_FILE" ] || die "No $ENV_FILE. This script is for the production host."

BACKUP_PASSPHRASE="$(env_val BACKUP_PASSPHRASE)"
BACKUP_DIR="$(env_val BACKUP_DIR)"; BACKUP_DIR="${BACKUP_DIR:-/var/backups/archonarena}"
BACKUP_KEEP_LOCAL="$(env_val BACKUP_KEEP_LOCAL)"; BACKUP_KEEP_LOCAL="${BACKUP_KEEP_LOCAL:-7}"
BACKUP_KEEP_REMOTE="$(env_val BACKUP_KEEP_REMOTE)"; BACKUP_KEEP_REMOTE="${BACKUP_KEEP_REMOTE:-30}"
BACKUP_INCLUDE_CARD_ART="$(env_val BACKUP_INCLUDE_CARD_ART)"
BACKUP_S3_BUCKET="$(env_val BACKUP_S3_BUCKET)"
BACKUP_S3_PREFIX="$(env_val BACKUP_S3_PREFIX)"; BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-archonarena}"
BACKUP_S3_ENDPOINT="$(env_val BACKUP_S3_ENDPOINT)"
BACKUP_RSYNC_TARGET="$(env_val BACKUP_RSYNC_TARGET)"
DB_USER="$(env_val DB_USER)"; DB_USER="${DB_USER:-archonarena}"
DB_NAME="$(env_val DB_NAME)"; DB_NAME="${DB_NAME:-archonarena}"

# Two seams for a stack where Postgres or the uploaded images are not inside
# compose - a managed database, say. They are also what lets the restore
# rehearsal in test/deploy/backupRestore.spec.js drive these scripts for real,
# which is the difference between a rehearsed restore and a paragraph in a
# runbook that nobody has executed since the day it was written.
#
#   BACKUP_PG_URI      libpq base URI; the database name is appended
#   BACKUP_IMAGE_ROOT  directory holding avatar/, bgs/ and cards/
PG_URI="$(env_val BACKUP_PG_URI)"; PG_URI="${BACKUP_PG_URI:-$PG_URI}"
IMAGE_ROOT="$(env_val BACKUP_IMAGE_ROOT)"; IMAGE_ROOT="${BACKUP_IMAGE_ROOT:-$IMAGE_ROOT}"

[ -n "$BACKUP_PASSPHRASE" ] || die "BACKUP_PASSPHRASE is not set in $ENV_FILE.
       Generate one and store it in your password manager BEFORE the first run:
           openssl rand -base64 48
       If it only ever exists on this machine, the backup dies with the machine."

OFFHOST="none"
[ -n "$BACKUP_S3_BUCKET" ] && OFFHOST="s3"
[ -n "$BACKUP_RSYNC_TARGET" ] && OFFHOST="rsync"

STAMP="$(date -u +%Y-%m-%dT%H%M%SZ)"
DAY="$(date -u +%F)"
ARCHIVE="archonarena-${STAMP}.tar.enc"
STARTED_AT="$(date -u +%s)"

if $DRY_RUN; then
    step "Dry run"
    info "archive:     $BACKUP_DIR/$ARCHIVE"
    info "database:    $DB_NAME as $DB_USER"
    info "card art:    $([ "$BACKUP_INCLUDE_CARD_ART" = "true" ] && echo included || echo 'excluded (re-derivable via npm run fetchdata)')"
    info "off-host:    $OFFHOST"
    [ "$OFFHOST" = "s3" ] && info "             s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/${BACKUP_S3_ENDPOINT:+ via $BACKUP_S3_ENDPOINT}"
    [ "$OFFHOST" = "rsync" ] && info "             $BACKUP_RSYNC_TARGET"
    info "retention:   $BACKUP_KEEP_LOCAL local, $BACKUP_KEEP_REMOTE remote"
    [ "$OFFHOST" = "none" ] && warn "No off-host target configured - see BACKUP_S3_BUCKET in .env.production.example"
    exit 0
fi

# --- staging -----------------------------------------------------------------
mkdir -p "$BACKUP_DIR" || die "Cannot create $BACKUP_DIR"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/archon-backup.XXXXXX")" || die "Cannot create a staging directory"
chmod 700 "$STAGE"
cleanup() { rm -rf "$STAGE"; }
trap cleanup EXIT

# The passphrase goes to a mode-600 file rather than the command line, where it
# would be readable in `ps` by every user on the box for the life of the run.
PASSFILE="$STAGE/pass"
umask 077
printf '%s' "$BACKUP_PASSPHRASE" >"$PASSFILE"

CONTENT="$STAGE/content"
mkdir -p "$CONTENT"


# --- database ----------------------------------------------------------------
step "Dumping $DB_NAME"
# --clean --if-exists because the disaster case restores onto a stack that has
# already run initdb over server/db/schema, so every table exists before the
# dump is applied; without the DROPs the restore collides on the first CREATE.
# --no-owner --no-acl so the dump does not require the role names of the machine
# that is gone.
PGDUMP_FLAGS=(--clean --if-exists --no-owner --no-acl)
if [ -n "$PG_URI" ]; then
    pg_dump "${PGDUMP_FLAGS[@]}" "$PG_URI/$DB_NAME" | gzip -9 >"$CONTENT/database.sql.gz"
    dump_status=("${PIPESTATUS[@]}")
else
    $DC exec -T postgres pg_dump "${PGDUMP_FLAGS[@]}" -U "$DB_USER" "$DB_NAME" | gzip -9 >"$CONTENT/database.sql.gz"
    dump_status=("${PIPESTATUS[@]}")
fi
[ "${dump_status[0]}" -eq 0 ] || die "pg_dump failed (exit ${dump_status[0]}). Nothing was written."
[ "${dump_status[1]}" -eq 0 ] || die "gzip failed while compressing the dump."

# An empty or header-only dump exits 0. Insist on seeing the tables that hold
# the data this exists to protect, so a dump of the wrong (or a freshly
# initialised) database fails here instead of looking like a good backup.
#
# Read once into a variable and match in the shell rather than piping into
# `grep -q`: under `pipefail` a quiet grep exits on its first hit, the writer
# upstream takes SIGPIPE, and the pipeline reports failure at exactly the moment
# the check passed.
dump_tables="$(gunzip -c "$CONTENT/database.sql.gz" | grep -oE '^COPY public\."[A-Za-z]+"' || true)"
for table in Users Ratings Games; do
    case "$dump_tables" in
        *"\"$table\""*) ;;
        *) die "The dump contains no \"$table\" table. That is not this database - check DB_NAME/DB_USER." ;;
    esac
done
info "database.sql.gz  $(du -h "$CONTENT/database.sql.gz" | cut -f1)"

# --- uploaded images ---------------------------------------------------------
# Avatars and backgrounds are player uploads and exist nowhere else. Card art is
# bulk that fetchdata can re-download, so it is opt-in.
step "Archiving uploaded images"
capture_images() { # local-name, directory-under-img
    local name="$1" dir="$2" out="$CONTENT/$1.tar.gz"

    if [ -n "$IMAGE_ROOT" ]; then
        if [ -d "$IMAGE_ROOT/$dir" ]; then
            tar -czf "$out" -C "$IMAGE_ROOT" "$dir" || die "Could not archive $dir"
        else
            info "$name: no $IMAGE_ROOT/$dir, nothing to archive"
            return
        fi
    else
        $DC exec -T lobby tar -cz -C /usr/src/app/public/img "$dir" >"$out" 2>/dev/null ||
            die "Could not archive $dir from the lobby container. Is the stack up?"
    fi

    info "$name.tar.gz  $(du -h "$out" | cut -f1)"
}

capture_images avatars avatar
capture_images backgrounds bgs
if [ "$BACKUP_INCLUDE_CARD_ART" = "true" ]; then
    capture_images card-art cards
else
    info "card art excluded (BACKUP_INCLUDE_CARD_ART is not true; npm run fetchdata re-downloads it)"
fi

# --- manifest ----------------------------------------------------------------
# Written inside the archive so a restore can prove each member arrived intact
# rather than trusting that a tar which extracted is a tar that is correct.
step "Writing the manifest"
{
    printf '{\n'
    printf '  "format": 1,\n'
    printf '  "createdAt": "%s",\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf '  "host": "%s",\n' "$(hostname)"
    printf '  "commit": "%s",\n' "$(git rev-parse HEAD 2>/dev/null || echo unknown)"
    printf '  "database": "%s",\n' "$DB_NAME"
    printf '  "cardArtIncluded": %s,\n' "$([ "$BACKUP_INCLUDE_CARD_ART" = "true" ] && echo true || echo false)"
    printf '  "members": {\n'
    first=true
    for f in "$CONTENT"/*; do
        [ -f "$f" ] || continue
        $first || printf ',\n'
        first=false
        printf '    "%s": { "bytes": %s, "sha256": "%s" }' \
            "$(basename "$f")" "$(stat -c%s "$f")" "$(sha256sum "$f" | cut -d' ' -f1)"
    done
    printf '\n  }\n}\n'
} >"$STAGE/manifest.json"
mv "$STAGE/manifest.json" "$CONTENT/manifest.json"

# --- pack and encrypt --------------------------------------------------------
step "Encrypting"
tar -cf "$STAGE/archive.tar" -C "$CONTENT" . || die "Could not pack the archive."
plain_sha="$(sha256sum "$STAGE/archive.tar" | cut -d' ' -f1)"

openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -salt \
    -in "$STAGE/archive.tar" -out "$BACKUP_DIR/$ARCHIVE" -pass "file:$PASSFILE" ||
    die "Encryption failed."
chmod 600 "$BACKUP_DIR/$ARCHIVE"

# Decrypt it straight back. This is the difference between "a file was written"
# and "a file that can be restored was written" - a truncated or half-flushed
# write passes the first and fails the second, and only one of those is a
# backup.
step "Verifying the archive"
roundtrip_sha="$(openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 \
    -in "$BACKUP_DIR/$ARCHIVE" -pass "file:$PASSFILE" 2>/dev/null | sha256sum | cut -d' ' -f1)"
[ "$roundtrip_sha" = "$plain_sha" ] ||
    die "The archive does not decrypt back to what was encrypted. Local disk or memory fault; do not trust this backup."

cipher_bytes="$(stat -c%s "$BACKUP_DIR/$ARCHIVE")"
cipher_sha="$(sha256sum "$BACKUP_DIR/$ARCHIVE" | cut -d' ' -f1)"
info "$ARCHIVE  $(du -h "$BACKUP_DIR/$ARCHIVE" | cut -f1)  verified"

# --- ship off-host -----------------------------------------------------------
remote_uri=""
case "$OFFHOST" in
    s3)
        step "Uploading to s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/"
        remote_uri="s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/$ARCHIVE"
        # The AWS CLI runs in a container so the host needs nothing installed,
        # and --endpoint-url is what makes this work against R2, B2, Wasabi or
        # anything else speaking S3 rather than only AWS.
        aws_cli() {
            docker run --rm \
                -e AWS_ACCESS_KEY_ID="$(env_val AWS_ACCESS_KEY_ID)" \
                -e AWS_SECRET_ACCESS_KEY="$(env_val AWS_SECRET_ACCESS_KEY)" \
                -e AWS_DEFAULT_REGION="$(env_val AWS_DEFAULT_REGION)" \
                -v "$BACKUP_DIR:/backup:ro" \
                amazon/aws-cli:latest ${BACKUP_S3_ENDPOINT:+--endpoint-url "$BACKUP_S3_ENDPOINT"} "$@"
        }
        aws_cli s3 cp "/backup/$ARCHIVE" "$remote_uri" >/dev/null || die "Upload failed."

        # Ask the remote how big the object is. An upload command that exited 0
        # is not evidence the bytes are there.
        remote_bytes="$(aws_cli s3api head-object --bucket "$BACKUP_S3_BUCKET" \
            --key "$BACKUP_S3_PREFIX/$ARCHIVE" --query ContentLength --output text 2>/dev/null | tr -dc '0-9')"
        [ "$remote_bytes" = "$cipher_bytes" ] ||
            die "Uploaded object is ${remote_bytes:-unreadable} bytes, expected $cipher_bytes. The remote copy is not usable."
        info "verified $remote_bytes bytes at $remote_uri"

        if [ "$BACKUP_KEEP_REMOTE" -gt 0 ] 2>/dev/null; then
            cutoff="$(date -u -d "$BACKUP_KEEP_REMOTE days ago" +%Y-%m-%d)"
            aws_cli s3 ls "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/" 2>/dev/null |
                awk '{print $1, $4}' | while read -r d key; do
                [ -n "$key" ] || continue
                [[ "$d" < "$cutoff" ]] && aws_cli s3 rm "s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/$key" >/dev/null
            done
            info "pruned remote copies older than $cutoff"
        fi
        ;;
    rsync)
        step "Copying to $BACKUP_RSYNC_TARGET"
        remote_uri="$BACKUP_RSYNC_TARGET/$ARCHIVE"
        rsync -a --chmod=600 "$BACKUP_DIR/$ARCHIVE" "$BACKUP_RSYNC_TARGET/" || die "rsync failed."
        remote_bytes="$(rsync --list-only "$BACKUP_RSYNC_TARGET/$ARCHIVE" 2>/dev/null | awk '{gsub(/,/,"",$2); print $2}')"
        [ "$remote_bytes" = "$cipher_bytes" ] ||
            die "Remote copy is ${remote_bytes:-unreadable} bytes, expected $cipher_bytes."
        info "verified $remote_bytes bytes at $remote_uri"
        ;;
    none)
        warn "No off-host target configured, so this backup is on the same machine as the database."
        warn "That protects against a bad migration and against nothing else. Set BACKUP_S3_BUCKET"
        warn "or BACKUP_RSYNC_TARGET in $ENV_FILE - see .env.production.example."
        ;;
esac

# --- local retention ---------------------------------------------------------
step "Pruning local copies"
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/archonarena-*.tar.enc 2>/dev/null | tail -n "+$((BACKUP_KEEP_LOCAL + 1))" | while read -r old; do
    rm -f "$old"
    info "removed $(basename "$old")"
done
info "keeping the newest $BACKUP_KEEP_LOCAL locally"

# --- record ------------------------------------------------------------------
# healthcheck.sh reads this. It is written only after the archive verified and
# (when configured) the remote copy was confirmed, so its presence means a
# usable backup exists rather than that the script ran.
elapsed=$(($(date -u +%s) - STARTED_AT))
cat >"$BACKUP_DIR/last-success.json" <<EOF
{
    "finishedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "day": "$DAY",
    "archive": "$ARCHIVE",
    "bytes": $cipher_bytes,
    "sha256": "$cipher_sha",
    "offHost": "$OFFHOST",
    "remote": "$remote_uri",
    "seconds": $elapsed
}
EOF

printf '\n\033[32mBacked up in %ss: %s (%s)\033[0m\n' "$elapsed" "$ARCHIVE" \
    "$([ "$OFFHOST" = "none" ] && echo 'LOCAL ONLY' || echo "off-host via $OFFHOST")"
