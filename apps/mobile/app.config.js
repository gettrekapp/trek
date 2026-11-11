// The build's config: app.json, plus what a build supplies from outside the repo (6b).
// - Android push needs the Firebase project's google-services.json: GOOGLE_SERVICES_JSON (a path;
//   an EAS "file" environment variable gives one) or ./google-services.json (git-ignored). Without
//   it the build has no FCM, and the phone says so instead of registering for push.
// - TREK_RELAY_URL / TREK_RELAY_KEY: the push relay's address and registration key, over
//   app.json's extra.relayUrl / extra.relayKey.
// - TREK_APNS_MODE=production: the iOS push entitlement for TestFlight and App Store builds
//   (the expo-notifications plugin's `mode`; development builds use the APNs sandbox).
const fs = require('node:fs')
const path = require('node:path')

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

  return { ...config, android, extra, plugins }
}
