#!/usr/bin/env node
// Dynamic relative import is valid in CommonJS and ESM projects alike.
// Codex consumes stdin even if its host supplies incidental CLI arguments.
import('../../.claude/hooks/user-prompt-submit.cjs')
    .then(({ default: implementation }) => implementation.main({ stdinOnly: true }))
    .catch(() => { process.stdout.write(JSON.stringify({})); });
