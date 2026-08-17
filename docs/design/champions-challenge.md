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
after a member-chosen number of games — the collection-wide gem hunt. Several
slots can be filled at once; asking for more decks than there are free slots
(or than the collection can supply) fills what fits and reports how many
landed, because a partial fill is a real answer rather than an error.
Admin-owned decks skip the daily cap so the operator can flood their own lab.

## The Gauntlet — playing the field (N24)

The mirror lab measures a deck against the company it keeps. A deck that wins
70% inside a weak collection and one that wins 70% against the world are not
the same deck, and sparring against your own roster cannot tell them apart.
The Gauntlet plays a member's decks against decks **nobody here owns**.

**Where the field comes from.** Master Vault publishes one global deck list,
ordered by registration date, and walking it page by page is how anyone builds
a complete index — it is what Decks of KeyForge does, and what this site
already does in `CatalogService` for deck-name search. That catalog stores
names and uuids only (a search result needs a name; asking for card lists
would multiply every crawl response by two orders of magnitude), so a catalog
deck must be **hydrated** before the engine can play it: its cards fetched
once from Master Vault, parsed by the member-facing importer's own parser, and
kept forever — a registered deck's contents never change. A deck this server
cannot simulate is stored as unplayable rather than retried, so it never costs
a second request. Hydration only runs while at least one member has the
Gauntlet switched on.

**Never your own, never a friend's.** The draw excludes any pool deck whose
uuid the member owns, or that an accepted friend owns. A friend's deck is
precisely the company-it-keeps problem the Gauntlet exists to escape.

**What the member controls.** A share of games (the rest stay mirror games —
both measurements are useful), sets, houses the opponent must contain, a SAS
window, and strategies. Sets and houses are exact, from the catalog.
Strategies are read off the deck's AERC breakdown — `amber` is amber control,
`aggro` is creature control and effective power, `speed` is expected amber,
`control` is artifact control and disruption, `efficiency` is draw and cycle —
which only exists for decks Decks of KeyForge has been asked about. So a
strategy or SAS filter narrows the pool to enriched decks, and the page says
how many decks the filters actually reach rather than letting a member wonder
why every game is still a mirror.

**Reading the deck instead of asking about it (N30).** Every strategy filter used
to be computed from DoK's AERC breakdown, which made the most configurable part
of the Gauntlet depend on somebody else's key: no key, no enrichment, no strategy
filter, and a pool that answered every strategy with "no opponents" while looking
perfectly healthy. The card list is already stored, so `deckProfile.js` reads it
— printed amber, creature power and armour, plus clause-level keyword counts on
the same axes. **Clause** level because "destroy a friendly creature" and
"destroy an enemy creature" are opposite facts and card-level matching cannot
tell them apart.

It is not AERC and not SAS, lives on its own scale under its own names, and never
feeds ARI — a rating built partly on a keyword count would be a worse rating
wearing the same clothes. Each strategy therefore carries two sets of bars, and a
deck is judged by DoK where DoK has rated it and by the local reading where it
has not: "either passes" would silently loosen the filter for exactly the decks
we know most about. The local bars are calibrated so each strategy admits roughly
a fifth to a third of randomly assembled decks, and the spec re-measures that
against the real card pool — a filter that matches everything and one that
matches nothing fail identically from the outside. Profiling is pure CPU over
cards already stored, so it runs before enrichment and costs no request at all.
The SAS window still means DoK's SAS.

**Asking DoK about the pool, politely (N27).** Enrichment runs a few decks per
sweep — never-asked first, and within those the most played, because a deck the
draw keeps picking is the one whose stats the report most needs. Two rules keep
it from becoming a way to hammer somebody else's API.

It asks about decks the crawl brought **into the pool**, never the catalog at
large. The catalog indexes every deck that exists; at 25 requests a minute that
is years of asking, for data the site would never read.

And every ask is **stamped** whether or not DoK answers (`SasAskedAt`). Master
Vault registers plenty of decks DoK has no rating for, and "no `DeckSas` row" is
also exactly what a deck nobody has asked about looks like — so the pass used to
spend its whole per-run budget re-asking the same unanswerable decks on every
sweep and never reach the pool behind them. One nullable timestamp turns that
into a queue that rotates: asked once per `gauntletEnrichRetryDays` (30), long
because "DoK does not rate this deck" does not change week to week.

