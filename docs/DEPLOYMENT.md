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

## 3. Transactional email

**Do this before opening sign-ups.** Email verification is on by default
(`lobby.requireActivation`), so registration depends on outbound mail: if a send fails the
account is rolled back, which means a site with broken email takes **no new accounts at all**.
Password reset depends on it either way — without it, a player who forgets their password has
no route back into their account.

If you are not ready, that is fine, but make it a decision: set `REQUIRE_ACTIVATION=false`
in `.env.production`, accepting that people can play under addresses they do not own until
you turn it back on.

There are two transports. `lobby.emailTransport` defaults to `auto`, which picks **SMTP** when
`SMTP_HOST` is set and **SES** otherwise — so you configure one of the two and nothing else.

|                    | **SMTP** (§3a)                        | **AWS SES** (§3b)                      |
| ------------------ | ------------------------------------- | -------------------------------------- |
| Account            | Sign up with an email address         | Needs an AWS account (card required)   |
| Setup              | DNS records, then paste an API key    | DNS records, IAM user, sandbox request |
| Time to first send | Under an hour                         | About a day (sandbox approval)         |
| Cost               | Free tiers usually cover a small site | Cheapest at volume (~$0.10 per 1,000)  |

**Take SMTP unless you already use AWS.** SES is meaningfully cheaper only at volumes this
site is nowhere near.

### 3a. SMTP (recommended)

Works with any provider that speaks SMTP — Resend, Brevo, Postmark, Mailgun, Mailjet, a
company relay. The steps are the same for all of them:

1. **Sign up** and add `archonarena.com` as a sending domain.
2. **Verify the domain.** They give you DNS records — typically DKIM `CNAME`s and a `TXT`.
   Add them at Porkbun.

    > Porkbun appends the domain automatically. Enter the host part only: `abc._domainkey`,
    > **not** `abc._domainkey.archonarena.com`, which becomes
    > `abc._domainkey.archonarena.com.archonarena.com` and never verifies. This is the most
    > common way this step fails.

    Add SPF too if the apex has no `TXT` yet — the provider will tell you the value. Neither
    SPF nor DKIM is required for a send to be _accepted_; both strongly affect whether it
    lands in the inbox rather than spam.

3. **Create an API key** (or SMTP credentials) and fill in `.env.production`:

    ```sh
    EMAIL_FROM_ADDRESS=noreply@archonarena.com   # must be at the verified domain
    EMAIL_REPLY_TO=support@archonarena.com       # optional; replies to noreply@ vanish
    SMTP_HOST=smtp.your-provider.com
    SMTP_PORT=587
    SMTP_USER=<username or "apikey">
    SMTP_PASSWORD=<the API key>
    ```

    Leave `SMTP_SECURE` blank. Implicit TLS is inferred on port 465 and STARTTLS on anything
    else, which is what providers expect. Setting it wrong usually shows up as a connection
    that hangs rather than an error that says so.

    Most providers want an **API key** as the password, not your account password.

4. **Restart and prove it** — §3c.

### 3b. AWS SES (alternative)

Only worth it if you already have an AWS account or expect real volume.

1. **Verify the domain.** SES console → **Identities → Create identity → Domain** →
   `archonarena.com`, Easy DKIM on, RSA_2048. Note the region. Add the three CNAMEs it gives
   you at Porkbun, with the same host-part caveat as above.
2. **Leave the sandbox.** A new SES account can only send _to_ verified addresses and is
   capped at 200 messages/day. **Account dashboard → Request production access**; say it is
   transactional mail (activation and password reset) triggered by the recipient's own
   action, with no marketing list. Roughly a day.
