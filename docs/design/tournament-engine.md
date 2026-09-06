# Design: Tournament Engine (Phase 7)

Status: **Increments 1-5 shipped** — full event lifecycle for Swiss (with optional
top-N cut), single elimination, double elimination and round robin, online and in
person: create → register (caps, waitlists, join codes, check-in, deck registration
with SAS bands) → pair rounds → play (auto-created games online) → results
(auto-reported or manual, best-of series) → standings → final placements and player
history. Inspired by the operational depth of established tournament platforms and the
play-in-platform integration of chess.com events — plus KeyForge-only conditions
(increment 5) that no other game could offer: deck swap policies, set legality,
house restrictions, one-Archon-per-event uniqueness, SAS chain handicaps,
Chainbound-style event chains, the official Triad format, and Reversal /
Adaptive Bo1 events.

## Current architecture (analysis)

TCO's only tournament support was an external, API-key-driven integration with a
third-party bracket service. That integration has been removed: every tournament
now runs on the native, in-platform engine described here.

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
    score-group-preferring backtracking that finds a rematch-free perfect
    matching whenever one exists within a bounded search, with byes to the
    lowest-standing player who hasn't had one, and a folded (top half vs bottom
    half) seeded round 1. The search is exhaustive backtracking over perfect
    matchings — super-exponential in the worst case — and it runs inside the
    lobby process, so it carries an explicit work budget
    (`PAIRING_SEARCH_BUDGET`). Exceeding it degrades to allowing rematches
    rather than running long, and the pairs that repeat come back in
    `rematches` so the organizer learns it from the pairing rather than from
    two players at a table.
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
-   **Standings**: match points, then the three standard TCG tiebreakers —
    **OMW%** (opponents' match-win percentage, each opponent floored at 33%),
    **GW%** (own game-win percentage), **OGW%** (opponents' game-win percentage,
    same floor) — with fewest byes as the last resort. Byes are excluded from
    the opponent averages (there is no opponent to average) but count as a match
    win for the player's own record; players who dropped stay in the calculation
    with their final record, because their opponents earned those results.

    These replaced a sum of opponents' points ("strength of schedule"). A sum is
    only meaningful when everyone has played the same number of matches, and the
    moment byes, drops or an uneven round enter — exactly when tiebreakers
    decide something — it silently rewards whoever happened to face busier
    opponents. The 33% floor is what stops your tiebreakers being wrecked by
    drawing the player who went 0-5 and left, which you had no say in.

    Final placements: bracket players rank by elimination wave (ties share
    placement — 3rd/3rd, 5th…8th), everyone else by standings; stamped into
    `TournamentPlayers.FinalRank` and served as player history
    (`/api/tournaments/history/:username`).

-   **Registration operations** (tournament-platform-style): player caps with FIFO
    waitlists and automatic promotion, private events with 8-char join codes,
    TO-opened check-in with optional shed-no-shows at start, per-event deck
    registration validated against DoK SAS bands (`DeckSas`), decks locked at
    start, decklist visibility control, scheduled start times, staff (judges)
    who share full event control, manual/rating/random/registration seeding,
    round timers with a live clock, announcements, printable pairings.
-   **Result integrity** (`ConfirmedBy`/`DisputedBy`, migration 49): a reported
    result now records whose word it stands on. Reporting your own **loss** is
    taken at face value; reporting your own **win** lands unconfirmed and the
    opponent is asked to confirm or dispute. Organizers and judges are the
    adjudicators, so their entries are final; so are results the platform
    witnessed itself (a game played here) and system consequences (a drop
    forfeiting open matches) — there is nobody's word to take.

    An unconfirmed result still counts toward standings and still lets the round
    advance. Holding the event until both players click would hand any sore
    loser a veto, which is a worse failure than the one being fixed; what the
    flag buys is that disagreement becomes _visible_ — the organizer sees a
    disputed match instead of hearing about it at the awards ceremony. A dispute
    never reverses anything by itself (it is a claim, not a ruling), and any
    fresh result written over the match clears it.

-   **Round clock with teeth** (`RoundEndsAt`, migration 49): the deadline is
    stored on the event rather than each client deriving it from
    `RoundStartedAt + RoundTimerMinutes`, so an extension is one edit everyone
    sees. `adjustRoundClock` moves it; `resolveUnfinished` is the "time in the
    round" call — every still-open match is decided on its current game score,
    the leader taking it and a level match becoming a draw. Bracket matches are
    exempt from the draw case (somebody has to advance) and are handed back to
    the organizer to decide. Before this, the clock was decorative and
    `nextRound` refused to pair while any result was missing, so one player who
    closed their laptop stopped the event for everyone.

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

Migration `49 - TournamentResultIntegrity.sql`:

-   `TournamentMatches` + ConfirmedBy/ConfirmedAt, DisputedBy/DisputedAt,
    DisputeNote, plus a partial index on the disputed rows (finding what needs
    the organizer is the most common query while an event runs). Existing
    decided results are backfilled as confirmed by whoever reported them, so a
    finished event does not reappear as a wall of unresolved disputes.
-   `Tournaments` + RoundEndsAt.

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
finish,cancel,resolve-unfinished,round-clock}`
-   `POST /api/tournaments/:id/register-triad-decks`
-   `POST /api/tournaments/:id/matches/:matchId/{result,confirm,dispute,award,
double-loss,open-game,triad-ban,triad-pick}`

## Settings

Registry section `tournament`: maxPlayerCap, autoCreateGames, allowRated,
sasPerChain, maxHandicapChains — site-wide guardrails; everything else is
per-event.

## Tests

-   `pairing.spec.js`: Swiss invariants, fold order, seed placement, single/double
    elim templates (waves, sources, bye cascades incl. losers bracket), round
    robin coverage, the tiebreaker chain (OMW% including the 33% floor, GW%,
    OGW%, byes excluded from opponent averages), the search budget (a 64-player
    late round pairs promptly; a heavily constrained field still seats everyone),
    series math.
-   `TournamentService.spec.js` (in-memory db): validation, caps/waitlists,
    private events + list visibility, check-in + shed-no-shows, deck registration
    with SAS bounds + start blocking + deck lock, staff authorization, lifecycle
    per format, double-elim end-to-end incl. grand-final reset, playoff cut,
    series score validation, bracket correction locking, penalties, drop
    forfeits, online automation (needing-games/attach/record incl. idempotency),
    final ranks + history, detail flags, result confirmation (own-loss trusted,
    own-win pending, opponent confirm/dispute, reporter cannot self-confirm,
    outsiders excluded, a fresh result clearing the dispute), and the round
    clock (deadline set from the timer, extension without restarting the round,
    unfinished matches resolved on game score, a level match drawn, a bracket
    match handed back, and the next round unblocked afterwards).
-   `RatingService.spec.js`: unrated events never rate; rated events boost K.

## Series continuation, seat locks, windows and local time (N57)

Four fixes from a live best-of-three, recorded here because each changes a rule the
engine or its tables rely on.

-   **Per-match ordering in the lobby.** `GAMEWIN` (record the result, open the next
    table) and `TOURNAMENTNEXTGAME` (seat both players at it) arrive seconds apart about
    the same match, and the second used to read the score the first was still writing.
    When the players' click beat the database the lobby asked which game the match
    needed, was told "game one", built a second game-one table, seated them there, and
    later discarded that game's result as a duplicate - while the real game-two table
    sat unjoined. `Lobby.runForMatch` chains all tournament work per match in arrival
    order, `awaitNextGameInfo` refuses to open a table whose game number does not match
    what the finished table expects, and players who cannot be seated are told so over
    the new `lobbynotice` channel. The pending screen names the game of the series it
    is, and the game list flags a reserved table with "your match table is ready".
-   **Seats know their deck by name.** `getMatchesNeedingGames` now returns each seat's
    deck name with its id, the table carries them as `tournament.deckNames`, and the
    summary exposes `tournament.seats` (`locked`, `deckName`) - withheld for other seats
    under `hideDecklists`. A seat whose registered deck fails to load tells the player
    (`gameerror`) instead of the server log.
-   **Windows.** `TournamentMatchTimeSlots.SlotEnd` (migration 92) makes an offer a
    window; `acceptMatchTime` takes a `time` inside it. `ON CONFLICT` on the same start
    keeps the wider end. A window has to end after it starts, run at most seven days,
    and sit entirely inside the round deadline.
-   **The seats carry the score.** `getMatchesNeedingGames` returns `wins` by seat, the
    table pins them on its players, and the engine's post-game menu
    (`GameWonPrompt.seriesDecided`) uses them - so a 2-0 no longer offers game three.
    `describeMatchReadiness` tells the lobby and `ensureGameForMatch` whether a match
    with no listed game is complete or merely blocked (Triad pick, chain bid), and the
    lobby only ever hands back an unstarted table.
-   **Local time in mail.** `Users.Settings_TimeZone` (migration 91) is reported by the
    browser after sign-in (`PUT /api/account/timezone`); `tournamentNotifications`
    formats every scheduling time for the recipient through
    `notifications/timeLabel.js`, falling back to the UTC label when no zone is known.

## The table a player is actually sent to (N57 follow-up)

The N57 work was reported broken from a live event: "when I opened and joined my table
it said my opponent joined and it auto started the game and then gave me the win and
opened the next game." No such game was played. Three rules were missing, and all three
are now enforced.

-   **A game connection goes to the game it was handed off to.** The handoff names a
    game (`Lobby.sendHandoff`), and the node used to throw that away and ask "which of my
    games is this user in?" (`GameServer.findGameForUser`). For twenty minutes after
    every game of a series that question has two answers - the finished table, which the
    node keeps so its players can read the result, and the one the event has just opened
    -   and it answered with the older one. The player joining game two was re-seated in
        game one and shown its state: the opponent's join, the start, the win, and the
        button offering game two. `gameId` now travels in the game socket's handshake auth
        (its own field, not a claim inside the token, which the refresh flow replaces), and
        `seatConnection` resolves that game and refuses a connection for a game that does not
        hold the user. `findGameForUser` remains the fallback for older clients and prefers a
        game that is still being played.
-   **Being connected is not agreeing to play.** `seatTournamentPlayers` seats a player
    from the mere existence of a lobby socket, and a table with both seats full starts
    itself - so one player pressing "Open my table" dropped their opponent, wherever they
    were on the site, into a live game. That is right when a round is paired (both
    players are waiting for exactly this) and wrong on demand, which is the whole of how
    an asynchronous event is played. `ensureGameForMatch` now passes `requestedBy`
    through to `ensureTournamentGame({ seatOnly })`: the asker is seated, the opponent is
    told their table is ready and walks to it themselves.
-   **A game must not start against a seat nobody can reach.** A seat holds the socket id
    it was filled with, and that id goes stale on every reconnect. A missing handoff used
    to be logged and stepped over, leaving one player at a board and an opponent who
    never learned the game existed. `startTournamentGameIfReady` now requires a live
    socket for every seat (`Lobby.socketForSeat`, which falls back from the seat's id to
    the player's current lobby socket) and leaves the table pending otherwise.

Two engine rules back that up, because a game that starts wrong must not be scoreable.
`Player.connectionSucceeded` records whether a seat's socket ever reached the node;
`Game.recordAbandonmentResultOnLeave` and `Game.checkAbandonment` both refuse to award a
game for or against a seat that never arrived. Without that, whoever was standing there
was handed the win, `recordGameWin` counted it, and the series advanced on a game in
which no card was played.

Finally, `TournamentMatchGames.GameUuid` is the only way a result finds its row, so
`attachGame` no longer overwrites it. A duplicate table is refused and discarded rather
than disinheriting the table the players are sitting at; repointing needs an explicit
`{ replace: true }` from a caller that has looked and found the old table gone. The
series score moves by an atomic increment in the database rather than a
read-modify-write in Node, and `Game.getSummary` carries `tournament` across a node sync
so a lobby restart does not lose a table's event.

## Future considerations

-   Hybrid events (paper + online results into one standing) — the result flow
    already accepts both; needs per-match mode marking.
-   QR join codes and check-in kiosks for IRL events.
-   Tournament announcements → notification/Discord fan-out (Phase 16).
-   Sanctioned OP circuits, seasons and invite tracking (Phase 17).
-   Spectator/caster featured-match page fed by TournamentMatchGames (Phase 15).
