import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';

import Link from '../Components/Navigation/Link';
import Panel from '../Components/Site/Panel';
import {
    Bullets,
    Callout,
    Contents,
    Definitions,
    Lead,
    P,
    ProsePage,
    Section
} from '../Components/Site/Prose';
import chatCommands from '../../server/game/chatCommands.json';

/**
 * ARCHON: How To Play - the guide to using the platform.
 *
 * The old version covered six topics, four of which were a sentence long
 * ("Clicking the Decks link will let you import decks from the master vault")
 * and two of which were about manual mode. It never explained how to start a
 * game, what the formats mean, how to enter a tournament, what happens when you
 * concede, or how anything is rated - so the page could not answer the
 * questions a new player arrives with, and the questions it did answer were the
 * ones nobody was asking.
 *
 * It is written for someone who knows KeyForge and does not know this site.
 * Learning KeyForge itself is a different job, and the links at the top hand
 * that off to the rulebook rather than doing it badly here.
 */

const SECTIONS = [
    { id: 'decks', title: 'Adding decks' },
    { id: 'starting', title: 'Starting a game' },
    { id: 'formats', title: 'Formats' },
    { id: 'interface', title: 'Playing a game' },
    { id: 'manual', title: 'Manual mode' },
    { id: 'commands', title: 'Chat commands' },
    { id: 'finishing', title: 'Finishing, conceding and leaving' },
    { id: 'rated', title: 'Rated play' },
    { id: 'tournaments', title: 'Entering a tournament' },
    { id: 'irl', title: 'Games away from the screen' },
    { id: 'bugs', title: 'When a card misbehaves' }
];

