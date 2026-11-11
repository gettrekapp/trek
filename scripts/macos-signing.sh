# scripts/macos-signing.sh — sourced (bash) by the release workflow's macOS signing steps: the
# Trek.app job and the macOS trek-server tarball jobs. Needs, in the environment:
#   CSC_LINK, CSC_KEY_PASSWORD   the Developer ID Application certificate (.p12, base64) and its password
#   APPLE_API_KEY_P8, APPLE_API_KEY_ID, APPLE_API_ISSUER   (an App Store Connect API key), or
#   APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID
#   RUNNER_TEMP
# Leaves behind:
#   CSC_KEYCHAIN                 a keychain made here holding the identity (on the search list too);
#                                CSC_LINK and CSC_KEY_PASSWORD are unset
#   APPLE_API_KEY                the .p8's path, when the API key is used (Apple ID variables unset)
#   notary                       notarytool's credential arguments (an array)
#   notarize <file>              submits a .zip, .dmg or .pkg and waits; fails unless Accepted
# and an EXIT trap removing the keychain and the .p8 however the step ends.
set -euo pipefail

kc="$RUNNER_TEMP/trek-signing.keychain-db"
p12="$RUNNER_TEMP/trek-signing.p12"
trap 'rm -f "$RUNNER_TEMP"/AuthKey_*.p8 "$p12"; security delete-keychain "$kc" 2>/dev/null || true' EXIT

# The certificate goes into a keychain made here, not through CSC_LINK: electron-builder 26.15.3
# runs `security set-key-partition-list -k <the .p12's password>` on its own temp keychain, whose
# password is a different, random one, and fails ("SecKeychainUnlock: The user name or passphrase
# you entered is not correct"). With CSC_LINK unset it signs from the keychain named by CSC_KEYCHAIN.
kcpass=$(openssl rand -base64 32)
security create-keychain -p "$kcpass" "$kc"
security set-keychain-settings -lut 21600 "$kc"
security unlock-keychain -p "$kcpass" "$kc"
(umask 077; printf '%s' "$CSC_LINK" | base64 --decode > "$p12")
security import "$p12" -k "$kc" -P "$CSC_KEY_PASSWORD" -T /usr/bin/codesign -T /usr/bin/productbuild
rm -f "$p12"
security set-key-partition-list -S apple-tool:,apple: -s -k "$kcpass" "$kc" > /dev/null
# On the search list too, so codesign finds the identity's certificate chain.
security list-keychains -d user -s "$kc" $(security list-keychains -d user | tr -d '"')
identities=$(security find-identity -v -p codesigning "$kc")
case $identities in *'Developer ID Application'*) ;; *) echo "::error title=No signing identity::CSC_LINK holds no Developer ID Application identity"; exit 1 ;; esac
unset CSC_LINK CSC_KEY_PASSWORD kcpass identities
export CSC_KEYCHAIN="$kc"

if [ -n "${APPLE_API_KEY_P8:-}" ] && [ -n "${APPLE_API_KEY_ID:-}" ] && [ -n "${APPLE_API_ISSUER:-}" ]; then
  # The API key wins: electron-builder would use the Apple ID first if both were set.
  unset APPLE_ID APPLE_APP_SPECIFIC_PASSWORD
  key="$RUNNER_TEMP/AuthKey_${APPLE_API_KEY_ID}.p8"
  (umask 077; printf '%s\n' "$APPLE_API_KEY_P8" > "$key")
  export APPLE_API_KEY="$key"
  notary=(--key "$key" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER")
else
  notary=(--apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi
unset APPLE_API_KEY_P8

# Judged by the status it reports, not its exit code; a failure prints the notary's log.
notarize() {
  local file=$1 result status id
  result=$(xcrun notarytool submit "$file" "${notary[@]}" --wait --timeout 45m --output-format json) || true
  echo "$result"
  status=$(node -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).status)) } catch { process.stdout.write("no answer") }' "$result")
  if [ "$status" != Accepted ]; then
    id=$(node -e 'try { process.stdout.write(String(JSON.parse(process.argv[1]).id ?? "")) } catch {}' "$result")
    [ -z "$id" ] || xcrun notarytool log "$id" "${notary[@]}" || true
    echo "::error title=Not notarized::The notary service says \"$status\" for $file (its log is above)"
    return 1
  fi
}
