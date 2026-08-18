const fs = require('fs');
const path = require('path');

/**
 * ARCHON (N38): buttons that navigate nowhere.
 *
 * HeroUI's Button renders a plain <button> and forwards neither `href` nor
 * `as`. So `<HeroButton as={Link} to='/somewhere'>` compiles, renders, styles
 * correctly, and does nothing at all when clicked - the worst shape a UI bug
 * can take, because there is nothing to see and nothing in any log.
 *
 * This has now cost two features. Membership.jsx carries a comment about the
 * first (`as='a'` on the checkout buttons, which meant nobody could subscribe),
 * and the Deep Probe's Vault Tour invite was reported by a member as "the open
 * champion challenge button doesn't work" - the same trap, in the same
 * codebase, with a warning already written down beside it.
 *
 * A comment did not prevent the second one, so this is a test.
 */
const CLIENT = path.join(__dirname, '..', '..', 'client');

const jsxFiles = (dir) =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);

        if (entry.isDirectory()) {
            return jsxFiles(full);
        }

        return entry.isFile() && entry.name.endsWith('.jsx') ? [full] : [];
    });

describe('navigation that actually navigates', function () {
    const files = jsxFiles(CLIENT);

    it('finds jsx to check, so a broken glob cannot pass this silently', function () {
        expect(files.length).toBeGreaterThan(50);
    });

    it('never asks a HeroUI Button to be a link', function () {
        const offenders = [];

        for (const file of files) {
            const source = fs.readFileSync(file, 'utf8');

            // Only real code - the two explanatory comments about this very
            // trap must not fail the test that exists because of them.
            const code = source
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .split('\n')
                .filter((line) => !line.trim().startsWith('//'))
                .join('\n');

            if (/<(Hero)?Button[^>]*\bas=\{?['"]?(Link|a)\b/.test(code)) {
                offenders.push(path.relative(CLIENT, file));
            }
        }

        // Use a <Link> styled as a button, or an <a> for anything external.
        expect(offenders).toEqual([]);
    });

    it('keeps the Deep Probe invite pointing somewhere', function () {
        const source = fs.readFileSync(path.join(CLIENT, 'pages', 'DeepProbe.jsx'), 'utf8');

        expect(source).toContain("to={unlocked ? '/champions-challenge' : '/membership'}");
        // A Link, so the route actually changes.
        expect(source).toMatch(/<Link\b[\s\S]{0,400}?champions-challenge/);
    });
});
