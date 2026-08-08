import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ARCHON: elimination bracket visualization.
 *
 * Drawn as an SVG rather than as flex columns of boxes. The old version laid
 * matches out in columns and left the reader to work out which two feed which -
 * fine for a top 4, useless for a 32-player double elimination, which is the
 * size at which a bracket stops being a list and starts being the thing you
 * navigate an event by. Here every match knows its source matches, so the
 * connectors are drawn from the same data the engine advances players along,
 * and a wrong line would mean a wrong bracket rather than a cosmetic slip.
 *
 * Geometry, not layout engine: a match's vertical centre is the average of its
 * two feeders' centres, computed round by round from the first. That is what
 * produces the familiar bracket pinch, and it needs no measurement pass.
 *
 * Zoom exists because a 64-player double elim is genuinely large; it scales the
 * whole SVG rather than re-laying anything out, so the picture never reflows
 * under the reader.
 */

const BOX_WIDTH = 168;
const BOX_HEIGHT = 46;
const COLUMN_GAP = 56;
const SLOT_HEIGHT = 21;
const MIN_ROW_GAP = 14;

/** Timestamps come back from Postgres without a zone; they are UTC. */
const asUtc = (value) => {
    if (!value) {
        return null;
    }

    const text = typeof value === 'string' ? value : String(value);
    const time = new Date(text.endsWith('Z') ? text : `${text}Z`);

    return Number.isNaN(time.getTime()) ? null : time;
};

/**
 * Lay one bracket out. Returns positioned matches plus the connector paths
 * between them, in a coordinate space starting at (0, 0).
 */
const layoutBracket = (matches) => {
    const rounds = new Map();

    for (const match of matches) {
        const key = match.bracketRound || 1;

        if (!rounds.has(key)) {
            rounds.set(key, []);
        }

        rounds.get(key).push(match);
    }

    const ordered = [...rounds.entries()].sort((a, b) => a[0] - b[0]);
    const positions = new Map();
    const placed = [];

    // The first round sets the rhythm; later rounds hang off their feeders.
    const firstRoundGap = BOX_HEIGHT + MIN_ROW_GAP;

    ordered.forEach(([roundNumber, roundMatches], columnIndex) => {
        const sorted = [...roundMatches].sort((a, b) => (a.bracketPos || 0) - (b.bracketPos || 0));
        const x = columnIndex * (BOX_WIDTH + COLUMN_GAP);

        sorted.forEach((match, rowIndex) => {
            const feeders = [match.p1SourceMatchId, match.p2SourceMatchId]
                .map((id) => (id == null ? null : positions.get(id)))
                .filter(Boolean);

            // Centred between its feeders when it has them; otherwise evenly
            // spaced down the column (round one, and any slot seeded directly).
            const centerY =
                feeders.length > 0
                    ? feeders.reduce((sum, feeder) => sum + feeder.centerY, 0) / feeders.length
                    : rowIndex * firstRoundGap + BOX_HEIGHT / 2;

            const position = { x, centerY, round: roundNumber };
            positions.set(match.id, position);
            placed.push({ match, ...position });
        });
    });

    // A later round can float above the first if its feeders did; shift the
    // whole picture down so nothing is drawn at a negative coordinate.
    const minTop = placed.reduce(
        (min, entry) => Math.min(min, entry.centerY - BOX_HEIGHT / 2),
        Infinity
    );
    const offset = Number.isFinite(minTop) && minTop < 0 ? -minTop : 0;

    const boxes = placed.map((entry) => ({
        ...entry,
        top: entry.centerY - BOX_HEIGHT / 2 + offset,
        centerY: entry.centerY + offset
    }));

    const byId = new Map(boxes.map((box) => [box.match.id, box]));
    const links = [];

    for (const box of boxes) {
        for (const sourceId of [box.match.p1SourceMatchId, box.match.p2SourceMatchId]) {
            const source = sourceId == null ? null : byId.get(sourceId);

            if (!source) {
                continue;
            }

            // Elbow: out of the feeder, across the gutter, into the target.
            const startX = source.x + BOX_WIDTH;
            const startY = source.centerY;
            const endX = box.x;
            const endY = box.centerY;
            const midX = startX + (endX - startX) / 2;

            links.push({
                key: `${sourceId}-${box.match.id}`,
                d: `M ${startX} ${startY} H ${midX} V ${endY} H ${endX}`
            });
        }
    }

    const width = boxes.reduce((max, box) => Math.max(max, box.x + BOX_WIDTH), 0);
    const height = boxes.reduce((max, box) => Math.max(max, box.top + BOX_HEIGHT), 0);
    const columns = ordered.map(([roundNumber], index) => ({
        round: roundNumber,
        x: index * (BOX_WIDTH + COLUMN_GAP)
    }));

    return { boxes, links, columns, width, height, roundCount: ordered.length };
};

