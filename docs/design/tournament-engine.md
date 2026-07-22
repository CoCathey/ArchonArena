# Design: Tournament Engine (Phase 7)

Status: **Increments 1-5 shipped** — full event lifecycle for Swiss (with optional
top-N cut), single elimination, double elimination and round robin, online and in
person: create → register (caps, waitlists, join codes, check-in, deck registration
with SAS bands) → pair rounds → play (auto-created games online) → results
(auto-reported or manual, best-of series) → standings → final placements and player
history. Inspired by the operational depth of Challonge/TopDeck and the
play-in-platform integration of chess.com events — plus KeyForge-only conditions
(increment 5) that no other game could offer: deck swap policies, set legality,
house restrictions, one-Archon-per-event uniqueness, SAS chain handicaps,
Chainbound-style event chains, the official Triad format, and Reversal /
Adaptive Bo1 events.

## Current architecture (analysis)

TCO's only tournament support was the Challonge integration (external service,
API-key driven, TO-permission gated) — kept intact as "Challonge Events" under
Other. The native engine replaces it for everything new.

## Architecture

```
client /tournaments (+/:id)
   └─ /api/tournaments/*  (reads public/optional-auth; mutations JWT + service authz)
        └─ TournamentService  (persistence + lifecycle + authorization)
             ├─ pairing.js          (pure: Swiss, bracket templates, round robin, standings)
             ├─ tournamentEvents    (in-process bridge to the lobby)
             └─ Tournaments / TournamentPlayers / TournamentMatches /
                TournamentStaff / TournamentMatchGames  (migrations 27, 32)

lobby.js  ⇄  tournamentEvents / TournamentService
   ├─ 'roundPaired'      → create a lobby game per pairing (registered decks pre-selected)
   ├─ 'ensureMatchGame'  → recreate a lost table on demand (player/TO button)
   └─ router 'onGameWin' → TournamentService.recordGameWin (series-aware, idempotent)

RatingService.processGame
   └─ TournamentMatchGames lookup: unrated events never move Amber;
      rated events apply the tournament K multiplier.
```

### Why this shape

-   **Pure pairing core** (`pairing.js`), same discipline as the Elo calculator:
    the correctness-critical math is I/O-free and exhaustively tested. Swiss uses
    score-group-preferring backtracking that guarantees a rematch-free perfect
    matching whenever one exists, with byes to the lowest-standing player who
    hasn't had one, and a folded (top half vs bottom half) seeded round 1.
-   **Bracket templates**: elimination formats generate the _entire_ bracket at
    start — every slot exists with "winner of X"/"loser of Y" source references
    (`P1SourceMatchId`/`P1SourceIsLoser`), byes resolved through both brackets at
    build time. Results propagate through a fixpoint (`propagateBracket`) that
    fills slots, auto-completes walkovers, creates the grand-final reset when the
    losers champion takes GF1, and is idempotent. This also powers the bracket
    visualization and keeps "next round" a pure gate (`Round` = wave number).
-   **Losers bracket structure**: L1 pairs W1 losers; even L rounds are majors
    (W losers drop in, order reversed on odd majors to delay rematches); odd L
    rounds are minors. Waves: W_r at r, L_j at j+1, GF after everything.
-   **Best-of series**: matches carry `BestOf`, `Player1Wins`, `Player2Wins`;
    online series auto-create the next game on each GAMEWIN until clinched;
    manual reporting takes a winner + loser-wins count.
-   **Standings**: points → strength of schedule → extended SoS → fewest byes,
    plus W-L records and game counts. Final placements: bracket players rank by
    elimination wave (ties share placement — 3rd/3rd, 5th…8th), everyone else by
    standings; stamped into `TournamentPlayers.FinalRank` and served as player
    history (`/api/tournaments/history/:username`).
-   **Registration operations** (Challonge/TopDeck-style): player caps with FIFO
    waitlists and automatic promotion, private events with 8-char join codes,
    TO-opened check-in with optional shed-no-shows at start, per-event deck
    registration validated against DoK SAS bands (`DeckSas`), decks locked at
    start, decklist visibility control, scheduled start times, staff (judges)
    who share full event control, manual/rating/random/registration seeding,
    round timers with a live clock, announcements, printable pairings.
-   **Penalty tools**: forfeit and no-show awards, double loss (non-bracket),
    result corrections locked once later bracket results are built on them
    (downstream slots are cleared and re-propagated otherwise), auto-forfeit of
    open matches when a player drops.
-   **Online automation**: pairing a round emits `roundPaired`; the lobby creates
    one game per pairing (tournament-reserved join, registered decks
    auto-selected, online players seated immediately, game auto-starts when both
    are seated). GAMEWIN → `recordGameWin` (unique (MatchId, GameNumber) rows
    make it idempotent) → match completes or the next series game spawns.
    Tables that lose their pending game (restart) are recreated with "Open my
    table" (`ensureMatchGame`). Pending tournament games survive the stale-game
    sweep until their match is decided or the round moves on.
