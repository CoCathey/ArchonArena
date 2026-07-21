import React from 'react';

/**
 * ARCHON: player ratings are branded as "Amber" (after KeyForge's Æmber),
 * the way Clash Royale uses trophies - a themed currency instead of a bare
 * "rating points" number. This is display only; the underlying value is the
 * numeric Elo rating. NB: deck power is "SAS" and is deliberately separate.
 */
const AmberGem = ({ className }) => (
    <svg viewBox='0 0 24 24' className={className} aria-hidden='true'>
        <path d='M12 2l8 7-8 13-8-13z' fill='currentColor' opacity='0.95' />
        <path d='M4 9h16l-8 13z' fill='currentColor' opacity='0.55' />
        <path d='M12 2l4 7-4 13-4-13z' fill='currentColor' opacity='0.3' />
    </svg>
);

/**
 * @param {{ value: number|string, className?: string, iconClass?: string,
 *   showLabel?: boolean }} props
 */
const AmberValue = ({ value, className = '', iconClass = 'h-3.5 w-3.5', showLabel = false }) => {
    const display =
        typeof value === 'number' ? value.toLocaleString() : value === undefined ? '-' : value;

    return (
        <span className={`inline-flex items-center gap-1 font-bold text-amber-300 ${className}`}>
            <AmberGem className={`${iconClass} shrink-0 text-amber-400`} />
            {display}
            {showLabel && <span className='ml-0.5 text-xs font-normal text-muted'>Amber</span>}
        </span>
    );
};

AmberValue.displayName = 'AmberValue';

export default AmberValue;
