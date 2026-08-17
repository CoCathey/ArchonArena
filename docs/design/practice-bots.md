# The practice bots

## Goal

There is always one open game in the lobby that anyone can join and play,
against a bot that picks a random deck. An empty lobby is the hardest problem
a new platform has; this is the half of F9 that answers it for a _player_ (the
other half, a watchable bot-vs-bot showcase, builds on the same pieces).

## Thirteen characters, one per house

A bot belongs to a house, is named for it, and only ever plays decks that
contain that house. That is what makes the open table worth returning to: sit
down against Snudge and you know you are getting Dis. When a table gets
joined, the next one is opened by a different bot, so the lobby's practice
seat is a rotating cast rather than a fixture.

| House    | Bot            | House         | Bot            |
| -------- | -------------- | ------------- | -------------- |
| Brobnar  | BingleBangbang | Sanctum       | Bulwark        |
| Dis      | Snudge         | Saurian       | Philophosaurus |
| Ekwidon  | TalentScout    | Shadows       | BadPenny       |
| Geistoid | Memette        | Skyborn       | RedBaron       |
| Logos    | HelperBot      | Star Alliance | Explorover     |
| Mars     | Tunk           | Unfathomable  | Bubbles        |
| Untamed  | FuzzyGruen     |               |                |

Those are only the names a fresh site starts with. Every bot's name, picture
and profile is an admin's to change from **Bot Settings**; the house is not,
because the house is what the bot's account is bound to and what decides the
decks it may play.

## What a player gets

1. The game list always shows an open table - **"Play against Snudge! (Dis
   practice)"** - hosted by a bot with its deck already picked.
2. Join it, pick any of your decks, and the game starts itself - no waiting
   for an owner to press Start (the owner is a bot; it has no mouse). The
   Start button works too, and belongs to the player who joined.
3. The bot plays a real game through the real engine: house calls, plays,
   reaps, fights, and answers to every card prompt. It answers instantly.
4. **Easy, Medium or Hard**, chosen from the pending screen before the game
   starts (Medium by default). See below - it changes the bot's deck, not its
   brain.
5. The moment your game starts, a different bot opens a fresh table for the
   next player (up to an admin-configured number of concurrent games).
6. Practice games are recorded and replayable, and are never results - no
   Amber, no deck records, no statistics, no rating.

## Difficulty is the deck, not the brain

A bot that plays worse on purpose teaches bad habits, and a bot that plays
better on purpose needs a second brain nobody maintains. So every setting runs
the same policy, and what changes is the deck it sits down with - the honest
lever KeyForge already has, because a 50-ARI deck loses to a 110-ARI deck in
anybody's hands.

| Setting | ARI      |
| ------- | -------- |
| Easy    | 45 - 65  |
| Medium  | 66 - 89  |
| Hard    | 90 - 125 |

ARI is the platform's own living deck rating (N19): seeded from SAS/AERC and
moved by every rated and sparring game since, so a band means "decks this
platform has watched perform like this" rather than "decks somebody's model
once scored". The bands touch but do not overlap, and leave a gap at each end
on purpose - below 45 is unpleasant to play against and above 125 is a wall.

The pool is **every deck the site has ever imported**, counted once per deck
rather than once per copy: a deck is 36 cards with a Master Vault uuid, not
somebody's property, and the bot plays the cards. Nothing about whose
collection a copy sits in reaches the table. That is what makes the settings
mean anything - three bands per house need hundreds of decks to feel
different, and no hand-stocked bot account was ever going to hold them. When a
band genuinely has nothing in it (a young site, an unrated house) the table
opens with an unbanded deck and says so in the log, because a table that opens
beats a table that does not.

Whoever joins the table owns the setting until the game starts; changing it
re-deals the bot's deck. An unattended table opens at whatever an admin chose
(`bots.defaultDifficulty`, Medium out of the box).

## Shape

```
server/services/botgames/roster.js           the thirteen houses and their default names
server/services/botplayer/decisions.js       the move list, shared with the lab
server/services/botgames/BotService.js       accounts, admin edits, who hosts, which deck
server/services/botplayer/BotPolicy.js       how a bot answers any prompt (shared)
server/services/championschallenge/SimulatedGame.js  the lab's driver, delegating to BotPolicy
server/gamenode/botdriver.js                 the bot's seat at a real table (pump per event)
server/gamenode/gameserver.js                pumps the driver at start, per input, per sweep
server/lobby.js  runBotTableSweep            hosts/recycles the table, auto-starts on deck pick
server/gamerouter.js                         skips create/update/replay/rating for bot games
server/api/bots.js                           the Bot Settings API (isAdmin)
client/pages/BotAdmin.jsx                    the Bot Settings screen, at /admin/bots
server/db/schema/migrations/74 - Bots.sql    house -> account binding, per-bot on/off
server/services/botgames/difficulty.js       Easy/Medium/Hard, as ARI bands
server/services/DeckService.js               practiceDeckPool - the library, by house and band
server/services/settings/registry.js         the `bots` section (edited on the bot screen)
client/Components/Games/PendingGame.jsx      the difficulty toggle, beside Copy Game Link
```

