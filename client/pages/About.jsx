import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import SiteContentOverride from '../Components/Site/SiteContentOverride';
import {
    Bullets,
    Callout,
    Contents,
    Definitions,
    FeatureCard,
    FeatureGrid,
    Lead,
    P,
    ProsePage,
    Section
} from '../Components/Site/Prose';

/**
 * ARCHON: About - what this site is, and what it can do.
 *
 * Rewritten because the page had fallen a long way behind the product. It
 * described a place to play casual games with a rating attached, at a point
 * where the platform runs tournaments with entry fees and prize pools, sells
 * memberships, analyses decks, and handles in-person events. Somebody deciding
 * whether to sign up was reading a description of a different, smaller site.
 *
 * Two things were also simply wrong and are corrected here rather than
 * reworded: the shuffle is no longer Math.random (it is drawn from the system
 * CSPRNG), and rated play is live rather than "coming".
 *
 * Admins can still replace this whole page from Site Settings > Site Content.
 */

const SECTIONS = [
    { id: 'what', title: 'What it is' },
    { id: 'start', title: 'Getting started' },
    { id: 'play', title: 'Ways to play' },
    { id: 'ratings', title: 'Ratings and leaderboards' },
    { id: 'events', title: 'Tournaments' },
    { id: 'community', title: 'Community' },
    { id: 'membership', title: 'Archon+' },
    { id: 'shuffle', title: 'The shuffle' },
    { id: 'colors', title: 'Username colours' },
    { id: 'thanks', title: 'Lineage and thanks' },
    { id: 'ip', title: 'Intellectual property' }
];

