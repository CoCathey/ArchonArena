# Design: Tournament Engine (Phase 7)

Status: **Increment 1 shipped** — full event lifecycle for Swiss and single-elimination,
online and in person: create → register → pair rounds → report results → standings →
champion. Auto-created games, rating integration, and double-elim/round-robin are
follow-up increments.

## Current architecture (analysis)

TCO's only tournament support is the Challonge integration (external service, API-key
driven, TO-permission gated) — kept intact as "Challonge Events" under Other. There is
no native event system, no pairing logic, no standings.

## Proposed architecture

```
client /tournaments (+/:id)
   └─ /api/tournaments/*  (reads public; mutations JWT + service-side authz)
        └─ TournamentService  (persistence + lifecycle + authorization)
             ├─ pairing.js    (pure: Swiss, single-elim, standings)
             └─ Tournaments / TournamentPlayers / TournamentMatches (migration 27)
```

### Why this shape

-   **Pure pairing core** (`pairing.js`), same discipline as the Elo calculator: the
    correctness-critical math is I/O-free and exhaustively tested (14 tests). Swiss uses
    score-group-preferring backtracking that guarantees a rematch-free perfect matching
    whenever one exists, with byes to the lowest-standing player who hasn't had one.
    Single-elim reseeds each round (1 vs lowest remaining seed); byes go to top seeds.
-   **Standings**: points (wins; byes count), then strength-of-schedule, then fewest
    byes — so a played win outranks a received one.
-   **Anyone can organize**: event creation requires only a login; the creator gets full
    control of their event, and site TOs/admins (`canManageTournaments`/`isAdmin`) can
    manage any event. This is what makes it useful to local IRL scenes immediately.
-   **Result reporting**: either participant may report an _open_ result (self-service
    for online play); only the organizer can _change_ a recorded one (dispute
    resolution). Byes are stored as pre-reported auto-wins, so "round complete" checks
    are uniform.
-   **Online and IRL are the same engine**: IRL events get table numbers per pairing and
    the TO reports results; online events differ only in that players will eventually
    get auto-created games (increment 2 — the hook point is round creation).
-   **No gameplay-engine coupling**: the engine never reaches into `server/game/**`.

## Files changed

-   `server/services/tournament/{pairing,TournamentService}.js` — new
-   `server/db/schema/30-32 - Tournament*.sql` + `migrations/27 - Tournaments.sql` — new
-   `server/api/tournaments.js` — new; registered in `api/index.js`
-   `client/pages/{Tournaments,TournamentDetail}.jsx` — new; `/tournaments` placeholder
    replaced, `/tournaments/:id` added; RTK endpoints (`listEvents`, `getEventDetail`,
    `createTournament`, `tournamentAction`) — named to avoid the legacy Challonge
    `getTournaments` endpoint
-   `test/server/services/tournament/*` — 26 tests (pairing + lifecycle via in-memory db)

## Database migrations

`27 - Tournaments.sql`: `Tournaments` (format swiss|single-elim, game format, mode
online|irl, status registration|active|complete|cancelled, round tracking),
`TournamentPlayers` (unique per event, Dropped flag), `TournamentMatches` (round, table
number, bye = null Player2, winner + reporter audit).

## API changes

-   `GET /api/tournaments`(`?status=`), `GET /api/tournaments/:id` — public
-   `POST /api/tournaments` — create (any logged-in user)
-   `POST /api/tournaments/:id/{register,drop,start,next-round,finish,cancel}`
-   `POST /api/tournaments/:id/matches/:matchId/result`

## Tests

Pairing: round counts, byes (incl. everyone-has-had-one), score-group pairing, rematch
avoidance + forced-rematch fallback, elim seeding/byes/finals, standings tiebreaks.
Service (in-memory db): validation, registration windows, re-register after drop,
authorization (organizer vs stranger vs site TO), round gating on unreported results,
Swiss round cap, elim field halving, participant-report vs organizer-override, detail
payload.

## Future considerations

-   **Increment 2 — online automation**: create table games automatically per pairing,
    subscribe to GAMEWIN to auto-report, round timers, no-show handling.
-   **Rating integration**: feed tournament matches into RatingService (weighting
    admin-config via the settings registry).
-   **Formats**: double elimination, round robin; Swiss cut-to-top-N into elim.
-   **TO tools**: deck registration with SAS caps (DeckSas is ready for this),
    penalties, printable pairings, QR join codes.
-   **Settings registry section**: default round counts, registration limits.
