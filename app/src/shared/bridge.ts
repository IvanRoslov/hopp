// The API the preload bridge exposes to the page as `window.hopp`.
// Named functions only: the page never sees ipcRenderer or Node.
export interface HoppBridge {
  version: string;
}

declare global {
  interface Window {
    hopp: HoppBridge;
  }
}
