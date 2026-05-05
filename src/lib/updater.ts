import { ask } from "@tauri-apps/plugin-dialog"
import { relaunch } from "@tauri-apps/plugin-process"
import { check } from "@tauri-apps/plugin-updater"

export async function checkForUpdates(): Promise<void> {
  try {
    const update = await check()
    if (!update) return

    // Native dialog instead of window.confirm: doesn't block the
    // renderer the same way, and we keep the message plain-text since
    // OS dialogs render markdown literally. Detailed release notes
    // live on the GitHub Release page.
    const accepted = await ask(
      `RubberFit Desktop ${update.version} is available. Download and install now?`,
      { title: "Update available", kind: "info" }
    )
    if (!accepted) return

    await update.downloadAndInstall()
    await relaunch()
  } catch (err) {
    // Offline, no manifest, signature mismatch, etc. — don't surface
    // a startup error dialog (more disruptive than a missed check),
    // but log so devtools shows what's happening. Signature mismatch
    // in particular is worth seeing: a stale pubkey in the installed
    // app vs the current server signing key would fail every check
    // forever, and silent silence makes it invisible.
    console.warn("[updater] check failed:", err)
  }
}
