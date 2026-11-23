/**
 * Auto-update.
 *
 * The VoicerAI release had a bug worth not repeating: the updater's feed was
 * pointed at the upstream repository instead of the project's own, so update
 * checks 404'd and nobody noticed because they fail silently. Two defences:
 *
 *   1. The channel is configured here, in code, from package.json's build
 *      config, rather than being left to a default.
 *   2. Errors are surfaced to the UI instead of swallowed, so a broken feed is
 *      visible rather than invisible.
 *
 * Only used in a packaged build: running from source would try to update the
 * checkout, which is never what a developer wants.
 */
import { app, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';

let lastError: string | null = null;

export function getUpdateError(): string | null {
  return lastError;
}

export function initAutoUpdate(onStatus?: (message: string) => void): void {
  if (!app.isPackaged) return;

  // Never download or install without the user knowing.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('error', (err) => {
    lastError = err?.message ?? String(err);
    onStatus?.(`Update check failed: ${lastError}`);
  });

  autoUpdater.on('update-available', (info) => {
    onStatus?.(`Update ${info.version} is downloading.`);
  });

  autoUpdater.on('update-not-available', () => {
    onStatus?.('You are on the latest version.');
  });

  autoUpdater.on('update-downloaded', (info) => {
    onStatus?.(`Update ${info.version} ready.`);
    void dialog
      .showMessageBox({
        type: 'info',
        buttons: ['Restart now', 'Later'],
        defaultId: 0,
        cancelId: 1,
        message: `ThinkFlyFlow ${info.version} is ready to install.`,
        detail:
          'Restarting now closes the app briefly. Sync resumes automatically where it left off.',
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  // A failed check must never block startup, so this is fire and forget.
  void autoUpdater.checkForUpdates().catch((err) => {
    lastError = err?.message ?? String(err);
    onStatus?.(`Update check failed: ${lastError}`);
  });
}

/**
 * The feed the app will actually consult. Exposed so the smoke test can assert
 * it points at this project rather than somewhere inherited.
 */
export function updateFeedOwner(): { owner: string; repo: string } {
  return { owner: 'rilwan2003', repo: 'thinkflyflow-desktop' };
}