Six properties are worth keeping if this is ever extended.

**They play what the lab learned.** The Champion's Challenge (N21) trains a
model by playing thousands of games against itself and crowning a champion
only when it can prove it is better. The practice bots score their moves with
that same champion model, over the same enumerated move list
(`services/botplayer/decisions`, shared with the lab so a fork and a live
table cannot disagree about what "candidate 3" means). A stronger champion is
therefore a stronger opponent in the lobby, with no second brain to maintain
and nothing to copy across.

The list is deliberately conservative - every move the engine would offer a
human, less the one no sound player makes - so the model reorders sound play
rather than inventing unsound play, and End Turn is offered only once nothing
else remains, which is what stops a young model discovering the strategy of
doing nothing. When a card is clicked the reason is remembered, so the menu
that opens next is answered with the move the model chose rather than by a
fixed preference order. With no champion yet (a fresh site) or with the
learned play switched off, the bots fall back to the plain order below and
keep playing.

**The plain order has to be good, because most of the time it is what plays.**
A site has no champion until the Challenge has run, so the fallback is the
opponent people actually meet, and three of its habits came back from a real
table as blunders:

-   _It threw away cards it should have kept._ Discard is a legal action on
    every card in hand, so an upgrade drawn before any creature looked like a
    playable card whose only button was the bin. The move list no longer
    offers a card whose sole legal action is Discard: nothing is lost by
    holding it, and a move nobody can pick is a move no policy can get wrong.
-   _It picked its play at random._ Literally - the fallback drew a hand card
    out of a hat, which is how a targeted action got fired into an empty
    board on the first play of a turn. Moves are now ranked: creatures,
    upgrades, artifacts, actions, abilities, fights worth taking, reaps,
    fights not worth taking. Building the board first is what gives the cards
    that need targets something to point at. Randomness survives _inside_ a
    rank, so two games from the same hand still differ - which is where the
    lab's self-play gets its variety.
-   _It fought at random too._ A fight is now scored from the same arithmetic
    the engine resolves it with - power, armour, elusive, skirmish, assault,
    hazardous, poison, ward - and taken only when it wins the exchange; the
    target is the best creature the prompt will accept. It is an estimate,
    since card abilities can change any of it, but it is the difference
    between trading a giant for a token and not.

All of that lives in the shared move module, so the lab's unmodelled games
train on exactly the play a lobby opponent makes.

**It plays the race, not just the board.** Two facts a KeyForge player reads
first and the bot used to ignore entirely:

-   _Are they about to forge?_ Amber sitting in the opponent's pool at or
    above their key cost is a key already, unless it leaves before their turn
    begins. So a move that takes their amber - a steal or a capture - is
    ranked ahead of everything else, and the house call weighs a house that
    can answer them far above a house with one more card in it. (A steal is
    worth two of a reap in any case: one on, one off.)
-   _Can I forge this turn?_ With enough ready creatures to reach the key
    cost, reaping outranks even a fight the bot would win - a dead enemy
    creature is worth less than the key - and the moment the amber is there
    the order reverts by itself.

"Does this card take amber" is answered by the platform's own card-knowledge
index (F3's `cardKnowledge`, built from the canonical Master Vault packs),
rather than by a second parser written for the bots. It is coarse by design: a
conditional steal counts, because ordering one first costs nothing when the
condition fails. The game node warms that index at startup - it parses nine
megabytes synchronously, and the first bot decision of a game is the worst
moment to spend a fifth of a second.

**It knows its own deck.** The model's state now includes the composition of
what this seat can still draw: how much of the remaining deck is creatures,
how much bonus amber is left in it, how much amber control. A player knows
their own decklist and has watched their own cards leave it, so that is fair
information - and it is the difference between evaluating the board and
evaluating the game. The deck's ORDER is never read, and neither is anything
about the opponent's hand or deck.

What both bots keep is the important part: answering from the buttons and
selectable cards the prompt itself publishes, so any of the ~2,700 card
implementations can be answered, and playing through `menuButton`/`cardClicked`

-   the same calls a browser click becomes - so a bot cannot cheat and upstream
    card fixes apply to it automatically.

**What the deep planner does NOT do here.** The lab's deep bot plans by
_forking_ the game: it replays a seeded input log into a copy, tries a
candidate move there, rolls the copy forward and scores where it led. That
needs two things a live table does not have - a seed the whole game ran under,
and every input expressible in the replay log, including a person's clicks -
and it costs roughly a minute of compute per game, which at a table is a
minute of somebody's evening. So the practice bots take the learned model (all
of the strength, none of the wait) and leave forking to the lab, where the
opponent is another computer and nobody is waiting. Giving the live bots deep
thought means seeding practice games and logging both seats' inputs; the
place it would pay off first is the bot-vs-bot showcase, where both seats are
already ours.

