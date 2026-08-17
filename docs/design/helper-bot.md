# The Helper Bot

## Goal

There is always one open game in the lobby that anyone can join and play,
against a house bot that picks a random deck. An empty lobby is the hardest
problem a new platform has; the Helper Bot is the half of F9 that answers it
for a _player_ (the other half, a watchable bot-vs-bot showcase, builds on
the same pieces). Named for the Age of Ascension card.

## What a player gets

1. The game list always shows **"Play against HelperBot! (practice)"**,
   hosted by the bot with its deck already picked.
2. Join it, pick any of your decks, and the game starts itself - no waiting
   for an owner to press Start (the owner is the bot; it has no mouse).
3. The bot plays a real game through the real engine: house calls, plays,
   reaps, fights, and answers to every card prompt. It answers instantly.
4. The moment your game starts, the bot opens a fresh table for the next
   player (up to an admin-configured number of concurrent games).
5. Practice games are never persisted or rated - no Amber, no deck records,
   no statistics, no replays.

## Shape

```
server/services/botplayer/BotPolicy.js       how a bot answers any prompt (shared)
server/services/provinggrounds/SimulatedGame.js  the lab's driver, now delegating to BotPolicy
server/gamenode/botdriver.js                 the bot's seat at a real table (pump per event)
server/gamenode/gameserver.js                pumps the driver at start, per input, per sweep
server/services/botgames/HelperBotService.js the account, the config, the random deck
server/lobby.js  runHelperBotSweep           hosts/recycles the table, auto-starts on deck pick
server/gamerouter.js                         skips create/update/replay/rating for bot games
server/services/settings/registry.js         the `helperBot` admin section
```

Five properties are worth keeping if this is ever extended.

**One policy, two hosts.** The prompt-answering policy was extracted from the
Proving Grounds' SimulatedGame into `BotPolicy`, and both the lab and the
Helper Bot drive it. It answers from the buttons and selectable cards the
prompt itself publishes, so it can answer anything the ~2,700 card
implementations raise, and it plays through `menuButton`/`cardClicked` - the
same calls a browser click becomes - so it cannot cheat and upstream card
fixes apply to it automatically. A strength upgrade lands in the lab and at
the table at once.

**Termination has a human witness now.** The lab could abandon a wedged game
and record nothing; at a real table somebody is sitting across from the bot.
So the node driver's caps end in an honest **concede** instead: past the
interaction budget or the turn cap the bot says so in chat, concedes, and
the ordinary win flow frees the table. The pump also never dispatches an
input once `game.winner` is set, so the bot can never press anything on the
post-game menu. Anything it cannot answer is left standing, where force-pass
(`Game.checkInactivity`) remains the human's remedy.

**Bot games are invisible to the rest of the platform.** The Proving Grounds
doctrine, applied at the router: `startGame` never creates the row, GAMEWIN
neither persists nor replays nor rates, and `persistFinishedGame` (REMATCH /
PLAYERLEFT / next-game paths) checks the same flag. The flag rides the save
state from the node, so a lobby restart cannot lose it. Every official
statistic filters only on FinishedAt/WinnerId; one bot row in "Games" would
be a real result in thirty queries at once. Quick Join also never matches
into a bot table - a plain game means a person - and the bot's table is
exempt from the stale-pending-game cleanup, because waiting is its job.

**The account is real, provably ours, and unenterable.** The bot is an
ordinary row in "Users" - that is what lets every existing path treat it as
just another player. Its stored password is deliberately not a bcrypt hash
(every login comparison fails), and it is recognised by a sentinel email no
human can register. If the configured username belongs to a row with any
other email, the service refuses to run rather than seat a bot in somebody's
name. The bot's lobby seat id is `'TBA'` - the platform's existing "no
socket" sentinel - so the node's `isEmpty()` counts the bot as absent and a
table the human abandons closes itself; `checkAbandonment` likewise never
awards a bot an abandonment win.

**The sweep repairs, it does not remember.** Every 15 seconds the lobby
re-reads the admin config (the off switch works without a restart), ensures
the account, and re-establishes the invariant: one open table while under
the concurrency cap. A table whose joiner sat down and never picked a deck
is recycled after a grace period; a table hosted under a previous bot name
is cleared; a table lost to a node death or lobby restart is simply
re-hosted. Rematch is the one deliberate detour: the bot holds no socket, so
the ordinary rematch flow returns the table with both decks still held -
re-picking a deck starts the next game - and the recycle clock is refreshed
so the sweep does not sweep it out from under someone who just asked to
keep playing.

## The deck

"Picks a random deck" means: a random deck from the bot account's own
collection, chosen by the same query the Lucky Dice use; when the account
owns nothing, a random standalone deck (the curated set shipped in
`master-vault-data/standalone-decks.json`, seeded by
`server/scripts/importstandalonedecks.js`), so a fresh deployment has a
working bot with zero setup. An admin curates the pool by importing decks
into the bot account. A new deck is rolled for every table it opens.

## Admin config (`helperBot` settings section)

On/off, the bot's username, most concurrent games, the joiner grace period,
spectators on bot games, and the turn cap behind the concede. All read per
sweep tick.

## Future

-   The F9 showcase: a supervisor keeping a bot-vs-bot table spectatable is
    the remaining half; the driver already plays both seats (the spec plays
    full bot-vs-bot games through the real game server).
-   A first-class rematch that reseats the human at a fresh bot table with
    one click.
-   Policy upgrades (fight/trade heuristics, key timing) - shared with the
    Proving Grounds, so the lab's ratings sharpen with the same change.
-   The tutorial's sparring partner (N11).
