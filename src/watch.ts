/** Regenerate a project when its source spec changes. */
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type WatchHandle = { close(): void };

export async function watchSpec(
  input: string,
  generate: () => Promise<void>,
  options: { pollIntervalMs?: number; requestTimeoutMs?: number; retryIntervalMs?: number; additionalInputs?: string[]; log?: (message: string) => void } = {},
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
  const watchers: FSWatcher[] = [];
  const additionalInputs = [...new Set((options.additionalInputs ?? []).map(file => resolve(file)))];

  async function digest(): Promise<string> {
    const bytes = isUrl
      ? await (async () => {
          const res = await fetch(input, { signal: AbortSignal.timeout(requestTimeout) });
          if (!res.ok) throw new Error(`Failed to fetch spec: HTTP ${res.status} from ${input}`);
          return Buffer.from(await res.arrayBuffer());
        })()
      : await readFile(input);
    const hash = createHash('sha256').update(bytes);
    for (const file of additionalInputs) {
      const extra = await readFile(file);
      hash.update(JSON.stringify([file, extra.length]));
      hash.update(extra);
    }
    return hash.digest('hex');
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
  }
  const localFiles = [...new Set([...(isUrl ? [] : [resolve(input)]), ...additionalInputs])];
  watchers.push(...watchLocalInputs(localFiles, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { void refresh(); }, 100);
  }, log));
  await refresh();
  log(`Watching ${input}${isUrl ? ` every ${interval / 1000}s` : ''} for changes (Ctrl+C to stop).`);
  return {
    close() {
      closed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      clearInterval(pollTimer);
      for (const watcher of watchers) watcher.close();
    },
  };
}

function watchLocalInputs(files: string[], changed: () => void, log: (message: string) => void): FSWatcher[] {
  const directories = new Map<string, Set<string>>();
  for (const file of files) {
    const names = directories.get(dirname(file)) ?? new Set<string>();
    names.add(basename(file)); directories.set(dirname(file), names);
  }
  // Watch parents so atomic replacement is picked up for every generation input.
  return [...directories].map(([directory, names]) => {
    const watcher = watchDirectory(directory, (_event, filename) => {
      if (filename === null || names.has(filename.toString())) changed();
    });
    watcher.on('error', (err) => log(`Watch: ${err.message}`));
    return watcher;
  });
}
