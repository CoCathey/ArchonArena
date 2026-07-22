import React, { useState } from 'react';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton, Input, toast } from '@heroui/react';
import { useParams } from 'react-router-dom';

import Panel from '../Components/Site/Panel';
import SelectDeckModal from '../Components/Games/SelectDeckModal';
import RoundTimer from '../Components/Tournaments/RoundTimer';
import BracketView from '../Components/Tournaments/BracketView';
import MyMatchPanel from '../Components/Tournaments/MyMatchPanel';
import RoundsPanel from '../Components/Tournaments/RoundsPanel';
import StandingsPanel from '../Components/Tournaments/StandingsPanel';
import PlayersPanel from '../Components/Tournaments/PlayersPanel';
import printPairings from '../Components/Tournaments/printPairings';
import { useGetEventDetailQuery, useTournamentActionMutation } from '../redux/api';

const formatNames = {
    swiss: 'Swiss',
    'single-elim': 'Single Elimination',
    'double-elim': 'Double Elimination',
    'round-robin': 'Round Robin'
};

const Badge = ({ children, tone = 'default', title }) => (
    <span
        title={title}
        className={`rounded px-1.5 py-0.5 text-xs uppercase tracking-wide ${
            tone === 'amber'
                ? 'bg-amber-400/15 text-amber-300'
                : tone === 'green'
                ? 'bg-emerald-500/15 text-emerald-400'
                : 'bg-surface-tertiary/70 text-muted'
        }`}
    >
        {children}
    </span>
);
Badge.displayName = 'TournamentBadge';

/**
 * ARCHON: tournament page (Phase 7): registration with join codes and
 * deck registration, check-in, per-round pairings with series scores
 * and judge tools, bracket visualization, live standings, round timer,
 * and one-click access to auto-created online games.
 */
