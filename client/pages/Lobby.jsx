import React from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

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

    const features = [
        {
            title: t('SAS-adjusted ratings'),
            body: t(
                'A chess-style Elo that accounts for deck power: upset a stronger deck and your rating knows it.'
            )
        },
        {
            title: t('Rankings'),
            body: t('Climb worldwide, regional, country, and state leaderboards. Coming soon.')
        },
        {
            title: t('Tournaments'),
            body: t('Online and in-person events with automatic pairings. Coming soon.')
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
                </div>
            </div>

            <div className='grid gap-4 pb-12 md:grid-cols-3'>
                {features.map((feature) => (
                    <div
                        key={feature.title}
                        className='rounded-lg border border-border/70 bg-surface-secondary/60 p-5'
                    >
                        <div className='mb-2 font-semibold text-amber-300'>{feature.title}</div>
                        <div className='text-sm text-muted'>{feature.body}</div>
                    </div>
                ))}
            </div>
        </div>
    );
};

Lobby.displayName = 'Lobby';

export default Lobby;
