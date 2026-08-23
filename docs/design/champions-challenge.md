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

**And it answered at random too.** Targets were the half of the interaction
layer that got fixed; the other half is the button prompt — "would you like to
use this?", "choose a house", which of two triggers resolves first. Nearly
every optional ability in KeyForge arrives as one of these, and any prompt the
policy had no fixed title for was answered by picking a button out of a hat.
Worse than the odds: the choice was never recorded as a decision, so no amount
of training could ever reach it.

Buttons are decisions now, on the same footing as targets — one weight per
(prompt, answer) pair, plus one for the button's own text so that `btn:yes`
carries what accepting an optional ability is worth **across** prompts. That
second weight is what makes an unfamiliar prompt better than a coin flip on its
first showing rather than after the hundredth. With no model at all the bot
presses Yes, because an optional ability is shown to the player it benefits and
the ones where that reasoning fails (concede, cancel) never reach the branch.

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

**...and then drowned.** Preferring a measured target is not the same as
weighting one. Every row reached the gradient with the same force, and the fast
bot outproduces the deep bot by orders of magnitude: at the budgets this
shipped with, roughly one training decision in four thousand carried a number
anybody had measured. The loop was learning almost entirely from the label that
cannot teach move order — "this appeared in a game somebody won", which for a
good turn-3 play in a game thrown away on turn 20 points the wrong way.

Two numbers fix that and they only work together. `trainingTargetWeight`
(default 8) scales the gradient for a searched decision, so a minute of
thinking outweighs a handful of noisy games rather than being averaged into
them — it goes on the gradient and not on the weight decay, because L2 is a
property of the weights and not of the evidence, and the shrinkage counts stay
unweighted because one observation is still one observation. And the deep
budget itself went up: 8 games a day, 20 analyzed decisions each, 8 candidates
apiece, which is about thirteen times the measured rows for something like half
an hour of CPU. `deepGamesPerDay` still accepts 0, because a small box has to
be able to say no.

The budget is guarded by a spec rather than by a comment
(`registryTypes.spec.js`): these are exactly the numbers somebody trims to
reclaim CPU without noticing what was traded away.

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

## Learning from the people who play here (N48)

Every row in the training diary came from the lab playing itself, which makes
the whole loop a closed system: it can get steadily better at beating its own
habits and never discover that the habits are the problem. The site already
runs thousands of games with a person sitting on one side of the table, and
their moves are the one source of play nothing in the lab generates.

**Capture is live, at the game node, before the engine acts.** A human's click
arrives at `onGameMessage`, and `HumanCapture.note` reads the decision out of it
on the way past — from the position the move was chosen FROM, since a row built
after the engine resolved the move would describe the consequence and label it
the cause.

**The rows are the bot's own rows, or they are worse than nothing.** A model is
a weight per feature; feed it rows whose features were computed even slightly
differently and it does not learn less, it learns something wrong, confidently,
with no signal in the output that says so. So the capture calls
`decisionRecord(game, player, action)` — the same function the bot's own driver
calls, with the same triple — and a spec compares a captured row against that
function called directly.

**Why not rebuild the rows from replays.** It was the obvious cheaper route and
it is a trap worth writing down. A recording knows a deck's SIZE but not its
contents, so the deck-composition features the model reads would simply be
absent — and absent reads as _false_, not as unknown. Every human row would have
carried a quiet, systematic lie. Replays also record board snapshots rather than
the action taken, so the move itself would have to be inferred.

**Only the choices the bot would also have scored.** The policy answers a great
many prompts from a rule rather than from the model — the mulligan, the
end-of-turn confirmation, its own prophecy question — and it never scores a
choice it did not have. Capturing those would teach the model that whatever the
engine compels is good, weighted by how often it compels it. The capture mirrors
that skip list exactly, and a decision with fewer than two options is not a
decision. A cancelled card menu is not a move either.

**Conceded and abandoned games are thrown away.** A concession labels every move
the conceder made a losing move, including the good ones, and people concede for
reasons that have nothing to do with the position. Nothing else in the diary
carries that distortion.

**Which tables, and what a human move is worth.** `championsChallenge.humanLearning`
takes `bot` (practice tables, the default), `all` (people against people too) or
`off`. The pull is `humanGameWeight`, default 3 — above the 1 an ordinary
sparring row pulls, because the move came from somebody trying to win; well
below the 8 a searched decision pulls, because the label is still "somebody won
this game twenty turns later". The diary stores the **source**, not the weight,
and the weight is applied when a batch is folded — so changing the knob
re-weights the whole diary rather than only its future. Zero parks the rows
without losing them.

