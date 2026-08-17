import React, {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState
} from 'react';
import PropTypes from 'prop-types';

import PlayerBadge from './PlayerBadge';
import Link from '../Navigation/Link';
import { getRoleClass } from '../../util';
import { TIERS } from '../../membership';
// ARCHON (N12): name effects, one of the profile cosmetics.
import { accentStyle, nameEffectClass } from '../../cosmetics';

/**
 * ARCHON (N12): one component for "somebody else's name".
 *
 * Before this there was no such component. Every list - the member directory,
 * the leaderboards, club rosters, tournament standings, friends, match history,
 * the lobby seats, in-game chat - rendered a username itself and re-derived its
 * own class string, and two of them were still building `${role}-role`, a
 * keyteki class name nothing has defined for years. So supporters were
 * invisible on those pages and nobody could tell, because there was no single
 * place the badge was supposed to come from.
 *
 * Now there is. `<PlayerName username='alice' />` is enough anywhere: if the
 * surrounding payload already carries the tier it is used directly, and if it
 * does not, the provider below fetches it. A page added next year gets badges
 * by rendering names the same way every other page does.
 *
 * ## Why a provider rather than per-page fetching
 *
 * The badge belongs on fifteen pages whose payloads are built by a dozen
 * unrelated services. Threading a tier through all of them is a dozen chances
 * to get the membership logic subtly different and a dozen migrations to write.
 * Instead each name asks for itself, the provider coalesces a render pass into
 * one request, and the answer is cached for the session.
 */

const PlayerBadgeContext = createContext(null);

/** How long to wait for more names before sending. One paint, roughly. */
const BATCH_MS = 40;

/** Matches BadgeService.MAX_USERNAMES. */
const MAX_PER_REQUEST = 300;

/**
 * Collects the names being rendered and resolves them in batches.
 *
 * Mount once, near the root. Without it `PlayerName` still renders - it just
 * shows the name with no badge, which is the correct degradation for something
 * decorative.
 */
export const PlayerBadgeProvider = ({ children }) => {
    const [badges, setBadges] = useState({});
    // Names asked for at least once, so a player with no badge is not
    // re-requested by every list they appear in.
    const asked = useRef(new Set());
    const queued = useRef(new Set());
    const timer = useRef(null);

    const flush = useCallback(async () => {
        timer.current = null;

        const names = [...queued.current].slice(0, MAX_PER_REQUEST);

        queued.current = new Set([...queued.current].slice(MAX_PER_REQUEST));

        if (!names.length) {
            return;
        }

        let resolved = {};

        try {
            const response = await fetch(
                `/api/membership/badges?usernames=${encodeURIComponent(names.join(','))}`
            );

            if (response.ok) {
                const body = await response.json();

                resolved = (body && body.badges) || {};
            }
        } catch {
            // Decoration. A failed lookup shows unbadged names, and the names
            // stay in `asked` so a broken endpoint is not retried per row.
        }

        setBadges((current) => {
            const next = { ...current };

            for (const name of names) {
                // null, not undefined: "asked, has nothing" is a real answer
                // and must not look like "not asked yet".
                next[name] = resolved[name] || null;
            }

            return next;
        });

        if (queued.current.size) {
            timer.current = setTimeout(flush, BATCH_MS);
        }
    }, []);

    const request = useCallback(
        (username) => {
            const key = String(username || '')
                .trim()
                .toLowerCase();

            if (!key || asked.current.has(key)) {
                return;
            }

            asked.current.add(key);
            queued.current.add(key);

            if (!timer.current) {
                timer.current = setTimeout(flush, BATCH_MS);
            }
        },
        [flush]
    );

    useEffect(
        () => () => {
            if (timer.current) {
                clearTimeout(timer.current);
            }
        },
        []
    );

    const value = useMemo(() => ({ badges, request }), [badges, request]);

    return <PlayerBadgeContext.Provider value={value}>{children}</PlayerBadgeContext.Provider>;
};

PlayerBadgeProvider.propTypes = { children: PropTypes.node };

/**
 * The badge for a username, fetching it if this is the first time it has been
 * asked for. Returns undefined while unknown, so nothing flashes into place.
 *
 * @param {string} username
 * @param {boolean} [skip] when the caller already has the tier
 */
