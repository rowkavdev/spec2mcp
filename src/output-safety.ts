/** Guard source inputs from Forge's recursive output-directory clean. */
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const isUrl = (value: string): boolean => /^https?:\/\//i.test(value);

/** Canonicalize existing path ancestors too, so symlinked output parents are checked. */
async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try { return join(await realpath(current), ...missing.reverse()); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

export async function assertOutputDoesNotContainInputs(outDir: string, inputs: { label: string; path?: string }[]): Promise<void> {
  const output = await canonicalPath(outDir);
  for (const { label, path } of inputs) {
    if (!path || isUrl(path)) continue;
    const input = await canonicalPath(path);
    const within = relative(output, input);
    if (within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within))) {
      throw new Error(`Output directory contains ${label} input (${path}); choose an output directory outside its source inputs.`);
    }
  }
}
