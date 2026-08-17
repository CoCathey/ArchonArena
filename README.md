# Archon Arena

**Archon Arena** ([archonarena.com](https://archonarena.com)) is a next-generation competitive
platform for playing [KeyForge](https://keyforging.com/) in your browser — ratings, rankings,
tournaments, and analytics built on a proven gameplay engine.

It is a fork of [keyteki](https://github.com/keyteki/keyteki), the engine behind
The Crucible Online. The gameplay engine is kept upstream-compatible so card fixes and new
sets can be pulled in — see [docs/UPSTREAM.md](docs/UPSTREAM.md).

## What Archon Arena adds

Around the inherited gameplay engine (14 sets, all card scripts and their regression suite),
Archon Arena adds a competitive platform as separate, loosely-coupled services:

-   **Ratings ("Amber")** — chess-style Elo modified by key differential and by how far apart the
    two decks are in strength, with FIDE-style K tiers, provisional placements, rating floors,
    decay and seasons. Separate pools for Archon, Sealed and Alliance. Fully admin-configurable.
-   **ARI, the Archon Rating Index** — the platform's own deck rating, and what the Elo handicap
    now reads. Every deck has one: it starts where the card math (SAS/AERC) points and then moves
    with what the platform actually witnesses, so a deck that overperforms its paper score stops
    being handicapped as though it had not.
-   **Rankings** — worldwide, region, country and state leaderboards under Community, a single
    Stats page, and public player profiles that every username on the site links to.
-   **Tournaments** — Swiss, single/double elimination, round robin and cut-to-top-N, Bo1/3/5,
    online / in-person / hybrid / asynchronous pacing, waitlists, QR check-in, staff and judge
    tools, seeding, penalties, brackets, printables, prize-pool and entry-fee tracking, and
    KeyForge-specific event rules (deck locks, set legality, chains, Triad, Reversal, Adaptive).
-   **Matchmaking** — a Quick Match queue that pairs on Amber proximity with tolerance that
    widens as you wait.
-   **Replays, spectating and the Watch hub** — board-state replays you can step through, jump
    to each key forge, and share with a public link; live spectating with spectator counts, an
    admin-pinned featured match and an optional server-enforced broadcast delay.
-   **Deck SAS integration** — SAS/AERC scores from Decks of KeyForge, on deck lists, the deck
    view, the pre-game screen and per-deck statistics, with a rate-limited background refresh
    sweep. Bulk collection import from DoK and a Master Vault name index so decks can be found
    by name rather than by pasting a link.
-   **Statistics** — a meta dashboard (house and set win rates, SAS bands, format share, the
    house matchup matrix) plus per-player and per-deck breakdowns.
-   **Community** — friends, a member directory, clubs (the Grand Alliance Council) with
    leaderboards and invitations, teams with their own ladder, a local store directory and an
    in-person play hub (Into the Fray). Paper games can be recorded by both players independently
    and count on the same ladder.
-   **Moderation** — reports with captured evidence, a claim/resolve queue, graduated actions
    (note, warn, mute, timeout, ban) with reasons and expiries, a chat content filter, and a
    full audit log.
-   **Notifications** — a typed taxonomy behind an in-app centre, branded email and push to the
    mobile app, with per-category opt-out.
-   **Archon+ membership** — an optional Patreon-backed supporter program (Supporter / Archon /
    Vault Master) whose perks are analytics and cosmetics only: Archon Intelligence, Deep Probe,
    AERC analysis, deck comparison, replay analysis and the misplay review, profile
    customisation, organizer CSV exports, a preview programme, and the Champion's Challenge,
    where a computer play-tests your decks against each other in the background. Nothing a member
    buys touches Amber, matchmaking or tournament eligibility.
-   **Learn and practice** — a played-through Learn-to-Play walkthrough at `/learn` that teaches
    the game a move at a time, no account required, and thirteen practice bots (one per house)
    that keep an open table in the lobby at any hour.
-   **Mobile** — an Expo iOS app (`mobile/`) that plays the full game board, plus decks,
    tournaments, membership and push notifications.
-   **Admin** — a settings service backing every runtime-tunable value, an admin settings page,
    analytics and funnel dashboards, user/rating/season/ban/node/news/bug-report tooling, and
    feature flags.

**Keybringer SSO** (OpenID Connect against Keycloak) is built and tested but ships **disabled**
(`auth.oidc.enabled` is `false`): registering the client in the Keybringer realm needs Ghost
Galaxy's permission. Local registration is a complete signup path on its own, and the login page
only offers the SSO button when the server reports it configured.

See [ROADMAP.md](ROADMAP.md) for the full plan and current status.

## Reporting Bugs or Issues

Use the [GitHub Issues](https://github.com/CoCathey/ArchonArena/issues) page. Before
submitting a new issue, check if it has already been reported. Please include screenshots,
the full chat log, and steps to reproduce. Signed-in players can also file a report in-app,
which lands in the admin bug-report triage page.

## Development

-   [Developer Guide](docs/DEVELOPMENT.md) — the Archon Arena pass over the platform layer:
    layout, services, the schema-vs-migrations split, settings, seeding and the verification loop
-   [Local Development](docs/local-development.md) — setting up the engine/stack basics
-   [Deployment](docs/DEPLOYMENT.md) — production compose, migrations, backups and the runbook
-   [Security](docs/SECURITY.md) — controls, dependency triage, accepted risks, re-review checklist
-   [Upstream Sync](docs/UPSTREAM.md) — pulling gameplay/card fixes from keyteki

The [docs folder](docs/README.md) also documents how the gameplay engine works:

-   [Implementing Cards](docs/implementing-cards.md) - How to implement new cards
-   [Testing Cards](docs/testing-cards.md) - How to write and run tests for cards
-   [Card Messages](docs/card-messages.md) - How to update card log messages
-   [Adding a New Set](docs/new-sets.md) - Scaffolding required to register a new KeyForge set

Design notes for the platform services live in [docs/design/](docs/design/).

Common commands: `npm test` (the full suite; needs no database), `npm run lint`,
`npm run build`, `npm run migrate`, `npm run dev:lobby` / `npm run dev:gamenode`.

## Lineage & acknowledgements

Archon Arena is built on the shoulders of open source: keyteki (The Crucible Online), which
was itself a fork of [ringteki](https://github.com/ringteki/ringteki), inspired by
jinteki/throneteki. Our thanks to all their contributors.

KeyForge and all related artwork and trademarks are the property of Fantasy Flight Games /
Ghost Galaxy. This site is a fan project and is not endorsed by or affiliated with them.
