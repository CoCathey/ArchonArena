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

# Retry a URL for up to ~30s: the script is often run right after a
# restart, while the app inside an already-"running" container is still
# booting (settings snapshot, card cache) and Caddy answers 502.
probe() { # url -> echoes final http code
    local code attempt
    for attempt in 1 2 3 4 5 6; do
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || echo 000)"
        case "$code" in
            502 | 503 | 000) [ "$attempt" -lt 6 ] && sleep 5 ;;
            *) break ;;
        esac
    done
    echo "$code"
}

echo "== Site reachability =="
code="$(probe "https://$DOMAIN/")"
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
ws_code="$(probe "https://$DOMAIN/node-0/socket.io/?EIO=4&transport=polling")"
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

# Card ART is separate from card data: images are downloaded into the
# card_images volume and served from public/img/cards.
imgs="$($DC exec -T lobby sh -c 'ls /usr/src/app/public/img/cards 2>/dev/null | wc -l' 2>/dev/null | tr -d '[:space:]')"
if [ "${imgs:-0}" -gt 1000 ] 2>/dev/null; then
    ok "card art present ($imgs images)"
else
    bad "card art missing (${imgs:-0} images) - boards show blank cards" "$DC exec lobby npm run fetchdata   (downloads ~6k images; resumable, skips existing)"
fi

# Pending migrations mean the running code expects a schema the database does
# not have yet. The ledger makes that answerable instead of a guess.
ledger="$(psql_q $'SELECT COUNT(*) FROM information_schema.tables WHERE table_name=\'SchemaMigrations\'')"
if [ "${ledger:-0}" -eq 0 ] 2>/dev/null; then
    # NOT --baseline: on a database that is genuinely behind the code, that
    # marks every migration applied without running any and the missing tables
    # stay missing. --status first, then baseline only as far as it has got.
    bad "no migration ledger - schema state is untracked" "$DC exec lobby npm run migrate -- --status   (then --baseline-through <file>, see docs/DEPLOYMENT.md)"
else
    applied="$(psql_q 'SELECT COUNT(*) FROM "SchemaMigrations"')"
    onDisk="$(ls -1 server/db/schema/migrations/*.sql 2>/dev/null | wc -l | tr -d '[:space:]')"
    if [ "${applied:-0}" -ge "${onDisk:-0}" ] 2>/dev/null; then
        ok "migrations up to date (${applied}/${onDisk} applied)"
    else
        bad "${applied}/${onDisk} migrations applied - the database is behind the code" "$DC exec lobby npm run migrate"
    fi
fi

# Finished games that should have rated and did not. This is the check that was
# missing when a broken replay save silently stopped the ladder for a month:
# every other signal was green, because nothing else was wrong.
#
# Runs the backfill in its default dry-run mode rather than repeating its query
# here, so there is one definition of "should have rated" instead of two that
# can drift. Read-only.
unrated_out="$($DC exec -T lobby npm run backfill:ratings 2>/dev/null)"
if echo "$unrated_out" | grep -q 'No unrated finished games'; then
    ok "all finished games are rated"
elif echo "$unrated_out" | grep -qE '[0-9]+ finished game\(s\) have no rating rows'; then
    unrated_n="$(echo "$unrated_out" | grep -oE '^[0-9]+ finished game' | grep -oE '^[0-9]+')"
    bad "${unrated_n:-some} finished game(s) were never rated" "$DC exec lobby npm run backfill:ratings          # dry run, then add -- --commit"
else
    # Could not tell - do not claim either way.
    warn "could not check for unrated games" "run: $DC exec lobby npm run backfill:ratings"
fi

users="$(psql_q 'SELECT COUNT(*) FROM "Users"')"
ok "user accounts: ${users:-?}"

# The demo logins (admin/test0/test1, password 'password') must never exist on a
# production database. They used to be seeded by 'server/db/schema/99 - Data.sql',
# which this stack mounts into docker-entrypoint-initdb.d, so any database
# initialised before that fix has a full-permission account with a guessable
# password. Databases created since are clean - this check proves it.
demo="$(psql_q $'SELECT COUNT(*) FROM "Users" WHERE lower("Username") IN (\'admin\',\'test0\',\'test1\')')"
if [ "${demo:-0}" -eq 0 ] 2>/dev/null; then
    ok "no seeded demo accounts (admin/test0/test1)"
