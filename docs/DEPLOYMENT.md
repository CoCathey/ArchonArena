# Deploying Archon Arena to archonarena.com

This is the production runbook for the Docker Compose stack in
`docker-compose.prod.yml`. It assumes a single Linux host (VPS) with Docker installed —
the right starting point; the Helm charts under `infrastructure/` are inherited from
upstream for a later Kubernetes migration if scale demands it.

## Architecture

```
Internet ──▶ Caddy (:80/:443, auto-TLS)
              ├── /node-0/socket.io ─▶ game node container (socket.io, :9500)
              └── everything else   ─▶ lobby container (Express + socket.io, :4000)
                                        ├── PostgreSQL (users, decks, games)
                                        └── Redis (lobby↔node messaging, cache)
```

-   The lobby serves the built React client, the REST API, and the lobby websocket.
-   Game nodes run actual games. They register with the lobby over Redis and are reached
    by browsers **through the site origin** at `/node-N/socket.io` — no per-node DNS or
    open ports.
-   Caddy obtains and renews Let's Encrypt certificates automatically.

## 1. Server prerequisites

-   Any Linux VPS (2 vCPU / 4 GB RAM is fine to start; the lobby is the memory hog).
-   Docker Engine + the compose plugin installed.
-   Ports 80 and 443 open in the provider's firewall.

## 2. DNS at Porkbun

In the Porkbun dashboard for `archonarena.com`, create:

| Type | Host                   | Answer                                | TTL |
| ---- | ---------------------- | ------------------------------------- | --- |
| A    | _(leave blank — apex)_ | `<server IPv4>`                       | 600 |
| A    | `www`                  | `<server IPv4>`                       | 600 |
| AAAA | _(apex)_               | `<server IPv6>` (if the host has one) | 600 |
| AAAA | `www`                  | `<server IPv6>` (if the host has one) | 600 |

Delete any Porkbun "parked domain" ALIAS/CNAME records on the apex first — they conflict.
Wait for `dig +short archonarena.com` to return the server IP before first boot, because
Let's Encrypt validates over the domain.

## 3. First boot

```bash
git clone https://github.com/CoCathey/ArchonArena.git /opt/archonarena
cd /opt/archonarena
cp .env.production.example .env.production
$EDITOR .env.production           # fill in generated secrets (openssl rand -hex 32)
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

PostgreSQL initializes itself from `server/db/schema/*.sql` on the first start (empty
data volume only). Then load card data **and card art** (one command does both — art
downloads take a while, are resumable, and skip existing files):

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec lobby npm run fetchdata
```

Card art, user avatars, and custom backgrounds live in named volumes
(`card_images`, `user_avatars`, `user_backgrounds`) mounted into the lobby, so they
survive redeploys. Without those mounts they are written to the container layer and
silently wiped by every `up -d`.

Visit `https://archonarena.com` — you should see the Archon Arena lobby.

### Bootstrapping the first admin

A production database is seeded with **no accounts at all**. The demo logins
(`admin` / `test0` / `test1`, password `password`) live in `server/db/dev-seed/`, which only
the local `docker-compose.yml` mounts — production must never create them, since `admin`
carries every management permission.

Register your account through the site as a normal player, then promote it:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec lobby npm run grant-admin -- <your-username>
```

Sign out and back in for the permissions to take effect. The command is idempotent.

> If you deployed before this change, your database already contains those accounts.
> `deploy/healthcheck.sh` now FAILs while they exist — delete or rename them, and treat the
> site as compromised if it was publicly reachable with `admin` intact.

## 4. Deploying updates

```bash
cd /opt/archonarena
git pull
docker compose -f docker-compose.prod.yml --env-file .env.production build
docker compose -f docker-compose.prod.yml --env-file .env.production up -d
```

Compose replaces containers with the new image; Caddy keeps serving during the swap.
For zero-disruption game-node updates, drain first (roadmap: deploy script) — restarting
`node-0` ends in-progress games on it.

Database schema changes are applied by the migration runner, which tracks what has run in
a `SchemaMigrations` ledger:

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec lobby npm run migrate
```

**Once per database**, seed the ledger before the first tracked deploy — a database built
from `server/db/schema` already contains every migration's effect, so replaying them would
error:

```bash
docker compose ... exec lobby npm run migrate -- --baseline
```

Inspect without changing anything with `npm run migrate -- --status`. The runner applies
each file in its own transaction (so a failure leaves nothing half-applied), and refuses to
run at all if a migration that was already applied has since been edited.
`deploy/healthcheck.sh` FAILs when migrations are pending.

## 5. Backups

Nightly dump (add to root's crontab on the host):

```cron
0 5 * * * cd /opt/archonarena && docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -U archonarena archonarena | gzip > /var/backups/archonarena-$(date +\%F).sql.gz
```

Restore: `gunzip -c <file> | docker compose ... exec -T postgres psql -U archonarena archonarena`.
Keep at least 14 days; copy off-host (object storage) — a backup on the same disk is not
a backup.

## 6. Scaling game nodes

Each node is one container with a unique identity:

1. In `docker-compose.prod.yml`, duplicate the `node-0` service as `node-1` with
   `SERVER=node-1`.
2. In `deploy/Caddyfile`, duplicate the `@node0` matcher/handle pair for `/node-1/...`
   pointing at `node-1:9500`.
3. `docker compose ... up -d`.

The lobby discovers nodes dynamically through Redis; no lobby config changes needed.
When one host is no longer enough, nodes can move to separate machines by giving them a
public address (set `HOST`) or by fronting them with the same Caddy over a private
network — decision deferred until load requires it.

## 7. Monitoring (minimum viable)

-   Set `SENTRY_DSN` in `.env.production` for error tracking (client + server support is
    already wired upstream).
-   Point an external uptime monitor (e.g. UptimeRobot) at `https://archonarena.com/`.
-   `docker compose ... logs -f lobby node-0` for live logs; Winston writes structured
    logs to stdout.

## 8. Health check

`deploy/healthcheck.sh` verifies everything the site needs in one pass — containers,
HTTPS + certificate, the game-node socket path through Caddy, the game node's advertised
address (must be empty or game starts strand players), every schema migration, card and
standalone-deck data, required env vars, and disk/memory. It is read-only and each FAIL
prints the exact command that fixes it.

```bash
cd /opt/archonarena && bash deploy/healthcheck.sh
```

Run it after every deploy, and any time something feels off. Exit code is the number of
failures, so it can be dropped into cron/uptime tooling as-is.
