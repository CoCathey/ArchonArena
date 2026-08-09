/**
 * The image-diff harness is the one thing under `test/` that runs in a browser
 * rather than in Node: `harness.js` is loaded as a page module, and the
 * callbacks `run.js` hands to `page.evaluate` are serialized and executed in
 * the page too. `test/.eslintrc.js` declares Node only, so without this every
 * `document` and `window` here reads as undefined.
 */
module.exports = {
    env: {
        browser: true
    }
};
