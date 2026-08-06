#!/usr/bin/env bash
# Archon Arena Patreon setup.
#
#   cd /opt/archonarena && bash deploy/patreon-setup.sh
#
# Asks for the three values from your Patreon client page, looks up the campaign
# id for you, writes them into .env.production, restarts the lobby, and proves it
# worked by reading the status endpoint back.
#
# Why this exists rather than "edit the env file and restart":
#
#   * The campaign id is the one value Patreon does not show you in the UI. It
#     takes an API call with the creator token, and skipping it is not a
#     cosmetic omission - without it, a pledge to ANY creator on Patreon counts
#     as a pledge to you, and those people get the supporter role here.
#   * Pasted credentials routinely carry a trailing space or newline. That fails
#     at the very last step of the OAuth handshake, as a generic "error syncing
#     your patreon account" with nothing in the logs pointing at whitespace.
#     Everything read here is trimmed.
#   * A wrong value looks exactly like a right one until a player tries to link.
#     The check at the end is the difference between "configured" and "working".
#
# Re-running is safe: it overwrites the same keys rather than appending copies,
# and backs the env file up first.
#
# Non-interactive (skips the matching prompt):
#   PATREON_CLIENT_ID=... PATREON_CLIENT_SECRET=... PATREON_CAMPAIGN_ID=... \
#     bash deploy/patreon-setup.sh

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
ENV_FILE=".env.production"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok() { printf '  \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mWARN\033[0m %s\n' "$1"; }
die() {
    printf '\n\033[31mFAILED: %s\033[0m\n' "$1" >&2
    [ -n "${2:-}" ] && printf '  fix: %s\n' "$2" >&2
    exit 1
}

# Paste is the main input method here, and a trailing space or CR from a
# terminal copy is invisible but fatal.
trim() { printf '%s' "$1" | tr -d '\r\n' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//'; }

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2-)"
DOMAIN="$(trim "${DOMAIN:-archonarena.com}")"

# --- preflight ---------------------------------------------------------------

step "Checking prerequisites"

[ -f "$ENV_FILE" ] || die "No $ENV_FILE in $(pwd)" \
    "cp .env.production.example .env.production && edit it"
ok "$ENV_FILE found"

lobby_state="$($DC ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk '$1=="lobby"{print $2}')"
[ "$lobby_state" = "running" ] || die "the lobby container is '${lobby_state:-missing}'" \
    "$DC up -d lobby"
ok "lobby running"

command -v curl >/dev/null 2>&1 || die "curl is not installed" "apt install curl"

# --- collect ------------------------------------------------------------------

step "Patreon client credentials"
echo "  From https://www.patreon.com/portal/registration/register-clients"
echo "  (expand your client; the eye icon reveals each hidden value)"
echo

client_id="$(trim "${PATREON_CLIENT_ID:-}")"
if [ -z "$client_id" ]; then
    read -r -p "  Client ID: " client_id
    client_id="$(trim "$client_id")"
fi
[ -n "$client_id" ] || die "Client ID is required"

client_secret="$(trim "${PATREON_CLIENT_SECRET:-}")"
if [ -z "$client_secret" ]; then
    # Not echoed: this one is a credential, and terminals get screenshotted.
    read -rs -p "  Client Secret (hidden): " client_secret
    echo
    client_secret="$(trim "$client_secret")"
fi
[ -n "$client_secret" ] || die "Client Secret is required"

# --- campaign id ---------------------------------------------------------------

campaign_id="$(trim "${PATREON_CAMPAIGN_ID:-}")"

if [ -z "$campaign_id" ]; then
    step "Looking up your campaign id"
    echo "  This needs the Creator's Access Token from the same page. It is used"
    echo "  once, right here, and is NOT stored in $ENV_FILE."
    echo

    read -rs -p "  Creator's Access Token (hidden): " creator_token
    echo
    creator_token="$(trim "$creator_token")"
    [ -n "$creator_token" ] || die "Creator's Access Token is required to look up the campaign id" \
        "or re-run with PATREON_CAMPAIGN_ID=<id> if you already know it"

    campaigns_json="$(curl -sS --max-time 20 \
        -H "Authorization: Bearer $creator_token" \
        'https://www.patreon.com/api/oauth2/v2/campaigns' 2>&1)"

    # Parsed by the lobby's node rather than by grep: the host is only required
    # to have Docker, and a regex over JSON would happily pull an id out of an
    # error body.
    parsed="$($DC exec -T lobby node -e '
        let raw = "";
        process.stdin.on("data", (chunk) => (raw += chunk));
        process.stdin.on("end", () => {
            let body;
            try {
                body = JSON.parse(raw);
            } catch (err) {
                console.log("UNPARSEABLE");
                return;
            }
            if (body.errors && body.errors.length) {
                console.log("APIERROR " + (body.errors[0].detail || body.errors[0].title || ""));
                return;
            }
            const ids = (body.data || []).map((entry) => entry.id).filter(Boolean);
            console.log(ids.length ? "IDS " + ids.join(" ") : "EMPTY");
        });
    ' <<<"$campaigns_json" 2>/dev/null)"
    parsed="$(trim "$parsed")"

    case "$parsed" in
        APIERROR*)
            die "Patreon rejected the token: ${parsed#APIERROR }" \
                "check you copied the Creator's Access Token (not the refresh token)"
            ;;
        EMPTY)
            die "That token works, but the account has no campaign yet" \
                "create your campaign at https://www.patreon.com/create, then re-run"
            ;;
        IDS*)
            set -- ${parsed#IDS }
            campaign_id="$1"
            if [ "$#" -gt 1 ]; then
                warn "the account has $# campaigns; using the first ($campaign_id)"
                warn "re-run with PATREON_CAMPAIGN_ID=<id> to pick another: $*"
            fi
            ok "campaign id $campaign_id"
            ;;
        *)
            die "Could not read Patreon's response" \
                "re-run with PATREON_CAMPAIGN_ID=<id> to skip this lookup"
            ;;
    esac
    unset creator_token campaigns_json
