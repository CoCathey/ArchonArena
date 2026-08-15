#!/usr/bin/env bash
# Archon Arena rolling deploy - replace the running stack without ending games.
#
#   cd /opt/archonarena && bash deploy/rolling-deploy.sh
#
# Why this exists, rather than `docker compose up -d`:
#
# A game lives entirely in one game node process's memory and cannot be moved to
# another node. So "no downtime" cannot mean "games survive a restart" - it means
# never restarting a node that still has games on it. And the lobby and the game
# nodes share one image (archonarena), so a plain `up -d` after a build replaces
# every one of them at once and takes every game in progress down with it.
#
# The sequence here instead:
#
#   1. build the new image once
#   2. replace the lobby (a few seconds; Caddy holds requests, socket.io
#      reconnects, games in progress are untouched because players are connected
#      straight to the nodes)
#   3. for each node in turn: stand it down, let its games finish, replace it,
#      wait for it to come back - while its siblings carry the new games
#
# Step 3 is why more than one node is needed: with a single node, standing it
# down means nobody can start a game until it has been replaced.
#
# Nothing here is destructive to game state. The slow part is honest waiting -
# a node with a long game on it holds up its own replacement, by design.

set -euo pipefail

cd "$(dirname "$0")/.." || exit 1

COMPOSE_FILE="docker-compose.prod.yml"
ENV_FILE=".env.production"
DC="docker compose -f $COMPOSE_FILE --env-file $ENV_FILE"

DRAIN_TIMEOUT=5400 # 90 minutes, matching the node's own drain cap
POLL_INTERVAL=10
SKIP_BUILD=0
FORCE_AFTER_TIMEOUT=0
ASSUME_YES=0
DO_LOBBY=1
DO_NODES=1
ONLY_NODES=""

usage() {
    cat <<'USAGE'
Usage: bash deploy/rolling-deploy.sh [options]

  --skip-build            Deploy the image already built (no docker build)
  --lobby-only            Replace only the lobby
  --nodes-only            Replace only the game nodes
  --node <name>           Only this node (repeatable, e.g. --node node-1)
  --drain-timeout <secs>  How long to wait for a node's games (default 5400)
  --force-after-timeout   Replace a node whose games did not finish in time.
                          ENDS THOSE GAMES. Off by default.
  -y, --yes               Do not prompt
  -h, --help              This message
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --skip-build) SKIP_BUILD=1 ;;
        --lobby-only) DO_NODES=0 ;;
        --nodes-only) DO_LOBBY=0 ;;
        --node)
            shift
            ONLY_NODES="$ONLY_NODES $1"
            ;;
        --drain-timeout)
            shift
            DRAIN_TIMEOUT="$1"
            ;;
        --force-after-timeout) FORCE_AFTER_TIMEOUT=1 ;;
        -y | --yes) ASSUME_YES=1 ;;
        -h | --help)
            usage
            exit 0
            ;;
        *)
            printf 'Unknown option: %s\n\n' "$1" >&2
            usage
            exit 2
            ;;
    esac
    shift
done

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
info() { printf '    %s\n' "$1"; }
ok() { printf '    \033[32mOK\033[0m   %s\n' "$1"; }
warn() { printf '    \033[33mWARN\033[0m %s\n' "$1"; }
die() {
    printf '    \033[31mFAIL\033[0m %s\n' "$1" >&2
    exit 1
}

confirm() { # prompt
    [ "$ASSUME_YES" = "1" ] && return 0

    printf '    %s [y/N] ' "$1"
    read -r reply </dev/tty || reply=""

    case "$reply" in
        y | Y | yes | YES) return 0 ;;
        *) return 1 ;;
    esac
}

[ -f "$COMPOSE_FILE" ] || die "$COMPOSE_FILE not found - run this from the repo root"
[ -f "$ENV_FILE" ] || die "$ENV_FILE not found - see docs/DEPLOYMENT.md"

# Talk to a node's control port from inside its own container. Node is
# guaranteed to be present (it is what the container runs); curl is not.
NODE_REQ_JS='
const http = require("http");
const req = http.request(
    {
        host: "127.0.0.1",
        port: Number(process.env.HEALTH_PORT) || 9000,
        method: process.env.HC_METHOD,
        path: process.env.HC_PATH,
        timeout: 5000
    },
    (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
            process.stdout.write(body);
            process.exit(res.statusCode < 400 ? 0 : 1);
        });
    }
);
req.on("error", (err) => {
    process.stderr.write(String(err.message));
    process.exit(1);
});
req.on("timeout", () => {
    req.destroy();
    process.exit(1);
});
req.end();
'

node_req() { # service method path
    $DC exec -T -e HC_METHOD="$2" -e HC_PATH="$3" "$1" node -e "$NODE_REQ_JS" 2>/dev/null
}

node_games() { # service -> number of games, or empty if unreachable
    node_req "$1" GET /health/games | tr -d '[:space:]'
}

service_running() { # service
    [ "$($DC ps --format '{{.Service}} {{.State}}' 2>/dev/null | awk -v s="$1" '$1==s{print $2}')" = "running" ]
}

discover_nodes() {
    $DC config --services 2>/dev/null | grep -E '^node-' | sort
}

DOMAIN="$(grep -E '^DOMAIN=' "$ENV_FILE" 2>/dev/null | cut -d= -f2)"
DOMAIN="${DOMAIN:-archonarena.com}"

probe() { # url -> http code
    curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" || echo 000
}

