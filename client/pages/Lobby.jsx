import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import { Navigate, useNavigate } from 'react-router-dom';

import AlertPanel from '../Components/Site/AlertPanel';
import BrandMark from '../assets/img/aa_mark.svg';

/**
 * ARCHON: chess.com-style landing page. News lives under Community > News;
 * lobby chat and promo banners were removed. Admin MOTD/banner notices
 * still surface here since this is where every player lands.
 */
const Lobby = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const bannerNotice = useSelector((state) => state.lobby.bannerNotice);
    const motd = useSelector((state) => state.lobby.motd);
    const users = useSelector((state) => state.lobby.users);
    const games = useSelector((state) => state.lobby.games);
    const user = useSelector((state) => state.account.user);

    const toAlertType = (type) => (type === 'error' ? 'danger' : type || 'info');

    // ARCHON: new accounts finish (or skip) the setup wizard before landing
    if (user && user.onboarded === false) {
        return <Navigate to='/welcome' replace />;
    }

    // ARCHON: these three used to be a brochure, and two of them were out of
    // date - Rankings and Tournaments both said "Coming soon" long after they
    // shipped, on the page every player lands on. They describe what is live
    // now, and each one goes to the thing it describes; all three routes are
    // public, so this works signed out too.
    const features = [
        {
            title: t('SAS-adjusted ratings'),
            body: t(
                'A chess-style Elo that accounts for deck power: upset a stronger deck and your rating knows it.'
            ),
            path: '/stats/me'
        },
        {
            title: t('Rankings'),
            body: t(
                'Climb worldwide, regional, country and state leaderboards - Archon, Sealed and Alliance each ranked on their own.'
            ),
            path: '/community/leaderboards'
        },
        {
            title: t('Tournaments'),
            body: t(
                'Swiss, elimination and round-robin events with automatic pairings - online, in person, or played out over days.'
            ),
            path: '/tournaments'
        }
    ];

    return (
        <div className='mx-auto w-full max-w-5xl'>
            {motd?.message && (
                <AlertPanel className='mb-3 text-sm' type={toAlertType(motd.motdType)}>
                    {motd.message}
                </AlertPanel>
            )}
            {bannerNotice && (
                <AlertPanel className='mb-3 text-sm' type='warning'>
                    {bannerNotice}
                </AlertPanel>
            )}

            <div className='flex flex-col items-center gap-10 py-10 lg:flex-row lg:gap-16 lg:py-16'>
                <div className='flex flex-1 flex-col items-center gap-6 text-center'>
                    <img src={BrandMark} alt='' className='h-28 w-28 lg:h-36 lg:w-36' />
                    <h1 className='max-w-xl text-3xl font-extrabold leading-tight text-foreground lg:text-4xl'>
                        {t('Play KeyForge Online on Archon Arena')}
                    </h1>
                    <p className='max-w-lg text-base text-muted'>
                        {t(
                            'Competitive KeyForge in your browser: rated games, deck SAS, and tournaments. Every deck is unique - so is every ranking.'
                        )}
                    </p>
                    <div className='flex w-full max-w-xs flex-col gap-3'>
                        {user ? (
                            <>
                                <HeroButton
                                    variant='primary'
                                    className='w-full !py-5 !text-lg'
                                    onPress={() => navigate('/play')}
                                >
                                    {t('Play Online')}
                                </HeroButton>
                                <HeroButton
                                    variant='tertiary'
                                    className='w-full'
                                    onPress={() => navigate('/decks')}
                                >
                                    {t('My Decks')}
                                </HeroButton>
                            </>
                        ) : (
                            <>
                                <HeroButton
                                    variant='primary'
                                    className='w-full !py-5 !text-lg'
                                    onPress={() => navigate('/register')}
                                >
                                    {t('Get Started')}
                                </HeroButton>
                                <HeroButton
                                    variant='tertiary'
                                    className='w-full'
                                    onPress={() => navigate('/play')}
                                >
                                    {t('Watch the Lobby')}
                                </HeroButton>
                            </>
                        )}
                    </div>
                    <div className='text-sm text-muted'>
                        {t('{{users}} players online - {{games}} games', {
                            users: users?.length || 0,
                            games: games?.length || 0
                        })}
                    </div>
                    {/* ARCHON: mobile apps. These land on a Coming Soon page
                        until the store listings are live, so the buttons say so
                        rather than looking like store badges that download
                        something. */}
                    <div className='flex flex-wrap items-center justify-center gap-2'>
                        <button
                            type='button'
                            onClick={() => navigate('/mobile/ios')}
                            className='inline-flex items-center gap-2 rounded-md border border-border/70 bg-surface-secondary/60 px-3 py-1.5 text-sm text-foreground transition hover:border-amber-300/60'
                        >
                            <svg
                                viewBox='0 0 24 24'
                                className='h-4 w-4'
                                fill='currentColor'
                                aria-hidden='true'
                            >
                                <path d='M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.53 4.08zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z' />
                            </svg>
                            {t('iPhone App')}
                            <span className='rounded bg-surface-secondary px-1 text-[0.625rem] font-semibold uppercase text-muted'>
                                {t('soon')}
                            </span>
                        </button>
                        <button
                            type='button'
                            onClick={() => navigate('/mobile/android')}
                            className='inline-flex items-center gap-2 rounded-md border border-border/70 bg-surface-secondary/60 px-3 py-1.5 text-sm text-foreground transition hover:border-amber-300/60'
                        >
                            <svg
                                viewBox='0 0 24 24'
                                className='h-4 w-4'
                                fill='currentColor'
                                aria-hidden='true'
                            >
                                <path d='M17.6 9.48l1.84-3.18c.16-.31.04-.7-.26-.85-.29-.15-.65-.06-.83.22l-1.88 3.24a11.46 11.46 0 0 0-8.94 0L5.65 5.67c-.19-.29-.55-.37-.83-.22-.3.16-.42.54-.26.85L6.4 9.48A10.8 10.8 0 0 0 1 18h22a10.8 10.8 0 0 0-5.4-8.52zM7 15.25a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5zm10 0a1.25 1.25 0 1 1 0-2.5 1.25 1.25 0 0 1 0 2.5z' />
                            </svg>
                            {t('Android App')}
                            <span className='rounded bg-surface-secondary px-1 text-[0.625rem] font-semibold uppercase text-muted'>
                                {t('soon')}
                            </span>
                        </button>
                    </div>
                </div>
            </div>

            {/* ARCHON: standing on the shoulders of two community projects -
                say so where every player lands, not just on the About page. */}
            <div className='mb-6 rounded-lg border border-border/50 bg-surface-secondary/40 px-5 py-4 text-center'>
                <div className='mb-1 text-xs font-semibold uppercase tracking-wide text-amber-300/80'>
                    {t('Special thanks')}
                </div>
                <p className='mx-auto max-w-2xl text-sm text-muted'>
                    {t(
                        'Archon Arena exists because of two projects that have carried the KeyForge community for years: '
                    )}
                    <a
                        href='https://thecrucible.online'
                        target='_blank'
                        rel='noopener noreferrer'
                        className='font-semibold text-foreground underline decoration-amber-400/60 underline-offset-2 hover:text-amber-300'
                    >
                        {t('The Crucible Online')}
                    </a>
                    {t(', whose open-source gameplay engine powers every game played here, and ')}
                    <a
                        href='https://decksofkeyforge.com'
                        target='_blank'
                        rel='noopener noreferrer'
                        className='font-semibold text-foreground underline decoration-amber-400/60 underline-offset-2 hover:text-amber-300'
                    >
                        {t('Decks of KeyForge')}
                    </a>
                    {t(
                        ', whose SAS ratings taught us all how to talk about deck power. Thank you for keeping the Crucible burning.'
                    )}
                </p>
            </div>

            <div className='grid gap-4 pb-12 md:grid-cols-3'>
                {features.map((feature) => (
                    <button
                        key={feature.title}
                        type='button'
                        onClick={() => navigate(feature.path)}
                        className='rounded-lg border border-border/70 bg-surface-secondary/60 p-5 text-left transition hover:border-amber-300/60'
                    >
                        <div className='mb-2 font-semibold text-amber-300'>{feature.title}</div>
                        <div className='text-sm text-muted'>{feature.body}</div>
                    </button>
                ))}
            </div>
        </div>
    );
};

Lobby.displayName = 'Lobby';

export default Lobby;
