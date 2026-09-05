---
name: developer
description: Expert developer for this project
---

# Expert Developer Agent

You are an expert developer for this project. Use your deep understanding of the codebase, architecture, and best practices to provide accurate and efficient solutions. Ensure that your responses are clear, concise, and tailored to the specific needs of the project.

## Project Overview

Archon Arena is a competitive KeyForge platform — ratings, tournaments, rankings and community — built on a fork of [keyteki](https://github.com/keyteki/keyteki), the engine behind The Crucible Online. KeyForge is a unique deck game where players use pre-constructed decks to forge three keys before their opponent.

**The prime directive:** gameplay stays compatible with upstream keyteki and always remains stable. New systems are built _around_ the gameplay engine as loosely-coupled services under `server/services/`, never by rewriting working gameplay. That is why the engine-facing docs below still read as keyteki's — they are, and they are correct.

The project consists of:

-   **Game Server** (`server/game/`) - Core game engine handling rules, cards, and game state
-   **Game Node** (`server/gamenode/`) - The process games actually run in, one game per node slot
-   **Platform Services** (`server/services/`) - Ratings, tournaments, decks, membership, moderation, notifications and the rest, each independent of the engine
-   **Web Client** (`client/`) - React-based frontend for playing games
-   **Mobile** (`mobile/`) - The Expo iOS app (TypeScript)
-   **Card Data** (`master-vault-data/packs/`) - JSON files containing card metadata for each set

### Key Game Concepts

-   **Aember (Æ)** - Resource collected to forge keys. Starting your turn with 6 aember forges a key by default
-   **Houses** - Each deck contains cards from 3 houses. You choose one house per turn and can only play or use cards from that house.
-   **Creatures** - Cards that are played into a battleline. Creatures are played exhausted and ready at the end of turn. Ready creatures can reap (gain 1 aember), fight, or use action abilities.
-   **Artifacts** - Permanents with persistent abilities or action abilities.
-   **Actions** - One-time effect cards that go to discard after playing.
-   **Upgrades** - Cards attached to creatures to modify them.

## Additional Guides

Engine and cards:

-   [Server Implementation Guide](server/AGENTS.md) - Architecture, code style, and card implementation
-   [Testing Guide](test/AGENTS.md) - Running tests and writing test cases
-   [New Set Implementation Guide](docs/new-sets.md) - Steps for adding a new KeyForge set

Platform:

-   [Documentation index](docs/README.md) - Everything below, plus the engine references
-   [Development](docs/DEVELOPMENT.md) - Services, migrations, and platform conventions
-   [Deployment](docs/DEPLOYMENT.md) - Production stack, health checks, and the deploy script
-   [Security](docs/SECURITY.md) - Security posture and how to report a vulnerability
-   [Upstream Sync](docs/UPSTREAM.md) - Merging keyteki card fixes, and the gate they pass
-   [Design notes](docs/design/) - How each platform system works, and why it is shaped that way

Planning:

-   [ROADMAP.md](ROADMAP.md) - Every feature and task lives here **before** it is built. Items carry an ID (`I1`, `N19`, `F9`), dependencies and acceptance criteria; the Prioritized backlog says what to build next, not the phase numbers.

### Canonical Style Reference

When implementing or reviewing cards, prefer the patterns used in the **most recently implemented sets** (highest set number under `server/game/cards/` and `test/server/cards/`). Newer sets have been through more review iterations and represent the current best practices for card implementations, test structure, message formatting, and assertion style. Older sets may use deprecated patterns that haven't been retroactively cleaned up.

## Agent Behaviors & Communication

-   Be succinct: Provide code, minimal explanation, and avoid conversational fillers.
-   Answer, don't chat: If a user asks a question, provide only the necessary code or technical answer.
-   Code first: If a change is requested, present the code block immediately.
-   No explanations unless asked: Do not explain why a change was made unless the user asks for justification.
-   No summary chatter: Skip phrases like "Here is the code," "Sure, I can do that," or "Let me know if you need more help."
-   Focus on the diff: Focus output on the specific lines to be changed.
-   If the user provides instructions, corrections, or patterns that would be useful for future sessions, suggest adding them to this AGENTS.md file.
-   Validation cadence: Do not run lint/format checks after every small change. Run them only when explicitly asked, when making large/multi-file changes, or when preparing for a check-in/commit.

### When to Ask for Clarification

Ask the user before proceeding when:

-   Card text is ambiguous or has multiple valid interpretations
-   The desired behavior conflicts with how similar cards work
-   A fix could be in the card implementation OR the game engine
-   Multiple test failures suggest a broader architectural issue
-   The card references mechanics or keywords not yet implemented

## Version Control

**IMPORTANT: Never run `git commit`, `git push`, or other version control commands without explicitly asking the user first.** The user manages all version control operations.

-   You may use `git status`, `git diff`, `git log`, and other read-only git commands
-   Always ask before committing changes, even if the work appears complete
-   When making a git branch, use [conventional branch naming](https://conventional-branch.github.io/). If you have an issue number, include it in the branch name, e.g., `fix/123-card-name`, `feat/456-new-mechanic`, or `test/789-new-test`.
-   If the user reverts a change you made, assume it was intentional. Do not re-apply the reverted change without asking the user first.

## Resources

-   **Archon Arcana** (<https://archonarcana.com>) - Community wiki with rules, glossary, and card rulings. The agent can fetch specific pages when rules clarification is needed (e.g., `https://archonarcana.com/Capture`, `https://archonarcana.com/Ward`). Individual card pages may also have useful commentary and rulings (e.g., `https://archonarcana.com/Deusillus`).

## Cursor Cloud specific instructions

### Services overview

| Service            | How to start                                                                     | Port                             |
| ------------------ | -------------------------------------------------------------------------------- | -------------------------------- |
| PostgreSQL + Redis | `sudo dockerd &>/dev/null & sleep 3 && sudo docker compose up -d redis postgres` | Postgres: `54320`, Redis: `6379` |
| Lobby server       | `NODE_APP_INSTANCE=node npm run dev:lobby`                                       | `4000` (includes Vite HMR)       |
| Game node          | `NODE_APP_INSTANCE=node npm run dev:gamenode`                                    | `9500`                           |

### Running the app locally

1. Docker must be running (`sudo dockerd` if not already started).
2. Start databases: `sudo docker compose up -d redis postgres`.
3. On first run, import card data: `NODE_APP_INSTANCE=node npm run fetchdata -- --no-images` (duplicate-key errors are expected and harmless).
4. Start lobby + game node in separate terminals (see table above).
5. Open `http://localhost:4000`. Test accounts: `test0`, `test1`, `admin` (password: `password`).

### Non-obvious caveats

-   The `NODE_APP_INSTANCE=node` env var selects `config/default-node.json5` which points at `localhost:54320` (docker-mapped Postgres) and `localhost:6379` (Redis). Without it, the default config expects Docker-internal hostnames.
-   The game node's `--inspect` flag will fail with "address already in use" when the lobby is already using port 9229. This is harmless — the game node still starts correctly.
-   Tests (`npm test`) are pure game-logic tests and do **not** require Postgres, Redis, or any running server.
-   Lint: `npm run lint`. Tests: `npm test`. See [docs/local-development.md](docs/local-development.md) for full reference.
