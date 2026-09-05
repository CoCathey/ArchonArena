# Archon Arena Documentation

Archon Arena is a competitive KeyForge platform built on a fork of
[keyteki](https://github.com/keyteki/keyteki), the engine behind The Crucible Online. The
gameplay engine stays compatible with upstream and is extended, never rewritten; everything
else — ratings, tournaments, membership, statistics — is built around it as separate services.

That split is why these docs are in two halves. The engine references below are inherited and
still describe the engine accurately. The platform documentation covers what was built since
the fork.

## Getting Started

-   [Local Development](local-development.md) - Setting up your development environment - only necessary for UI, server, or database changes
-   [Development](DEVELOPMENT.md) - Working on the platform: services, migrations, conventions
-   [Implementing Cards](implementing-cards.md) - General card implementation guidelines
-   [Testing Cards](testing-cards.md) - How to write tests for cards
-   [Card Messages](card-messages.md) - How to format game log messages
-   [Adding a New Set](new-sets.md) - Scaffolding required to register a new KeyForge set

## Game Engine References

-   [Card Abilities](card-abilities.md) - Complete reference for ability types (`play`, `reap`, `fight`, `destroyed`, etc.)
-   [Card Properties](card-properties.md) - Auto-handled properties (Power, Armor, Aember Bonus, Enhancements)
-   [Game Actions](game-actions.md) - All `ability.actions.*` methods with examples
-   [Keywords](keywords.md) - Keywords handled automatically by the engine (Taunt, Elusive, etc.)

## Platform Operations

-   [Deployment](DEPLOYMENT.md) - Production stack, TLS, health checks, and the deploy script
-   [Security](SECURITY.md) - Reporting a vulnerability, and the platform's security posture
-   [Upstream Sync](UPSTREAM.md) - How keyteki card fixes are merged in, and the gate they pass
-   [Test Baseline](TEST-BASELINE.md) - The recorded card-suite baseline CI is measured against

## Design Notes

Longer notes on how each platform system works and why it is shaped the way it is, in
[`docs/design/`](design/):

| System                                                      | What it covers                                           |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| [Rating engine](design/rating-engine.md)                    | ARI-adjusted Elo, K tiers, floors, decay, seasons        |
| [Rankings, Amber and IRL](design/rankings-amber-and-irl.md) | Leaderboards, regional scopes, in-person play            |
| [Tournament engine](design/tournament-engine.md)            | Formats, pairings, cuts, hybrid and asynchronous events  |
| [Deck SAS](design/deck-sas.md)                              | SAS enrichment and how deck strength is read             |
| [Deck catalog](design/deck-catalog.md)                      | The Master Vault name catalog and its crawl              |
| [DoK import](design/dok-import.md)                          | Decks of KeyForge integration and the import worker      |
| [Champion's Challenge](design/champions-challenge.md)       | Background deck testing and the learning loop            |
| [Practice bots](design/practice-bots.md)                    | The bots that keep an open table in the lobby            |
| [Settings service](design/settings-service.md)              | Admin-configurable values and the audit log              |
| [Keybringer SSO](design/keybringer-sso.md)                  | OIDC auth, PKCE, account linking                         |
| [Patreon](design/patreon.md)                                | Membership tiers and supporter sync                      |
| [Profile cosmetics](design/profile-cosmetics.md)            | Badges, avatars and backgrounds                          |
| [Onboarding](design/onboarding.md)                          | The new-player welcome and the Learn-to-Play walkthrough |
| [Game state sync](design/game-state-sync.md)                | How board state reaches the client                       |
| [Game leave resilience](design/game-leave-resilience.md)    | Disconnects, reconnects and abandonment                  |
| [Direct messages](design/direct-messages.md)                | Player-to-player threads around the match scheduler      |
