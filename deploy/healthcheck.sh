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
check_table "DeckCatalog" "51 - DeckCatalog.sql"
check_table "DeckCatalogState" "51 - DeckCatalog.sql"
check_table "DeckImportJobs" "53 - DeckImportJobs.sql"

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
# The app is asked rather than the env file re-parsed here: EmailService knows
# which transport is in use (SMTP or SES) and what each one needs, and one
# authority cannot drift into disagreeing with itself.
email_state="$($DC exec -T lobby node -e "
const ConfigService = require('./server/services/ConfigService');
const EmailService = require('./server/services/EmailService');
const c = new EmailService(new ConfigService()).describeConfiguration();
const where = c.transport === 'smtp' ? (c.smtpHost || 'no host') : (c.sesRegion || 'no region');
console.log([c.ready ? 'READY' : 'NOTREADY', c.transport, where, c.problems.join(' ')].join('|'));
" 2>/dev/null | tail -1)"

if grep -qE "^REQUIRE_ACTIVATION=false" .env.production 2>/dev/null; then
    email_consequence="no password reset can be sent - a player who forgets their password is locked out permanently"
    email_optout=""
else
    email_consequence="NO ACCOUNT CAN BE REGISTERED (verification is required) and no password reset can be sent"
    email_optout="   —   or set REQUIRE_ACTIVATION=false to keep sign-ups open without email"
fi

case "$email_state" in
    READY*)
        email_transport="$(echo "$email_state" | cut -d'|' -f2)"
        email_where="$(echo "$email_state" | cut -d'|' -f3)"
        ok "email configured (${email_transport} via ${email_where})"
        # Configured is not working. Only a send proves that, and a health check
        # must not send mail on every run.
        ok "prove it actually sends: $DC exec lobby npm run check:email -- you@example.com"
        ;;
    NOTREADY*)
        email_problems="$(echo "$email_state" | cut -d'|' -f4)"
        bad "email is not configured - $email_consequence" "$email_problems  See docs/DEPLOYMENT.md section 3${email_optout}"
        ;;
    *)
        warn "could not determine the email configuration" "lobby may be mid-restart; re-run, or: $DC exec lobby npm run check:email -- you@example.com"
        ;;
esac

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
        401 | 403) bad "DoK rejected the API key (HTTP $dok_probe)" "likely cause: DoK issues one key per account and generating a new one voids the old instantly, so generating a key anywhere else (e.g. for a collection sync) revokes this one. There is no way to read an existing key back, so recovery is a rotation: generate one key at https://decksofkeyforge.com/about/sellers-and-devs, copy it immediately, set DOK_API_KEY in .env.production to it, use that SAME string for any other DoK use, then: $DC up -d lobby. Note 403 is also what Cloudflare returns when it blocks this host - check which you have with: $DC exec -T lobby node -e \"fetch('https://decksofkeyforge.com/public-api/v3/decks/00000000-0000-0000-0000-000000000000',{headers:{'Api-Key':process.env.DOK_API_KEY||''}}).then(async r=>console.log(r.status,(await r.text()).slice(0,300)))\"" ;;
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
# ARCHON (N12): Patreon. Optional, so unset is a WARN - but half-set is a FAIL.
# Credentials with no campaign id is the dangerous middle state: the app works,
# and quietly hands the supporter role to anyone who backs any creator on
# Patreon, because /identity returns memberships across every campaign.
if grep -qE "^PATREON_CLIENT_ID=.+" .env.production 2>/dev/null; then
    if grep -qE "^PATREON_CLIENT_SECRET=.+" .env.production 2>/dev/null; then
        # Asked of the app rather than re-read from the file, so this reflects
        # what the container actually loaded (the env vars have to be forwarded
        # in docker-compose.prod.yml to get there at all).
        patreon_state="$($DC exec -T lobby node -e "
            const ConfigService = require('./server/services/ConfigService');
            const PatreonService = require('./server/services/PatreonService');
            const s = new PatreonService(new ConfigService(), {});
            const c = s.getConfig();
            console.log([s.isEnabled() ? 'ON' : 'OFF', c.campaignId || '', c.callbackUrl || ''].join('|'));
        " 2>/dev/null | tail -1)"
        patreon_on="$(echo "$patreon_state" | cut -d'|' -f1)"
        patreon_campaign="$(echo "$patreon_state" | cut -d'|' -f2)"
        patreon_callback="$(echo "$patreon_state" | cut -d'|' -f3)"

        if [ "$patreon_on" = "ON" ]; then
            ok "Patreon linking enabled (callback $patreon_callback)"
            if [ -n "$patreon_campaign" ]; then
                ok "Patreon scoped to campaign $patreon_campaign"
            else
                bad "Patreon has no campaign id - a pledge to ANY creator grants supporter here" \
                    "bash deploy/patreon-setup.sh  (or set PATREON_CAMPAIGN_ID in .env.production)"
            fi
            ok "the redirect URI on the Patreon client must equal $patreon_callback exactly"
        elif [ "$patreon_on" = "OFF" ]; then
            bad "PATREON_* is set in .env.production but the app reports Patreon off" \
                "usually PATREON_ENABLED=false, or a stray space in a value: $DC up -d lobby"
        else
            warn "could not determine the Patreon configuration" "lobby may be mid-restart; re-run"
        fi
    else
        bad "PATREON_CLIENT_ID is set but PATREON_CLIENT_SECRET is empty" \
            "bash deploy/patreon-setup.sh"
    fi
else
    warn "Patreon linking not configured" "optional - no Patreon UI is shown and no supporter roles change (docs/design/patreon.md)"
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
