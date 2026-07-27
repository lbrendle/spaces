# Spaces releases

Spaces checks `latest.json` on the official Cloudflare downloads Worker.
Tauri signs updater bundles separately from Apple Developer ID signing.

The updater private key, its password, and Apple credentials stay outside this
repository. A release build receives them only through the build environment:

```sh
npm run release:manifest -- \
  --version 0.1.15 \
  --bundle "src-tauri/target/universal-apple-darwin/release/bundle/macos/Spaces.app.tar.gz" \
  --signature "src-tauri/target/universal-apple-darwin/release/bundle/macos/Spaces.app.tar.gz.sig" \
  --installer "src-tauri/target/universal-apple-darwin/release/bundle/dmg/Spaces_0.1.15_universal.dmg"
```

Deploy `release/wrangler.jsonc` only after the signed bundle, signature,
manifest, universal binary, notarization ticket, and installer are verified.
