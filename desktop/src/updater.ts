import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { config } from "./config";
import { toast } from "./toast";

type AppUpdate = NonNullable<Awaited<ReturnType<typeof check>>>;

let checking: Promise<AppUpdate | null> | null = null;
let offeredVersion = "";
let installing = false;

async function installUpdate(update: AppUpdate) {
  if (installing) return;
  installing = true;
  let downloaded = 0;
  let total = 0;
  const brand = config().brand;
  const toastId = toast.show({
    kind: "info",
    title: `Downloading ${brand} ${update.version}`,
    detail: "You can keep working until the download finishes.",
    pending: true,
    timeout: 0,
  });

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        const progress = total
          ? `${Math.min(100, Math.round((downloaded / total) * 100))}% downloaded`
          : "Downloading the signed update…";
        toast.update(toastId, { detail: progress });
      } else if (event.event === "Finished") {
        toast.update(toastId, {
          title: "Update ready",
          detail: `Restarting ${brand}…`,
        });
      }
    });
    await relaunch();
  } catch (reason) {
    installing = false;
    toast.update(toastId, {
      kind: "error",
      title: `${brand} could not update`,
      detail: reason instanceof Error ? reason.message : String(reason),
      pending: false,
      timeout: 0,
    });
  }
}

export async function checkForAppUpdate(
  options: { silent?: boolean } = {},
): Promise<AppUpdate | null> {
  if (checking) return checking;
  checking = check()
    .then((update) => {
      if (!update) {
        if (!options.silent) {
          toast.success(`${config().brand} is up to date`);
        }
        return null;
      }
      if (offeredVersion !== update.version) {
        offeredVersion = update.version;
        toast.show({
          kind: "info",
          title: `${config().brand} ${update.version} is ready`,
          detail: update.body || "Install the signed update without downloading the app again.",
          timeout: 0,
          action: {
            label: "Update and restart",
            run: () => void installUpdate(update),
          },
        });
      }
      return update;
    })
    .catch((reason) => {
      if (!options.silent) {
        toast.error("Could not check for updates", reason);
      }
      return null;
    })
    .finally(() => {
      checking = null;
    });
  return checking;
}

export function initAppUpdater(): () => void {
  const first = window.setTimeout(
    () => void checkForAppUpdate({ silent: true }),
    5_000,
  );
  const interval = window.setInterval(
    () => void checkForAppUpdate({ silent: true }),
    6 * 60 * 60 * 1_000,
  );
  return () => {
    window.clearTimeout(first);
    window.clearInterval(interval);
  };
}
