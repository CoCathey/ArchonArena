# Archon Arena

**Archon Arena** ([archonarena.com](https://archonarena.com)) is a next-generation competitive
platform for playing [KeyForge](https://keyforging.com/) in your browser — ratings, rankings,
tournaments, and analytics built on a proven gameplay engine.

It is a fork of [keyteki](https://github.com/keyteki/keyteki), the engine behind
The Crucible Online. The gameplay engine is kept upstream-compatible so card fixes and new
sets can be pulled in — see [docs/UPSTREAM.md](docs/UPSTREAM.md).

## What Archon Arena adds

-   **SAS-adjusted Elo ratings** — chess-style Elo modified by key differential and deck SAS
    (power) difference, fully admin-configurable
-   **Rankings** — worldwide, region, country, and state leaderboards
-   **Tournaments** — online, in-person, and hybrid events with TO tools
-   **Keybringer SSO** — sign in with your Keybringer account
-   **Deck SAS integration** — SAS/AERC scores from Decks of KeyForge

See [ROADMAP.md](ROADMAP.md) for the full plan and current status.

## Reporting Bugs or Issues

Use the [GitHub Issues](https://github.com/CoCathey/ArchonArena/issues) page. Before
submitting a new issue, check if it has already been reported. Please include screenshots,
the full chat log, and steps to reproduce.

## Development

The [docs folder](docs/README.md) contains documentation on how the engine works:

-   [Local Development](docs/local-development.md) - Setting up for local development
-   [Upstream Sync](docs/UPSTREAM.md) - Pulling gameplay/card fixes from keyteki
-   [Implementing Cards](docs/implementing-cards.md) - How to implement new cards
-   [Testing Cards](docs/testing-cards.md) - How to write and run tests for cards
-   [Card Messages](docs/card-messages.md) - How to update card log messages

## Lineage & acknowledgements

Archon Arena is built on the shoulders of open source: keyteki (The Crucible Online), which
was itself a fork of [ringteki](https://github.com/ringteki/ringteki), inspired by
jinteki/throneteki. Our thanks to all their contributors.

KeyForge and all related artwork and trademarks are the property of Fantasy Flight Games /
Ghost Galaxy. This site is a fan project and is not endorsed by or affiliated with them.