**Termination has a human witness now.** The lab could abandon a wedged game
and record nothing; at a real table somebody is sitting across from the bot.
So the node driver's caps end in an honest **concede** instead: past the
interaction budget or the turn cap the bot says so in chat, concedes, and
the ordinary win flow frees the table. The pump also never dispatches an
input once `game.winner` is set, so the bot can never press anything on the
post-game menu. Anything it cannot answer is left standing, where force-pass
(`Game.checkInactivity`) remains the human's remedy.

**Practice games are recorded, and are never results.** These were once one
decision - "invisible" - and a player asked for the half of it that was wrong:
they wanted to find a game again, watch the replay back, and show somebody the
turn that won it, none of which is possible for a game that was never written
down. So a bot game is persisted and its replay saved like any other, and its
row carries `BotGame`.

What the flag buys is the other half. Every statistic on this site selects
finished games with the same shape - `FinishedAt IS NOT NULL [AND WinnerId IS
NOT NULL]` - so one unflagged bot row would be a real result in thirty places
at once: deck records, house and meta aggregates, player win rates, the
Tournament Lab, the intelligence reports. Every one of them excludes flagged
rows, and a spec reads the source to prove none of them forgets
(`botGamesAreNotResults.spec.js`) - thirty places is too many to remember, and
a win rate that is quietly two points off is not something anybody notices.

The line is: **listings show them, numbers do not count them.** A player's game
history and their profile's recent games include practice games deliberately -
that is what recording them was for. Ratings never see one at all: the router
declines to call the rating engine for a bot game, and the engine re-checks the
flag itself, because that is the function that moves somebody's Amber. Quick
Join never matches into a bot table either.

**The account is real, provably ours, and unenterable.** The bot is an
ordinary row in "Users" - that is what lets every existing path treat it as
just another player. Its stored password is deliberately not a bcrypt hash
(every login comparison fails), and it is recognised by a sentinel email no
human can register, minted from the bot's HOUSE rather than its name -
because the name is an admin's to change and would stop proving anything the
moment they changed it. A name already held by any other account means that
bot simply does not play, rather than the site seating a bot in somebody's
name; the other twelve carry on.

Because the account is real, editing a bot's picture and profile is editing a
user: the Bot Settings screen writes the same `Settings_Avatar`, `Bio`,
`Country` and `State` a person edits, through the same picture pipeline
(`services/images/userImages.js`), so a bot's face renders everywhere a
player's does with no second code path. The bot's lobby seat id is `'TBA'` - the platform's existing "no
socket" sentinel - so the node's `isEmpty()` counts the bot as absent and a
table the human abandons closes itself; `checkAbandonment` likewise never
awards a bot an abandonment win.

**The sweep repairs, it does not remember.** Every 15 seconds the lobby
re-reads the admin config (the off switch works without a restart), ensures
the roster, and re-establishes the invariant: one open table while under the
concurrency cap, hosted by a bot chosen at random from those that can
actually play - enabled, holding a deck of their house, and not already
sitting somewhere else. A table whose joiner sat down and never picked a deck
is recycled after a grace period; a table lost to a
node death or lobby restart is simply re-hosted. Rematch is the one
deliberate detour: the bot holds no socket, so the ordinary rematch flow
returns the table with both decks still held - re-picking a deck starts the
next game - and the recycle clock is refreshed so the sweep does not sweep
it out from under someone who just asked to keep playing.

**A ready table cannot sit idle, and is never a dead end.** Starting is
reachable three ways, because the bot owning the table means the Start
button would otherwise belong to a player with no hands:

1. **Deck selection starts it** (`onSelectDeck`) — what a player actually
   experiences, immediate. The deck is seated before the parts of selection
   that can fail late (the SAS attach, a state push), so the failure path
   asks to start too rather than stranding a table that is genuinely ready.
2. **The sweep heals it** (≤15s). Readiness is re-derived every tick from
   the lobby's own state instead of being trusted to a single event, so a
   game node that was briefly unavailable, a deck applied down a path that
   does not reach the hook, or a lost callback costs a few seconds rather
   than the table.
