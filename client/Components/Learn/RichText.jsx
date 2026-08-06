import React from 'react';

import { BonusIcons } from './learnIcons';

/**
 * ARCHON (N11): the tiny markup the tutorial's prose and card text share.
 *
 * Two things need rendering. **Bold** marks the term a step is teaching, so the
 * reader can find it again when they scroll back. The {A} {D} {C} {R} tokens
 * stand in for the Aember, damage, capture and draw glyphs: the master vault
 * card text uses private-use unicode code points for those, and the site ships
 * no font that has them, so they are stored as tokens and drawn as the same
 * icons the board uses.
 */

const TOKEN_ICONS = {
    A: { src: BonusIcons.amber, label: 'Æmber' },
    D: { src: BonusIcons.damage, label: 'damage' },
    C: { src: BonusIcons.capture, label: 'capture' },
    R: { src: BonusIcons.draw, label: 'draw' },
    P: { src: BonusIcons.power, label: 'power' },
    X: { src: BonusIcons.discard, label: 'discard' }
};

const SEGMENT = /(\*\*[^*]+\*\*|\*[^*]+\*|\{[ADCRPX]\})/g;

// Bold and italic can wrap icon tokens ("**10{A}**"), so the inner text is run
// back through the same splitter rather than dropped in as a raw string.
const renderSegments = (text, keyPrefix) =>
    text.split(SEGMENT).map((segment, index) => {
        const key = `${keyPrefix}-${index}`;

        if (segment.startsWith('**') && segment.endsWith('**')) {
            return (
                <strong key={key} className='font-semibold text-foreground'>
                    {renderSegments(segment.slice(2, -2), key)}
                </strong>
            );
        }

        if (segment.length > 2 && segment.startsWith('*') && segment.endsWith('*')) {
            return (
                <em key={key} className='italic'>
                    {renderSegments(segment.slice(1, -1), key)}
                </em>
            );
        }

        const token = segment.length === 3 && segment[0] === '{' ? TOKEN_ICONS[segment[1]] : null;

        if (token) {
            return (
                <img
                    key={key}
                    src={token.src}
                    alt={token.label}
                    title={token.label}
                    className='mx-px inline-block h-[1em] w-[1em] translate-y-[0.1em] align-baseline'
                />
            );
        }

        return <React.Fragment key={key}>{segment}</React.Fragment>;
    });

/**
 * @param {{ text: string, className?: string, as?: string }} props
 */
const RichText = ({ text, className, as: Tag = 'p' }) => {
    const lines = String(text ?? '').split('\n');

    return (
        <Tag className={className}>
            {lines.map((line, index) => (
                <React.Fragment key={index}>
                    {index > 0 && <br />}
                    {renderSegments(line, index)}
                </React.Fragment>
            ))}
        </Tag>
    );
};

RichText.displayName = 'RichText';

export default RichText;