const roundTitle = (t, bracketRound, maxRound, prefix = '') => {
    if (bracketRound === maxRound) {
        return prefix ? `${prefix} ${t('Final')}` : t('Final');
    }

    if (bracketRound === maxRound - 1 && !prefix) {
        return t('Semifinals');
    }

    return `${prefix ? `${prefix} ` : ''}${t('Round {{round}}', { round: bracketRound })}`;
};

/** One player's line inside a match box. */
const Slot = ({ name, score, isWinner, isMe, showScore }) => (
    <div className='flex items-center gap-1' style={{ height: SLOT_HEIGHT }}>
        <span
            className={`min-w-0 flex-1 truncate text-xs ${
                isWinner
                    ? 'font-bold text-amber-300'
                    : name
                    ? 'text-foreground/90'
                    : 'italic text-muted'
            } ${isMe ? 'underline decoration-amber-400/70 underline-offset-2' : ''}`}
        >
            {name || 'TBD'}
        </span>
        {showScore && (
            <span
                className={`shrink-0 tabular-nums text-xs ${
                    isWinner ? 'font-bold text-amber-300' : 'text-muted'
                }`}
            >
                {score}
            </span>
        )}
    </div>
);
Slot.displayName = 'BracketSlot';

const MatchBox = ({ box, currentUsername, onSelect, isSelected, t }) => {
    const { match } = box;
    const decided = !!match.winnerId || !!match.resultType;
    const showScores = match.bestOf > 1 && (match.player1Wins > 0 || match.player2Wins > 0);
    const live = !decided && match.player1Id && match.player2Id;
    const scheduled = asUtc(match.scheduledAt);

    return (
        <div
            className='absolute'
            style={{ left: box.x, top: box.top, width: BOX_WIDTH, height: BOX_HEIGHT }}
        >
            <button
                type='button'
                onClick={() => onSelect(isSelected ? null : match.id)}
                className={`flex h-full w-full flex-col justify-center rounded-md border px-1.5 text-left transition ${
                    isSelected
                        ? 'border-amber-400/80 bg-surface-secondary ring-1 ring-amber-400/40'
                        : decided
                        ? 'border-border/60 bg-surface-secondary/40 hover:border-border/90'
                        : live
                        ? 'border-amber-400/45 bg-surface-secondary/70 hover:border-amber-400/70'
                        : 'border-dashed border-border/50 bg-surface-secondary/25 hover:border-border/70'
                }`}
                title={
                    scheduled
                        ? t('Scheduled for {{time}}', { time: scheduled.toLocaleString() })
                        : undefined
                }
            >
                <Slot
                    name={match.player1}
                    score={match.player1Wins}
                    isWinner={!!match.winnerId && match.winnerId === match.player1Id}
                    isMe={match.player1 === currentUsername}
                    showScore={showScores}
                />
                {match.resultType === 'bye' ? (
                    <div
                        className='text-[0.65rem] italic text-muted'
                        style={{ height: SLOT_HEIGHT }}
                    >
                        {t('bye')}
                    </div>
                ) : (
                    <Slot
                        name={match.player2}
                        score={match.player2Wins}
                        isWinner={!!match.winnerId && match.winnerId === match.player2Id}
                        isMe={match.player2 === currentUsername}
                        showScore={showScores}
                    />
                )}
            </button>
            {/* Corner ticks: the state a reader scans a bracket for without
                opening anything - is this played, is it booked, is it late. */}
            {scheduled && !decided && (
                <span
                    className='pointer-events-none absolute -right-1 -top-1 rounded bg-sky-500/80 px-1 text-[0.6rem] font-semibold text-white'
                    title={t('Scheduled for {{time}}', { time: scheduled.toLocaleString() })}
                >
                    {t('booked')}
                </span>
            )}
            {match.disputedBy && (
                <span className='pointer-events-none absolute -right-1 -top-1 rounded bg-red-500/85 px-1 text-[0.6rem] font-semibold text-white'>
                    {t('disputed')}
                </span>
            )}
        </div>
    );
};
MatchBox.displayName = 'BracketMatchBox';