3. **The joiner can press Start** (`onStartGame`, and `canClickStart` in the
   client). Ownership cannot be the gate at a bot table, so the seated
   player holds the button; a joiner with no deck is told to pick one rather
   than clicking into silence.

`startBotGameIfReady` is the one launcher behind all three: it
re-checks everything and reports whether it started, so calling it from
anywhere, repeatedly, is safe.

**They think visibly.** The bot decides in microseconds, and a whole turn
landing in one frame reads as a glitch rather than an opponent: cards appear
already played and there is nothing to follow. So a pump plays ONE move and
then waits (`bots.thinkMs`, jittered ±25% so the rhythm is not metronomic),
pushing the board out between plays. It is still far faster than a person -
this is legibility, not a handicap - and zero means instant, which is what
bot-vs-bot games and the specs use.

**They are players, not members.** Being an ordinary account is what lets a
bot hold a seat, a deck and a picture with no second kind of player in the
codebase - and the price is that surfaces about the _community_ have to say
"people only" out loud. The member directory and its search do
(`notABotSql`, defined once beside the sentinel email): a bot is found in the
lobby, by playing it, not by browsing the people who play here.

**A node outlives one bad game.** The node holds every live game in memory
and nowhere else, so an uncaught throw - from a timer, a socket callback, or
a promise nobody awaited - used to end every game on it at once: boards
freeze, the connection drops, and there is nothing left to reconnect to.
Errors raised while resolving a game are contained per-game
(`runAndCatchErrors`), and now the escapes are too: the periodic sweep
contains each game's work, the connection handler refuses one socket rather
than the process, and last-resort `uncaughtException` / `unhandledRejection`
guards log loudly and keep the node serving everybody else.

**A bot never holds the node.** The engine is synchronous and the game node
is single-threaded and shared, so a bot thinking inside one call is not "a
slow bot": every other game on that node waits behind it, including the ping
the lobby uses to decide the node is alive. A node that goes quiet for a
minute is declared timed out and the lobby then clears **every game on it**.
So a pump runs on a wall-clock budget and, if it needs longer, hands the loop
back and finishes on a later tick.

## The deck

"Picks a random deck" means: a random deck from that bot's own collection
**containing its house**, chosen by the same query the Lucky Dice use with a
house filter; when it owns none, a random standalone deck containing its
house (the curated set shipped in `master-vault-data/standalone-decks.json`,
seeded by `server/scripts/importstandalonedecks.js`). A new deck is rolled
for every table.

An admin curates a bot's pool by importing decks into that bot's account -
Bot Settings shows how many each one holds, and says so plainly when a bot
has none, because a bot with nothing of its house cannot host however enabled
it is. The shipped standalone decks cover nine houses, so Ekwidon, Geistoid,
Skyborn and Unfathomable need decks imported before those four can play.

## Admin config

**Bot Settings** (`/admin/bots`, isAdmin) holds both halves: the roster - each
bot's name, picture, profile, on/off switch and deck count - and the knobs
that govern all of them (keep a table open at all, most concurrent games, the
joiner grace period, spectators, the pause between plays, whether they play
the learned policy, the concede cap). The knobs are an ordinary
settings section (`bots`) stored, validated and audited like every other; the
registry's `page` field is what moves it off the general Site Settings screen
and onto this one, next to the roster it governs. All of it is read per sweep
tick, so nothing needs a restart.

## Future

-   The F9 showcase: a supervisor keeping a bot-vs-bot table spectatable is
    the remaining half; the driver already plays both seats (the spec plays
    full bot-vs-bot games through the real game server).
-   A first-class rematch that reseats the human at a fresh bot table with
    one click.
-   Per-bot personality: a policy weighting per house, so Brobnar's bot
    fights and Logos' bot draws - the roster already gives each one an
    identity to hang that on.
-   Policy upgrades - shared with the Champion’s Challenge, so the lab's
    ratings sharpen with the same change. Key timing is the obvious next one:
    the plain order reaps for amber but has no notion of racing to a key, and
    no notion at all of holding a creature back to stop the other side
    forging.
-   **Train a champion.** The single biggest lever, and it needs no code: the
    plain order is a floor, not a ceiling, and everything above is the bot
    playing without a model. Run the Challenge (or the Gauntlet) until a
    champion is crowned and the bots start scoring their moves with it.
-   More crosses in `labFeatures`. Every candidate at one decision shares a
    state, so state features cancel out of the ranking entirely and only the
    action's own features can separate two moves. The kind is now crossed
    with four coarse board contexts (`x:playAction:noBoard` and friends),
    which is what lets a champion learn "not this, not here" - the mistake
    that fired an action into an empty board. Each new context is another
    column the Challenge has to fill with games, so add them deliberately.
-   The tutorial's sparring partner (N11).
