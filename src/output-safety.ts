/** Guard source inputs from being mixed into the generated output directory. */
import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

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

function containsPath(output: string, input: string): boolean {
  const within = relative(output, input);
  return within === '' || (within !== '..' && !within.startsWith(`..${sep}`) && !isAbsolute(within));
}

export async function assertOutputDoesNotContainInputs(outDir: string, inputs: { label: string; path?: string }[]): Promise<void> {
  const output = await canonicalPath(outDir);
  for (const { label, path } of inputs) {
    if (!path || isUrl(path)) continue;
    const input = await canonicalPath(path);
    // Finalize replaces the input's directory entry even when it is a link
    // to a file outside output. Resolve the parent without following that
    // final link so both the source entry and its target stay protected.
    const absolute = resolve(path);
    const entry = join(await canonicalPath(dirname(absolute)), basename(absolute));
    if (containsPath(output, input) || containsPath(output, entry)) {
      throw new Error(`Output directory contains ${label} input (${path}); choose an output directory outside its source inputs.`);
    }
  }
}