export const usePlayerBadge = (username, skip = false) => {
    const context = useContext(PlayerBadgeContext);
    const request = context && context.request;
    const key = String(username || '')
        .trim()
        .toLowerCase();

    useEffect(() => {
        if (!skip && key && request) {
            request(key);
        }
    }, [key, request, skip]);

    if (skip || !context || !key) {
        return undefined;
    }

    return context.badges[key] || undefined;
};

/**
 * Name colours per tier, matching the key glyph. Deliberately not the chip
 * backgrounds from TIER_BADGE_CLASS - a filled pill behind every name in a
 * table is unreadable; this is the text-only form of the same palette.
 */
const TIER_TEXT_CLASS = Object.freeze({
    [TIERS.SUPPORTER]: 'font-semibold text-emerald-300',
    [TIERS.ARCHON]: 'font-semibold text-amber-300',
    [TIERS.VAULT_MASTER]: 'font-semibold text-violet-300'
});

/**
 * A player's name, with their membership badge.
 *
 * @param {object} props
 * @param {string} props.username
 * @param {string} [props.tier] pass when the payload already carries it
 * @param {string} [props.tierName]
 * @param {string} [props.role] site role, for the name colour
 * @param {object} [props.cosmetics] ARCHON (N12): the player's cosmetics, for
 *        the name effect and the key finish. Pass when the payload carries
 *        them; otherwise the badge lookup brings them along.
 * @param {boolean} [props.link] link through to their profile
 * @param {boolean} [props.plain] skip the role colour, keep the badge
 * @param {string} [props.className] applied to the name text
 */
const PlayerName = ({
    username,
    tier,
    tierName,
    role,
    cosmetics,
    isNew,
    link = false,
    plain = false,
    className = '',
    children
}) => {
    // An explicitly passed tier is authoritative: the lobby and the profile
    // already know it, and re-fetching would be a request per row for data
    // that arrived with the page.
    const looked = usePlayerBadge(username, tier !== undefined);
    const effectiveTier = tier !== undefined ? tier : looked && looked.tier;
    const effectiveName = tierName !== undefined ? tierName : looked && looked.tierName;
    const effectiveRole = role !== undefined ? role : looked && looked.role;
    // ARCHON (N20): the New pill for fresh accounts, from the payload when it
    // carries one and the badge lookup otherwise.
    const effectiveIsNew = isNew !== undefined ? isNew : looked && looked.isNew;
    // ARCHON (N12): the badge lookup carries these for pages whose payload does
    // not, so a leaderboard gets them without its own query. Only members ever
    // have one, and the server drops it from the badge once a pledge lapses -
    // so there is nothing to check here.
    const effectiveCosmetics = cosmetics !== undefined ? cosmetics : looked && looked.cosmetics;
    const effectClass = nameEffectClass(effectiveCosmetics);

    const nameClass = plain
        ? className
        : // A paying player is coloured by their tier rather than by the flat
          // supporter green, so the three tiers are distinguishable in a list.
          // Site roles outrank tiers: an admin is red whether or not they pay.
          [TIER_TEXT_CLASS[effectiveTier] || getRoleClass(effectiveRole), className]
              .filter(Boolean)
              .join(' ');

    const label = children || username;
    // A gradient name paints the text with its own colour, so the tier colour
    // underneath it would never be seen; the effect class wins where there is
    // one, and the tier colour is what shows for everybody else.
    const textClass = [nameClass, effectClass].filter(Boolean).join(' ');

    return (
        <span
            className='inline-flex min-w-0 items-baseline gap-1'
            style={effectClass ? accentStyle(effectiveCosmetics) : undefined}
        >
            {link ? (
                <Link
                    className={`${textClass} truncate hover:underline`}
                    href={`/players/${encodeURIComponent(username)}`}
                >
                    {label}
                </Link>
            ) : (
                <span className={`${textClass} truncate`}>{label}</span>
            )}
            <PlayerBadge
                cosmetics={effectiveCosmetics}
                isNew={!!effectiveIsNew}
                tier={effectiveTier}
                tierName={effectiveName}
            />
        </span>
    );
};

PlayerName.displayName = 'PlayerName';

PlayerName.propTypes = {
    children: PropTypes.node,
    className: PropTypes.string,
    cosmetics: PropTypes.object,
    isNew: PropTypes.bool,
    link: PropTypes.bool,
    plain: PropTypes.bool,
    role: PropTypes.string,
    tier: PropTypes.string,
    tierName: PropTypes.string,
    username: PropTypes.string
};

export default PlayerName;
export { TIER_TEXT_CLASS };
