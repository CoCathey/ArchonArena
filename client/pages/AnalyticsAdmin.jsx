import React from 'react';

import AnalyticsDashboard from '../Components/Admin/AnalyticsDashboard';

/**
 * ARCHON (N8): the admin operations dashboard page. The dashboard itself is
 * a component so it can also be dropped into the settings page or a future
 * combined admin view without moving the route.
 */
const AnalyticsAdmin = () => (
    <div className='mx-auto w-full max-w-3xl space-y-4'>
        <AnalyticsDashboard />
    </div>
);

AnalyticsAdmin.displayName = 'AnalyticsAdmin';

export default AnalyticsAdmin;