const TournamentDetail = () => {
    const { t } = useTranslation();
    const { id } = useParams();
    const user = useSelector((state) => state.account.user);
    const { data, refetch } = useGetEventDetailQuery(id, { pollingInterval: 15000 });
    const [runAction, actionState] = useTournamentActionMutation();

    const [joinCode, setJoinCode] = useState('');
    const [showJoinCode, setShowJoinCode] = useState(false);
    const [showDeckPicker, setShowDeckPicker] = useState(false);
    const [triadPicks, setTriadPicks] = useState(null); // in-progress 3-deck pool
    const [editingAnnouncement, setEditingAnnouncement] = useState(null);
    const [staffName, setStaffName] = useState('');

    if (!data?.success) {
        return (
            <div className='mx-auto w-full max-w-4xl'>
                <Panel title={t('Tournament')}>
                    <div className='text-sm text-muted'>
                        {data ? t('No such tournament') : t('Loading...')}
                    </div>
                </Panel>
            </div>
        );
    }

    const { tournament, players, matches, standings, staff } = data;

    const act = async (action, body, successMessage) => {
        try {
            const result = await runAction({ id, action, body }).unwrap();

            if (result.success) {
                if (successMessage) {
                    toast.success(successMessage);
                }
                refetch();

                return true;
            }

            toast.danger(result.message || t('Action failed'));
        } catch {
            toast.danger(t('Action failed'));
        }

        return false;
    };

    const register = async () => {
        if (tournament.visibility === 'private' && !tournament.canManage && !showJoinCode) {
            setShowJoinCode(true);

            return;
        }

        const ok = await act(
            'register',
            tournament.visibility === 'private' ? { joinCode } : {},
            t('You are registered')
        );

        if (ok) {
            setShowJoinCode(false);
            setJoinCode('');

            if (tournament.requireDeckRegistration) {
                setShowDeckPicker(true);
            }
        }
    };

    const onDeckSelected = async (deck) => {
        if (tournament.triad) {
            const picks = [...(triadPicks || []), deck];

            if (picks.some((entry, index) => picks.findIndex((d) => d.id === entry.id) !== index)) {
                toast.danger(t('Pick three different decks'));

                return;
            }

            if (picks.length < 3) {
                setTriadPicks(picks);
                toast.success(
                    t('Deck {{count}} of 3 chosen - pick the next one', { count: picks.length })
                );

                return;
            }

            setShowDeckPicker(false);
            setTriadPicks(null);
            await act(
                'register-triad-decks',
                { deckIds: picks.map((entry) => entry.id) },
                t('Triad pool registered')
            );

            return;
        }

        setShowDeckPicker(false);
        await act('register-deck', { deckId: deck.id }, t('Deck registered'));
    };

    const startTournament = () => {
        if (
            tournament.checkInOpen &&
            players.some((player) => !player.waitlisted && !player.dropped && !player.checkedIn)
        ) {
            const dropNoShows = window.confirm(
                t('Remove players who have not checked in? Cancel keeps everyone in the event.')
            );

            act('start', { dropNoShows }, t('Tournament started'));
        } else {
            act('start', {}, t('Tournament started'));
        }
    };

    const myPlayer = user ? players.find((player) => player.userId === user.id) : null;
    const swissRoundsDone =
        tournament.format === 'swiss' &&
        tournament.stage === 'main' &&
        tournament.roundCount &&
        tournament.currentRound >= tournament.roundCount;

    const statusLabel =
        tournament.status === 'registration'
            ? tournament.checkInOpen
                ? t('Check-in Open')
                : t('Open Registration')
            : tournament.status === 'active'
            ? tournament.stage === 'playoff'
                ? t('Playoff - Round {{round}} of {{total}}', {
                      round: tournament.currentRound,
                      total: tournament.roundCount || '?'
                  })
                : t('Round {{round}} of {{total}}', {
                      round: tournament.currentRound,
                      total: tournament.roundCount || '?'
                  })
            : t(tournament.status);

    const hasBracket = matches.some((match) => match.bracket);

    const startTimeLabel = tournament.startTime
        ? new Date(tournament.startTime).toLocaleString()
        : null;

    return (
        <div className='mx-auto w-full max-w-6xl space-y-4'>
            <Panel title={tournament.name}>
                <div className='flex flex-wrap items-center gap-x-3 gap-y-2 text-sm'>
                    <Badge tone='amber'>
                        {t(formatNames[tournament.format] || tournament.format)}
                        {tournament.cutTo ? ` → ${t('Top {{n}}', { n: tournament.cutTo })}` : ''}
                    </Badge>
                    <Badge>{tournament.gameFormat}</Badge>
                    <Badge>{tournament.mode === 'irl' ? t('In Person') : t('Online')}</Badge>
                    {tournament.bestOf > 1 && (
                        <Badge>{t('Bo{{n}}', { n: tournament.bestOf })}</Badge>
                    )}
                    {tournament.playoffBestOf > 1 && tournament.cutTo && (
                        <Badge>{t('Playoff Bo{{n}}', { n: tournament.playoffBestOf })}</Badge>
                    )}
                    {tournament.rated && (
                        <Badge tone='amber' title={t('Games move Amber ratings')}>
                            {t('Rated')}
                        </Badge>
                    )}
                    {tournament.visibility === 'private' && <Badge>{t('Private')}</Badge>}
                    {(tournament.sasMin != null || tournament.sasMax != null) && (
                        <Badge title={t('Registered decks must fit this SAS band')}>{`${t('SAS')} ${
                            tournament.sasMin ?? 0
                        }-${tournament.sasMax ?? '∞'}`}</Badge>
                    )}
                    {tournament.triad && (
                        <Badge
                            tone='amber'
                            title={t('Three-deck pools; opponents ban one each match')}
                        >
                            {t('Triad')}
                        </Badge>
                    )}
                    {tournament.deckSwapPolicy === 'between-rounds' && !tournament.triad && (
                        <Badge title={t('Players may bring a different deck to each round')}>
                            {t('Deck Swaps')}
                        </Badge>
                    )}
                    {tournament.sasChainHandicap && (
                        <Badge title={t('The stronger deck starts each game with chains')}>
                            {t('SAS Handicap')}
                        </Badge>
                    )}
                    {tournament.chainsPerMatchWin > 0 && (
                        <Badge
                            title={t('Each match win adds {{n}} chains for the rest of the event', {
                                n: tournament.chainsPerMatchWin
                            })}
                        >
                            {t('Chainbound +{{n}}', { n: tournament.chainsPerMatchWin })}
                        </Badge>
                    )}
                    {tournament.allowedSets && tournament.allowedSets.length > 0 && (
                        <Badge title={t('Only decks from these sets may register')}>
                            {t('{{n}} sets legal', { n: tournament.allowedSets.length })}
                        </Badge>
                    )}
                    {tournament.bannedHouses && tournament.bannedHouses.length > 0 && (
                        <Badge title={tournament.bannedHouses.join(', ')}>
                            {t('No {{houses}}', {
                                houses: tournament.bannedHouses.join('/')
                            })}
                        </Badge>
                    )}
                    {tournament.requiredHouses && tournament.requiredHouses.length > 0 && (
                        <Badge title={t('Decks must contain these houses')}>
                            {t('Must have {{houses}}', {
                                houses: tournament.requiredHouses.join('/')
                            })}
                        </Badge>
                    )}
                    <span className='text-muted'>{statusLabel}</span>
                    {tournament.status === 'active' && (
                        <RoundTimer
                            roundStartedAt={tournament.roundStartedAt}
                            roundTimerMinutes={tournament.roundTimerMinutes}
                        />
                    )}
                    {startTimeLabel && tournament.status === 'registration' && (
                        <span className='text-muted'>
                            {t('Starts {{time}}', { time: startTimeLabel })}
                        </span>
                    )}
                    <span className='text-muted'>
                        {t('Organized by {{organizer}}', { organizer: tournament.organizer })}
                        {staff.length > 0 &&
                            ` - ${t('judges')}: ${staff
                                .map((member) => member.username)
                                .join(', ')}`}
                    </span>
                </div>

                <div className='mt-2 flex flex-wrap items-center gap-2'>
                    {user &&
                        tournament.status === 'registration' &&
                        (tournament.isRegistered || tournament.isWaitlisted ? (
                            <>
                                {tournament.isWaitlisted && (
                                    <Badge>{t('You are on the waitlist')}</Badge>
                                )}
                                {tournament.checkInOpen &&
                                    !tournament.isWaitlisted &&
                                    (tournament.isCheckedIn ? (
                                        <Badge tone='green'>{t('Checked in')}</Badge>
                                    ) : (
                                        <HeroButton
                                            size='sm'
                                            variant='primary'
                                            onPress={() =>
                                                act('check-in', {}, t('You are checked in'))
                                            }
                                        >
                                            {t('Check In')}
                                        </HeroButton>
                                    ))}
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => {
                                        setTriadPicks(tournament.triad ? [] : null);
                                        setShowDeckPicker(true);
                                    }}
                                >
                                    {tournament.triad
                                        ? myPlayer?.hasDeck
                                            ? t('Change Triad Pool')
                                            : t('Register Triad Pool (3 decks)')
                                        : myPlayer?.hasDeck
                                        ? t('Change Deck ({{deck}})', {
                                              deck: myPlayer.deckName || t('registered')
                                          })
                                        : t('Register Deck')}
                                </HeroButton>
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => act('drop', {}, t('You are unregistered'))}
                                >
                                    {t('Unregister')}
                                </HeroButton>
                            </>
                        ) : (
                            <>
                                <HeroButton size='sm' variant='primary' onPress={register}>
                                    {t('Register')}
                                </HeroButton>
                                {showJoinCode && (
                                    <span className='flex items-center gap-1'>
                                        <Input
                                            className='w-36'
                                            value={joinCode}
                                            placeholder={t('Join code')}
                                            onChange={(event) => setJoinCode(event.target.value)}
                                        />
                                        <HeroButton size='sm' variant='primary' onPress={register}>
                                            {t('Join')}
                                        </HeroButton>
                                    </span>
                                )}
                            </>
                        ))}
                    {user && tournament.status === 'active' && tournament.isRegistered && (
                        <HeroButton
                            size='sm'
                            variant='tertiary'
                            onPress={() => {
                                if (window.confirm(t('Drop from the event?'))) {
                                    act('drop', {}, t('You dropped from the event'));
                                }
                            }}
                        >
                            {t('Drop')}
                        </HeroButton>
                    )}

                    {tournament.canManage && (
                        <span className='ml-auto flex flex-wrap gap-2'>
                            {tournament.status === 'registration' && (
                                <>
                                    {!tournament.checkInOpen && (
                                        <HeroButton
                                            size='sm'
                                            variant='tertiary'
                                            onPress={() =>
                                                act('open-check-in', {}, t('Check-in is open'))
                                            }
                                        >
                                            {t('Open Check-in')}
                                        </HeroButton>
                                    )}
                                    <HeroButton
                                        size='sm'
                                        variant='primary'
                                        isPending={actionState.isLoading}
                                        onPress={startTournament}
                                    >
                                        {t('Start Tournament')}
                                    </HeroButton>
                                </>
                            )}
                            {tournament.status === 'active' && (
                                <>
                                    {swissRoundsDone && tournament.cutTo ? (
                                        <HeroButton
                                            size='sm'
                                            variant='primary'
                                            isPending={actionState.isLoading}
                                            onPress={() =>
                                                act('cut', {}, t('Playoff bracket created'))
                                            }
                                        >
                                            {t('Cut to Top {{n}}', { n: tournament.cutTo })}
                                        </HeroButton>
                                    ) : (
                                        <HeroButton
                                            size='sm'
                                            variant='primary'
                                            isPending={actionState.isLoading}
                                            onPress={() =>
                                                act('next-round', {}, t('Next round paired'))
                                            }
                                        >
                                            {t('Pair Next Round')}
                                        </HeroButton>
                                    )}
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        onPress={() => act('finish', {}, t('Tournament complete'))}
                                    >
                                        {t('Finish')}
                                    </HeroButton>
                                </>
                            )}
                            {['registration', 'active'].includes(tournament.status) && (
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    onPress={() => {
                                        if (window.confirm(t('Cancel this tournament?'))) {
                                            act('cancel', {}, t('Tournament cancelled'));
                                        }
                                    }}
                                >
                                    {t('Cancel Event')}
                                </HeroButton>
                            )}
                        </span>
                    )}
                </div>

                {tournament.announcement && editingAnnouncement === null && (
                    <div className='mt-3 rounded-md border border-amber-400/40 bg-amber-400/10 px-3 py-2 text-sm text-amber-200'>
                        <span className='mr-2 font-bold uppercase tracking-wide text-amber-300'>
                            {t('Announcement')}
                        </span>
                        <span className='whitespace-pre-wrap'>{tournament.announcement}</span>
                    </div>
                )}

                {tournament.canManage && (
                    <div className='mt-3 space-y-2 border-t border-border/50 pt-2'>
                        {editingAnnouncement === null ? (
                            <div className='flex flex-wrap gap-2 text-xs'>
                                <button
                                    type='button'
                                    className='text-muted underline-offset-2 hover:text-foreground hover:underline'
                                    onClick={() =>
                                        setEditingAnnouncement(tournament.announcement || '')
                                    }
                                >
                                    {tournament.announcement
                                        ? t('Edit announcement')
                                        : t('Post announcement')}
                                </button>
                                {tournament.visibility === 'private' && tournament.joinCode && (
                                    <span className='text-muted'>
                                        {t('Join code')}:{' '}
                                        <span className='select-all font-mono text-foreground'>
                                            {tournament.joinCode}
                                        </span>
                                    </span>
                                )}
                            </div>
                        ) : (
                            <div className='space-y-1'>
                                <textarea
                                    className='min-h-16 w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:outline-none'
                                    value={editingAnnouncement}
                                    maxLength={2000}
                                    onChange={(event) => setEditingAnnouncement(event.target.value)}
                                />
                                <div className='flex gap-2'>
                                    <HeroButton
                                        size='sm'
                                        variant='primary'
                                        onPress={async () => {
                                            const ok = await act(
                                                'update',
                                                { announcement: editingAnnouncement },
                                                t('Announcement updated')
                                            );

                                            if (ok) {
                                                setEditingAnnouncement(null);
                                            }
                                        }}
                                    >
                                        {t('Save')}
                                    </HeroButton>
                                    <HeroButton
                                        size='sm'
                                        variant='tertiary'
                                        onPress={() => setEditingAnnouncement(null)}
                                    >
                                        {t('Cancel')}
                                    </HeroButton>
                                </div>
                            </div>
                        )}
                        {tournament.isOrganizer && (
                            <div className='flex flex-wrap items-center gap-2 text-xs'>
                                <span className='text-muted'>{t('Judges')}:</span>
                                {staff.map((member) => (
                                    <span
                                        key={member.userId}
                                        className='inline-flex items-center gap-1 rounded bg-surface-tertiary/70 px-1.5 py-0.5 text-foreground'
                                    >
                                        {member.username}
                                        <button
                                            type='button'
                                            className='text-muted hover:text-red-400'
                                            onClick={() =>
                                                act(
                                                    'staff/remove',
                                                    { userId: member.userId },
                                                    t('Judge removed')
                                                )
                                            }
                                        >
                                            ×
                                        </button>
                                    </span>
                                ))}
                                <Input
                                    className='w-40'
                                    value={staffName}
                                    placeholder={t('Add judge by username')}
                                    onChange={(event) => setStaffName(event.target.value)}
                                />
                                <HeroButton
                                    size='sm'
                                    variant='tertiary'
                                    className='!h-7'
                                    onPress={async () => {
                                        if (
                                            staffName.trim() &&
                                            (await act(
                                                'staff/add',
                                                { username: staffName.trim() },
                                                t('Judge added')
                                            ))
                                        ) {
                                            setStaffName('');
                                        }
                                    }}
                                >
                                    {t('Add')}
                                </HeroButton>
                            </div>
                        )}
                    </div>
                )}

                {tournament.description && (
                    <p className='mt-2 whitespace-pre-wrap text-sm text-muted'>
                        {tournament.description}
                    </p>
                )}
            </Panel>

            <MyMatchPanel
                tournament={tournament}
                matches={matches}
                players={players}
                user={user}
                act={act}
            />

            {hasBracket && (
                <Panel title={tournament.stage === 'playoff' ? t('Playoff Bracket') : t('Bracket')}>
                    <BracketView matches={matches} currentUsername={user?.username} />
                </Panel>
            )}

            <div className='grid gap-4 lg:grid-cols-2'>
                {tournament.status === 'registration' ? (
                    <PlayersPanel tournament={tournament} players={players} act={act} />
                ) : (
                    <StandingsPanel
                        tournament={tournament}
                        standings={standings}
                        players={players}
                        currentUsername={user?.username}
                    />
                )}

                <RoundsPanel
                    tournament={tournament}
                    matches={matches}
                    user={user}
                    act={act}
                    actionPending={actionState.isLoading}
                    onPrint={(round) =>
                        printPairings(
                            tournament,
                            matches.filter((match) => match.round === round),
                            round,
                            standings
                        )
                    }
                />
            </div>

            {showDeckPicker && (
                <SelectDeckModal
                    onClose={() => setShowDeckPicker(false)}
                    onDeckSelected={onDeckSelected}
                />
            )}
        </div>
    );
};

TournamentDetail.displayName = 'TournamentDetail';

export default TournamentDetail;
