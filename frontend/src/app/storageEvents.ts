/** Fired on window when something may have changed how much the account stores. */
export const STORAGE_CHANGED = 'tlingual:storage-changed'

/** Asks the storage shown in the sidebar to be read again. */
export function notifyStorageChanged() {
  window.dispatchEvent(new Event(STORAGE_CHANGED))
}