Both of the sweeps that spend the DoK budget on nobody's behalf — this one and
the stale-SAS refresh — also leave `dok.backgroundHeadroom` (5) requests of each
minute alone. Yielding when the budget is spent only protects whoever asked
first; a sweep is otherwise entitled to the minute's last slot, and a member
arriving a second later sees no SAS at all, which from their side is
indistinguishable from DoK being down. The admin health panel reports how much
of the playable pool is rated and how much was asked about and came back
unrated, because a SAS filter that matches nothing is otherwise unexplainable
from the outside: the pool looks full and healthy.

**Reported separately, never averaged.** Field results live in their own table
and appear in their own column. "How do I do against my own decks" and "how do
I do against the field" are different claims; their average answers neither.
Field games move ARI at the sim rate like any sparring game, count against the
same per-deck daily budget, and — because a field game needs only one of the
member's decks — give a single-deck roster games the mirror lab never could.

## Three sparring partners (N28)

Every sparring game the lab had ever played was piloted by one policy, so a
deck's win rate meant **"how this deck does against this bot"**. A deck that
happened to punish that bot's habits carried a rating saying it was strong, and
nothing in the output could show it: a tidy 62% is a tidy 62% whether it was
earned against a varied field or against one opponent's blind spot.

So three pilots now rotate, and each of them plays every deck. A rating is an
average over three styles instead of a measurement against one, and the **spread**
across the three is a new fact worth having — a deck that wins under the Racer
and loses under the Bruiser is a deck whose result depends on what the opponent
is trying to do, which one number cannot say.

**One brain, three styles.** A persona is a small fixed bias added to the
champion model's weights (`labPersonas.js`) — nothing is trained separately and
the learning loop does not fork. Three independently trained models would need
three diaries, three arenas and three times the games, and would converge on the
same play anyway, because all three would be trained to win. Two consequences
are deliberate: personas bias **action** features only (state features are
identical across every candidate at one decision point, so a state bias would
look meaningful and change nothing), and a persona is slightly the weaker player
for being pulled away from the policy trained to win. That is the price of
decorrelating one pilot's errors, and it is what `personaStrength` dials.

**Both seats share the pilot.** Within a game, symmetric piloting is what keeps
the result attributable to the DECKS; across games, the pilot rotates. Two
different pilots in one game would put "which bot flew it" into every row.
Showcase games are unstyled — a showcase is meant to be the best play the site
can produce — and arena games are unstyled too, because a title fight measures
brains, not styles.

**The pilots duel, so the spread can be trusted.** A persona pulled too far is
simply a bad player, and a deck's spread would then measure "which decks punish
bad play" rather than style matchup. Ordinary sparring cannot show that, because
both seats share the pilot — so two personas meet on the arena's neutral decks
with **paired seeds**, one seed played twice with the pilots swapped between
seats, exactly as a candidate meets the champion. What survives the pair is the
difference between the players. The ladder is on the member's page (with
intervals) and in the admin health panel beside each pilot's game count.

`personasEnabled` off, or `personaStrength` 0, restores the single-pilot lab
exactly; the recorded `Persona` column then stays null and the page shows no
styles rather than empty ones.

## The Vault Tour — your slate against what wins (N32)

The mirror lab measures a deck against the company it keeps. The Gauntlet
measures it against a random sample of every deck that exists. Neither answers
the question a player picking a deck for an event actually asks, which is **how
does this hold up against what wins** — and that field cannot be sampled,
because winning decks are not a distribution. They are a list, and somebody has
to know which decks were on it.

So this field is **curated**: an admin enters tournament decks by Master Vault or
Decks of KeyForge link (the id in the URL is the same either way), with the event
and how the deck finished. The lab fetches each one's cards a few per sweep, the
same pacing the Gauntlet's pool uses, and plays a member's slate through them
over and over.

**The deliverable is the matrix**, not a percentage. Against a dozen named
opponents an average is the least interesting number available: a deck at 60%
overall that loses every game to the deck which won the biggest event of the year
has been told something the average hides. Rows are the field, columns are the
member's three decks, and the last row is the total with its interval.

