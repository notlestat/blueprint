// Finds an agent's command-line program, such as `claude` or `codex`.
//
// An app opened from Finder does not get the PATH your terminal has. It gets
// /usr/bin:/bin:/usr/sbin:/sbin, so a program in ~/.local/bin or Homebrew's
// folder looks missing. This searches PATH, then the folders these programs
// usually install into.

import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const USUAL = ['~/.local/bin', '~/.claude/local', '/opt/homebrew/bin', '/usr/local/bin', '~/.npm-global/bin', '~/.bun/bin', '~/.volta/bin'];

const executable = (file) => access(file, constants.X_OK).then(() => true, () => false);

// `override` is the path from an environment variable such as BLUEPRINT_CLAUDE.
// It wins when it points at a program that runs.
export async function findCli(name, { override, env = process.env, home = homedir() } = {}) {
  if (override) return (await executable(override)) ? override : null;
  const dirs = [...(env.PATH || '').split(path.delimiter), ...USUAL.map((d) => d.replace(/^~/, home))];
  for (const dir of new Set(dirs)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    if (await executable(file)) return file;
  }
  return null;
}
