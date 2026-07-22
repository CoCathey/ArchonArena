import React from 'react';
import ReactMarkdown from 'react-markdown';

import Panel from './Panel';
import { useGetSiteContentQuery } from '../../redux/api';

/**
 * ARCHON: admin-authored page content (Site Content settings section).
 * Wrap a built-in page with this; when the admin has written Markdown for
 * `field` ('about' | 'privacy') it replaces the built-in content, otherwise
 * the children render unchanged. react-markdown escapes raw HTML, so the
 * content cannot inject scripts.
 */
const SiteContentOverride = ({ field, title, children }) => {
    const { data } = useGetSiteContentQuery();
    const markdown = data?.[field];

    if (!markdown) {
        return children;
    }

    return (
        <div className='min-h-full w-full'>
            <Panel title={title}>
                <div className='prose-headings:text-foreground space-y-3 text-sm leading-relaxed text-foreground/90 [&_a]:text-amber-300 [&_a]:underline [&_h1]:text-xl [&_h1]:font-bold [&_h2]:text-lg [&_h2]:font-bold [&_h3]:text-base [&_h3]:font-semibold [&_li]:ml-5 [&_ul]:list-disc'>
                    <ReactMarkdown>{markdown}</ReactMarkdown>
                </div>
            </Panel>
        </div>
    );
};

SiteContentOverride.displayName = 'SiteContentOverride';

export default SiteContentOverride;