Three separations are deliberate:

-   **Not the roster.** Three slots, not the eight. Different question, different
    opposition — and a member testing three decks against tournament decks should
    not have to withdraw five to do it. A deck may sit in both.
-   **Its own budget.** Twelve games per deck per day, counted from the Vault Tour
    table alone, so neither measurement starves the other. Site admins are exempt,
    as everywhere in the lab.
-   **Never ARI.** ARI is a rating on the SAS scale fed by games against
    representative opposition. A hand-picked field of winners is the opposite of
    representative, and feeding it in would import the operator's choice of
    opponents straight into the platform's deck rating — invisibly, and unfixably
    afterwards, because nobody could tell which part of the number came from
    where. These games are also kept out of the training diary for the same
    reason: the champion generalises from what it sees.

A starting field ships in `vaultTourField.js` and is seeded on the first sweep
that finds it missing (`ON CONFLICT DO NOTHING`, so an operator's corrections
always win). Those entries carry **`placing: unknown`** rather than a guess: the
list arrived without placings, and "won the event" is not a claim to invent to
fill a column. An admin sets the real ones on the Vault Tour panel.

## Where the games run (N24)

A simulated game is about half a second of solid CPU and a deep showcase game
is closer to a minute. Inside the lobby that is CPU taken from the process
serving chat, matchmaking and the sockets of people playing real games — and
the lab is the one workload with nobody waiting on it.

So the sweep can be hosted by a node of its own:

```
npm run challenge        # server/challengeworker
```

Set `championsChallenge.sweepOwner` to `worker` and the lobby stands down;
`any` lets whichever process claims the lease play. The right to sweep **is** a
lease — a single-row table claimed in one atomic statement — because two
sweepers would quietly play every deck twice its daily budget, invisibly, in
results nobody can audit. A crashed holder costs one lease period of idleness
(`sweepLeaseSeconds`, default 120), never a double-played roster; an
unrecognised `sweepOwner` falls back to the lobby rather than to nobody.

The worker needs **Postgres and nothing else**: the lab reads card data from
the pack files on disk rather than the Redis-backed `CardService`, talks to no
game node, and serves no HTTP. It does make outbound requests to Master Vault
and Decks of KeyForge while the Gauntlet pool is growing.

## Sharpening the bot (N25)

Four things were wrong with how the bot learned, and they are worth naming
because each was invisible in the output — a bot that targets at random and a
bot that targets well both produce a tidy win-rate table.

**It targeted at random.** Every "choose a creature to destroy", "steal from
whom", "return which card" — most of what one KeyForge player does to another —
was answered by picking a selectable card with a dice roll. Targets are
decisions now, with features for whose the card is, what it is worth, whether
it is ready, how much amber is sitting on it and where it stands. Magnitudes
are ownership-gated (`sel:theirPower` and `sel:myPower` are separate weights)
because a linear model cannot otherwise learn that a big creature is a good
thing to destroy and a bad thing to sacrifice. Each distinct prompt also gets
two weights of its own, which is what lets "destroy" and "heal" be learned
apart when the board looks identical.

**The deep bot compared candidates under different futures.** The rollout seed
mixed in the candidate index, so road A and road B were played out against
different draws and a move could win the comparison for having been dealt a
better deck. Futures are now shared across candidates at a decision — common
random numbers — which removes that noise for free. This was a search bug, not
a tuning choice: it made the search report deck luck as insight.

**Credit was assigned by the final score alone.** Every decision in a lost game
was labelled a loss, so a strong play on turn 3 of a game thrown away on turn
20 trained the model against itself. Labels now lean partly on the value of the
position the same seat reached at its next decision — a TD-style target, with
the outcome still the anchor and the value model frozen for the batch so
targets cannot chase the weights they are updating. `trainingLambda` is
**(admin-config)**; 0 restores the old behaviour exactly.

**The deep bot's thinking was thrown away.** Its rollouts measure what a move
is actually worth, and those numbers only fed the showcase panel. They are
recorded as training targets now — the taken road and the rejected ones, which
are the only negative examples the loop ever gets — and `trainModel` prefers a
measured target over any outcome-derived label. A minute of forking becomes
knowledge that costs nothing to use again.

