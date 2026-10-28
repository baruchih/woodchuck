// Download with a "Save as" dialog where the browser supports it (Chrome/Edge
// desktop, secure context). Elsewhere the caller's <a download> runs as usual.

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options?: { suggestedName?: string }) => Promise<{
    createWritable: () => Promise<WritableStream<Uint8Array>>;
  }>;
}

export function canPickSaveLocation(): boolean {
  return typeof (window as unknown as SaveFilePickerWindow).showSaveFilePicker === 'function';
}

/**
 * Click handler for a download link. Opens the save dialog and streams the
 * response straight to the chosen file (no buffering, so large files are fine).
 * Leaves the event alone when the dialog isn't available.
 */
export function saveDownloadOnClick(url: string, filename: string, onError?: (message: string) => void) {
  return (e: { preventDefault: () => void; stopPropagation: () => void }) => {
    e.stopPropagation();
    const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
    if (!picker) return;
    e.preventDefault();
    void (async () => {
      let handle;
      try {
        handle = await picker({ suggestedName: filename });
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return; // dialog cancelled
        // Blocked (e.g. a system folder) — fall back to a normal download
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        return;
      }
      try {
        const res = await fetch(url);
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        await res.body.pipeTo(await handle.createWritable());
      } catch (err) {
        (onError ?? console.error)(`Download failed: ${(err as Error).message}`);
      }
    })();
  };
}
