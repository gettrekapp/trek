// The claude adapter is a plugin's since plugins A1. This bare re-export keeps the clients'
// imports working until plugins A2 (scripts/pluginBoundaries.test.mjs).
export * from '../../../plugins/claude/shared/claude.ts'
