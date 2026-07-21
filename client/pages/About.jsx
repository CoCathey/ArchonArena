import React from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';

const About = () => {
    const { t } = useTranslation();

    return (
        <div className='min-h-full w-full'>
            <Panel title={t('About Archon Arena - Help and information')}>
                <Button
                    className='mb-2 ml-auto block w-fit'
                    variant='primary'
                    onPress={() =>
                        window.open(
                            'https://github.com/CoCathey/ArchonArena/issues',
                            '_blank',
                            'noopener,noreferrer'
                        )
                    }
                >
                    <Trans>Report Problems</Trans>
                </Button>
                <Trans i18nKey='about.whatisthis'>
                    <h3>What is Archon Arena?</h3>

                    <p>
                        Archon Arena is a competitive platform for playing KeyForge, the Unique Deck
                        Game from Ghost Galaxy, in your browser. Beyond casual games it adds the
                        things a competitive scene needs: an Elo-style rating that accounts for deck
                        power (SAS) and margin of victory, worldwide/regional/country/state
                        leaderboards, tournaments for online and in-person play, clubs, and friends.
                    </p>
                </Trans>
                <Trans i18nKey='about.gettingstarted'>
                    <h3>Getting started</h3>
                    <p>
                        Create an account, then add your decks on the{' '}
                        <Link href='/decks'>Decks page</Link> — import your whole collection at once
                        with your Decks of KeyForge username, or paste a single Master Vault link.
                        Then jump into a game from <Link href='/play'>Play Online</Link>. The{' '}
                        <Link href='/how-to-play'>How To Play guide</Link> covers the interface in
                        detail. Rated games move your rating; you can watch yourself climb on the{' '}
                        <Link href='/leaderboards'>Leaderboards</Link>.
                    </p>
                </Trans>
                <Trans i18nKey='about.ratings'>
                    <h3>How do ratings work?</h3>
                    <p>
                        Ratings use a chess-style Elo system with two KeyForge twists: your
                        deck&apos;s SAS score adjusts the expected result (upsetting a stronger deck
                        pays more than stomping with one), and the key differential of the final
                        score scales the exchange (a 3-0 moves more points than a 3-2). New players
                        are provisional for their first games while the system finds their level.
                    </p>
                </Trans>
                <Trans i18nKey='about.whydiscarded'>
                    <h3>Why do my best cards always get discarded?</h3>
                    <p>
                        The most-asked question in online card gaming! The shuffle uses a
                        Fisher-Yates algorithm - true randomness - which can feel harsher than the
                        imperfect human shuffling you are used to at a table. The randomness has
                        been verified over millions of test draws. If you believe you have found a
                        genuine card bug, please report it on GitHub.
                    </p>
                </Trans>
                <Trans i18nKey='about.thanks'>
                    <h3>Lineage and thanks</h3>
                    <p>
                        Archon Arena&apos;s gameplay engine is built on the keyteki open source
                        project - the engine behind The Crucible Online - which itself descends from
                        the ringteki and jinteki family of card game platforms. Our sincere thanks
                        to all of their maintainers and contributors: this platform stands on years
                        of their work.
                    </p>
                </Trans>
                <Trans i18nKey='about.colors'>
                    <h3>Meaning of Username Colors</h3>
                    <p>
                        Some usernames have different colors and the intent is to acknowledge the
                        supporters of the platform:
                    </p>
                    <ul className='list-disc pl-6'>
                        <li>
                            <span className='username role-admin'>admin</span> - site administrator
                        </li>
                        <li>
                            <span className='username role-contributor'>contributor</span> - people
                            who have made significant development contributions to the site
                        </li>
                        <li>
                            <span className='username role-supporter'>supporter</span> - financial
                            supporters of the platform
                        </li>
                        <li>
                            <span className='username role-winner'>winner</span> - current
                            tournament winner
                        </li>
                        <li>
                            <span className='username role-previouswinner'>previous winner</span> -
                            former tournament winner
                        </li>
                    </ul>
                </Trans>
                <Trans i18nKey='about.addicons'>
                    <h3>Additional Icons</h3>
                    <p>
                        Some icons were included from game-icons.net: Death Note by
                        <a
                            target='_blank'
                            href='http://lorcblog.blogspot.com/'
                            rel='noopener noreferrer'
                        >
                            lorc
                        </a>
                        <a
                            target='_blank'
                            href='https://creativecommons.org/licenses/by/3.0/'
                            rel='noopener noreferrer'
                        >
                            CC-BY 3.0
                        </a>
                    </p>
                    <p>
                        Time Limit icon made by
                        <a href='https://www.flaticon.com/authors/minh-hoang' title='Minh Hoang'>
                            Minh Hoang
                        </a>
                        from
                        <a href='https://www.flaticon.com/' title='Flaticon'>
                            www.flaticon.com
                        </a>
                        is licensed by
                        <a
                            href='http://creativecommons.org/licenses/by/3.0/'
                            title='Creative Commons BY 3.0'
                            target='_blank'
                            rel='noopener noreferrer'
                        >
                            CC 3.0 BY
                        </a>
                    </p>
                </Trans>
                <Trans i18nKey='about.addnotes'>
                    <h3>Intellectual property</h3>
                    <p>
                        KeyForge, its artwork, card text, and all related trademarks are the
                        property of Fantasy Flight Games and Ghost Galaxy. Archon Arena is an
                        unofficial fan project: we claim no ownership of any of it, and neither
                        Fantasy Flight Games nor Ghost Galaxy endorses, supports, or is involved
                        with this site in any way. Archon Arena exists so passionate fans can play
                        the game they love and, we hope, buy more of it.
                    </p>
                </Trans>
            </Panel>
        </div>
    );
};

About.displayName = 'About';

export default About;
