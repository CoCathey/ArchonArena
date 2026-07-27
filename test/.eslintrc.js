module.exports = {
    root: true,
    env: {
        node: true,
        // parserOptions already accepts ES2020 syntax, but without this the
        // matching globals (Map, Set, Promise, globalThis...) are undeclared, so
        // using any of them in a test trips no-undef.
        es2020: true
    },
    parserOptions: {
        ecmaVersion: 11,
        sourceType: 'module',
        ecmaFeatures: {
            jsx: true
        }
    },
    plugins: ['react', 'prettier'],
    extends: ['eslint:recommended', 'plugin:react/recommended', 'plugin:prettier/recommended'],
    rules: {
        'no-restricted-syntax': [
            'error',
            {
                selector: 'MemberExpression[object.name="describe"][property.name="only"]',
                message: 'Remove focused test (describe.only)'
            },
            {
                selector: 'MemberExpression[object.name="it"][property.name="only"]',
                message: 'Remove focused test (it.only)'
            }
        ]
    },
    settings: {
        react: {
            version: 'detect'
        }
    },
    globals: {
        afterEach: true,
        beforeEach: true,
        describe: true,
        expect: true,
        globalThis: true,
        it: true,
        vi: true
    }
};
