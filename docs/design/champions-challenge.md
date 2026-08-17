# The Champion’s Challenge

## Goal

Give Vault Master ($20) a capability that is genuinely new capability rather
than a nicer view of existing data: a computer plays a member's decks against
each other in the background — practice games on the real engine, never rated
ones — and reports which decks outperform what their SAS predicts. The user
asks three questions and the lab answers all three:

1. **How good are my decks really?** A simulated record per deck, plus the
   deck's ARI - the platform's living rating, which these games help move.
2. **How do they win?** Which opening house carries each deck, first-player
   splits, keys and tempo.
3. **Do I own a hidden gem?** A deck whose lab record is _statistically_
   above its SAS expectation, not just luckily ahead of it.

It is also the platform's first AI player driving the production engine —
the hard half of the F9 bot showcase and the base F3's analysis wants.

## What a member gets

| Surface                | What                                                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `/champions-challenge` | Enroll up to 8 decks (admin-config); each plays up to 12 games/day (admin-config) against the rest of the roster |
| Results table          | Record, win rate, SAS expectation for the opponents actually faced, delta, the deck's ARI, verdict               |
| Hidden gem badge       | Wilson 95% lower bound of the sim win rate clears the SAS expectation, over ≥20 games                            |
| Findings               | Sentences: the gems, over/under-performers, best opening house, first-player splits                              |

## Shape

```
server/services/championschallenge/SimulatedGame.js       the AI player; one game, start to winner
server/services/championschallenge/packCards.js           card JSON from master-vault-data, cloned per deck
server/services/championschallenge/labMath.js             Wilson, SAS expectation, gem rule, findings
server/services/championschallenge/ChampionsChallengeService.js  enroll/withdraw, the sweep, the report
server/api/championschallenge.js                          routes, requireCapability(CHAMPIONS_CHALLENGE)
server/lobby.js  runChampionsChallengeSweep               the tick, cadence gate, error containment
server/db/schema/migrations/72 - ProvingGrounds.sql   ProvingGroundsDecks + ProvingGroundsGames
client/pages/ChampionsChallenge.jsx                       the page, PremiumLock'd
```

Four properties are worth keeping if this is ever extended.

**Simulated games are invisible to the rest of the platform.** They live in
their own tables. Nothing here writes `Games` or `GamePlayers`, and nothing
calls the rating engine. Every official statistic filters only on
`FinishedAt IS NOT NULL AND WinnerId IS NOT NULL`, so one simulated row in
the shared table would be a real result in every deck record, house stat,
meta dashboard and leaderboard at once. A spec enforces the boundary by
forbidding the official tables' quoted names in any SQL the service runs.
If a future feature wants sim games beside real ones, it joins the lab's
tables explicitly; it does not move lab rows into `Games`.

**The bot plays through the same interface a human does.** `SimulatedGame`
answers prompts via `menuButton`/`cardClicked` — the calls a browser click
becomes — and decides what is playable with `card.getLegalActions`, the
engine's own legality check. It cannot cheat, and card fixes pulled from
upstream apply to it automatically. Strength is deliberately plain (call the
fullest house, play everything, reap, end turn) with a generic handler for
every other prompt, because the requirement is that games _finish_: Done and
Autoresolve are pressed when offered, Cancel never while an alternative
exists, the loop halts on `game.winner` before the rematch prompt, and
turn/interaction caps abandon the pathological game — which is then recorded
nowhere. Improving the bot improves the ratings, but every policy change
must keep the termination guarantees.

**The claims are conservative, and computed in one place.** Expectations use
the site's own Elo model (`EloCalculator.expectedScore` with the admin-tuned
`sasWeight`), so "what SAS predicts" here is the same exchange rate the
Amber ladder applies to real games. "Hidden gem" demands the whole 95%
Wilson interval above expectation over at least 20 games; and the rating
column is the deck's ARI (N19, `rating/AriService.js`) — the same index
rated games move, nudged here at the gentler `simGameK`. All the arithmetic
lives in `labMath.js` and `AriService.js` as pure functions with specs — the
page only maps server verdicts to pixels.

**Lapsing pauses, it never deletes.** The sweep re-resolves the roster
owner's entitlements (through `resolveEntitlements`, the one authority)
before playing for them; a lapsed Vault Master's decks simply stop being
scheduled. Enrollments and results are kept, so resubscribing resumes
exactly where the lab left off. Same doctrine as cosmetics: hide the
benefit, keep the data.

## Cost model

A full simulated game is roughly half a second of CPU (measured; the engine
is synchronous and timer-free), and the driver yields to the event loop
every few moves, so the lobby's real players never queue behind a bot game.
Pace is fully admin-config (`championsChallenge` settings section): sweep
cadence, games per batch, per-deck daily budget, roster size, turn cap, and
the off switch — which is read on every tick, so flipping it stops play
within a sweep. The engine's ~2,600 card classes load lazily on the first
sweep (~0.7s once per process), not at lobby boot.

## Future

-   The same player as a practice opponent and the F9 showcase (a supervisor
    keeping a bot table watchable is the remaining half).
-   Matchup matrices between chosen enrolled decks; "test this deck against
    the current meta's archetypes".
-   Policy upgrades (fight/trade heuristics, key-timing) — each one sharpens
    every number the lab already reports.

## The learning bot (N21)

The sparring partner studies its own games now. The pieces, and the property
each one protects:

**The diary and the model.** Every sparring game logs its chosen decisions
as features — the amber race, the key race, board presence, the action
taken, the card involved — and the finished game labels them. A
dependency-free logistic model with one learned weight per card id trains
in-process (`labPolicy.js`); its spec plants a signal and proves training
finds it. The champion model steers every game at softmax temperature, so
the bot mostly does what looks best while still sampling the alternatives
it needs to learn from.

**The title fight.** Candidates train from the diary and must beat the
sitting champion head-to-head (per-seat policies, neutral decks, seats
flipped by coin) until the 95% Wilson lower bound of their record clears
50%. Promotion is a status flip on a `BotPolicies` row; retirement keeps
the record. The bot provably improves and can never quietly regress.

**Determinism, then forks.** Seeded games draw engine randomness through an
AsyncLocalStorage-scoped source (`secureRandom.withRandomSource`) — real
games never enter the scope — with the bot's own dice on a separate stream
and every input logged by list-position. `replayTo` rebuilds the exact game
at any point (fingerprint-verified), and any mismatch aborts the fork
loudly. This is what lets the deep bot take card abilities literally: a
fork EXECUTES the candidate card's real ability code.

**The deep bot.** At house calls and key-race turns it forks the game per
candidate move, plays sampled futures forward with the fast policy, scores
horizons with the value model, keeps the best road, and annotates the
decision with win odds and alternatives; the biggest swing is flagged as
the turning point. Budgets everywhere (admin-config) — a deep game is
seconds-to-minutes, which is why the fast bot keeps the volume and the deep
bot plays the showcases the page renders.

**The randomizer.** 🎲 slots draw a random eligible deck and rotate it out
after a member-chosen number of games — the collection-wide gem hunt.
Admin-owned decks skip the daily cap so the operator can flood their own lab.
