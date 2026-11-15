#!/usr/bin/env node
// Download design skills from GitHub into the folder Blueprint's agent loads
// them from.
//
//   node scripts/export-skills.mjs [--out ~/.blueprint/agent-skills]
//
// skills.config.json lists each source repository, the skill folders to take
// from it, and the lead skills the agent loads before it designs. The agent
// reads files but cannot run them, so only text is copied: SKILL.md and its
// reference files. Scripts, images and other assets are left behind, and the
// manifest counts them so the agent knows which steps to skip.

import { readFile, writeFile, readdir, stat, mkdir, rm, mkdtemp, copyFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SKILLS_PLUGIN } from '../lib/agent.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);
const TEXT = /\.(md|txt|json|ya?ml|csv)$/i;
const SKIP_NAMES = new Set(['.git', 'node_modules', '.DS_Store']);
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
// GitHub's own rules: an owner is letters, digits and hyphens, not starting with a
// hyphen. A repository name may hold dots, but cannot be "." or "..".
const REPO = /^[A-Za-z0-9][A-Za-z0-9-]*\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;

// A skill folder inside a repository, like "taste-skill" or "plugin/skills/impeccable".
// No segment may be "." or "..", or start with "-", so a path cannot leave the clone.
const FOLDER = /^(?!\.\.?(\/|$))[A-Za-z0-9_.][A-Za-z0-9_.-]*(\/(?!\.\.?(\/|$))[A-Za-z0-9_.][A-Za-z0-9_.-]*)*$/;

// A config entry is a folder name, or { folder, when } with a note on when to use it.
export function skillEntry(entry) {
  const { folder, when = '' } = typeof entry === 'string' ? { folder: entry } : entry || {};
  if (typeof folder !== 'string' || !FOLDER.test(folder)) throw new Error(`"${folder}" is not a skill folder path inside a repository.`);
  if (typeof when !== 'string') throw new Error(`The "when" note for ${folder} must be text.`);
  return { folder, when: when.trim() };
}

const expand = (p) => (p.startsWith('~/') ? path.join(os.homedir(), p.slice(2)) : p);

// Clone one GitHub repository, shallow and sparse: only the folders that may
// hold the listed skills are downloaded. Reports the commit it is at.
export async function cloneRepo(repo, into, folders = []) {
  if (!REPO.test(repo)) throw new Error(`"${repo}" is not a GitHub repository name like owner/name.`);
  await run('git', ['clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', `https://github.com/${repo}.git`, into]);
  const dirs = folders.flatMap((f) => [`skills/${f}`, f]);
  if (dirs.length) await run('git', ['-C', into, 'sparse-checkout', 'set', '--', ...dirs]);
  const { stdout } = await run('git', ['-C', into, 'rev-parse', 'HEAD']);
  return { dir: into, commit: stdout.trim() };
}

// The SKILL.md front matter fields this script needs.
function frontMatter(text) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] || '';
  const field = (key) => {
    const m = block.match(new RegExp(`^${key}:[ \\t]*(.*(?:\\n[ \\t]+.*)*)`, 'm'));
    return m ? m[1].replace(/^[>|]-?\s*/, '').replace(/\s*\n\s*/g, ' ').trim() : '';
  };
  return { name: field('name'), description: field('description'), manualOnly: field('disable-model-invocation') === 'true' };
}

// Copy the text files of one skill folder. Returns the bytes copied and the
// number of files left behind.
async function copyText(from, to) {
  let bytes = 0;
  let left = 0;
  async function walk(rel) {
    for (const entry of await readdir(path.join(from, rel), { withFileTypes: true })) {
      if (SKIP_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) await walk(child);
      else if (TEXT.test(entry.name)) {
        bytes += (await stat(path.join(from, child))).size;
        if (bytes > MAX_TEXT_BYTES) throw new Error(`its text is over ${MAX_TEXT_BYTES / 1024 / 1024} MB`);
        await mkdir(path.dirname(path.join(to, child)), { recursive: true });
        await copyFile(path.join(from, child), path.join(to, child));
      } else left += 1;
    }
  }
  await walk('');
  return { bytes, left };
}

