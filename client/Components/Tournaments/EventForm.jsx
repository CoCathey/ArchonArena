import React from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Label } from '@heroui/react';

import { Constants } from '../../constants';
import PrizePoolFields from './PrizePoolFields';

const selectClass =
    'w-full rounded-md border border-border/65 bg-surface-secondary/55 px-3 py-2 text-sm text-foreground focus:border-border/90 focus:outline-none dark:border-border/80 dark:bg-surface-secondary/85';

const houseOptions = [
    ['brobnar', 'Brobnar'],
    ['dis', 'Dis'],
    ['ekwidon', 'Ekwidon'],
    ['geistoid', 'Geistoid'],
    ['logos', 'Logos'],
    ['mars', 'Mars'],
    ['ouboros', 'Ouboros'],
    ['redemption', 'Redemption'],
    ['sanctum', 'Sanctum'],
    ['saurian', 'Saurian'],
    ['shadows', 'Shadows'],
    ['skyborn', 'Skyborn'],
    ['staralliance', 'Star Alliance'],
    ['unfathomable', 'Unfathomable'],
    ['untamed', 'Untamed']
];

/**
 * ARCHON: the event settings form, shared by creating and editing.
 *
 * updateSettings has always accepted a full re-configuration while an event is
 * still in registration, and nothing reached it: the only editable field on the
 * page was the announcement, so an organizer who picked the wrong format, the
 * wrong number of rounds or the wrong deck rule had no way to correct it and
 * had to cancel the event and re-create it, losing everyone who had already
 * registered.
 *
 * One component rather than two forms, because two forms drift - and the half
 * that drifts would be the one that only runs when somebody has already made a
 * mistake.
 */