**Said out loud.** A table that is capturing says so in its own chat log when it
opens. Nothing captured identifies anybody: a row is the feature vector of a
position and the move taken from it, with no player, deck or game attached. The
lab health panel reports the human share of the diary, because a capture that
has silently stopped looks exactly like a healthy lab from every other figure
on that page.

## The rung that is a person (N50)

The calibration ladder (N39) measures the champion against opponents that never
learn — the plain bot, the three personas, the searching bot — and that fixity
is the whole point: a ladder whose rungs move measures nothing.

It also means the ladder tops out at the lab's own ceiling. Every rung is
something the lab built, so the highest praise available is "as good as the best
bot we can make", and the question anybody actually asks about a game bot — can
it beat a person — was not on the page at all.

**It could not be answered from anywhere else, either.** Practice games are
deliberately never results (F9): no Amber, no deck records, no rating, no
statistic. That is the right call and it has a cost — a bot that had never once
beaten a human being looked identical, from every number this site publishes, to
one that always did. The games were already being played; nothing was counting
them.

**The split is the measurement.** "The bot beats people 55% of the time" is a
number about the site's population, not about the bot: a site whose practice
tables are mostly joined by first-week players reports a strong bot for as long
as it keeps beating first-week players, and the report goes on being true and
goes on meaning nothing. So each game is filed twice — against the total, and
against the band its opponent falls in — and the shape is what reads: beats the
newcomers, holds the middle, loses to the good ones is the sentence that says
what to work on.

The bands are the **rating engine's own** thresholds (`provisionalGames`,
`highRatingThreshold`), not numbers invented for this. Those are the points the
platform already treats as meaningful about a player, and a second opinion about
where "strong" starts is a second thing to keep in step. A player with no rating
row at all bands as provisional rather than being dropped: they played the game,
the bot won or lost it, and excluding them would quietly make this a record of
rated players only — which on a young site is almost nobody, and specifically not
the people who join a practice table.

**Which games count.** Concessions and abandonments are thrown away, matching
what N48 already decided for the training diary — and it matters more here,
because the practice bot **concedes itself** past its interaction and turn caps
(`gamenode/botdriver.js`). Counting those would file the bot's own wedges as
wins for whoever was sitting across from it, so a bot that got _worse_ at
finishing games would show up on this page as people getting better at beating
it. Games the engine decided — a third key, or any of the timeout rules — are
the ones that measure play.

**Two facts are stamped at the table, not inferred later.** The save state has
always known a table _was_ a practice game and never which SEAT the bot held, so
a result filed from it alone would be credited to whichever name came first. And
a champion can be promoted while a game is being played, so reading the current
version at file time would credit a model that never sat down. Both ride with
GAMEWIN: `botSeats` from the driver, `botPolicyVersion` from the policy the
lobby actually sent. A table where either is ambiguous — a bot-versus-bot
showcase, a seat that was never identified — files nothing rather than guessing.

**Where it is stored, and why it is read differently.** The same
`ChallengeCalibration` table, under `human` and `human:<band>`, written per
champion version like every other rung. It is _read_ across versions, where the
ladder is read within one: the ladder plays hundreds of games a sweep, and this
grows only when somebody sits down, so per-champion it would say "0 games so
far" for most of every reign. The rows are still written per version, so the day
this is worth splitting by champion the history is already there.

Human rows are excluded from the ladder's own query, both halves of it. The
ladder reads "the newest version anybody calibrated", so one practice game
finishing after a promotion and before the lab's next sweep would otherwise make
`MAX(PolicyVersion)` name a version holding nothing but that game — and the
whole ladder would vanish from the page until the sweep caught up.

**Its own panel, not a sixth rung.** The ladder's panel says out loud that its
opponents never learn, which is what makes them a ruler. People are the exact
opposite. Putting one in that list would make the page contradict itself; the
honest arrangement is a ruler, and beside it the thing being measured.

## A position that can be copied (N51)

N46 diagnosed why the bot reads as not thinking, and it was not randomness: the
live driver plays greedily and explores nothing. It is that `scoreDecision`
scores each candidate as a _description of a move_, with no representation of
what the move does. The ladder puts a number on what that costs — the champion,
playing exactly these weights, beats the **searching** bot 33% of the time. Same
model, same features; the only difference is that one of them looks ahead.

The reason that search never reached a table is one sentence long: the deep bot
forks by **replaying a seeded input log from the start of a simulated game**,
and a live game has no such log. It is also why a deep game costs about a minute
where a fast one costs half a second — every fork re-runs the whole game so far,
so thinking about turn twenty costs twenty turns of engine.

