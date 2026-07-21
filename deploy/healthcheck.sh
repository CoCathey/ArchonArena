#!/usr/bin/env bash
# Archon Arena production health check.
#
# Verifies everything the site needs on the VPS: containers, TLS, the
# game-node wiring, database migrations, card data, env vars, and disk.
# Read-only - safe to run any time:
#
#   cd /opt/archonarena && bash deploy/healthcheck.sh
#
# Every FAIL line comes with the command that fixes it.

set -u
cd "$(dirname "$0")/.." || exit 1

DC="docker compose -f docker-compose.prod.yml --env-file .env.production"
DOMAIN="$(grep -E '^DOMAIN=' .env.production 2>/dev/null | cut -d= -f2)"
DOMAIN="${DOMAIN:-archonarena.com}"

PASS=0
FAIL=0
WARN=0

ok() { PASS=$((PASS + 1)); printf '  \033[32mOK\033[0m   %s\n' "$1"; }
bad() {
    FAIL=$((FAIL + 1))
    printf '  \033[31mFAIL\033[0m %s\n' "$1"
    [ -n "${2:-}" ] && printf '        fix: %s\n' "$2"
}
warn() {
    WARN=$((WARN + 1))
    printf '  \033[33mWARN\033[0m %s\n' "$1"
    [ -n "${2:-}" ] && printf '        note: %s\n' "$2"
}

psql_q() { $DC exec -T postgres psql -U "${DB_USER:-archonarena}" -d "${DB_NAME:-archonarena}" -tAc "$1" 2>/dev/null | tr -d '[:space:]'; }

# Pull DB creds from the env file so psql checks work.
DB_USER="$(grep -E '^DB_USER=' .env.production 2>/dev/null | cut -d= -f2)"
DB_NAME="$(grep -E '^DB_NAME=' .env.production 2>/dev/null | cut -d= -f2)"
DB_NAME="${DB_NAME:-archonarena}"

echo "== Containers =="
for svc in caddy lobby node-0 postgres redis; do
    state="$($DC ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$svc" '$1==s{print $2}')"
    if [ "$state" = "running" ]; then
        ok "$svc running"
    else
        bad "$svc is '${state:-missing}'" "$DC up -d $svc && $DC logs --tail 50 $svc"
    fi
done

echo "== Site reachability =="
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/" || echo 000)"
if [ "$code" = "200" ]; then
    ok "https://$DOMAIN returns 200"
else
    bad "https://$DOMAIN returned $code" "$DC logs --tail 50 caddy lobby"
fi

exp="$(echo | openssl s_client -servername "$DOMAIN" -connect "$DOMAIN:443" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
if [ -n "$exp" ]; then
    exp_s="$(date -d "$exp" +%s 2>/dev/null || echo 0)"
    days=$(((exp_s - $(date +%s)) / 86400))
    if [ "$days" -gt 14 ]; then
        ok "TLS certificate valid ($days days left; Caddy auto-renews)"
    else
        warn "TLS certificate expires in $days days" "Caddy should renew automatically; check: $DC logs caddy | grep -i acme"
    fi
else
    bad "could not read TLS certificate" "$DC logs --tail 50 caddy"
fi

# The game-board websocket path must reach the game node through Caddy.
# socket.io answers HTTP 200/400 to a bare polling probe; Caddy errors
# (404 = matcher wrong, 502 = node down/unreachable) mean broken games.
ws_code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "https://$DOMAIN/node-0/socket.io/?EIO=4&transport=polling" || echo 000)"
case "$ws_code" in
    200 | 400) ok "game-node socket path (/node-0/socket.io) reachable through Caddy" ;;
    *) bad "game-node socket path returned $ws_code - players cannot start games" "$DC restart node-0 caddy && $DC logs --tail 50 node-0" ;;
esac

echo "== Game node wiring =="
host_val="$($DC exec -T node-0 node -e "process.env.NODE_CONFIG_ENV='production'; console.log(JSON.stringify(require('config').get('gameNode.host')))" 2>/dev/null | tail -1)"
if [ "$host_val" = '""' ]; then
    ok "game node advertises no address (browsers connect same-origin)"
elif [ -z "$host_val" ]; then
    warn "could not read game node config" "container may be mid-restart; re-run in a minute"
else
    bad "game node advertises host $host_val - Start will strand players" "image is stale: bash /root/deploy-archonarena.sh (rebuilds with the fixed production config)"
fi

if $DC logs --tail 200 lobby 2>/dev/null | grep -qiE "node.*(hello|registered|connected)|HELLO"; then
    ok "lobby has seen the game node register"
else
    warn "no recent game-node registration in lobby logs (may have scrolled)" "verify by starting a test game; or: $DC restart node-0 && $DC logs -f lobby"
fi

echo "== Database & migrations =="
if [ "$(psql_q 'SELECT 1')" = "1" ]; then
    ok "postgres reachable ($DB_NAME as ${DB_USER:-archonarena})"