const About = () => {
    const { t } = useTranslation();

    return (
        // ARCHON: admins can replace this whole page from Site Settings >
        // Site Content; the built-in content below renders when unset.
        <SiteContentOverride field='about' title={t('About Archon Arena')}>
            <ProsePage>
                <Panel title={t('About Archon Arena')}>
                    <div className='pt-2'>
                        <Lead>
                            {t(
                                'Archon Arena is a free, fan-run platform for playing KeyForge in your ' +
                                    'browser — and for everything around the game: rated ladder play, ' +
                                    'tournaments online and in person, clubs, and tools for working out ' +
                                    'which of your decks is actually any good.'
                            )}
                        </Lead>

                        <div className='mb-5 flex flex-wrap gap-2'>
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

                        <Contents items={SECTIONS} label={t('On this page')} />

                        <Section id='what' title={t('What it is')}>
                            <P>
                                {t(
                                    'You bring the decks you already own. Import them from the Master ' +
                                        'Vault, find an opponent, and play a full game of KeyForge with ' +
                                        'the card text applied for you — the platform knows the rules, so ' +
                                        'nobody has to arbitrate them.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'Everything else exists because a game is more fun when it counts ' +
                                        'for something. Results feed a rating, ratings feed leaderboards, ' +
                                        'and organisers can run real events on top of both.'
                                )}
                            </P>
                            <FeatureGrid>
                                <FeatureCard title={t('Play online')}>
                                    {t(
                                        'Casual or rated games against anyone on the site, with the rules ' +
                                            'engine handling card effects.'
                                    )}
                                </FeatureCard>
                                <FeatureCard title={t('Play in person')}>
                                    {t(
                                        'Record games you played across a table, so your local night ' +
                                            'counts towards the same record.'
                                    )}
                                </FeatureCard>
                                <FeatureCard title={t('Tournaments')}>
                                    {t(
                                        'Swiss, single or double elimination, and round robin — online, ' +
                                            'in person, or both at once.'
                                    )}
                                </FeatureCard>
                                <FeatureCard title={t('Ratings')}>
                                    {t(
                                        'An Elo rating that understands deck power and margin of victory, ' +
                                            'with worldwide and regional leaderboards.'
                                    )}
                                </FeatureCard>
                                <FeatureCard title={t('Clubs and friends')}>
                                    {t(
                                        'Find people to play, join a club, and keep a friends list for ' +
                                            'games you actually want.'
                                    )}
                                </FeatureCard>
                                <FeatureCard title={t('Deck intelligence')}>
                                    {t(
                                        'Your own results, turned into an answer: which of your decks ' +
                                            'wins, against what, and in which sets.'
                                    )}
                                </FeatureCard>
                            </FeatureGrid>
                        </Section>

                        <Section id='start' title={t('Getting started')}>
                            <P>{t('Three steps, and the first two are quick.')}</P>
                            <Definitions
                                items={[
                                    {
                                        term: t('1. Make an account'),
                                        description: t(
                                            'A username, an email address and a password. You may be ' +
                                                'asked to confirm the email address before you can play — ' +
                                                'check your spam folder if the message does not arrive.'
                                        )
                                    },
                                    {
                                        term: t('2. Add your decks'),
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
                                                    ', paste a Master Vault link to import one deck, or ' +
                                                        'give your Decks of KeyForge username to bring in ' +
                                                        'your whole collection at once.'
                                                )}
                                            </>
                                        )
                                    },
                                    {
                                        term: t('3. Play'),
                                        description: (
                                            <>
                                                {t('Open ')}
                                                <Link
                                                    className='text-accent hover:underline'
                                                    href='/play'
                                                >
                                                    {t('Play')}
                                                </Link>
                                                {t(
                                                    ', start a table or join one. The How To Play guide ' +
                                                        'covers the game interface itself.'
                                                )}
                                            </>
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section
                            id='play'
                            title={t('Ways to play')}
                            lead={t(
                                'The same rules engine runs several formats. You pick one when you ' +
                                    'create a table, and events pick one for you.'
                            )}
                        >
                            <Definitions
                                items={[
                                    {
                                        term: t('Archon (normal)'),
                                        description: t(
                                            'Standard KeyForge: you and your opponent each bring a deck ' +
                                                'you own.'
                                        )
                                    },
                                    {
                                        term: t('Sealed'),
                                        description: t(
                                            'The platform deals each player a deck from the pool. No ' +
                                                'collection required — the fairest way to play a stranger.'
                                        )
                                    },
                                    {
                                        term: t('Alliance'),
                                        description: t(
                                            'Decks built from three pods taken from different decks, ' +
                                                'assembled in the Alliance builder.'
                                        )
                                    },
                                    {
                                        term: t('Adaptive'),
                                        description: t(
                                            'A short series with the same two decks. After the first ' +
                                                'game the players bid chains for the stronger deck, so ' +
                                                'the mismatch is priced rather than ignored.'
                                        )
                                    },
                                    {
                                        term: t('Reversal'),
                                        description: t(
                                            'You play your opponent’s deck and they play yours. Deck ' +
                                                'power stops mattering and piloting is all that is left.'
                                        )
                                    },
                                    {
                                        term: t('Manual mode'),
                                        description: t(
                                            'Automation off, for anything the engine gets wrong or any ' +
                                                'card you would rather resolve yourself.'
                                        )
                                    }
                                ]}
                            />
                        </Section>

                        <Section id='ratings' title={t('Ratings and leaderboards')}>
                            <P>
                                {t(
                                    'Rated games move an Elo rating, the same idea chess uses, with two ' +
                                        'changes that matter in a game where the decks are not equal:'
                                )}
                            </P>
                            <Bullets
                                items={[
                                    t(
                                        'Deck power counts. Your deck’s SAS score shifts what the system ' +
                                            'expected, so beating a stronger deck is worth more than ' +
                                            'winning with one.'
                                    ),
                                    t(
                                        'The margin counts. A 3–0 moves more points than a 3–2, because ' +
                                            'it is more evidence.'
                                    ),
                                    t(
                                        'New players are provisional for their first games, while the ' +
                                            'system works out roughly where they belong.'
                                    )
                                ]}
                            />
                            <P>
                                {t(
                                    'From there you can see where you stand worldwide, or by country and ' +
                                        'region, on the leaderboards — and your own history, deck by ' +
                                        'deck, on your stats page.'
                                )}
                            </P>
                        </Section>

                        <Section
                            id='events'
                            title={t('Tournaments')}
                            lead={t(
                                'Anyone can run an event. The platform handles pairing, standings, ' +
                                    'tiebreaks and reporting, so an organiser can play in their own ' +
                                    'tournament.'
                            )}
                        >
                            <Bullets
                                items={[
                                    t(
                                        'Swiss, single elimination, double elimination or round robin, ' +
                                            'with an optional cut to a top bracket.'
                                    ),
                                    t(
                                        'Online, in person, or hybrid — where some tables play here and ' +
                                            'some play on paper, into one standing.'
                                    ),
                                    t(
                                        'Set restrictions, house requirements, SAS limits and deck ' +
                                            'registration, all enforced when a player signs up rather ' +
                                            'than argued about later.'
                                    ),
                                    t(
                                        'Scheduling for events that run over days: offer the times that ' +
                                            'suit you, in your own time zone, and let your opponent pick.'
                                    ),
                                    t(
                                        'Entry fees and prize pools, with payment tracked per player, ' +
                                            'and judges who can settle a disputed result.'
                                    ),
                                    t(
                                        'Email and push notifications when you are paired, when a round ' +
                                            'is about to end, and when someone proposes a time.'
                                    )
                                ]}
                            />
                        </Section>

                        <Section id='community' title={t('Community')}>
                            <P>
                                {t(
                                    'Add friends, join or start a club, and browse the member directory ' +
                                        'to find people near you. Clubs have their own pages, members and ' +
                                        'invitations, and can run their own events.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'Finished games can be replayed and shared with a link, which is the ' +
                                        'quickest way to settle "what should I have done there".'
                                )}
                            </P>
                        </Section>

                        <Section
                            id='membership'
                            title={t('Archon+')}
                            lead={t(
                                'The site is free and the game is not paywalled. Archon+ is an optional ' +
                                    'subscription that pays for the servers and unlocks deeper analysis.'
                            )}
                        >
                            <Definitions
                                items={[
                                    {
                                        term: t('Free'),
                                        description: t(
                                            'Unlimited play, rated games, leaderboards, tournaments, ' +
                                                'clubs and replays. Everything needed to play and compete.'
                                        )
                                    },
                                    {
                                        term: t('Supporter'),
                                        description: t(
                                            'Your rating history game by game, deeper personal and ' +
                                                'deck statistics, and a badge.'
                                        )
                                    },
                                    {
                                        term: t('Archon'),
                                        description: t(
                                            'Archon Intelligence and the Tournament Lab: matchup ' +
                                                'analysis, personal deck rankings, deck comparison, ' +
                                                'meta analytics, and AERC analysis — your record read ' +
                                                'by what decks are actually good at rather than by one ' +
                                                'score.'
                                        )
                                    },
                                    {
                                        term: t('Vault Master'),
                                        description: t(
                                            'Everything above, plus the Proving Grounds — a computer ' +
                                                'plays your decks against each other in the background ' +
                                                'and finds the hidden gems — the preview programme with ' +
                                                'every preview on the day it opens, nameplate and badge ' +
                                                'cosmetics other players can see, and spreadsheet ' +
                                                'exports for the events you run.'
                                        )
                                    }
                                ]}
                            />
                            <Callout>
                                {t(
                                    'Some tier features are still on the roadmap rather than built. The ' +
                                        'membership page marks those as planned rather than included, so ' +
                                        'you can see exactly what you would be paying for today.'
                                )}
                            </Callout>
                            <P>
                                <Link className='text-accent hover:underline' href='/membership'>
                                    {t('See what each tier includes')}
                                </Link>
                            </P>
                        </Section>

                        <Section
                            id='shuffle'
                            title={t('Why do my best cards always get discarded?')}
                        >
                            <P>
                                {t(
                                    'The most-asked question in online card games, and the honest answer ' +
                                        'is that the shuffle is fine and it genuinely does feel worse ' +
                                        'than shuffling by hand. A real shuffle at a table is imperfect, ' +
                                        'and those imperfections tend to break up clumps. A correct one ' +
                                        'does not.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'The shuffle is Fisher–Yates, which is the standard, unbiased ' +
                                        'algorithm, and its randomness is drawn from the operating ' +
                                        'system’s cryptographic generator rather than from an ordinary ' +
                                        'one — the same class of source used for security keys. That ' +
                                        'means no sequence of shuffles can be predicted from watching ' +
                                        'earlier ones, which matters now that events carry entry fees.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'It is checked, not assumed: a test measures the distribution over ' +
                                        'tens of thousands of shuffles and fails the build if any card ' +
                                        'starts favouring any position.'
                                )}
                            </P>
                            <Callout>
                                {t(
                                    'If a specific card does the wrong thing, that is a bug and worth ' +
                                        'reporting — use the Report a bug link. Card bugs are real; a ' +
                                        'biased shuffle is not the explanation.'
                                )}
                            </Callout>
                        </Section>

                        <Section id='colors' title={t('Username colours')}>
                            <P>
                                {t(
                                    'Some names are coloured, to credit the people behind the site:'
                                )}
                            </P>
                            <ul className='m-0 mb-3 list-disc space-y-1 pl-5 text-sm'>
                                <li>
                                    <span className='username role-admin'>{t('admin')}</span>
                                    {t(' — site administrator')}
                                </li>
                                <li>
                                    <span className='username role-contributor'>
                                        {t('contributor')}
                                    </span>
                                    {t(' — has made significant development contributions')}
                                </li>
                                <li>
                                    <span className='username role-supporter'>
                                        {t('supporter')}
                                    </span>
                                    {t(' — supports the platform financially')}
                                </li>
                                <li>
                                    <span className='username role-winner'>{t('winner')}</span>
                                    {t(' — current tournament winner')}
                                </li>
                                <li>
                                    <span className='username role-previouswinner'>
                                        {t('previous winner')}
                                    </span>
                                    {t(' — former tournament winner')}
                                </li>
                            </ul>
                        </Section>

                        <Section id='thanks' title={t('Lineage and thanks')}>
                            <P>
                                {t(
                                    'The gameplay engine is built on keyteki, the open source project ' +
                                        'behind The Crucible Online, which itself descends from the ' +
                                        'ringteki and jinteki family of card game platforms. Thank you to ' +
                                        'every maintainer and contributor of those projects — this site ' +
                                        'stands on years of their work.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'Deck power (SAS) ratings come from Decks of KeyForge. Some icons ' +
                                        'come from game-icons.net (Death Note by lorc, CC-BY 3.0) and ' +
                                        'from Flaticon (Time Limit by Minh Hoang, CC 3.0 BY).'
                                )}
                            </P>
                        </Section>

                        <Section id='ip' title={t('Intellectual property')}>
                            <P>
                                {t(
                                    'KeyForge, its artwork, card text and all related trademarks belong ' +
                                        'to Fantasy Flight Games and Ghost Galaxy. Archon Arena is an ' +
                                        'unofficial fan project. We claim no ownership of any of it, and ' +
                                        'neither company endorses, supports or is involved with this site.'
                                )}
                            </P>
                            <P>
                                {t(
                                    'It exists so people who love the game can play it more, and — we ' +
                                        'hope — buy more of it.'
                                )}
                            </P>
                        </Section>
                    </div>
                </Panel>
            </ProsePage>
        </SiteContentOverride>
    );
};

About.displayName = 'About';

export default About;