else
    bad "SECURITY: ${demo} seeded demo account(s) present - 'admin' has full permissions and the password 'password'" "rename or delete them now, then bootstrap a real admin: $DC exec lobby npm run grant-admin -- <username>"
fi

echo "== Environment (.env.production) =="
for var in SECRET HMAC_SECRET DB_USER DB_PASSWORD; do
    if grep -qE "^$var=.+" .env.production 2>/dev/null; then
        ok "$var is set"
    else
        bad "$var is empty or missing" "edit /opt/archonarena/.env.production, then: $DC up -d lobby node-0"
    fi
done
# Transactional email. How bad a gap here is depends on whether verification is
# required: with it on, registration DEPENDS on a send succeeding (a failure
# rolls the account back), so broken mail means the site accepts no new accounts
# at all - not merely that password reset is unavailable.
#
# REQUIRE_ACTIVATION unset or empty means the default, which is on.
if grep -qE "^REQUIRE_ACTIVATION=false" .env.production 2>/dev/null; then
    activation_on=0
else
    activation_on=1
fi

if [ "$activation_on" -eq 1 ]; then
    email_consequence="NO ACCOUNT CAN BE REGISTERED (verification is required) and no password reset can be sent"
    # Only worth offering when it would actually change anything.
    email_optout="   —   or set REQUIRE_ACTIVATION=false to keep sign-ups open without email"
else
    email_consequence="no password reset can be sent - a player who forgets their password is locked out permanently"
    email_optout=""
fi

if grep -qE "^EMAIL_FROM_ADDRESS=.+" .env.production 2>/dev/null; then
    ok "EMAIL_FROM_ADDRESS set"
    # NOT a warning: the SESv2 client has no default region and the send fails
    # outright with "Region is missing". This used to say the SDK falls back to
    # a default, which is simply untrue and would send you looking elsewhere.
    if grep -qE "^AWS_SES_REGION=.+" .env.production 2>/dev/null; then
        ok "AWS_SES_REGION set"
        # Configured is not the same as working. Only an actual send proves that,
        # and a health check must not send mail on every run.
        ok "email configured - prove it sends with: $DC exec lobby npm run check:email -- you@example.com"
    else
        bad "AWS_SES_REGION empty - SES cannot send without a region, so $email_consequence" "set AWS_SES_REGION (the region your SES identity is verified in) in /opt/archonarena/.env.production, then: $DC up -d lobby"
    fi
else
    # config/production.json5 hardcodes a sender, so the app's own startup guard
    # sees one and stays silent. This file is the only place the gap shows.
    bad "EMAIL_FROM_ADDRESS empty or missing - $email_consequence" "set EMAIL_FROM_ADDRESS (a verified SES identity) in /opt/archonarena/.env.production, then: $DC up -d lobby${email_optout}"
fi

if grep -qE "^DOK_API_KEY=.+" .env.production 2>/dev/null; then
    ok "DOK_API_KEY set (SAS + bulk deck import enabled)"
    # Probe DoK from inside the lobby container: proves outbound network
    # AND whether DoK accepts the key. 200/404 = reachable + key accepted;
    # 401/403 = key rejected; 429 = rate limited; ERR = cannot reach.
    dok_probe="$($DC exec -T lobby node -e "
        fetch('https://decksofkeyforge.com/public-api/v3/decks/00000000-0000-0000-0000-000000000000', {
            headers: { 'Api-Key': process.env.DOK_API_KEY || '' },
            signal: AbortSignal.timeout(10000)
        }).then((r) => console.log(r.status)).catch((e) => console.log('ERR:' + e.message));
    " 2>/dev/null | tail -1)"
    # SAS enrichment (the only thing that uses the DoK API - bulk import is
    # now CSV/paste based and needs no DoK API at all).
    case "$dok_probe" in
        200 | 404) ok "Decks of KeyForge (SAS endpoint) reachable, API key accepted (probe: $dok_probe)" ;;
        401 | 403) bad "DoK rejected the API key (HTTP $dok_probe)" "regenerate the key on your DoK profile and update DOK_API_KEY in .env.production, then: $DC up -d lobby" ;;
        429) warn "DoK rate limit hit during probe (HTTP 429)" "harmless if enrichment just ran; re-check in a minute" ;;
        *) warn "cannot reach decksofkeyforge.com from the lobby ($dok_probe)" "only affects SAS scores; check VPS outbound: $DC exec lobby ping -c1 decksofkeyforge.com" ;;
    esac
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
