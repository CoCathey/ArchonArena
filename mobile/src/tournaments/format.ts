import type { OpenMatch, TournamentSummary } from '../api/tournaments';

/** Pairing structures the engine runs. */
const FORMAT_LABELS: Record<string, string> = {
    swiss: 'Swiss',
    'single-elim': 'Single elimination',
    'double-elim': 'Double elimination',
    'round-robin': 'Round robin',
    hybrid: 'Swiss + cut'
};

export function tournamentFormatLabel(format?: string): string {
    if (!format) {
        return 'Event';
    }
    return FORMAT_LABELS[format] ?? format.replace(/-/g, ' ');
}

export function statusLabel(event: Pick<TournamentSummary, 'status' | 'currentRound' | 'roundCount'>) {
    switch (event.status) {
        case 'registration':
            return 'Registration open';
        case 'active':
            return event.roundCount
                ? `Round ${event.currentRound ?? 1} of ${event.roundCount}`
                : `Round ${event.currentRound ?? 1}`;
        case 'complete':
            return 'Finished';
        case 'cancelled':
            return 'Cancelled';
        default:
            return String(event.status ?? '');
    }
}

/**
 * Server timestamps come back without a zone marker but are UTC. Parsing them
 * as local time would shift every match by the reader's offset, which for a
 * scheduling feature is the whole ballgame.
 */
export function parseUtc(value?: string | null): Date | undefined {
    if (!value) {
        return undefined;
    }
    const iso = /Z|[+-]\d{2}:?\d{2}$/.test(value) ? value : `${value}Z`;
    const date = new Date(iso);

    return Number.isNaN(date.getTime()) ? undefined : date;
}

/** A time in the reader's own zone — the point of doing this on the device. */
export function localTime(value?: string | null): string | undefined {
    const date = parseUtc(value);
    if (!date) {
        return undefined;
    }

    return date.toLocaleString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
    });
}

/** "in 2h 15m" / "12m ago", for deadlines and agreed times. */
export function relativeTime(value?: string | null, now = Date.now()): string | undefined {
    const date = parseUtc(value);
    if (!date) {
        return undefined;
    }

    const deltaMs = date.getTime() - now;
    const past = deltaMs < 0;
    const minutes = Math.round(Math.abs(deltaMs) / 60000);

    if (minutes < 1) {
        return past ? 'just now' : 'any moment';
    }

    let amount: string;
    if (minutes < 60) {
        amount = `${minutes}m`;
    } else if (minutes < 60 * 24) {
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        amount = rest ? `${hours}h ${rest}m` : `${hours}h`;
    } else {
        const days = Math.round(minutes / (60 * 24));
        amount = `${days}d`;
    }

    return past ? `${amount} ago` : `in ${amount}`;
}

/** What the player has to do about a match, in words rather than a code. */
export function actionLabel(match: OpenMatch): string {
    switch (match.needsAction) {
        case 'respond':
            return 'They proposed a time';
        case 'waiting':
            return 'Waiting on their answer';
        case 'play':
            return 'Scheduled';
        default:
            return 'Needs a time';
    }
}
