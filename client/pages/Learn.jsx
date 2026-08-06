import React, { useState } from 'react';
import { Button } from '@heroui/react';

import Panel from '../Components/Site/Panel';
import Link from '../Components/Navigation/Link';
import Tutorial from '../Components/Learn/Tutorial';
import { clearSavedStep, readSavedStep, totalSteps } from '../Components/Learn/tutorialProgress';

/**
 * ARCHON (N11): the Learn hub.
 *
 * The centrepiece is the interactive Learn-to-Play tutorial: the demo game from
 * Ghost Galaxy's two-player starter set, replayed step by step on a board laid
 * out like the real one. Everything else here is a pointer to material that
 * already exists rather than a second, drifting copy of the rules.
 */

const RESOURCES = [
    {
        title: 'Learn to Play booklet (PDF)',
        description:
            'Ghost Galaxy’s official booklet for the two-player starter set — the same walkthrough this tutorial follows.',
        href: 'https://keyforging.com/wp-content/uploads/2023/04/KF-Learn-to-Play_Web.pdf',
        external: true
    },
    {
        title: 'Two-player starter set',
        description:
            'The physical box this tutorial is built around: two learning decks, tokens, and two sealed decks.',
        href: 'https://keyforging.com/products/keyforge-player-starter-set-2/',
        external: true
    },
    {
        title: 'Starter set demo game (video)',
        description:
            'Ghost Galaxy’s video walkthrough of the same game, if you would rather watch than click.',
        href: 'https://www.youtube.com/watch?v=Vq3NvuY-wxU',
        external: true
    },
    {
        title: 'How To Play on Archon Arena',
        description:
            'Platform reference: importing decks, manual mode, chat commands, and how conceding works.',
        href: '/how-to-play',
        external: false
    }
];

const Learn = () => {
    const [started, setStarted] = useState(false);
    const [savedStep, setSavedStep] = useState(readSavedStep);

    if (started) {
        return (
            <div className='min-h-full w-full'>
                <Tutorial />
                <div className='mt-3'>
                    <Button
                        variant='tertiary'
                        onPress={() => {
                            setSavedStep(readSavedStep());
                            setStarted(false);
                        }}
                    >
                        Back to Learn
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className='mx-auto flex min-h-full w-full max-w-4xl flex-col gap-3'>
            <Panel title='Learn'>
                <div className='flex flex-col gap-3 py-2'>
                    <h2 className='text-xl font-semibold text-foreground'>
                        Learn to Play KeyForge
                    </h2>
                    <p className='max-w-2xl text-sm leading-relaxed text-muted'>
                        A complete game, played out one click at a time with the two learning decks
                        from the KeyForge two-player starter set. Every rule is explained the first
                        time it matters, the cards being talked about are spotlit on the board, and
                        the board is laid out exactly like a real game here — so by the end you know
                        both how to play KeyForge and how to play it on Archon Arena.
                    </p>
                    <ul className='max-w-2xl list-inside list-disc text-sm text-muted'>
                        <li>No account, no deck and no rules knowledge needed.</li>
                        <li>Around 15 minutes, and it remembers where you stopped.</li>
                        <li>Step backwards any time — nothing is hidden and nothing is random.</li>
                    </ul>
                    <div className='flex flex-wrap gap-2 pt-1'>
                        <Button variant='primary' onPress={() => setStarted(true)}>
                            {savedStep > 0
                                ? `Resume — step ${savedStep + 1} of ${totalSteps()}`
                                : 'Start the tutorial'}
                        </Button>
                        {savedStep > 0 && (
                            <Button
                                variant='tertiary'
                                onPress={() => {
                                    clearSavedStep();
                                    setSavedStep(0);
                                    setStarted(true);
                                }}
                            >
                                Start from the beginning
                            </Button>
                        )}
                    </div>
                </div>
            </Panel>

            <Panel title='What the tutorial covers'>
                <div className='grid gap-x-6 gap-y-1 py-2 text-sm text-muted sm:grid-cols-2'>
                    <div>Houses and the active house</div>
                    <div>Æmber, key cost and forging</div>
                    <div>The five steps of a turn</div>
                    <div>Playing, using and discarding cards</div>
                    <div>Creatures, artifacts, actions and upgrades</div>
                    <div>Ready, exhausted and the battleline</div>
                    <div>Reaping, fighting, power, armor and damage</div>
                    <div>Capture, steal, ward, stun and taunt</div>
                    <div>Deploy, splash-attack and the flanks</div>
                    <div>Archives, bonus icons and reshuffling</div>
                </div>
            </Panel>

            <Panel title='More to read and watch'>
                <div className='flex flex-col gap-2 py-2'>
                    {RESOURCES.map((resource) => (
                        <div
                            key={resource.href}
                            className='rounded-md border border-border/60 bg-surface-secondary/25 p-3'
                        >
                            {resource.external ? (
                                <a
                                    href={resource.href}
                                    target='_blank'
                                    rel='noopener noreferrer'
                                    className='text-sm font-semibold'
                                >
                                    {resource.title}
                                </a>
                            ) : (
                                <Link href={resource.href} className='text-sm font-semibold'>
                                    {resource.title}
                                </Link>
                            )}
                            <p className='mt-0.5 text-sm text-muted'>{resource.description}</p>
                        </div>
                    ))}
                </div>
            </Panel>
        </div>
    );
};

Learn.displayName = 'Learn';

export default Learn;
