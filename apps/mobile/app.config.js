// The build's config: app.json, plus what a build supplies from outside the repo (6b).
// - Android push needs the Firebase project's google-services.json: GOOGLE_SERVICES_JSON (a path;
//   an EAS "file" environment variable gives one) or ./google-services.json (git-ignored). Without
//   it the build has no FCM, and the phone says so instead of registering for push.
// - TREK_RELAY_URL / TREK_RELAY_KEY: the push relay's address and registration key, over
//   app.json's extra.relayUrl / extra.relayKey.
// - TREK_APNS_MODE=production: the iOS push entitlement for TestFlight and App Store builds
//   (the expo-notifications plugin's `mode`; development builds use the APNs sandbox).
// - The manifest says the portrait screen is optional. expo-camera brings ML Kit's scanner
//   activities, which are locked to portrait, so Google Play would otherwise infer
//   android.hardware.screen.portrait as required and hide the app from landscape-only devices.
const fs = require('node:fs')
const path = require('node:path')
const { withAndroidManifest } = require('expo/config-plugins')

const PORTRAIT = 'android.hardware.screen.portrait'

function withOptionalPortraitScreen(config) {
  return withAndroidManifest(config, (c) => {
    const manifest = c.modResults.manifest
    const features = (manifest['uses-feature'] ?? []).filter((f) => f.$['android:name'] !== PORTRAIT)
    features.push({ $: { 'android:name': PORTRAIT, 'android:required': 'false' } })
    manifest['uses-feature'] = features
    return c
  })
}

module.exports = ({ config }) => {
  const googleServices = process.env.GOOGLE_SERVICES_JSON || './google-services.json'
  const android = { ...config.android }
  if (fs.existsSync(path.resolve(__dirname, googleServices))) android.googleServicesFile = googleServices
  else delete android.googleServicesFile

  const extra = {
    ...config.extra,
    relayUrl: process.env.TREK_RELAY_URL ?? config.extra?.relayUrl ?? '',
    relayKey: process.env.TREK_RELAY_KEY ?? config.extra?.relayKey ?? ''
  }

  const mode = process.env.TREK_APNS_MODE === 'production' ? 'production' : undefined
  const plugins = (config.plugins ?? []).map((p) => {
    const [name, props] = Array.isArray(p) ? p : [p, undefined]
    if (name !== 'expo-notifications' || !mode) return p
    return [name, { ...props, mode }]
  })

  return withOptionalPortraitScreen({ ...config, android, extra, plugins })
}
