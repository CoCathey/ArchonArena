import React from 'react';
import { Card } from '@heroui/react';

/**
 * @typedef PanelProps
 * @property {import('react').ReactNode | import('react').ReactNodeArray} [children]
 * @property {string} [className]
 * @property {string} [contentClassName]
 * @property {string} [headerClassName]
 * @property {string} [headerTextClassName]
 * @property {string} [title]
 * @property {string} [titleClass]
 * @property {'start' | 'center'} [titleAlign]
 * @property {string} [type]
 */

/**
 * ARCHON (N16 groundwork): two changes to how a panel header reads.
 *
 * The header carried an inset amber bevel - a 1px light line along its top
 * edge - which is a gradient-era detail, and because Panel is the dominant
 * visual unit it was repeated on essentially every screen. Removed; the
 * border below the header already separates it from the content.
 *
 * Titles now align to the start and carry weight, instead of being centred
 * at normal weight. A centred, unweighted panel title reads as a caption
 * rather than a heading, which is most of why the panels looked flat.
 *
 * `titleAlign='center'` keeps the old behaviour, and the three game-board
 * panels use it: the board is deliberately last in the redesign, and its
 * phase indicator is genuinely better centred over the board than pushed
 * to one edge.
 */

/**
 * @param {PanelProps} props
 */
const Panel = ({
    title,
    titleClass,
    titleAlign = 'start',
    children,
    className,
    contentClassName,
    headerClassName,
    headerTextClassName
}) => {
    const baseClass =
        'min-h-0 flex flex-col !p-0 !gap-0 rounded-md border border-border/75 !bg-surface !text-foreground shadow-[var(--surface-shadow)]';
    /**
     * ARCHON: `flex-auto`, not `flex-1`, and it is not a style preference.
     *
     * `flex-1` is `flex: 1 1 0%` - a zero basis, which tells the layout to size
     * this box WITHOUT REGARD TO ITS CONTENT. With `overflow-hidden` on top,
     * the panel's intrinsic height became its header alone, so a Panel sitting
     * in a grid row beside another one got stretched to whatever the OTHER
     * column needed and then silently cut its own content off at that line -
     * no scrollbar, no indication, just missing.
     *
     * On the tournament page that meant an organizer whose Rounds panel was
     * taller than the Standings beside it lost the bottom of the current round:
     * the report buttons and the withdraw control were sliced through the
     * middle and could not be reached or scrolled to. The taller the round, the
     * more was gone.
     *
     * `flex-auto` is `flex: 1 1 auto` - same grow and shrink, but the content's
     * own height is the basis. The panel still fills a height it is given, and
     * now it also asks for the height it needs.
     */
    let contentClass =
        'min-h-0 flex flex-auto flex-col overflow-hidden px-3 py-2 text-foreground [&_label]:!text-foreground [&_.form-label]:!text-foreground';
    if (contentClassName) {
        contentClass += ` ${contentClassName}`;
    }
    const centered = titleAlign === 'center';
    const headerBaseClass = 'w-full !p-0 !m-0 rounded-tr-md rounded-tl-md flex items-center';
    const headerTextClass = headerTextClassName || 'text-[color:var(--heading)]';
    // No inset bevel: the bottom border is what separates header from content.
    const headerClass = headerClassName || 'border-b border-border/50 bg-surface';
    // py-1.5 rather than py-0.5: a 24px header was too cramped for the title
    // to read as a heading at all, and this is the one place the extra space
    // is inseparable from the type change.
    const headerInnerClass = `w-full px-3 py-1.5 flex items-center min-h-7 ${
        centered ? 'justify-center' : 'justify-start'
    }`;

    return (
        <Card className={`${baseClass}${className ? ` ${className}` : ''}`}>
            {title && (
                <Card.Header
                    className={`${headerBaseClass} ${headerClass} ${
                        centered ? 'text-center' : 'text-start'
                    } ${headerTextClass}${titleClass ? ` ${titleClass}` : ''}`}
                >
                    <div className={headerInnerClass}>
                        <Card.Title
                            className={`!m-0 w-full min-h-5 !leading-none flex items-center font-semibold ${
                                centered ? 'text-center justify-center' : 'text-start justify-start'
                            } ${headerTextClass}`}
                        >
                            {title}
                        </Card.Title>
                    </div>
                </Card.Header>
            )}
            <Card.Content className={contentClass}>{children}</Card.Content>
        </Card>
    );
};

export default Panel;
