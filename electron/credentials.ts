/**
 * Credential storage.
 *
 * The `sk_` key is a workspace-wide credential: whoever holds it can read and
 * write everything in that workspace. It therefore never touches plaintext on
 * disk. Electron's safeStorage gives us the OS keychain on macOS and DPAPI on
 * Windows.
 *
 * safeStorage is not always available (some Linux setups without a secret
 * service, or a headless run). When it is not, we refuse to persist rather than
 * quietly falling back to plaintext: a silent downgrade here would be the worst
 * possible failure mode. The user is asked to sign in each launch instead.
 */
import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface StoredCredential {
  apiKey: string;
  baseUrl: string;
  workspaceId: string;
  workspaceName: string;
  encrypted: boolean;
}

function credentialPath(): string {
  return path.join(app.getPath('userData'), 'credential.json');
}

export function isSecureStorageAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

export function saveCredential(cred: Omit<StoredCredential, 'encrypted'>): void {
  if (!isSecureStorageAvailable()) {
    // Do not write anything. An unencrypted API key on disk is worse than
    // asking the user to sign in again next launch.
    throw new Error(
      'Secure credential storage is unavailable on this system. ' +
        'The app will not save your key; you will need to sign in each time.',
    );
  }
  const encrypted = safeStorage.encryptString(
    JSON.stringify({ apiKey: cred.apiKey, baseUrl: cred.baseUrl }),
  );
  const payload = {
    workspaceId: cred.workspaceId,
    workspaceName: cred.workspaceName,
    // base64 so it can live in a JSON file alongside the other fields
    secret: encrypted.toString('base64'),
  };
  fs.writeFileSync(credentialPath(), JSON.stringify(payload), { mode: 0o600 });
}

export function loadCredential(): StoredCredential | null {
  try {
    const raw = fs.readFileSync(credentialPath(), 'utf8');
    const parsed = JSON.parse(raw) as {
      workspaceId: string;
      workspaceName: string;
      secret: string;
    };
    if (!parsed.secret) return null;
    const json = safeStorage.decryptString(Buffer.from(parsed.secret, 'base64'));
    const inner = JSON.parse(json) as { apiKey: string; baseUrl: string };
    return {
      apiKey: inner.apiKey,
      baseUrl: inner.baseUrl,
      workspaceId: parsed.workspaceId,
      workspaceName: parsed.workspaceName,
      encrypted: true,
    };
  } catch {
    // Missing, corrupt, or decryptable only by a different OS user: treat as
    // signed out rather than crashing on launch.
    return null;
  }
}

export function clearCredential(): void {
  try {
    fs.rmSync(credentialPath(), { force: true });
  } catch {
    // Nothing to do: a missing file is the desired end state anyway.
  }
}
