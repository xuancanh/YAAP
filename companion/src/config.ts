/** ~/.yaam-companion/config.json — the server URL, this companion's bearer
 *  token (a credential: file mode 0600, directory 0700) and the scopes the
 *  owner chose at pairing. */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface CompanionConfig {
  serverUrl: string;
  token: string;
  runnerId: string;
  name: string;
  platform: string;
  scopes: string[];
  pairedAt: string;
}

export const configDir = (): string => process.env.YAAM_COMPANION_HOME || path.join(homedir(), '.yaam-companion');
export const configPath = (): string => path.join(configDir(), 'config.json');

export async function loadConfig(): Promise<CompanionConfig | null> {
  try {
    const raw = await readFile(configPath(), 'utf8');
    const c = JSON.parse(raw) as CompanionConfig;
    if (!c.serverUrl || !c.token || !Array.isArray(c.scopes)) return null;
    return c;
  } catch {
    return null;
  }
}

export async function saveConfig(c: CompanionConfig): Promise<void> {
  await mkdir(configDir(), { recursive: true, mode: 0o700 });
  await writeFile(configPath(), JSON.stringify(c, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  // mkdir/writeFile modes are masked by umask; set them explicitly.
  await chmod(configDir(), 0o700).catch(() => {});
  await chmod(configPath(), 0o600).catch(() => {});
}

export async function clearConfig(): Promise<void> {
  await writeFile(configPath(), '{}\n', { encoding: 'utf8', mode: 0o600 }).catch(() => {});
}
