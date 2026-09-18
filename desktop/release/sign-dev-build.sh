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
# It also moves the app out of the build tree. The bundle Tauri produces lives
# under target/debug/, inside a hidden .claude/worktrees/ path, and is deleted
# and recreated on every compile — three things that make macOS treat it as a
# different, disposable app each time. Permissions granted to such a bundle
# have nowhere stable to attach. ~/Applications is an ordinary, visible,
# permanent location, which is what a TCC entry needs to mean anything.
set -e
BUILT="${1:-desktop/src-tauri/target/debug/bundle/macos/Spaces.app}"
INSTALLED="${SPACES_DEV_APP:-$HOME/Applications/Spaces Dev.app}"
IDENTITY="${SPACES_SIGN_IDENTITY:-Developer ID Application: lauren brendle (LAJ5Z8VAUC)}"

[ -d "$BUILT" ] || { echo "no app bundle at $BUILT" >&2; exit 1; }

mkdir -p "$(dirname "$INSTALLED")"
# ditto rather than cp: it preserves the bundle's extended attributes and
# symlinks, which a plain copy mangles and codesign then rejects.
rm -rf "$INSTALLED"
ditto "$BUILT" "$INSTALLED"

# Signed in place, at the path the permission will be attached to.
codesign --force --deep --sign "$IDENTITY" \
  --identifier app.spaces.desktop --options runtime "$INSTALLED"
codesign --verify --strict "$INSTALLED"
codesign -dv --verbose=2 "$INSTALLED" 2>&1 | grep -E "^Identifier|^TeamIdentifier"
echo "installed: $INSTALLED"