Both are the same problem. There was no way to copy a position. This is that
way.

### Exact, or nothing

A fork that is subtly wrong is worse than no fork. A planner searching a
position that differs from the real one does not plan badly — it plans
confidently about a game nobody is playing, and nothing in the output says so.
Same trap N48 avoided by refusing to rebuild training rows from replays, same
principle N46 applied when it made an unknowable afterstate emit nothing rather
than a guess.

So `capture` returns a snapshot **or a reason**, never a best effort. It refuses:

-   a lasting effect that is not a `persistentEffect`. Persistent effects
    re-register themselves when a card lands in a location, so a rebuilt board
    gets them free; everything else was put there by an ability that has already
    resolved, and its closures cannot be rebuilt from data.
-   a delayed or during-opponent's-next-turn effect, for the same reason.
-   a card in play the decklist cannot account for — a token creature — because
    a rebuild deals from the decklist and has nowhere to take an extra body
    from.

Measured over real games across all thirteen houses: **80% of house calls
capture, and every one that captures reproduces its position exactly** — 968 of
968 accepted forks in the widest sweep, over 1,205 house calls. The refusals are a short list of specific cards, not
anything structural, which is a much better place to be — it can be shortened
incrementally.

### The turn boundary, and why that one

A snapshot is taken at the **house call**. Three reasons, and they agree: it is
the cleanest point in the pipeline (the key phase has resolved, no ability is
mid-resolution, only a prompt is outstanding); it is the decision a planner most
needs, because the house call decides the whole rest of the turn, which is
exactly why N46 could not model it; and forking there means a search explores
whole **turns** — the unit a person plans in, and the thing the bot has never
been able to compare.

Restore therefore queues the turn from the **house phase**, not the top of the
round. A snapshot is taken inside the house phase, after the key phase has
already forged and spent; queuing a whole round would forge a second time off
the same amber, which is the kind of error that makes a fork look like a
brilliant line.

### Two bugs the fingerprint caught, and why the test is shaped that way

Structural equality is not the test — two positions can carry identical numbers
and diverge on the next input. So `fingerprint` is exhaustive where
`SimulatedGame.boardHash` is deliberately coarse: that one exists to notice a
game going in circles, this one exists to prove two games _are_ the same game,
and a field left out of it is a field a fork is free to get wrong.

Comparing fingerprints over real games caught both of the bugs that were there:

-   **Cards under a card** (what a prophecy buries) were captured and never put
    back, so a board quietly forgot what it was carrying.