const EventForm = ({ form, setForm, showAdvanced, setShowAdvanced, entrantCount }) => {
    const { t } = useTranslation();
    const set = (field) => (event) => setForm({ ...form, [field]: event.target.value });

    const isSealed = form.gameFormat === 'sealed';
    // Said back plainly, because a band is easy to set backwards or so narrow
    // that nobody can enter - and the organizer finds out when players cannot
    // register rather than when they set it.
    const sasBandHint = (() => {
        const min = form.sasMin === '' || form.sasMin == null ? null : Number(form.sasMin);
        const max = form.sasMax === '' || form.sasMax == null ? null : Number(form.sasMax);

        if (min === null && max === null) {
            return t('Any deck may enter. Leave both blank for no restriction.');
        }

        if (min !== null && max !== null && min > max) {
            return t('That range is backwards - the minimum is above the maximum.');
        }

        if (min !== null && max !== null) {
            return t(
                'Only decks rated {{min}}-{{max}} SAS may register. A deck Decks of KeyForge has not rated yet cannot enter.',
                { min, max }
            );
        }

        return min !== null
            ? t('Only decks rated {{min}} SAS or above may register.', { min })
            : t('Only decks rated {{max}} SAS or below may register.', { max });
    })();

    return (
        <>
            <div className='grid gap-3 md:grid-cols-2'>
                <div>
                    <Label htmlFor='tournamentName'>{t('Name')}</Label>
                    <Input
                        id='tournamentName'
                        value={form.name}
                        onChange={set('name')}
                        placeholder={t('Friday Night Archon')}
                    />
                </div>
                <div>
                    <Label htmlFor='tournamentFormat'>{t('Format')}</Label>
                    <select
                        id='tournamentFormat'
                        className={selectClass}
                        value={form.format}
                        onChange={set('format')}
                    >
                        <option value='swiss'>{t('Swiss')}</option>
                        <option value='single-elim'>{t('Single Elimination')}</option>
                        <option value='double-elim'>{t('Double Elimination')}</option>
                        <option value='round-robin'>{t('Round Robin')}</option>
                    </select>
                </div>
                <div>
                    <Label htmlFor='tournamentGameFormat'>{t('Game Format')}</Label>
                    <select
                        id='tournamentGameFormat'
                        className={selectClass}
                        value={form.gameFormat}
                        onChange={set('gameFormat')}
                    >
                        <option value='archon'>{t('Archon')}</option>
                        <option value='sealed'>{t('Sealed')}</option>
                        <option value='alliance'>{t('Alliance')}</option>
                        {/* ARCHON: Reversal is hidden from the UI for
                                    now; the engine still supports it. */}
                        <option value='adaptive-bo1'>
                            {t('Adaptive (play, swap, chain bid)')}
                        </option>
                    </select>
                </div>
                <div>
                    <Label htmlFor='tournamentMode'>{t('Mode')}</Label>
                    <select
                        id='tournamentMode'
                        className={selectClass}
                        value={form.mode}
                        onChange={set('mode')}
                    >
                        <option value='online'>{t('Online (games created automatically)')}</option>
                        <option value='irl'>{t('In Person')}</option>
                        {/* ARCHON: one standing, played both ways.
                                    Tables open on demand rather than at
                                    pairing, because the organizer cannot
                                    know from here which matches are being
                                    played across a table with cards. */}
                        <option value='hybrid'>
                            {t('Hybrid (players open their own online tables)')}
                        </option>
                    </select>
                </div>
                {/* ARCHON (N14): pacing is the single biggest
                            decision about how an event will feel to play
                            in, so it sits with format and mode rather than
                            behind "advanced". */}
                <div>
                    <Label htmlFor='tournamentPacing'>{t('Pacing')}</Label>
                    <select
                        id='tournamentPacing'
                        className={selectClass}
                        value={form.pacing}
                        onChange={set('pacing')}
                    >
                        <option value='live'>{t('Live - played in one sitting')}</option>
                        <option value='async'>
                            {t('Asynchronous - players schedule their own matches')}
                        </option>
                    </select>
                </div>
                {form.pacing === 'async' && (
                    <div>
                        <Label htmlFor='tournamentDeadlineDays'>{t('Days per round')}</Label>
                        <Input
                            id='tournamentDeadlineDays'
                            type='number'
                            min='1'
                            max='30'
                            value={form.roundDeadlineDays}
                            onChange={set('roundDeadlineDays')}
                        />
                        <div className='mt-1 text-xs text-muted'>
                            {t(
                                'Players arrange their own match time inside this window. You are told when a deadline passes with matches outstanding.'
                            )}
                        </div>
                    </div>
                )}
                {form.format === 'swiss' && (
                    <>
                        <div>
                            <Label htmlFor='tournamentRounds'>
                                {t('Swiss rounds (blank = automatic)')}
                            </Label>
                            <Input
                                id='tournamentRounds'
                                type='number'
                                min='1'
                                max='20'
                                value={form.roundCount}
                                onChange={set('roundCount')}
                            />
                        </div>
                        <div>
                            <Label htmlFor='tournamentCut'>
                                {t('Cut to top (blank = no playoff)')}
                            </Label>
                            <select
                                id='tournamentCut'
                                className={selectClass}
                                value={form.cutTo}
                                onChange={set('cutTo')}
                            >
                                <option value=''>{t('No cut')}</option>
                                <option value='2'>{t('Top 2')}</option>
                                <option value='4'>{t('Top 4')}</option>
                                <option value='8'>{t('Top 8')}</option>
                                <option value='16'>{t('Top 16')}</option>
                            </select>
                        </div>
                    </>
                )}
                <div>
                    <Label htmlFor='tournamentStart'>{t('Scheduled start')}</Label>
                    <Input
                        id='tournamentStart'
                        type='datetime-local'
                        value={form.startTime}
                        onChange={set('startTime')}
                    />
                </div>
                <div>
                    <Label htmlFor='tournamentBestOf'>{t('Match length')}</Label>
                    <select
                        id='tournamentBestOf'
                        className={selectClass}
                        value={form.bestOf}
                        onChange={set('bestOf')}
                    >
                        <option value='1'>{t('Best of 1')}</option>
                        <option value='3'>{t('Best of 3')}</option>
                        <option value='5'>{t('Best of 5')}</option>
                    </select>
                </div>
                {/* ARCHON: the deck rule sits with format and
                            pacing rather than behind "advanced". It is
                            enforced at the table now, so it is one of the
                            few settings every player in the event feels
                            directly - and an organizer who never opens the
                            advanced panel should not discover which of the
                            three they got by accident. */}
                <div>
                    <Label htmlFor='tournamentSwapPolicy'>{t('Deck rules')}</Label>
                    <select
                        id='tournamentSwapPolicy'
                        className={selectClass}
                        value={form.triad ? 'triad' : form.deckSwapPolicy}
                        onChange={(event) => {
                            const value = event.target.value;
                            setForm({
                                ...form,
                                triad: value === 'triad',
                                deckSwapPolicy: value === 'triad' ? 'locked' : value,
                                requireDeckRegistration:
                                    value === 'triad' ? true : form.requireDeckRegistration
                            });
                        }}
                    >
                        <option value='locked'>
                            {t('One deck, locked for the event (Archon standard)')}
                        </option>
                        <option value='between-rounds'>
                            {t('Deck may change between rounds')}
                        </option>
                        <option value='triad'>
                            {t('Triad: 3 decks, opponent bans one each match')}
                        </option>
                    </select>
                    <div className='mt-1 text-xs text-muted'>
                        {form.triad
                            ? t(
                                  'Each player registers three decks; opponents ban one of each pool before every match.'
                              )
                            : form.deckSwapPolicy === 'between-rounds'
                            ? t(
                                  'Players may register a different deck between rounds. The table enforces whichever deck they are on when the round starts.'
                              )
                            : t(
                                  'The registered deck is frozen when the event starts, and the table will not let a player pilot anything else.'
                              )}
                    </div>
                </div>

                {/* ARCHON: the SAS band sits with the deck rule rather than
                    behind "advanced". It is a deck rule - it decides which
                    decks may enter at all - and it was the single most asked-
                    for setting that nobody could find, because the advanced
                    panel is the one place an organizer setting up their first
                    event does not open. Sealed events deal their own decks, so
                    the band cannot apply to them. */}
                {!isSealed && (
                    <div>
                        <Label htmlFor='tournamentSasMin'>{t('Deck power (SAS) range')}</Label>
                        <div className='flex items-center gap-2'>
                            <Input
                                id='tournamentSasMin'
                                type='number'
                                min='0'
                                max='200'
                                placeholder={t('Min')}
                                aria-label={t('Minimum deck SAS')}
                                value={form.sasMin}
                                onChange={set('sasMin')}
                            />
                            <span className='text-sm text-muted'>{t('to')}</span>
                            <Input
                                id='tournamentSasMax'
                                type='number'
                                min='0'
                                max='200'
                                placeholder={t('Max')}
                                aria-label={t('Maximum deck SAS')}
                                value={form.sasMax}
                                onChange={set('sasMax')}
                            />
                        </div>
                        <div className='mt-1 text-xs text-muted'>{sasBandHint}</div>
                    </div>
                )}
            </div>

            {/* ARCHON: the buy-in sits in the open rather than behind
                "advanced". It is the setting a player is most entitled to know
                about before they register, and an organizer who never opens the
                advanced panel should not be unable to find it. */}
            <PrizePoolFields form={form} setForm={setForm} entrantCount={entrantCount} />

            <button
                type='button'
                className='text-xs text-muted underline-offset-2 hover:text-foreground hover:underline'
                onClick={() => setShowAdvanced((open) => !open)}
            >
                {showAdvanced ? t('Hide advanced options') : t('Advanced options…')}
            </button>

            {showAdvanced && (
                <div className='grid gap-3 border-t border-border/50 pt-3 md:grid-cols-2'>
                    {form.format === 'swiss' && form.cutTo && (
                        <div>
                            <Label htmlFor='tournamentPlayoffBestOf'>
                                {t('Playoff match length')}
                            </Label>
                            <select
                                id='tournamentPlayoffBestOf'
                                className={selectClass}
                                value={form.playoffBestOf}
                                onChange={set('playoffBestOf')}
                            >
                                <option value='1'>{t('Best of 1')}</option>
                                <option value='3'>{t('Best of 3')}</option>
                                <option value='5'>{t('Best of 5')}</option>
                            </select>
                        </div>
                    )}
                    <div>
                        <Label htmlFor='tournamentCap'>
                            {t('Player cap (blank = unlimited; extras waitlist)')}
                        </Label>
                        <Input
                            id='tournamentCap'
                            type='number'
                            min='2'
                            value={form.playerCap}
                            onChange={set('playerCap')}
                        />
                    </div>
                    <div>
                        <Label htmlFor='tournamentSeed'>{t('Seeding')}</Label>
                        <select
                            id='tournamentSeed'
                            className={selectClass}
                            value={form.seedMethod}
                            onChange={set('seedMethod')}
                        >
                            <option value='registration'>{t('Registration order')}</option>
                            <option value='rating'>{t('By Amber rating')}</option>
                            <option value='random'>{t('Random')}</option>
                            <option value='manual'>{t('Manual (set on roster)')}</option>
                        </select>
                    </div>
                    <div>
                        <Label htmlFor='tournamentVisibility'>{t('Visibility')}</Label>
                        <select
                            id='tournamentVisibility'
                            className={selectClass}
                            value={form.visibility}
                            onChange={set('visibility')}
                        >
                            <option value='public'>{t('Public')}</option>
                            <option value='private'>{t('Private (join code required)')}</option>
                        </select>
                    </div>
                    <div>
                        <Label htmlFor='tournamentTimer'>
                            {t('Round timer minutes (blank = none)')}
                        </Label>
                        <Input
                            id='tournamentTimer'
                            type='number'
                            min='5'
                            max='240'
                            value={form.roundTimerMinutes}
                            onChange={set('roundTimerMinutes')}
                        />
                    </div>
                    {form.mode !== 'irl' && (
                        <div>
                            <Label htmlFor='tournamentGameClock'>
                                {t('In-game clock minutes per player (blank = none)')}
                            </Label>
                            <Input
                                id='tournamentGameClock'
                                type='number'
                                min='10'
                                max='180'
                                value={form.gameTimeLimit}
                                onChange={set('gameTimeLimit')}
                            />
                        </div>
                    )}
                    <div>
                        <Label htmlFor='tournamentChainsPerWin'>
                            {t('Chains gained per match win (Chainbound style)')}
                        </Label>
                        <Input
                            id='tournamentChainsPerWin'
                            type='number'
                            min='0'
                            max='6'
                            value={form.chainsPerMatchWin}
                            onChange={set('chainsPerMatchWin')}
                        />
                    </div>
                    <div className='md:col-span-2'>
                        <Label>{t('Allowed sets (none checked = all sets)')}</Label>
                        <div className='flex flex-wrap gap-x-3 gap-y-1'>
                            {Constants.Expansions.map((expansion) => (
                                <label
                                    key={expansion.value}
                                    className='flex items-center gap-1 text-sm text-foreground'
                                >
                                    <input
                                        type='checkbox'
                                        checked={form.allowedSets.includes(
                                            parseInt(expansion.value, 10)
                                        )}
                                        onChange={(event) => {
                                            const id = parseInt(expansion.value, 10);
                                            setForm({
                                                ...form,
                                                allowedSets: event.target.checked
                                                    ? [...form.allowedSets, id]
                                                    : form.allowedSets.filter(
                                                          (entry) => entry !== id
                                                      )
                                            });
                                        }}
                                    />
                                    {expansion.label}
                                </label>
                            ))}
                        </div>
                    </div>
                    <div className='md:col-span-2'>
                        <Label>{t('Banned houses')}</Label>
                        <div className='flex flex-wrap gap-x-3 gap-y-1'>
                            {houseOptions.map(([code, label]) => (
                                <label
                                    key={code}
                                    className='flex items-center gap-1 text-sm text-foreground'
                                >
                                    <input
                                        type='checkbox'
                                        checked={form.bannedHouses.includes(code)}
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                bannedHouses: event.target.checked
                                                    ? [...form.bannedHouses, code]
                                                    : form.bannedHouses.filter(
                                                          (entry) => entry !== code
                                                      ),
                                                requiredHouses: form.requiredHouses.filter(
                                                    (entry) => entry !== code
                                                )
                                            })
                                        }
                                    />
                                    {t(label)}
                                </label>
                            ))}
                        </div>
                    </div>
                    <div className='md:col-span-2'>
                        <Label>{t('Required houses (max 3)')}</Label>
                        <div className='flex flex-wrap gap-x-3 gap-y-1'>
                            {houseOptions.map(([code, label]) => (
                                <label
                                    key={code}
                                    className='flex items-center gap-1 text-sm text-foreground'
                                >
                                    <input
                                        type='checkbox'
                                        checked={form.requiredHouses.includes(code)}
                                        disabled={
                                            !form.requiredHouses.includes(code) &&
                                            form.requiredHouses.length >= 3
                                        }
                                        onChange={(event) =>
                                            setForm({
                                                ...form,
                                                requiredHouses: event.target.checked
                                                    ? [...form.requiredHouses, code]
                                                    : form.requiredHouses.filter(
                                                          (entry) => entry !== code
                                                      ),
                                                bannedHouses: form.bannedHouses.filter(
                                                    (entry) => entry !== code
                                                )
                                            })
                                        }
                                    />
                                    {t(label)}
                                </label>
                            ))}
                        </div>
                    </div>
                    <label className='flex items-center gap-2 text-sm text-foreground'>
                        <input
                            type='checkbox'
                            checked={form.sasChainHandicap}
                            onChange={(event) =>
                                setForm({
                                    ...form,
                                    sasChainHandicap: event.target.checked
                                })
                            }
                        />
                        {t('SAS chain handicap (stronger deck starts chained)')}
                    </label>
                    <label className='flex items-center gap-2 text-sm text-foreground'>
                        <input
                            type='checkbox'
                            checked={form.ratedGames}
                            onChange={(event) =>
                                setForm({ ...form, ratedGames: event.target.checked })
                            }
                        />
                        {t('Rated event (games move Amber)')}
                    </label>
                    <label className='flex items-center gap-2 text-sm text-foreground'>
                        <input
                            type='checkbox'
                            checked={form.requireDeckRegistration}
                            onChange={(event) =>
                                setForm({
                                    ...form,
                                    requireDeckRegistration: event.target.checked
                                })
                            }
                        />
                        {t('Require deck registration (decks lock at start)')}
                    </label>
                    <label className='flex items-center gap-2 text-sm text-foreground'>
                        <input
                            type='checkbox'
                            checked={form.hideDecklists}
                            onChange={(event) =>
                                setForm({
                                    ...form,
                                    hideDecklists: event.target.checked
                                })
                            }
                        />
                        {t('Hide registered decks from other players')}
                    </label>
                </div>
            )}

            <div>
                <Label htmlFor='tournamentDescription'>{t('Description')}</Label>
                <textarea
                    id='tournamentDescription'
                    className={`${selectClass} min-h-20`}
                    value={form.description}
                    maxLength={4000}
                    onChange={set('description')}
                />
            </div>
        </>
    );
};

EventForm.displayName = 'EventForm';

export default EventForm;
