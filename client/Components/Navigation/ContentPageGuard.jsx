import React from 'react';
import { Navigate } from 'react-router-dom';

import { useGetSiteContentQuery } from '../../redux/api';

/**
 * ARCHON: gate an admin-toggleable content page (News/Articles/Blogs/Forums).
 * When the matching 'navigation' site setting is turned off the page is not
 * just hidden from the sidebar but unreachable by direct URL — visiting it
 * redirects home. While the flags are still loading we render the page rather
 * than redirect, so a slow fetch never bounces a legitimately-visible page.
 *
 * @param {{ pageKey: string, children: React.ReactNode }} props
 */
const ContentPageGuard = ({ pageKey, children }) => {
    const { data, isLoading } = useGetSiteContentQuery();

    if (!isLoading && data?.pages && data.pages[pageKey] === false) {
        return <Navigate to='/' replace />;
    }

    return children;
};

ContentPageGuard.displayName = 'ContentPageGuard';

export default ContentPageGuard;
