import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import process from "node:process";

function args(values) {
  const parsed = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index]?.replace(/^--/, "");
    const value = values[index + 1];
    if (key && value) parsed.set(key, value);
  }
  return parsed;
}

const input = args(process.argv.slice(2));
const version = input.get("version");
const bundle = input.get("bundle");
const signaturePath = input.get("signature");
const installer = input.get("installer");
const baseUrl =
  input.get("base-url") ??
  "https://spaces-downloads.ghostreader-app.workers.dev";
const notes =
  input.get("notes") ??
  "The latest signed universal Spaces release.";

if (!version || !bundle || !signaturePath || !installer) {
  throw new Error(
    "Usage: npm run release:manifest -- --version 0.1.16 --bundle <app.tar.gz> --signature <app.tar.gz.sig> --installer <universal.dmg>",
  );
}

const assets = resolve("release/assets");
await mkdir(assets, { recursive: true });
const updateName = `Spaces-${version}-universal.app.tar.gz`;
const installerName = `Spaces-${version}-universal.dmg`;
await Promise.all([
  copyFile(resolve(bundle), resolve(assets, updateName)),
  copyFile(resolve(installer), resolve(assets, installerName)),
]);
const signature = (await readFile(resolve(signaturePath), "utf8")).trim();
if (!signature) {
  throw new Error(`The updater signature is empty: ${basename(signaturePath)}`);
}

const platform = {
  signature,
  url: `${baseUrl}/${updateName}`,
};
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "darwin-aarch64": platform,
    "darwin-x86_64": platform,
  },
};
await writeFile(
  resolve(assets, "latest.json"),
  `${JSON.stringify(manifest, null, 2)}\n`,
  "utf8",
);
await writeFile(
  resolve(assets, "release.json"),
  `${JSON.stringify(
    {
      version,
      installer: `${baseUrl}/${installerName}`,
      updater: `${baseUrl}/latest.json`,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(`Prepared ${version}: ${installerName}, ${updateName}, latest.json`);
