import React from 'react';

import AnalyticsDashboard from '../Components/Admin/AnalyticsDashboard';
// ARCHON (N26): the Champion's Challenge lab's vital signs. Here rather than on
// a route of its own because this is the page an operator already opens to ask
// "is the site working", and the lab is part of the answer.
import LabHealth from '../Components/Admin/LabHealth';

/**
 * ARCHON (N8): the admin operations dashboard page. The dashboard itself is
 * a component so it can also be dropped into the settings page or a future
 * combined admin view without moving the route.
 */
const AnalyticsAdmin = () => (
    <div className='mx-auto w-full max-w-3xl space-y-4'>
        <AnalyticsDashboard />
        <LabHealth />
    </div>
);

AnalyticsAdmin.displayName = 'AnalyticsAdmin';

export default AnalyticsAdmin;
