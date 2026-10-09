/** Regenerate a project when its source spec changes. */
import { watch as watchDirectory, type FSWatcher } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export type WatchHandle = { close(): void };

export async function watchSpec(
  input: string,
  generate: () => Promise<void>,
  options: { pollIntervalMs?: number; requestTimeoutMs?: number; retryIntervalMs?: number; additionalInputs?: string[]; discoverInputs?: () => Promise<string[]>; log?: (message: string) => void } = {},
): Promise<WatchHandle> {
  const log = options.log ?? ((message: string) => console.error(message));
  const isUrl = /^https?:\/\//i.test(input);
  const interval = options.pollIntervalMs ?? 30_000;
  if (!Number.isFinite(interval) || interval < 1 || interval > 2_147_483_647) throw new Error('Poll interval must be between 1 and 2147483647 milliseconds');
  const requestTimeout = options.requestTimeoutMs ?? 30_000;
  if (!Number.isInteger(requestTimeout) || requestTimeout < 1 || requestTimeout > 2_147_483_647) throw new Error('Request timeout must be an integer between 1 and 2147483647 milliseconds');
  const retryInterval = options.retryIntervalMs ?? 1_000;
  if (!Number.isFinite(retryInterval) || retryInterval < 1 || retryInterval > 2_147_483_647) throw new Error('Retry interval must be between 1 and 2147483647 milliseconds');
  let retryTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let running = false;
  let pending = false;
  let fingerprint: string | undefined;
  let timer: NodeJS.Timeout | undefined;
  let pollTimer: NodeJS.Timeout | undefined;
  let watchers: FSWatcher[] = [];
  let watchedKey = '';
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
    // Files the spec pulls in through external $refs. Discovery fails while the
    // root is invalid; the next refresh finds them again once it parses.
    const discovered = await (options.discoverInputs?.() ?? Promise.resolve([])).catch(() => []);
    const dependencies = [...new Set(discovered.map(file => resolve(file)))]
      .filter(file => !additionalInputs.includes(file) && (isUrl || file !== resolve(input)))
      .sort();
    await syncWatchers(dependencies);
    for (const file of [...additionalInputs, ...dependencies]) {
      const extra = await readFile(file).catch((err: NodeJS.ErrnoException) => { if (dependencies.includes(file) && err.code === 'ENOENT') return Buffer.alloc(0); throw err; });
      hash.update(JSON.stringify([file, extra.length]));
      hash.update(extra);
    }
    return hash.digest('hex');
  }

  async function syncWatchers(dependencies: string[]): Promise<void> {
    if (closed) return;
    const files = [...new Set([...(isUrl ? [] : [resolve(input)]), ...additionalInputs, ...dependencies])];
    // Directory watching sees changes to a symlink, not writes to its target.
    // Keep both paths so retargeting the link and editing the current target
    // are observed, including atomic replacement of either file.
    const targets = await Promise.all(files.map(file => realpath(file).catch((err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return file;
      throw err;
    })));
    if (closed) return;
    const watchedFiles = [...new Set([...files, ...targets])];
    const key = watchedFiles.join('\0');
    if (key === watchedKey) return;
    const nextWatchers = watchLocalInputs(watchedFiles, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { void refresh(); }, 100);
    }, log);
    for (const watcher of watchers) watcher.close();
    watchers = nextWatchers;
    watchedKey = key;
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
  try {
    await syncWatchers([]);
    await refresh();
  } catch (error) {
    closed = true;
    clearTimeout(timer);
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    for (const watcher of watchers) watcher.close();
    throw error;
  }
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
  const watchers: FSWatcher[] = [];
  try {
    for (const [directory, names] of directories) {
      const watcher = watchDirectory(directory, (_event, filename) => {
        if (filename === null || names.has(filename.toString())) changed();
      });
      watcher.on('error', (err) => log(`Watch: ${err.message}`));
      watchers.push(watcher);
    }
    return watchers;
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
}
