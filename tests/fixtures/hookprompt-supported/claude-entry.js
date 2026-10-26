#!/usr/bin/env node
// Keep the historical entry usable in both CommonJS and ESM project trees.
const failOpen = () => { process.stdout.write(JSON.stringify({})); };
if (typeof module === 'object' && typeof require === 'function') {
    try {
        const implementation = require('./user-prompt-submit.cjs');
        module.exports = implementation;
        if (require.main === module) implementation.main().catch(failOpen);
    } catch {
        failOpen();
    }
} else {
    import('./user-prompt-submit.cjs')
        .then(({ default: implementation }) => implementation.main())
        .catch(failOpen);
}