else
    bad "cannot query postgres" "$DC logs --tail 50 postgres; check DB_USER/DB_PASSWORD in .env.production"
fi

check_table() { # table, migration file
    if [ "$(psql_q "SELECT COUNT(*) FROM information_schema.tables WHERE table_name='$1'")" = "1" ]; then
        ok "table \"$1\" exists"
    else
        bad "table \"$1\" missing" "$DC exec -T postgres psql -U ${DB_USER:-archonarena} -d $DB_NAME < \"server/db/schema/migrations/$2\""
    fi
}
check_column() { # table, column, migration file
    if [ "$(psql_q "SELECT COUNT(*) FROM information_schema.columns WHERE table_name='$1' AND column_name='$2'")" = "1" ]; then
        ok "column \"$1\".\"$2\" exists"
    else
        bad "column \"$1\".\"$2\" missing" "$DC exec -T postgres psql -U ${DB_USER:-archonarena} -d $DB_NAME < \"server/db/schema/migrations/$3\""
    fi
}

check_table "DeckSas" "22 - DeckSas.sql"
check_table "UserOidcIdentities" "23 - UserOidcIdentities.sql"
check_table "Ratings" "24 - Ratings.sql"
check_table "RatingHistory" "24 - Ratings.sql"
check_column "Users" "Country" "25 - UserLocation.sql"
check_table "SiteSettings" "26 - SiteSettings.sql"
check_table "Tournaments" "27 - Tournaments.sql"
check_table "Friendships" "28 - Community.sql"
check_table "Clubs" "28 - Community.sql"
check_column "Users" "OnboardedAt" "29 - Onboarding.sql"
check_column "Clubs" "JoinCode" "29 - Onboarding.sql"
check_column "Users" "DokUsername" "30 - DokUsername.sql"
check_table "Stores" "31 - Stores.sql"

cards="$(psql_q 'SELECT COUNT(*) FROM "Cards"')"
if [ "${cards:-0}" -gt 1000 ] 2>/dev/null; then
    ok "card data loaded ($cards cards)"
else
    bad "card data missing (${cards:-0} cards) - decks cannot be imported or played" "$DC exec lobby npm run fetchdata"
fi

sdecks="$(psql_q 'SELECT COUNT(*) FROM "StandaloneDecks"')"
if [ "${sdecks:-0}" -gt 0 ] 2>/dev/null; then
    ok "standalone decks loaded ($sdecks)"
else
    bad "standalone decks missing" "$DC exec lobby node server/scripts/importstandalonedecks.js"
fi

users="$(psql_q 'SELECT COUNT(*) FROM "Users"')"
ok "user accounts: ${users:-?}"

echo "== Environment (.env.production) =="
for var in SECRET HMAC_SECRET DB_USER DB_PASSWORD; do
    if grep -qE "^$var=.+" .env.production 2>/dev/null; then
        ok "$var is set"
    else
        bad "$var is empty or missing" "edit /opt/archonarena/.env.production, then: $DC up -d lobby node-0"
    fi
done
if grep -qE "^DOK_API_KEY=.+" .env.production 2>/dev/null; then
    ok "DOK_API_KEY set (SAS + bulk deck import enabled)"
else
    warn "DOK_API_KEY not set" "SAS scores and Decks of KeyForge bulk import stay disabled until set (get a key from your DoK profile)"
fi
if grep -qE "^OIDC_ENABLED=true" .env.production 2>/dev/null; then
    ok "Keybringer SSO enabled"
else
    warn "Keybringer SSO not enabled" "optional - needs the Keycloak client registered first (docs/design/keybringer-sso.md)"
fi

echo "== Resources =="
disk_pct="$(df --output=pcent / 2>/dev/null | tail -1 | tr -dc '0-9')"
if [ "${disk_pct:-100}" -lt 85 ]; then
    ok "disk usage ${disk_pct}%"
else
    bad "disk usage ${disk_pct}%" "docker system prune -f  (removes old images/build cache)"
fi
mem_avail_mb="$(awk '/MemAvailable/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"
if [ "${mem_avail_mb:-0}" -gt 500 ]; then
    ok "memory available ${mem_avail_mb}MB"
else
    warn "only ${mem_avail_mb}MB memory available" "check: docker stats --no-stream"
fi
if swapon --show 2>/dev/null | grep -q .; then
    ok "swap is enabled"
else
    warn "no swap configured" "recommended on a small VPS as an OOM safety net"
fi

echo
echo "================================================"
printf 'Result: \033[32m%d OK\033[0m, \033[33m%d WARN\033[0m, \033[31m%d FAIL\033[0m\n' "$PASS" "$WARN" "$FAIL"
if [ "$FAIL" -eq 0 ]; then
    echo "Everything the site needs is running."
else
    echo "Run the 'fix:' commands above, then re-run this script."
fi
exit "$FAIL"
