/** Typed access to the preload bridge, with a guard for running in a browser. */
import type { TffBridge } from '../electron/ipc';

declare global {
  interface Window {
    tff?: TffBridge & { secureStorageAvailable(): Promise<boolean> };
  }
}

export function bridge(): TffBridge {
  const b = window.tff;
  if (!b) {
    throw new Error(
      'The ThinkFlyFlow bridge is unavailable. This UI must run inside the desktop app.',
    );
  }
  return b;
}

export async function secureStorageAvailable(): Promise<boolean> {
  try {
    return (await window.tff?.secureStorageAvailable()) ?? false;
  } catch {
    return false;
  }
}

export const DEFAULT_BASE_URL = 'https://api.laureljar.com';