else
    ok "campaign id $campaign_id (from the environment)"
fi

step "Public campaign page (optional)"
echo "  Linked from the profile so players who have not pledged can find it."
campaign_url="$(trim "${PATREON_CAMPAIGN_URL:-}")"
if [ -z "$campaign_url" ]; then
    read -r -p "  Campaign URL [blank to skip]: " campaign_url
    campaign_url="$(trim "$campaign_url")"
fi

# --- write --------------------------------------------------------------------

step "Writing $ENV_FILE"

backup="$ENV_FILE.bak.$(date +%Y%m%d%H%M%S)"
cp -p "$ENV_FILE" "$backup" || die "could not back up $ENV_FILE"
ok "backed up to $backup"

# Replaces the key wherever it is (set or commented out) instead of appending a
# second definition - a duplicate would silently win or lose depending on order.
set_env_var() {
    local key="$1" value="$2" mode
    mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo 600)"
    grep -vE "^[[:space:]]*#?[[:space:]]*${key}=" "$ENV_FILE" >"$ENV_FILE.tmp"
    printf '%s=%s\n' "$key" "$value" >>"$ENV_FILE.tmp"
    chmod "$mode" "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
}

set_env_var PATREON_CLIENT_ID "$client_id"
set_env_var PATREON_CLIENT_SECRET "$client_secret"
set_env_var PATREON_CAMPAIGN_ID "$campaign_id"
[ -n "$campaign_url" ] && set_env_var PATREON_CAMPAIGN_URL "$campaign_url"
ok "PATREON_CLIENT_ID, PATREON_CLIENT_SECRET, PATREON_CAMPAIGN_ID written"

# 600: the file now holds an OAuth client secret alongside the DB password.
chmod 600 "$ENV_FILE" 2>/dev/null

# --- apply --------------------------------------------------------------------

step "Restarting the lobby"
$DC up -d lobby || die "lobby failed to start" "$DC logs --tail 50 lobby"

printf '  waiting for the lobby to answer'
for _ in $(seq 1 30); do
    if $DC exec -T lobby node -e 'fetch("http://localhost:4000/api/account/patreon/status").then(()=>process.exit(0)).catch(()=>process.exit(1))' >/dev/null 2>&1; then
        break
    fi
    printf '.'
    sleep 2
done
echo

# --- verify -------------------------------------------------------------------

step "Verifying"

# Asked from inside the container so this reports on the app itself, not on
# whatever DNS, Caddy or a CDN happens to be serving.
status="$($DC exec -T lobby node -e '
    fetch("http://localhost:4000/api/account/patreon/status")
        .then((r) => r.json())
        .then((body) => console.log(JSON.stringify(body)))
        .catch((err) => console.log(JSON.stringify({ error: err.message })));
' 2>/dev/null)"
status="$(trim "$status")"

case "$status" in
    *'"enabled":true'*)
        ok "the app reports Patreon enabled"
        ;;
    *)
        die "the app still reports Patreon disabled: ${status:-no response}" \
            "check for a stray space in the secret, then: $DC logs --tail 50 lobby"
        ;;
esac

public="$(curl -sS --max-time 15 "https://$DOMAIN/api/account/patreon/status" 2>/dev/null)"
case "$public" in
    *'"enabled":true'*) ok "https://$DOMAIN reports it too" ;;
    *) warn "the public URL did not confirm it (site may still be warming up)" ;;
esac

# The redirect URI is the one value this script cannot check for you: Patreon
# only rejects a mismatch at the final step of a real handshake.
cat <<EOF

$(printf '\033[1mDone.\033[0m') Two things left, both on Patreon's side:

  1. Confirm the Redirect URI on your client is EXACTLY:

         https://$DOMAIN/patreon

     No trailing slash, no www. A mismatch is the one failure this script
     cannot detect - Patreon only rejects it at the last step of a real
     link, as a generic "error syncing your patreon account".

  2. Link your own account to prove the round trip:

         https://$DOMAIN/profile  ->  Integrations  ->  Link Account

     You should land back on /profile with the row reading
     "Supporter - <your tier>" if you pledge to yourself, or
     "Connected - no active pledge" if you do not.

Backup of the previous env file: $backup
EOF
