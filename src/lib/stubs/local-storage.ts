// STUB: ported from rema-portal app/lib/local-storage.client.ts —
// localStorage helpers are framework-agnostic, no Next.js coupling
// (the original "use client" directive was a noop on the desktop
// build). Kept as-is so use-preset-state and any future hook can keep
// its existing imports.

export function setLocalStorageValue(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value)
  } catch (error) {
    if (import.meta.env.MODE !== "production") {
      console.error("[localStorage] Failed to write value:", error)
    }
  }
}

export function getLocalStorageValue(key: string): string | null {
  try {
    return window.localStorage.getItem(key)
  } catch (_error) {
    return null
  }
}

export function removeLocalStorageValue(key: string): void {
  try {
    window.localStorage.removeItem(key)
  } catch (error) {
    if (import.meta.env.MODE !== "production") {
      console.error("[localStorage] Failed to remove value:", error)
    }
  }
}
