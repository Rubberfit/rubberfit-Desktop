import { check } from "@tauri-apps/plugin-updater"
import { relaunch } from "@tauri-apps/plugin-process"

export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check()
    if (!update) return

    const accepted = window.confirm(
      `RubberFit Desktop ${update.version} is available.\n\n` +
        (update.body ?? "") +
        "\n\nDownload and install now?"
    )
    if (!accepted) return

    await update.downloadAndInstall()
    await relaunch()
  } catch {
    // Offline, no manifest, signature mismatch, etc. — fail silently;
    // the next launch will retry. Hard failures here would be more
    // disruptive than a missed check.
  }
}