-   **`controller` was restored where `defaultController` is the field that
    matters.** Control is _derived_ — `getModifiedController` reads a
    `takeControl` effect or falls back to `defaultController` — and
    `Game.checkGameState` re-derives it on every state change, physically moving
    a card whose controller disagrees with the board it sits on. Restoring only
    the derived value lasted exactly until the first state check, which handed
    the card back: a Treachery card ("enters play under your opponent's
    control") silently migrated to its owner's side. The copy was a legal,
    plausible position, and it was not the one being played.

A third thing worth writing down, because it looks like a bug and is not:
`player.allCards` **is the same array as** `player.deck` (see
`Player.prepareDecks`), so it shrinks with every card drawn and is not a record
of what was built. The first version of the decklist check tested membership
against it and concluded that every card in play was a token.

### Driving a fork

The copy is exact at the moment it is taken. What it cannot reproduce is the
randomness the engine reaches for **afterwards** — a deck running out and the
discard being shuffled back, an ability that discards at random. Left alone the
fork draws those from crypto, so two rollouts of the same line face different
futures and the comparison measures the deal rather than the move.

That is not a defect to fix, it is hidden information to **sample** — the same
call DeepGame makes when it rolls a fork forward on a fresh `rolloutSeed` so it
plans against likelihoods rather than replaying fate. So the caller wraps a
rollout in `withRandomSource(seededSource(n), …)` and varies `n` per sample,
never per candidate, so every line being compared faces the same futures.
Measured: forks rolled forty plies forward under one seeded source land on the
same position every time, and under different seeds they do not.

### What this unlocks

`fork(game)` is the one call a planner needs — both decklists already sit on the
seats as `deckData`, so a caller does not have to carry them alongside, which is
the difference between a facility a live table can use and one only the lab can.
It makes turn-level search possible at a real table for the first time, and it
removes the replay-from-turn-one cost that made the lab's own deep games
expensive. Nothing uses it yet; that is the next piece.

## Planning the house call (N52)

The house call is the worst-informed decision the bot makes and the most
consequential one it makes. N46 named exactly why it could not be modelled: a
house call "emits nothing at all: its consequence is the whole rest of the
turn". Every other move the bot scores is one it can describe. This one can
only be answered by finding out — and since a position can be copied (N51),
finding out is possible: fork the game, call each house, play that turn out,
and compare where each one left the board.

Rolling the turn out with **the same policy that will actually play it** makes
the estimate the honest one: not "what could this house do" but "what will this
bot do with it".

### Fairness is not optional

A fork is exact, and exactness is the problem — it holds the real deck in its
real order, so a planner handed one unmodified calls the house whose cards it is
about to draw, and looks brilliant doing it. That is not a small effect: the end
of every turn draws the hand back up, so a one-turn search reaches the next
three or four cards of its own deck on every line it considers.

So every rollout is **determinized** first (`services/botplayer/determinize.js`).
KeyForge is unusually kind here: a deck is a published 36-card list and the
opponent's play area, discard and purged pile are face up, so whatever is not in
them is distributed among their hand, deck and archives in an order nobody can
see. A fork already holds exactly that multiset in exactly those three zones, so
a plausible world is one shuffle — pool the three, shuffle, deal back to the
same counts. Nothing has to be derived, and the result cannot contradict
anything visible because the visible zones are never touched. The deciding seat
gets its own deck shuffled and nothing else: it built the deck and has watched
its own cards leave it, so composition is fair information and order is not.

That makes each world a sample rather than an answer, so several are averaged —
and every house is judged on **the same worlds**. Sharing them is not a nicety:
with one world each, a house can win for having been dealt a better shuffle and
the planner would be measuring the deal. Same common-random-numbers correction
DeepGame already applies to its own rollouts.

### The budget is the design

Measured on real positions: a fork costs about 10ms, determinizing half a
millisecond, playing a turn out about 25ms — so one rollout is roughly 35ms, and
three houses at two worlds each is about 200ms. The node is single-threaded and
shared, and a bot that holds it is every other game on that node waiting.

So the planner spends a wall-clock budget rather than a fixed count, and spends
it **breadth first**: one world for every house before a second for any of them.
A house nobody rolled has no score, and preferring a house that was tried over
one that was not is worse than not planning — so if the budget cannot cover one
world per house, the planner declines and the caller chooses as it always did.
It also declines on a position N51 refuses to fork, and on a table with no
champion, because scoring a rolled-out turn needs a value model.

### What it measures, and the honest result

**It is off by default, and that is a measurement rather than caution.**

Against a hand-made stand-in value model — no trained champion exists in a test
environment — the planner:

-   **changed the house call on 41% of turns**, with a clear value spread
    between the houses it compared (mean 0.21, and only 6 of 105 positions where
    the houses were indistinguishable). So the search runs, and it is not merely
    reproducing the heuristic.
-   **won 51% of paired games** against the identical pilot with planning off
    (95% CI 40.5–61.9%, n=80). Scoring after the opponent's reply instead of at
    the end of its own turn gave 55% (CI 42.5–66.9%, n=60); three rounds deep
    with three worlds gave 52% (CI 38.5–65.2%, n=50). All three are neutral.

The diagnosis those numbers support is the ordinary one for game search: **a
search is only as good as the thing it optimises.** The planner faithfully finds
the house that leads to the position the value model likes best, and the stand-in
value model is not a champion. A crude evaluator searched harder produces a bot
that is very good at reaching positions a crude evaluator likes.

What would settle it is a real champion and the instrument N50 built. The honest
state is that **the machinery is proven correct and its value is unproven**, so
it ships where an operator can turn it on and the ladder can decide. A bot must
never quietly get worse.

### Shape

```
server/services/botplayer/determinize.js   forget what the seat cannot see
server/services/botplayer/turnPlanner.js   fork, call each house, play it out, compare
server/services/botplayer/BotPolicy.js     chooseHouse consults the planner, or does not
server/services/settings/registry.js       bots.planHouseCall and its budget (all off/default)
server/lobby.js                            resolves the planner when a table opens
server/gamenode/gameserver.js              carries it to the driver
server/gamenode/botdriver.js               hands it to the policy
```

One property worth keeping if this is extended: **the pilot flying a rollout
never plans.** `BotPolicy`'s planner defaults to null, and the planner builds its
rollout pilots without one — otherwise the first house call inside the first
rollout would start a second planner, and a third inside that.