export async function exportSkills({ out, sources, lead = [], fetchRepo = cloneRepo }) {
  if (!Array.isArray(sources) || !sources.length) throw new Error('skills.config.json lists no sources.');
  // Check every entry before anything is downloaded or deleted.
  const plan = sources.map((source) => {
    if (!REPO.test(String(source?.repo))) throw new Error(`"${source?.repo}" is not a GitHub repository name like owner/name.`);
    return { repo: source.repo, entries: (source.skills || []).map(skillEntry) };
  });

  // The out folder is replaced on each export. Refuse to empty a folder this
  // script did not write, in case --out points somewhere important.
  const existing = await readdir(out).catch(() => null);
  if (existing?.length && !existing.includes('manifest.json')) throw new Error(`${out} already holds files that Blueprint did not write. Choose an empty folder.`);
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'blueprint-skills-'));

  try {
    const fetched = [];
    for (const [i, source] of plan.entries())
      fetched.push({ ...source, ...(await fetchRepo(source.repo, path.join(scratch, String(i)), source.entries.map((e) => e.folder))) });

    await rm(out, { recursive: true, force: true });
    await mkdir(path.join(out, '.claude-plugin'), { recursive: true });
    const skills = [];
    const skipped = [];
    const leadNames = [];
    for (const source of fetched) {
      for (const { folder, when } of source.entries) {
        const why = (reason) => skipped.push({ name: folder, repo: source.repo, reason });
        const candidates = [path.join(source.dir, 'skills', folder), path.join(source.dir, folder)];
        let from = null;
        for (const c of candidates) if (await stat(path.join(c, 'SKILL.md')).catch(() => null)) from = from || c;
        if (!from) {
          why('the repository has no SKILL.md for it');
          continue;
        }
        const meta = frontMatter(await readFile(path.join(from, 'SKILL.md'), 'utf8'));
        if (meta.manualOnly) {
          why('its author marked it manual-only');
          continue;
        }
        // Claude Code names a plugin skill by its folder, so the folder takes the skill's own name.
        const name = /^[a-z0-9-]+$/.test(meta.name) ? meta.name : path.basename(folder);
        if (skills.some((s) => s.name === name)) {
          why(`another source already gave a skill named ${name}`);
          continue;
        }
        try {
          const { left } = await copyText(from, path.join(out, 'skills', name));
          skills.push({ name, folder, repo: source.repo, description: meta.description, ...(when && { when }), leftBehind: left });
          if (lead.includes(folder) || lead.includes(name)) leadNames.push(name);
        } catch (err) {
          await rm(path.join(out, 'skills', name), { recursive: true, force: true });
          why(err.message);
        }
      }
    }

    const manifest = {
      generatedAt: new Date().toISOString(),
      sources: fetched.map((s) => ({ repo: s.repo, commit: s.commit })),
      lead: leadNames,
      skills,
      skipped,
    };
    await writeFile(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    await writeFile(
      path.join(out, '.claude-plugin', 'plugin.json'),
      JSON.stringify({ name: SKILLS_PLUGIN, version: '1.0.0', description: `Design skills for Blueprint's agent, from ${fetched.map((s) => s.repo).join(' and ')}.` }, null, 2) + '\n',
    );
    return manifest;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

// Run directly: `node scripts/export-skills.mjs`
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  try {
    const config = JSON.parse(await readFile(path.join(HERE, '..', 'skills.config.json'), 'utf8'));
    const home = process.env.BLUEPRINT_HOME || path.join(os.homedir(), '.blueprint');
    const out = path.resolve(expand(arg('--out') || path.join(home, 'agent-skills')));
    const m = await exportSkills({ out, sources: config.sources, lead: config.lead });
    console.log(`Copied ${m.skills.length} skill${m.skills.length === 1 ? '' : 's'} to ${out}`);
    for (const s of m.sources) console.log(`  ${s.repo} at ${s.commit.slice(0, 7)}`);
    for (const s of m.skills) console.log(`  ${s.name}${m.lead.includes(s.name) ? ' (lead)' : ''}${s.leftBehind ? `, left ${s.leftBehind} non-text files behind` : ''}`);
    if (m.skipped.length) {
      console.log(`Skipped ${m.skipped.length}:`);
      for (const s of m.skipped) console.log(`  ${s.name}: ${s.reason}`);
    }
    console.log('The agent picks these up on its next message.');
  } catch (err) {
    console.error(err.stderr?.toString().trim() || err.message);
    process.exit(1);
  }
}
