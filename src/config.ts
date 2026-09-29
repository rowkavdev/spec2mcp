import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ManifestOptions } from './manifest.js';

export const CONFIG_FILE = 'spec2mcp.config.json';
export type ProjectConfig = { name?: string; baseUrl?: string; include?: string[]; exclude?: string[] };

export async function readProjectConfig(path = CONFIG_FILE): Promise<ProjectConfig> {
  let text: string;
  try {
    text = await readFile(resolve(path), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path === CONFIG_FILE) return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON in ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`);
  }
  const config = parsed as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!['name', 'baseUrl', 'include', 'exclude'].includes(key)) {
      throw new Error(`Unknown key ${JSON.stringify(key)} in ${path}`);
    }
  }
  for (const key of ['name', 'baseUrl']) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new Error(`${path}: ${key} must be a string`);
    }
  }
  for (const key of ['include', 'exclude']) {
    const value = config[key];
    if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0))) {
      throw new Error(`${path}: ${key} must be an array of non-empty strings`);
    }
  }
  return config as ProjectConfig;
}

export function resolveConfig(config: ProjectConfig, flags: ProjectConfig): { options: ManifestOptions; config: ProjectConfig } {
  const effective: ProjectConfig = {
    ...(flags.name !== undefined || config.name !== undefined ? { name: flags.name ?? config.name } : {}),
    ...(flags.baseUrl !== undefined || config.baseUrl !== undefined ? { baseUrl: flags.baseUrl ?? config.baseUrl } : {}),
    ...(flags.include !== undefined || config.include !== undefined ? { include: flags.include ?? config.include } : {}),
    ...(flags.exclude !== undefined || config.exclude !== undefined ? { exclude: flags.exclude ?? config.exclude } : {}),
  };
  return { options: { serverName: effective.name, baseUrl: effective.baseUrl, include: effective.include, exclude: effective.exclude }, config: effective };
}