Two supporting changes:

**Title fights stop when the answer is clear.** Fixed-N Wilson spent the same
few hundred arena games on an obvious candidate as on a coin flip. A sequential
probability ratio test now decides — the same instrument chess engine testing
runs on — against a deliberately wide margin (H1 = 60%), so a 73% record over
fifty games takes the title and an even one is ruled out in about seventy.
Arena pairings are also **paired**: one seed played twice with the seats
swapped, so deck and draw luck cancel and what survives is the difference
between the two players. `arenaMinGames` is now a floor under the test rather
than a sample size, which is why its default fell from 150 to 30.

**Evidence is weighed.** A per-card weight learned from two observations is
noise, and there are ~2,700 card ids; weights are shrunk toward zero by
observation count (`count/(count+20)`) when scored — the small-sample rule the
hidden-gem badge lives by, applied to the model's own parameters. Exploration
temperature also anneals with the champion's experience toward a floor that
stays above zero, because a policy that stops exploring cannot notice the day
its habits stopped working. Dropped forks are counted and logged, so a deep bot
quietly running on a quarter of its samples no longer looks exactly like a deep
bot thinking hard.

## The model on real games (N26)

The value model the Challenge trains had only ever looked at the lab's own
sparring. It reads real games now: every recorded board frame of a replay,
scored from one player's seat, which turns a replay into a **win-probability
curve** and the sharpest drops in that curve into moments worth reviewing.
Gated on `advanced_replays` like the rest of replay analysis, so it reaches the
Archon tier rather than staying behind Vault Master.

**Parity is structural, not hoped for.** A model's weights are meaningless
against features scaled differently from the ones it trained on, and a mismatch
would produce a confident graph of nothing with no error anywhere. So there is
exactly one feature computation (`stateFeaturesFrom`) and two adapters build the
view it takes: one from live engine objects, one from a recorded frame
(`replayValue.js`). A spec asserts a live position and its recording produce
identical features.

**What it refuses to claim.** No counterfactual lines. "What would have happened
if you had reaped instead" needs the game replayed down a different branch, which
needs a seed and an input log — the deep bot can fork its own games because it
seeds them deliberately, and nothing can fork a human game played against crypto
randomness. So the panel reports where the game turned and says plainly that the
other road is not knowable. A drop is also not a verdict: the opponent playing
well produces one as surely as a misstep, and the copy says so. With no trained
model there is no curve at all, rather than a heuristic stand-in a reader could
not tell apart from the real thing.

## What the roster's games were already producing (N26)

Three panels over data the lab had been generating since N18 without ever showing
it:

**Your decks against each other.** The mirror lab plays every pair on the roster;
this is that matrix. Counted from the winner column only — counting both sides
would double every cell — and a pair with fewer than `MIN_OPENING_GAMES` between
them is left blank rather than coloured.

**What the bot makes of your deck.** The learned model carries a weight per card
id and a count of how often it has seen each one, so intersecting that with a
deck's cards says what having played each card has been worth across the games
this site actually played. A card seen fewer than `SHRINK_PRIOR` times is left
out entirely: below that the number is mostly prior, and "no view yet" is the
truthful thing to say.

**The sparring partner's history.** Every version that took the title, with the
record it took it on. Each promotion had to clear the sequential test against the
champion before it, so the list only ever goes one way — which is what turns "the
bot is learning" into a claim a member can check.

Win rates now carry their **95% interval** as well: 5-3 and 300-180 both print
"62%", and only one of them means it.

## The lab's vital signs (N26)

`/admin/analytics` grew a Champion's Challenge health panel. Every number in it
already existed — as a counter in a result object, a warning in a log, a row
nobody read — which was the problem: two features ship behind operator switches
(the catalog crawl, the worker node) and an operator had no way to see whether
the last hour of work went anywhere. It answers three questions: is anything
playing (games today, which process holds the sweep lease, and whether that
lease's heartbeat has gone stale — a dead worker node is otherwise invisible), is
the bot learning (diary depth, champion version, any title fight in progress),
and is the field growing (pool against target, last Master Vault fetch, and what
the pool could **not** play, grouped — one card id at the top of that list is an
actionable fact about this server's card data).