wait_for_site() { # seconds
    local deadline=$(($(date +%s) + $1)) code

    while [ "$(date +%s)" -lt "$deadline" ]; do
        code="$(probe "https://$DOMAIN/")"
        [ "$code" = "200" ] && return 0
        sleep 2
    done

    return 1
}

wait_for_node_ready() { # service seconds
    local deadline=$(($(date +%s) + $2))

    while [ "$(date +%s)" -lt "$deadline" ]; do
        if node_req "$1" GET /health/ready >/dev/null 2>&1; then
            return 0
        fi
        sleep 2
    done

    return 1
}

# ---------------------------------------------------------------------------

if [ -n "$ONLY_NODES" ]; then
    # shellcheck disable=SC2086
    NODES="$(printf '%s\n' $ONLY_NODES)"
else
    NODES="$(discover_nodes)"
fi

NODE_COUNT="$(printf '%s\n' "$NODES" | grep -c . || true)"

step "Plan"
info "compose:  $COMPOSE_FILE"
info "domain:   $DOMAIN"
[ "$DO_LOBBY" = "1" ] && info "lobby:    replace"
[ "$DO_NODES" = "1" ] && info "nodes:    $(printf '%s' "$NODES" | tr '\n' ' ')"
info "build:    $([ "$SKIP_BUILD" = "1" ] && echo 'skipped (using current image)' || echo 'yes')"

if [ "$DO_NODES" = "1" ] && [ "${NODE_COUNT:-0}" -lt 2 ]; then
    warn "only $NODE_COUNT game node configured."
    warn "While it drains, nobody can start a game - the site stays up but Start"
    warn "reports 'No game nodes available' until the replacement is running."
    warn "Add node-1 in $COMPOSE_FILE and deploy/Caddyfile for a gap-free deploy."
    confirm "Continue anyway?" || die "aborted"
fi

# A version string per rollout makes the admin panel's Version column answer
# "which nodes have I actually replaced?" - without it every node reports the
# same thing and a half-finished deploy is invisible. Only defaulted when the
# operator has not set one, in the shell or in the env file.
if [ -z "${VERSION:-}" ] && ! grep -qE '^VERSION=.+' "$ENV_FILE" 2>/dev/null; then
    if VERSION="$(git rev-parse --short HEAD 2>/dev/null)"; then
        export VERSION
        info "version:  $VERSION (from git)"
    fi
fi

if [ "$SKIP_BUILD" != "1" ]; then
    step "Building image"
    $DC build || die "build failed - nothing has been replaced"
    ok "image built"
fi

if [ "$DO_LOBBY" = "1" ]; then
    step "Replacing the lobby"
    info "Games in progress are unaffected: players are connected to the game"
    info "nodes directly, and the lobby re-syncs with them when it comes back."

    $DC up -d --no-deps lobby || die "lobby failed to start"

    if wait_for_site 120; then
        ok "site answering 200"
    else
        die "site did not come back within 120s - check: $DC logs --tail 100 lobby"
    fi
fi

if [ "$DO_NODES" = "1" ]; then
    for node in $NODES; do
        step "Replacing $node"

        if ! service_running "$node"; then
            info "not running - starting it"
            $DC up -d --no-deps "$node" || die "$node failed to start"
            ok "$node started"
            continue
        fi

        # Stand the node down first. This only stops NEW games being placed here;
        # the games it already holds keep playing. The flag lives on the node, so
        # it survives the lobby restart above and any lobby restart during the
        # wait below.
        if node_req "$node" POST /health/drain >/dev/null; then
            ok "$node standing down (no new games placed here)"
        else
            warn "could not reach $node's control port - it may predate this deploy."
            warn "Replacing it now would end its games."
            confirm "Replace $node anyway?" || die "aborted before touching $node"
        fi

        games="$(node_games "$node")"
        info "games in progress: ${games:-unknown}"

        deadline=$(($(date +%s) + DRAIN_TIMEOUT))
        drained=0

        while [ "$(date +%s)" -lt "$deadline" ]; do
            games="$(node_games "$node")"

            if [ "${games:-}" = "0" ]; then
                drained=1
                break
            fi

            # A node that stopped answering has already gone; nothing to wait for.
            if ! service_running "$node"; then
                drained=1
                break
            fi

            printf '\r    waiting: %s games still playing on %s   ' "${games:-?}" "$node"
            sleep "$POLL_INTERVAL"
        done

        printf '\r%*s\r' 60 ''

        if [ "$drained" != "1" ]; then
            warn "$node still has ${games:-?} games after ${DRAIN_TIMEOUT}s"

            if [ "$FORCE_AFTER_TIMEOUT" != "1" ]; then
                info "$node is left standing down - it takes no new games, and its"
                info "current games are still playing. Re-run this script to pick up"
                info "where it left off, or pass --force-after-timeout to end them."
                die "did not replace $node (its games are still running)"
            fi

            warn "--force-after-timeout: replacing $node and ending its games"
        else
            ok "$node has no games left"
        fi

        $DC up -d --no-deps --force-recreate "$node" || die "$node failed to come back"

        if wait_for_node_ready "$node" 120; then
            ok "$node ready"
        else
            die "$node did not become ready - check: $DC logs --tail 100 $node"
        fi

        ws_code="$(probe "https://$DOMAIN/$node/socket.io/?EIO=4&transport=polling")"
        case "$ws_code" in
            200 | 400) ok "$node reachable through Caddy" ;;
            *)
                warn "$node's socket path returned $ws_code through Caddy."
                warn "Players cannot be handed off to it. Is there a matching"
                warn "@$node route in deploy/Caddyfile?"
                ;;
        esac
    done
fi

step "Done"
info "Run the full check with: bash deploy/healthcheck.sh"
