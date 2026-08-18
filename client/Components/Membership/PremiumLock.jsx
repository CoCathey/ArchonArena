import React from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { Button as HeroButton } from '@heroui/react';
import { useNavigate } from 'react-router-dom';

import { hasCapability } from '../../membership';
import { useGetMembershipCatalogQuery } from '../../redux/api';

/**
 * ARCHON (N12): the locked state for a premium feature.
 *
 * The brief for this component is "don't simply hide it". A hidden feature
 * teaches a player nothing and gives them no reason to upgrade; a bare
 * "Premium Required" is worse, because it reads as a wall rather than an offer.
 * So the shape is always: show the real thing, blurred and unreadable behind an
 * overlay that says what they would learn from it.
 *
 * Three ways to use it:
 *
 *   <PremiumLock capability={...}>            wrap a real panel; when locked the
 *       <RealPanel />                          children are blurred behind an
 *   </PremiumLock>                             overlay and made inert
 *
 *   <PremiumLock capability={...} preview={<Sample />}>
 *       <RealPanel />                          a representative sample is blurred
 *   </PremiumLock>                             instead (use when the real data
 *                                              would be a round trip we should
 *                                              not make for a locked user)
 *
 *   <PremiumLock capability={...} inline />    a compact one-line lock, for a
 *                                              table cell or a stat tile
 *
 * The blurred children are wrapped `aria-hidden` with `pointer-events-none` so
 * the locked content is not reachable by keyboard or screen reader - the blur
 * is a visual affordance, not a security boundary. The actual boundary is
 * `requireCapability` on the endpoint; anything genuinely sensitive is simply
 * never sent to a client that may not see it.
 */
const PremiumLock = ({
    capability,
    children,
    preview,
    inline = false,
    title,
    className = '',
    minHeight,
    granted
}) => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const user = useSelector((state) => state.account.user);
    const { data: catalog } = useGetMembershipCatalogQuery();

    /**
     * ARCHON: the server's answer wins when there is one.
     *
     * `hasCapability` reads the capability list minted into the JWT at sign-in,
     * which goes stale the moment a membership changes - a Patreon sync or an
     * admin grant updates what the server will serve immediately, but the
     * token keeps saying no until it refreshes. In that window the endpoint
     * happily returns the data and this component blurs it: the player has
     * paid, the payload is on the page, and the UI hides it from them.
     *
     * So an endpoint that reports per-section entitlement (Archon
     * Intelligence sends a `locked` list) can pass `granted`, and it is
     * believed over the token in both directions - it was computed against
     * live entitlements one request ago. Left undefined, this behaves exactly
     * as it always has.
     */
    const unlocked = granted === undefined ? hasCapability(user, capability) : granted;

    // Unlocked - and for an admin this is always the branch taken, because the
    // server put every capability on their user object. There is no admin
    // check in this component.
    if (unlocked) {
        return children;
    }

    const copy = catalog?.capabilities?.[capability];
    const learn = copy?.learn;
    const label = title || copy?.label;

    // Which tier actually unlocks this, so the prompt names it rather than
    // saying "upgrade". Derived from the catalogue, so moving a capability
    // between tiers changes this prompt with no edit here.
    const tier = (catalog?.tiers || []).find((candidate) =>
        (candidate.capabilities || []).includes(capability)
    );
    const tierName = tier?.name;

    const upgrade = (
        <HeroButton size='sm' variant='primary' onPress={() => navigate('/membership')}>
            {tierName ? t('Unlock with {{tier}}', { tier: tierName }) : t('See membership')}
        </HeroButton>
    );

    if (inline) {
        return (
            <span className={`inline-flex items-center gap-1.5 text-xs text-muted ${className}`}>
                <LockGlyph />
                <button
                    className='underline decoration-dotted underline-offset-2 hover:text-foreground'
                    type='button'
                    onClick={() => navigate('/membership')}
                    title={learn || label}
                >
                    {tierName ? t('{{tier}}', { tier: tierName }) : t('Members')}
                </button>
            </span>
        );
    }

    return (
        <div
            className={`relative overflow-hidden rounded-md border border-border/70 ${className}`}
            style={minHeight ? { minHeight } : undefined}
        >
            {/* The value being demonstrated. Inert and hidden from assistive
                tech - it is a texture, not content. */}
            <div
                aria-hidden='true'
                className='pointer-events-none select-none blur-[6px] saturate-50 opacity-60'
            >
                {preview || children}
            </div>

            <div className='absolute inset-0 flex flex-col items-center justify-center gap-2 bg-surface/70 p-4 text-center backdrop-blur-[2px]'>
                <LockGlyph className='h-5 w-5 text-amber-300' />
                {label && <div className='text-sm font-semibold text-foreground'>{label}</div>}
                {learn && <p className='m-0 max-w-md text-xs text-muted'>{learn}</p>}
                {upgrade}
            </div>
        </div>
    );
};

const LockGlyph = ({ className = 'h-3.5 w-3.5' }) => (
    <svg
        aria-hidden='true'
        className={className}
        fill='none'
        stroke='currentColor'
        strokeWidth='2'
        viewBox='0 0 24 24'
    >
        <rect height='11' rx='2' ry='2' width='18' x='3' y='11' />
        <path d='M7 11V7a5 5 0 0 1 10 0v4' />
    </svg>
);

LockGlyph.propTypes = { className: PropTypes.string };

PremiumLock.propTypes = {
    granted: PropTypes.bool,
    capability: PropTypes.string.isRequired,
    children: PropTypes.node,
    className: PropTypes.string,
    inline: PropTypes.bool,
    minHeight: PropTypes.oneOfType([PropTypes.number, PropTypes.string]),
    preview: PropTypes.node,
    title: PropTypes.string
};

export default PremiumLock;
export { LockGlyph };