/** One bracket - winners, losers, or the grand final - as a single SVG-backed board. */
const BracketBoard = ({ matches, title, prefix, currentUsername, selectedId, onSelect, t }) => {
    const layout = useMemo(() => layoutBracket(matches), [matches]);

    if (layout.boxes.length === 0) {
        return null;
    }

    const maxRound = layout.columns.length ? layout.columns[layout.columns.length - 1].round : 0;

    return (
        <div className='min-w-max'>
            {title && (
                <div className='mb-1 text-xs font-semibold uppercase tracking-wide text-muted'>
                    {title}
                </div>
            )}
            <div className='mb-1 flex' style={{ width: layout.width }}>
                {layout.columns.map((column) => (
                    <div
                        key={column.round}
                        className='shrink-0 text-center text-[0.65rem] uppercase tracking-wide text-muted'
                        style={{ width: BOX_WIDTH, marginRight: COLUMN_GAP }}
                    >
                        {roundTitle(t, column.round, maxRound, prefix)}
                    </div>
                ))}
            </div>
            <div className='relative' style={{ width: layout.width, height: layout.height }}>
                <svg
                    className='pointer-events-none absolute inset-0'
                    width={layout.width}
                    height={layout.height}
                    aria-hidden='true'
                >
                    {layout.links.map((link) => (
                        <path
                            key={link.key}
                            d={link.d}
                            fill='none'
                            stroke='currentColor'
                            strokeWidth='1.5'
                            className='text-border'
                        />
                    ))}
                </svg>
                {layout.boxes.map((box) => (
                    <MatchBox
                        key={box.match.id}
                        box={box}
                        currentUsername={currentUsername}
                        onSelect={onSelect}
                        isSelected={selectedId === box.match.id}
                        t={t}
                    />
                ))}
            </div>
        </div>
    );
};
BracketBoard.displayName = 'BracketBoard';

