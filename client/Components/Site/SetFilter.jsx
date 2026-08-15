import React from 'react';
import PropTypes from 'prop-types';

import { Constants } from '../../constants';

/**
 * ARCHON: the set filter the intelligence pages share.
 *
 * A row of toggles rather than the popover multi-select the deck list uses. The
 * difference is what the control is for: on the deck list the filter narrows a
 * list you are already looking at, so it can afford to be tucked away. Here the
 * filter IS the question - "how do I do in Æmber Skies" - and the answer above
 * it changes meaning entirely depending on what is selected, so which sets are
 * on has to be readable at a glance without opening anything.
 *
 * "All sets" is a real state, not zero selections dressed up. Sending no filter
 * and sending an empty one mean opposite things to the server, and a control
 * that cannot tell them apart eventually sends the wrong one.
 */

/** Newest first: the sets someone is deciding about are the recent ones. */
const orderedSets = () =>
    [...Constants.Expansions]
        .map((expansion) => ({ id: parseInt(expansion.value, 10), label: expansion.label }))
        .filter((expansion) => Number.isFinite(expansion.id))
        .sort((a, b) => b.id - a.id);

const SetFilter = ({ selected = [], onChange, t, hint, disabled = false }) => {
    const sets = orderedSets();
    const all = selected.length === 0;

    const toggle = (id) =>
        onChange(selected.includes(id) ? selected.filter((set) => set !== id) : [...selected, id]);

    const chip = (isOn, key, label, onPress, title) => (
        <button
            className={[
                'rounded-full border px-2.5 py-1 text-xs transition',
                isOn
                    ? 'border-accent/60 bg-accent/15 text-accent'
                    : 'border-border/70 bg-surface-secondary/60 text-foreground hover:border-border',
                disabled ? 'cursor-not-allowed opacity-40' : ''
            ].join(' ')}
            disabled={disabled}
            key={key}
            onClick={onPress}
            title={title}
            type='button'
        >
            {label}
        </button>
    );

    return (
        <div className='space-y-1.5'>
            <div className='flex flex-wrap items-center gap-1.5'>
                {chip(all, 'all', t('All sets'), () => onChange([]), t('Show every set'))}
                <span aria-hidden='true' className='mx-0.5 h-4 w-px bg-border/70' />
                {sets.map((set) =>
                    chip(selected.includes(set.id), set.id, set.label, () => toggle(set.id))
                )}
            </div>
            {hint && <p className='m-0 text-[11px] text-muted'>{hint}</p>}
        </div>
    );
};

SetFilter.propTypes = {
    disabled: PropTypes.bool,
    hint: PropTypes.node,
    onChange: PropTypes.func.isRequired,
    selected: PropTypes.arrayOf(PropTypes.number),
    t: PropTypes.func.isRequired
};

SetFilter.displayName = 'SetFilter';

export default SetFilter;