-   **KeyForge-only conditions (increment 5)** — possible because every deck is
    a unique, externally-rated physical object:
    -   _Deck swap policy_: 'locked' (one deck all event, the Archon standard)
        or 'between-rounds' (re-register a different legal deck; it applies
        from the next pairing). Triad events are always locked to their pool.
    -   _Set legality_ (`AllowedSets` jsonb of expansion ids) and _house
        conditions_ (`RequiredHouses`/`BannedHouses` jsonb of house codes),
        validated on every deck registration via Decks.ExpansionId and the
        DeckHouses join.
    -   _One Archon per event_: the same Master Vault uuid cannot be
        registered by two players, across single decks and Triad pools.
    -   _SAS chain handicap_ (`SasChainHandicap`): online games start the
        stronger deck with chains — floor(SAS advantage / sasPerChain),
        capped at maxHandicapChains (both admin-config). Applied via the
        engine's `startingChains` hook, which behaves exactly like adaptive
        bid chains (short first hand, chain shed on the reduced refill).
    -   _Chainbound event chains_ (`ChainsPerMatchWin`): played match wins
        accrue `TournamentPlayers.EventChains`, carried into the winner's
        later games this event (stacking with the SAS handicap).
    -   _Triad_ (official 3-deck format): players register exactly three
        distinct decks (TournamentPlayerDecks, pools are open information);
        each match, both players ban one opposing deck, then pick from their
        own two survivors (`P1/P2BannedDeckId`, `P1/P2DeckId` on the match;
        ban before pick is enforced, choices are immutable). Online tables
        are only created once both picks are in.
    -   _Reversal / Adaptive Bo1 events_: event game formats now map onto
        the lobby's real formats (`archon`→`normal` — also fixing tournament
        games being invisible to lobby format filters); the game node
        already swaps decks for reversal and runs the adaptive bid.
-   **No gameplay-engine coupling**: the engine never reaches into
    `server/game/**`; the game object only carries an opaque `tournament` tag
    through its save state (plus the additive `startingChains` detail, applied
    at `Game.initialise` exactly like adaptive bid chains).

## Database

Migration `32 - TournamentsV2.sql` (over `27 - Tournaments.sql`):

-   `Tournaments` + StartTime, PlayerCap, BestOf, PlayoffBestOf, CutTo, Stage,
    SeedMethod, Visibility, JoinCode, RoundTimerMinutes, RoundStartedAt,
    CheckInOpenedAt, RatedGames, RequireDeckRegistration, SasMin, SasMax,
    HideDecklists, GameTimeLimit, Announcement.
-   `TournamentPlayers` + DeckId (FK Decks, SET NULL), CheckedIn, Waitlisted,
    FinalRank.
-   `TournamentMatches`: Player1Id now nullable (template slots) + Bracket,
    BracketRound, BracketPos, P1/P2SourceMatchId + IsLoser, Player1Wins,
    Player2Wins, BestOf, ResultType ('played'|'bye'|'forfeit'|'no-show'|
    'double-loss').
-   New `TournamentStaff` (unique per event/user) and `TournamentMatchGames`
    (unique (MatchId, GameNumber), indexed by GameUuid).

Migration `33 - KeyForgeConditions.sql`:

-   `Tournaments` + DeckSwapPolicy, AllowedSets, RequiredHouses, BannedHouses
    (jsonb), SasChainHandicap, ChainsPerMatchWin, Triad.
-   `TournamentPlayers` + EventChains.
-   `TournamentMatches` + P1/P2BannedDeckId, P1/P2DeckId (Triad state).
-   New `TournamentPlayerDecks` (Triad pools; unique (TournamentId, UserId,
    Slot)).

## API

-   `GET /api/tournaments` (`?status=`, optional auth — private events visible
    to organizer/staff/participants), `GET /api/tournaments/:id` (optional
    auth), `GET /api/tournaments/history/:username` — public.
-   `POST /api/tournaments` — create (any logged-in user).
-   `POST /api/tournaments/:id/{register,register-deck,drop,update,
open-check-in,check-in,seeds,staff/add,staff/remove,start,next-round,cut,
finish,cancel}`
-   `POST /api/tournaments/:id/register-triad-decks`
-   `POST /api/tournaments/:id/matches/:matchId/{result,award,double-loss,
open-game,triad-ban,triad-pick}`

## Settings

Registry section `tournament`: maxPlayerCap, autoCreateGames, allowRated,
sasPerChain, maxHandicapChains — site-wide guardrails; everything else is
per-event.

## Tests

-   `pairing.spec.js`: Swiss invariants, fold order, seed placement, single/double
    elim templates (waves, sources, bye cascades incl. losers bracket), round
    robin coverage, standings tiebreakers (extended SoS), series math.
-   `TournamentService.spec.js` (in-memory db): validation, caps/waitlists,
    private events + list visibility, check-in + shed-no-shows, deck registration
    with SAS bounds + start blocking + deck lock, staff authorization, lifecycle
    per format, double-elim end-to-end incl. grand-final reset, playoff cut,
    series score validation, bracket correction locking, penalties, drop
    forfeits, online automation (needing-games/attach/record incl. idempotency),
    final ranks + history, detail flags.
-   `RatingService.spec.js`: unrated events never rate; rated events boost K.

## Future considerations

-   Hybrid events (paper + online results into one standing) — the result flow
    already accepts both; needs per-match mode marking.
-   QR join codes and check-in kiosks for IRL events.
-   Tournament announcements → notification/Discord fan-out (Phase 16).
-   Sanctioned OP circuits, seasons and invite tracking (Phase 17).
-   Spectator/caster featured-match page fed by TournamentMatchGames (Phase 15).