const BracketView = ({ matches, currentUsername, players = [] }) => {
    const { t } = useTranslation();
    const [zoom, setZoom] = useState(1);
    const [selectedId, setSelectedId] = useState(null);

    const bracketMatches = matches.filter((match) => match.bracket);

    if (bracketMatches.length === 0) {
        return null;
    }

    const byBracket = (bracket) =>
        bracketMatches
            .filter((match) => match.bracket === bracket)
            .sort(
                (a, b) =>
                    (a.bracketRound || 0) - (b.bracketRound || 0) ||
                    (a.bracketPos || 0) - (b.bracketPos || 0)
            );

    const winners = byBracket('W');
    const losers = byBracket('L');
    const finals = byBracket('GF');
    const hasLosers = losers.length > 0;

    const selected = selectedId ? bracketMatches.find((match) => match.id === selectedId) : null;
    const seedOf = (userId) => players.find((player) => player.userId === userId)?.seed;

    return (
        <div className='space-y-2'>
            <div className='flex flex-wrap items-center gap-2 text-xs text-muted'>
                <span>{t('Click a match for its detail. Drag or scroll to pan.')}</span>
                <span className='ml-auto flex items-center gap-1'>
                    <button
                        type='button'
                        className='rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground'
                        onClick={() => setZoom((value) => Math.max(0.5, value - 0.1))}
                    >
                        −
                    </button>
                    <span className='w-10 text-center tabular-nums'>{Math.round(zoom * 100)}%</span>
                    <button
                        type='button'
                        className='rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground'
                        onClick={() => setZoom((value) => Math.min(1.5, value + 0.1))}
                    >
                        +
                    </button>
                    <button
                        type='button'
                        className='rounded border border-border/60 px-1.5 py-0.5 hover:text-foreground'
                        onClick={() => setZoom(1)}
                    >
                        {t('Reset')}
                    </button>
                </span>
            </div>

            <div className='overflow-x-auto pb-2'>
                <div
                    className='inline-flex flex-col gap-5'
                    style={{ transform: `scale(${zoom})`, transformOrigin: 'top left' }}
                >
                    <div className='flex items-start gap-8'>
                        <BracketBoard
                            matches={winners}
                            prefix={hasLosers ? t('Winners') : ''}
                            currentUsername={currentUsername}
                            selectedId={selectedId}
                            onSelect={setSelectedId}
                            t={t}
                        />
                        {finals.length > 0 && (
                            <div className='min-w-max'>
                                <div className='mb-1 text-xs font-semibold uppercase tracking-wide text-muted'>
                                    {t('Grand Final')}
                                </div>
                                <div className='mb-1 flex' style={{ width: BOX_WIDTH }}>
                                    <div
                                        className='shrink-0 text-center text-[0.65rem] uppercase tracking-wide text-muted'
                                        style={{ width: BOX_WIDTH }}
                                    >
                                        {finals.length > 1 ? t('and reset') : ' '}
                                    </div>
                                </div>
                                <div
                                    className='relative'
                                    style={{
                                        width: BOX_WIDTH,
                                        height: finals.length * (BOX_HEIGHT + MIN_ROW_GAP)
                                    }}
                                >
                                    {finals.map((match, index) => (
                                        <MatchBox
                                            key={match.id}
                                            box={{
                                                match,
                                                x: 0,
                                                top: index * (BOX_HEIGHT + MIN_ROW_GAP),
                                                centerY:
                                                    index * (BOX_HEIGHT + MIN_ROW_GAP) +
                                                    BOX_HEIGHT / 2
                                            }}
                                            currentUsername={currentUsername}
                                            onSelect={setSelectedId}
                                            isSelected={selectedId === match.id}
                                            t={t}
                                        />
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                    {hasLosers && (
                        <div className='border-t border-border/50 pt-3'>
                            <BracketBoard
                                matches={losers}
                                title={t('Losers Bracket')}
                                prefix={t('Losers')}
                                currentUsername={currentUsername}
                                selectedId={selectedId}
                                onSelect={setSelectedId}
                                t={t}
                            />
                        </div>
                    )}
                </div>
            </div>

            {selected && (
                <div className='rounded-md border border-border/60 bg-surface-secondary/45 px-3 py-2 text-sm'>
                    <div className='flex flex-wrap items-center gap-x-3 gap-y-1'>
                        <span className='font-semibold text-foreground'>
                            {selected.player1 || t('TBD')}
                            {seedOf(selected.player1Id) != null && (
                                <span className='ml-1 text-xs text-muted'>
                                    #{seedOf(selected.player1Id)}
                                </span>
                            )}
                            <span className='mx-1 text-muted'>{t('vs')}</span>
                            {selected.player2 || t('TBD')}
                            {seedOf(selected.player2Id) != null && (
                                <span className='ml-1 text-xs text-muted'>
                                    #{seedOf(selected.player2Id)}
                                </span>
                            )}
                        </span>
                        {selected.bestOf > 1 && (
                            <span className='text-muted'>
                                {t('Bo{{n}}', { n: selected.bestOf })}{' '}
                                <span className='font-bold text-foreground'>
                                    {selected.player1Wins}-{selected.player2Wins}
                                </span>
                            </span>
                        )}
                        {selected.scheduledAt && !selected.winnerId && (
                            <span className='text-sky-300'>
                                {t('Scheduled {{time}}', {
                                    time: asUtc(selected.scheduledAt)?.toLocaleString()
                                })}
                            </span>
                        )}
                        {selected.winnerId && (
                            <span className='font-semibold text-amber-300'>
                                {t('{{name}} advances', {
                                    name:
                                        selected.winnerId === selected.player1Id
                                            ? selected.player1
                                            : selected.player2
                                })}
                            </span>
                        )}
                        {selected.resultType && selected.resultType !== 'played' && (
                            <span className='rounded bg-surface-tertiary/70 px-1.5 text-xs italic text-muted'>
                                {t(selected.resultType)}
                            </span>
                        )}
                        <button
                            type='button'
                            className='ml-auto text-xs text-muted underline-offset-2 hover:text-foreground hover:underline'
                            onClick={() => setSelectedId(null)}
                        >
                            {t('close')}
                        </button>
                    </div>
                    {selected.games && selected.games.length > 0 && (
                        <div className='mt-1 text-xs text-muted'>
                            {t('{{count}} game(s) played on the platform', {
                                count: selected.games.length
                            })}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

BracketView.displayName = 'BracketView';

export default BracketView;
