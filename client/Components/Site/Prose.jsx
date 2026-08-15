import React from 'react';
import PropTypes from 'prop-types';

/**
 * ARCHON: the shared furniture for the site's long-form pages - How to Play,
 * About, Privacy and Terms.
 *
 * Those four had drifted into four different shapes: bare `<h3>` runs, ad-hoc
 * `<ul>`s, paragraphs at whatever width the panel happened to be. Read one
 * after another they did not look like the same site, and none of them was
 * skimmable - which matters most for exactly this kind of page, where almost
 * nobody reads top to bottom. They arrive from a link, looking for one answer.
 *
 * So the pieces here are built around finding things rather than around
 * decoration:
 *
 *   Contents   a jump list, because these pages are long
 *   Section    a heading with a stable anchor, so any part can be linked to
 *   Lead       the one-sentence answer, before the detail
 *   Definitions a term/explanation grid for the many "what does X mean" lists
 *   Callout    the handful of things a reader must not miss
 *
 * Measure is capped at ~68 characters. Text running the full width of a
 * desktop panel is the single biggest reason a page of prose feels like work.
 */

/** Body copy, held to a readable measure. */
export const P = ({ children, className = '' }) => (
    <p className={`m-0 mb-3 max-w-[68ch] text-sm leading-relaxed text-foreground ${className}`}>
        {children}
    </p>
);

P.propTypes = { children: PropTypes.node, className: PropTypes.string };

/** The opening line of a page or a section: the answer before the detail. */
export const Lead = ({ children }) => (
    <p className='m-0 mb-4 max-w-[68ch] text-base leading-relaxed text-foreground'>{children}</p>
);

Lead.propTypes = { children: PropTypes.node };

/**
 * A titled section with a linkable anchor.
 *
 * `scroll-mt` keeps the heading clear of the sticky site header when someone
 * arrives on the anchor - without it the target lands underneath the header
 * and the reader sees the middle of the section they asked for.
 */
export const Section = ({ id, title, children, lead }) => (
    <section className='mb-7 scroll-mt-20' id={id}>
        <h2 className='m-0 mb-2 border-b border-border/50 pb-1.5 text-lg font-semibold text-[color:var(--heading)]'>
            {title}
        </h2>
        {lead && <Lead>{lead}</Lead>}
        {children}
    </section>
);

Section.propTypes = {
    children: PropTypes.node,
    id: PropTypes.string,
    lead: PropTypes.node,
    title: PropTypes.node
};

/** A heading inside a section. */
export const SubSection = ({ id, title, children }) => (
    <div className='mb-4 scroll-mt-20' id={id}>
        <h3 className='m-0 mb-1.5 text-sm font-semibold uppercase tracking-wide text-muted'>
            {title}
        </h3>
        {children}
    </div>
);

SubSection.propTypes = { children: PropTypes.node, id: PropTypes.string, title: PropTypes.node };

/** A plain bulleted list at the same measure as the prose. */
export const Bullets = ({ items }) => (
    <ul className='m-0 mb-3 max-w-[68ch] list-disc space-y-1.5 pl-5 text-sm leading-relaxed text-foreground'>
        {items.map((item, index) => (
            <li key={index}>{item}</li>
        ))}
    </ul>
);

Bullets.propTypes = { items: PropTypes.arrayOf(PropTypes.node) };

/**
 * Term and explanation, side by side on a wide screen and stacked on a narrow
 * one. Most of what these pages have to say is shaped this way - what a format
 * is, what a tier includes, what a piece of data is kept for - and running it
 * as prose buries the term the reader is scanning for.
 */
export const Definitions = ({ items }) => (
    <dl className='m-0 mb-3 grid gap-x-4 gap-y-2 sm:grid-cols-[minmax(9rem,14rem)_1fr]'>
        {items.map((item, index) => (
            <React.Fragment key={index}>
                <dt className='text-sm font-semibold text-foreground sm:text-right'>{item.term}</dt>
                <dd className='m-0 max-w-[62ch] text-sm leading-relaxed text-muted'>
                    {item.description}
                </dd>
            </React.Fragment>
        ))}
    </dl>
);

Definitions.propTypes = {
    items: PropTypes.arrayOf(PropTypes.shape({ description: PropTypes.node, term: PropTypes.node }))
};

/** The few things a reader genuinely must not skim past. */
export const Callout = ({ children, tone = 'info' }) => {
    const tones = {
        info: 'border-accent/40 bg-accent/10',
        warn: 'border-amber-500/40 bg-amber-500/10'
    };

    return (
        <div
            className={`mb-3 max-w-[68ch] rounded-md border px-3 py-2 text-sm leading-relaxed text-foreground ${
                tones[tone] || tones.info
            }`}
        >
            {children}
        </div>
    );
};

Callout.propTypes = { children: PropTypes.node, tone: PropTypes.oneOf(['info', 'warn']) };

/** Jump links, for pages long enough that scrolling is not a search. */
export const Contents = ({ items, label }) => (
    <nav
        aria-label={label}
        className='mb-6 rounded-md border border-border/60 bg-surface-secondary/40 px-3 py-2'
    >
        <div className='mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted'>
            {label}
        </div>
        <ul className='m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0'>
            {items.map((item) => (
                <li key={item.id}>
                    <a className='text-sm text-accent hover:underline' href={`#${item.id}`}>
                        {item.title}
                    </a>
                </li>
            ))}
        </ul>
    </nav>
);

Contents.propTypes = {
    items: PropTypes.arrayOf(PropTypes.shape({ id: PropTypes.string, title: PropTypes.node })),
    label: PropTypes.node
};

/** A card in a feature grid - used on About to show what the site actually is. */
export const FeatureCard = ({ title, children }) => (
    <div className='rounded-md border border-border/70 bg-surface-secondary/40 p-3'>
        <h3 className='m-0 mb-1 text-sm font-semibold text-foreground'>{title}</h3>
        <p className='m-0 text-sm leading-relaxed text-muted'>{children}</p>
    </div>
);

FeatureCard.propTypes = { children: PropTypes.node, title: PropTypes.node };

/** The grid FeatureCards sit in. */
export const FeatureGrid = ({ children }) => (
    <div className='mb-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3'>{children}</div>
);

FeatureGrid.propTypes = { children: PropTypes.node };

/** A page wrapper: one measure, one rhythm, on every long-form page. */
export const ProsePage = ({ children }) => <div className='mx-auto max-w-4xl p-3'>{children}</div>;

ProsePage.propTypes = { children: PropTypes.node };
