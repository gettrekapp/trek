// The phone imports the repo's shared protocol code (src/shared) straight from the source tree:
// Metro watches that folder too. That code imports no packages (scripts/sharedForMobile.test.mjs
// checks), so every package resolves from this app's node_modules (nested ones included).
const { getDefaultConfig } = require('expo/metro-config')
const path = require('node:path')

const config = getDefaultConfig(__dirname)
config.watchFolders = [path.resolve(__dirname, '../../src/shared')]
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')]

module.exports = config
