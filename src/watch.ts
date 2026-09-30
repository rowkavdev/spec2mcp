/** Regenerate a project when its source spec changes. */
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type WatchHandle = { close(): void };

export async function watchSpec(
  input: string,
  generate: () => Promise<void>,
  options: { pollIntervalMs?: number; requestTimeoutMs?: number; retryIntervalMs?: number; log?: (message: string) => void } = {},
): Promise<WatchHandle> {
  const log = options.log ?? ((message: string) => console.error(message));
  const isUrl = /^https?:\/\//i.test(input);
  const interval = options.pollIntervalMs ?? 30_000;
  if (!Number.isFinite(interval) || interval <= 0) throw new Error('Poll interval must be a positive number');
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isFinite(requestTimeout) || requestTimeout <= 0) throw new Error('Request timeout must be a positive number');
  const retryInterval = options.retryIntervalMs ?? 1_000;
  if (!Number.isFinite(retryInterval) || retryInterval <= 0) throw new Error('Retry interval must be a positive number');
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let running = false;
  let pending = false;
  let fingerprint: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;

  async function digest(): Promise<string> {
    const bytes = isUrl
      ? await (async () => {
          const res = await fetch(input, { signal: AbortSignal.timeout(requestTimeout) });
          if (!res.ok) throw new Error(`Failed to fetch spec: HTTP ${res.status} from ${input}`);
          return Buffer.from(await res.arrayBuffer());
        })()
      : await readFile(input);
    return createHash('sha256').update(bytes).digest('hex');
  }

  async function refresh(): Promise<void> {
    if (closed || running) { pending = !closed; return; }
    clearTimeout(retryTimer);
    running = true;
    try {
      do {
        pending = false;
        try {
          const next = await digest();
          if (closed) break;
          if (next !== fingerprint) {
            // Keep retrying an unchanged invalid spec until it generates successfully.
            await generate();
            fingerprint = next;
            clearTimeout(retryTimer);
          }
        } catch (err) {
          log(`Watch: ${err instanceof Error ? err.message : String(err)}`);
          if (!isUrl && !closed) retryTimer = setTimeout(() => { void refresh(); }, retryInterval);
        }
      } while (pending && !closed);
    } finally {
      running = false;
    }
  }

  if (isUrl) {
    pollTimer = setInterval(() => { void refresh(); }, interval);
  } else {
    const absolute = resolve(input);
    // Watch the parent, not the file: editors often replace the file by rename.
    watcher = watchDirectory(dirname(absolute), (_event, filename) => {
      if (filename === null || filename.toString() === basename(absolute)) {
        clearTimeout(timer);
        timer = setTimeout(() => { void refresh(); }, 100);
      }
    });
    watcher.on('error', (err) => log(`Watch: ${err.message}`));
  }
  await refresh();
  log(`Watching ${input}${isUrl ? ` every ${interval / 1000}s` : ''} for changes (Ctrl+C to stop).`);
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearInterval(pollTimer);
      watcher?.close();
    },
  };
}