3. **Credentials.** An IAM user with exactly this policy — SES has no send-only managed
   policy and the broad ones grant far more:

    ```json
    {
        "Version": "2012-10-17",
        "Statement": [
            { "Effect": "Allow", "Action": ["ses:SendEmail", "ses:SendRawEmail"], "Resource": "*" }
        ]
    }
    ```

    Then in `.env.production` — leaving `SMTP_HOST` blank so SES is selected:

    ```sh
    EMAIL_FROM_ADDRESS=noreply@archonarena.com
    AWS_SES_REGION=us-east-1     # the SAME region the identity is verified in
    AWS_ACCESS_KEY_ID=<key id>
    AWS_SECRET_ACCESS_KEY=<secret>
    ```

    The region must match the identity's. An identity verified in `us-east-1` does not exist
    in `eu-west-1`, and the send is rejected as unverified — which reads like a DNS problem
    and is not.

### 3c. Prove it works

```bash
docker compose -f docker-compose.prod.yml --env-file .env.production up -d lobby
docker compose -f docker-compose.prod.yml --env-file .env.production \
  exec lobby npm run check:email -- you@example.com
```

This sends a real message through the same configuration and client the app uses, prints
which transport it chose and what it resolved, and translates a failure into the thing to go
and fix — bad credentials, unresolvable host, wrong port or TLS mode, unverified sender,
SES sandbox, missing IAM permission. Run it after any change to the email settings, and
again after a redeploy.

> A variable exported in the shell **overrides `--env-file`**. If the server has a stale
> `AWS_ACCESS_KEY_ID` or `SMTP_PASSWORD` in root's profile, it silently wins over
> `.env.production` and you will debug the wrong credential. `docker compose ... config`
> prints what the container will actually receive — trust that over the file.

Two things it deliberately does not claim:

-   **Accepted is not delivered.** Open the inbox, and check spam — activation mail in the
    spam folder costs you sign-ups exactly as effectively as mail that was never sent.
-   **A quiet boot log is not proof.** The server checks at startup whether the settings look
    complete, and says so when they do not. It cannot know whether the provider accepts them,
    the DNS is verified, or the key is still live. Only an actual send can.

Finally, once it works, register a throwaway account on the live site and click the link.
`check:email` proves the sender; only that proves the whole flow.

## 4. First boot

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

### Adopting migrations on a database that predates the ledger

A deployment whose Postgres volume was built from `server/db/schema/` some time ago has
everything up to that point and nothing since — and no `SchemaMigrations` ledger at all.
`npm run migrate` refuses to guess in that state, and its message suggests
`--baseline`. **That advice is for a database already at head. It is wrong here**, and
following it would mark every migration as applied without running any, leaving the missing
tables missing permanently.

Work out where the database actually is, then baseline only that far:

```bash
# Is a table from a later migration present? (Seasons arrived in 37, GameReplays in 38)
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  psql -U "$DB_USER" -d "$DB_NAME" -c "\dt public.*" | grep -E "Seasons|GameReplays"

# Files 01-21 are the upstream ones, always already baked into the schema directory.
npm run migrate -- --baseline-through 21
npm run migrate
```

Every Archon-era migration (22 onwards) guards its DDL with `IF NOT EXISTS`, so the second
command is safe even where the database already has some of them — re-applying is a no-op
rather than an error. Verify by diffing against a fresh build if in doubt.

## 5. Deploying updates

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

## 6. Backups

Nightly dump (add to root's crontab on the host):

```cron
0 5 * * * cd /opt/archonarena && docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres pg_dump -U archonarena archonarena | gzip > /var/backups/archonarena-$(date +\%F).sql.gz
```

Restore: `gunzip -c <file> | docker compose ... exec -T postgres psql -U archonarena archonarena`.
Keep at least 14 days; copy off-host (object storage) — a backup on the same disk is not
a backup.

## 7. Scaling game nodes

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

## 8. Monitoring (minimum viable)

-   Set `SENTRY_DSN` in `.env.production` for error tracking (client + server support is
    already wired upstream).
-   Point an external uptime monitor (e.g. UptimeRobot) at `https://archonarena.com/`.
-   `docker compose ... logs -f lobby node-0` for live logs; Winston writes structured
    logs to stdout.

## 9. Health check

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
