const fs = require('fs');
const path = require('path');

/**
 * ARCHON (N37): the grant panel exists AND is mounted.
 *
 * The reason this file is here rather than only the server-side entitlement
 * specs: every piece of the grant mechanism already worked. The columns, the
 * resolver, the admin endpoint and even the RTK mutation had been in the
 * codebase since N12, fully tested, and the feature did not exist - because
 * nothing rendered a button. That failure is invisible to any test of the
 * parts, and it has now happened three times in this project (the analytics
 * route, the Vault Tour field, this).
 *
 * So the thing asserted is the wiring: the panel uses the mutation, the
 * settings page renders the panel, and the trial button sends the tier and a
 * bounded expiry rather than an open-ended comp.
 */
const read = (relative) => fs.readFileSync(path.join(__dirname, '..', '..', relative), 'utf8');

describe('the membership grant panel', function () {
    const panel = read('client/Components/Admin/MembershipGrants.jsx');
    const settingsPage = read('client/pages/SettingsAdmin.jsx');

    it('is rendered by the admin settings page', function () {
        expect(settingsPage).toContain("from '../Components/Admin/MembershipGrants'");
        expect(settingsPage).toContain('<MembershipGrants />');
    });

    it('grants through the admin endpoint rather than inventing its own', function () {
        expect(panel).toContain('useGrantMembershipMutation');
        expect(panel).toContain('useGetAdminMembershipsQuery');
    });

    it('offers the seven-day Vault Master trial as one click', function () {
        expect(panel).toContain('const TRIAL_DAYS = 7');
        expect(panel).toContain("const TRIAL_TIER = 'vault_master'");
        expect(panel).toContain('Give {{days}}-day Vault Master trial');
    });

    it('sends an expiry with the trial, so it cannot become a permanent comp', function () {
        // The single most important property of this button: a trial that never
        // ends is a free tier handed out by accident, one account at a time.
        expect(panel).toMatch(/until:\s*until\(TRIAL_DAYS\)/);
    });

    it('revokes by clearing the tier, which leaves a paid membership alone', function () {
        expect(panel).toMatch(/tier:\s*null/);
    });

    it('shows what has already been comped', function () {
        // A grant screen that cannot show its own grants invites the same comp
        // twice and an expiry nobody can plan around.
        expect(panel).toContain('Current comps');
        expect(panel).toContain('member.grantedUntil');
    });
});