const HowToPlay = () => {
    const { t } = useTranslation();

    return (
        <ProsePage>
            <Panel title={t('How to play on Archon Arena')}>
                <div className='pt-2'>
                    <Lead>
                        {t(
                            'This guide is for players who know KeyForge and want to play it here. It ' +
                                'covers importing decks, starting a game, what the interface does, and ' +
                                'how tournaments and ratings work.'
                        )}
                    </Lead>

                    <Callout>
                        {t('New to KeyForge itself? Start with the ')}
                        <a
                            className='text-accent hover:underline'
                            href='https://www.youtube.com/watch?v=D7qt2H9Im2Q'
                            rel='noopener noreferrer'
                            target='_blank'
                        >
                            {t('tutorial video')}
                        </a>
                        {t(', the ')}
                        <a
                            className='text-accent hover:underline'
                            href='https://images-cdn.fantasyflightgames.com/filer_public/99/15/99157338-aa49-47b1-9ab9-90e99ba1db51/kf_quickstart_web_good.pdf'
                            rel='noopener noreferrer'
                            target='_blank'
                        >
                            {t('quickstart guide')}
                        </a>
                        {t(' or the full ')}
                        <a
                            className='text-accent hover:underline'
                            href='https://images-cdn.fantasyflightgames.com/filer_public/7f/d1/7fd1d910-f915-4b2c-9941-9457a8ab693a/keyforge_rulebook_v11-compressed.pdf'
                            rel='noopener noreferrer'
                            target='_blank'
                        >
                            {t('rulebook')}
                        </a>
                        {t('. This page assumes you already know how a turn works.')}
                    </Callout>

                    <Contents items={SECTIONS} label={t('On this page')} />

                    <Section
                        id='decks'
                        title={t('Adding decks')}
                        lead={t(
                            'You play with decks you own. Importing one copies its card list from the ' +
                                'official Master Vault — it does not affect your physical deck in any way.'
                        )}
                    >
                        <Definitions
                            items={[
                                {
                                    term: t('One deck at a time'),
                                    description: (
                                        <>
                                            {t('On the ')}
                                            <Link
                                                className='text-accent hover:underline'
                                                href='/decks'
                                            >
                                                {t('Decks page')}
                                            </Link>
                                            {t(
                                                ', paste the Master Vault link or the deck id. The name, ' +
                                                    'houses and cards come across automatically.'
                                            )}
                                        </>
                                    )
                                },
                                {
                                    term: t('Your whole collection'),
                                    description: t(
                                        'Enter your Decks of KeyForge username and every deck you have ' +
                                            'registered there is imported at once. This is the fast way ' +
                                            'in if you own more than a handful.'
                                    )
                                },
                                {
                                    term: t('Alliance decks'),
                                    description: t(
                                        'Built in the Alliance builder from pods belonging to decks you ' +
                                            'already have, and usable in Alliance games and events.'
                                    )
                                },
                                {
                                    term: t('SAS'),
                                    description: t(
                                        'Deck power ratings come from Decks of KeyForge and appear on ' +
                                            'your decks automatically. They are used to set expectations ' +
                                            'for rated games and to filter event-legal decks.'
                                    )
                                }
                            ]}
                        />
                        <P>
                            {t(
                                'A deck you no longer want can be deleted from the same page. Games ' +
                                    'already played with it keep their record.'
                            )}
                        </P>
                    </Section>

                    <Section id='starting' title={t('Starting a game')}>
                        <P>
                            {t('Open ')}
                            <Link className='text-accent hover:underline' href='/play'>
                                {t('Play')}
                            </Link>
                            {t(
                                ' to see the tables that are open. Join one, or create your own and ' +
                                    'wait for an opponent.'
                            )}
                        </P>
                        <P>{t('When you create a table you choose:')}</P>
                        <Definitions
                            items={[
                                {
                                    term: t('A format'),
                                    description: t(
                                        'Normal, sealed, alliance or adaptive — see below.'
                                    )
                                },
                                {
                                    term: t('A time limit'),
                                    description: t(
                                        'Optional, and worth setting if you do not want a game to run ' +
                                            'all evening.'
                                    )
                                },
                                {
                                    term: t('Deck restrictions'),
                                    description: t(
                                        'Bound the game to a SAS range, or let the site roll a random ' +
                                            'deck from your collection, if you want a closer match than ' +
                                            '"bring anything".'
                                    )
                                },
                                {
                                    term: t('Private or public'),
                                    description: t(
                                        'A private table needs the password you set, which is how you ' +
                                            'play a specific friend rather than whoever arrives first.'
                                    )
                                }
                            ]}
                        />
                        <P>
                            {t(
                                'Both players pick a deck, both press ready, and the game starts. First ' +
                                    'player is chosen at random unless the format decides it.'
                            )}
                        </P>
                    </Section>

                    <Section id='formats' title={t('Formats')}>
                        <Definitions
                            items={[
                                {
                                    term: t('Normal (Archon)'),
                                    description: t(
                                        'Standard KeyForge. Each player brings a deck from their own ' +
                                            'collection.'
                                    )
                                },
                                {
                                    term: t('Sealed'),
                                    description: t(
                                        'The site deals each player a random deck. You need no ' +
                                            'collection at all, and neither player has practised with ' +
                                            'what they get — the most level way to play a stranger.'
                                    )
                                },
                                {
                                    term: t('Alliance'),
                                    description: t(
                                        'Decks assembled from three pods drawn from different decks. ' +
                                            'Build one in the Alliance builder first.'
                                    )
                                },
                                {
                                    term: t('Adaptive'),
                                    description: t(
                                        'A series with the same two decks. Whoever loses the first game ' +
                                            'takes the winning deck for the second; if it goes to a ' +
                                            'decider, players bid chains to choose which deck to play. ' +
                                            'It measures the pilot, not the deck.'
                                    )
                                },
                                {
                                    term: t('Reversal'),
                                    description: t(
                                        'Available in events: you play your opponent’s deck and they ' +
                                            'play yours.'
                                    )
                                }
                            ]}
                        />
                    </Section>

                    <Section
                        id='interface'
                        title={t('Playing a game')}
                        lead={t(
                            'The board follows the physical layout, and the engine applies card text ' +
                                'for you — you choose, it resolves.'
                        )}
                    >
                        <Bullets
                            items={[
                                t(
                                    'Your hand is along the bottom, your battleline above it, and your ' +
                                        'opponent mirrored across the top.'
                                ),
                                t(
                                    'Click a card to use it. Where a card can do more than one thing, ' +
                                        'a menu appears — play, discard, use, or the specific choices ' +
                                        'that card offers.'
                                ),
                                t(
                                    'Prompts appear in the centre panel. When the game is waiting on ' +
                                        'you, that panel says what for.'
                                ),
                                t(
                                    'The message log records everything that happened, and is the place ' +
                                        'to check when a result surprises you.'
                                ),
                                t(
                                    'Hovering a card enlarges it; right-clicking pins the enlarged view ' +
                                        'so you can read a long card in full.'
                                ),
                                t(
                                    'Chat is beside the log. Spectators can be allowed or blocked when ' +
                                        'the table is made.'
                                )
                            ]}
                        />
                    </Section>

                    <Section id='manual' title={t('Manual mode')}>
                        <P>
                            {t(
                                'Most cards are automated, but not every interaction in KeyForge can be ' +
                                    'resolved without a judgement call, and misclicks happen. The wrench ' +
                                    'at the bottom right turns on manual mode.'
                            )}
                        </P>
                        <P>
                            {t(
                                'In manual mode, clicking a card gives you a menu that changes the game ' +
                                    'state directly — move it, ready it, add or remove counters, put it ' +
                                    'anywhere it needs to be. Both players can see every manual action ' +
                                    'in the log, so nothing is done quietly.'
                            )}
                        </P>
                        <Callout tone='warn'>
                            {t(
                                'Manual mode is a repair tool, not a way to play. If you need it because ' +
                                    'a card behaved wrongly, please report that card — it is the only ' +
                                    'way the automation improves.'
                            )}
                        </Callout>
                    </Section>

                    <Section
                        id='commands'
                        title={t('Chat commands')}
                        lead={t(
                            'Typed into the game chat, these do the same jobs as the manual menus and ' +
                                'are quicker once you know them.'
                        )}
                    >
                        <ul className='m-0 mb-3 list-none space-y-1 p-0 text-sm'>
                            {chatCommands.map((cmd) => (
                                <li key={cmd.usage}>
                                    <code className='rounded bg-surface-secondary px-1 py-0.5 font-mono text-xs text-accent'>
                                        {cmd.usage}
                                    </code>{' '}
                                    {/* Each command carries its own translation
                                        key; the English text is the fallback. */}
                                    <span className='text-muted'>
                                        — <Trans i18nKey={cmd.i18nKey}>{cmd.description}</Trans>
                                    </span>
                                </li>
                            ))}
                        </ul>
                    </Section>

                    <Section id='finishing' title={t('Finishing, conceding and leaving')}>
                        <Definitions
                            items={[
                                {
                                    term: t('Forging the third key'),
                                    description: t(
                                        'The game ends itself and the result is recorded. Nothing else ' +
                                            'is needed from either player.'
                                    )
                                },
                                {
                                    term: t('Conceding'),
                                    description: t(
                                        'The Concede button ends the game and gives your opponent the ' +
                                            'win. It is the polite way out of a game you cannot win — ' +
                                            'and it records a proper result, which simply leaving does ' +
                                            'not.'
                                    )
                                },
                                {
                                    term: t('Leaving without conceding'),
                                    description: t(
                                        'Closing the tab does not finish the game. In a rated game or an ' +
                                            'event, an abandoned table has to be resolved by your ' +
                                            'opponent or a judge, which is slow for them and reflects ' +
                                            'badly on you.'
                                    )
                                },
                                {
                                    term: t('Disconnecting'),
                                    description: t(
                                        'If you drop out, your seat is held and you can rejoin the same ' +
                                            'table. Games are not lost to a bad connection.'
                                    )
                                }
                            ]}
                        />
                        <P>
                            {t(
                                'Custom, but appreciated: type "gg" before you go. It costs nothing and ' +
                                    'it is most of what makes a small community pleasant.'
                            )}
                        </P>
                    </Section>

                    <Section
                        id='rated'
                        title={t('Rated play')}
                        lead={t(
                            'Games count by default. Finish one against another player and it moves ' +
                                'both ratings — there is nothing to switch on.'
                        )}
                    >
                        <P>
                            {t(
                                'The system is Elo, adjusted twice for KeyForge: your deck’s SAS shifts ' +
                                    'what was expected of you, and the key difference at the end scales ' +
                                    'how much the result is worth. Beating a much stronger deck 3–0 is ' +
                                    'the biggest single move available.'
                            )}
                        </P>
                        <P>
                            {t(
                                'A few things do not count, and they are the ones you would expect: a ' +
                                    'game with no winner, one that was abandoned rather than finished, ' +
                                    'and anything that is not a straight two-player result. Tournament ' +
                                    'games count unless the organiser made the event unrated, and games ' +
                                    'you played on paper count once both players have filed the same ' +
                                    'result with their decks attached.'
                            )}
                        </P>
                        <P>
                            {t(
                                'Your first games are provisional while the system finds your level, so ' +
                                    'early swings are larger. After that, see where you stand on the ' +
                                    'leaderboards — worldwide, or filtered to your country or region.'
                            )}
                        </P>
                    </Section>

                    <Section id='tournaments' title={t('Entering a tournament')}>
                        <P>
                            {t('Browse open events on the ')}
                            <Link className='text-accent hover:underline' href='/tournaments'>
                                {t('Tournaments page')}
                            </Link>
                            {t(
                                '. Registering takes a few things depending on how the event is set up:'
                            )}
                        </P>
                        <Bullets
                            items={[
                                t(
                                    'A deck, if the event requires registration. It is checked against ' +
                                        'the event’s rules — allowed sets, required or banned houses, ' +
                                        'SAS limits — when you submit it, so you find out immediately ' +
                                        'rather than at the door.'
                                ),
                                t(
                                    'Payment, if there is an entry fee. The organiser posts how to pay ' +
                                        'and ticks you off once you have; unpaid players are removed ' +
                                        'before the event starts.'
                                ),
                                t(
                                    'Your availability, for events played over days. Offer the times ' +
                                        'that suit you in your own time zone, and your opponent picks ' +
                                        'one or offers others back.'
                                )
                            ]}
                        />
                        <P>
                            {t(
                                'Once it starts, you are paired automatically each round and your table ' +
                                    'is created for you — for a best-of series, one button continues ' +
                                    'straight into the next game and the score keeps itself. Report the ' +
                                    'result if the event needs you to, and a judge can correct anything ' +
                                    'that goes wrong.'
                            )}
                        </P>
                    </Section>

                    <Section id='irl' title={t('Games away from the screen')}>
                        <P>
                            {t('Games played across a real table can be recorded from ')}
                            <Link className='text-accent hover:underline' href='/play-irl'>
                                {t('Play IRL')}
                            </Link>
                            {t(
                                '. Both players confirm the result, so it counts the same as one played ' +
                                    'here. Events can be run in person, or as a hybrid where some tables ' +
                                    'are online and some are on paper, all feeding one standing.'
                            )}
                        </P>
                    </Section>

                    <Section id='bugs' title={t('When a card misbehaves')}>
                        <P>
                            {t(
                                'The engine implements a very large number of cards and some of them are ' +
                                    'wrong. A report with the card name and what you expected is genuinely ' +
                                    'useful, and usually enough to fix it.'
                            )}
                        </P>
                        <div className='mb-3 flex flex-wrap gap-2'>
                            <Button
                                variant='primary'
                                onPress={() =>
                                    window.open(
                                        'https://github.com/CoCathey/ArchonArena/issues',
                                        '_blank',
                                        'noopener,noreferrer'
                                    )
                                }
                            >
                                {t('Report a problem')}
                            </Button>
                        </div>
                        <P>
                            {t(
                                'In the meantime, manual mode will get the game back to where it should ' +
                                    'be so you can finish playing.'
                            )}
                        </P>
                    </Section>
                </div>
            </Panel>
        </ProsePage>
    );
};

HowToPlay.displayName = 'How To Play';

export default HowToPlay;
