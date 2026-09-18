#!/bin/sh
# Give a local debug build the same code identity the shipped app has.
#
# Tauri ad-hoc signs debug bundles with a hash-derived identifier that changes
# on every compile. macOS keys TCC — Accessibility, Screen Recording, anything
# a person grants once — on that identity, so an unsigned debug build loses
# every permission on each rebuild and leaves a dead entry behind in the list.
#
# Signing with the real Developer ID and the real bundle identifier makes a
# grant survive rebuilds, which is the difference between testing a permission
# once and being able to work on the feature.
#
# Local only: this signs, it does not notarize or distribute.
set -e
APP="${1:-desktop/src-tauri/target/debug/bundle/macos/Spaces.app}"
IDENTITY="${SPACES_SIGN_IDENTITY:-Developer ID Application: lauren brendle (LAJ5Z8VAUC)}"

[ -d "$APP" ] || { echo "no app bundle at $APP" >&2; exit 1; }
codesign --force --deep --sign "$IDENTITY" \
  --identifier app.spaces.desktop --options runtime "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | grep -E "^Identifier|^TeamIdentifier"
