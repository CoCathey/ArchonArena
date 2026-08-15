module.exports = {
    root: true,
    env: {
        node: true,
        es6: true,
        browser: true
    },
    parserOptions: {
        ecmaVersion: 11,
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true
        }
    },
    plugins: ['react', 'prettier'],
    extends: [
        'eslint:recommended',
        'plugin:react-hooks/recommended',
        'plugin:react/recommended',
        'plugin:prettier/recommended'
    ],
    rules: {
        'react/prop-types': 'off',
        curly: ['error', 'all'],
        // ARCHON (N12): HeroUI's Button does not forward `href` - it renders a
        // <button>, so `<HeroButton as='a' href=...>` produces a control that
        // looks entirely correct and navigates nowhere. That shipped on the
        // membership page and every "Choose <tier>" button silently did
        // nothing, which is unusually hard to spot in review: the markup reads
        // exactly like a working link.
        //
        // Every other external link in this codebase is a plain <a>. This makes
        // the mistake impossible rather than a thing to remember.
        'no-restricted-syntax': [
            'error',
            {
                selector:
                    "JSXOpeningElement[name.name='HeroButton'] > JSXAttribute[name.name='href']",
                message:
                    'HeroUI Button does not forward href and will render a <button> that goes nowhere. Use a plain <a> styled as a button, or Link.'
            },
            {
                selector:
                    "JSXOpeningElement[name.name='HeroButton'] > JSXAttribute[name.name='as'][value.value='a']",
                message:
                    "HeroUI Button does not render an anchor for as='a'. Use a plain <a> styled as a button, or Link."
            }
        ]
    },
    settings: {
        react: {
            version: 'detect'
        }
    }
};
