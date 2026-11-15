import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { exportSkills, cloneRepo } from '../scripts/export-skills.mjs';

const tmp = (name) => mkdtemp(path.join(tmpdir(), `blueprint-export-${name}-`));
const exists = (p) => access(p).then(() => true, () => false);

// A small repository shaped like a GitHub skills repo: skills/<folder>/SKILL.md.
async function fakeRepo() {
  const repo = await tmp('repo');
  const put = async (file, body) => {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), body);
  };
  await put('skills/taste/SKILL.md', '---\nname: design-taste\ndescription: >-\n  Builds pages\n  with taste.\n---\n# Taste');
  await put('skills/taste/references/layout.md', 'grids');
  await put('skills/taste/library/type.json', '{}');
  await put('skills/taste/scripts/gate.mjs', 'run()');
  await put('skills/taste/assets/photo.jpg', 'jpeg');
  await put('plugin/skills/polish/SKILL.md', '---\nname: polish\ndescription: Refines a design.\n---\n# Polish');
  await put('skills/manual/SKILL.md', '---\nname: manual\ndescription: Only by hand.\ndisable-model-invocation: true\n---\n# Manual');
  return repo;
}

// Stands in for cloneRepo, so no test downloads anything.
const localFetch = (dirs) => async (repo, into) => {
  await cp(dirs[repo], into, { recursive: true });
  return { dir: into, commit: 'abc1234def' };
};

test('copies the text of each skill, names it by its own name, and leaves scripts and assets behind', async () => {
  const repo = await fakeRepo();
  const out = path.join(await tmp('out'), 'agent-skills');
  const m = await exportSkills({ out, sources: [{ repo: 'someone/taste', skills: ['taste', 'manual', 'ghost'] }], lead: ['taste'], fetchRepo: localFetch({ 'someone/taste': repo }) });

  assert.deepEqual(m.sources, [{ repo: 'someone/taste', commit: 'abc1234def' }]);
  assert.deepEqual(m.lead, ['design-taste']);
  assert.deepEqual(m.skills, [{ name: 'design-taste', folder: 'taste', repo: 'someone/taste', description: 'Builds pages with taste.', leftBehind: 2 }]);
  const skill = path.join(out, 'skills', 'design-taste');
  assert.ok(await exists(path.join(skill, 'SKILL.md')));
  assert.ok(await exists(path.join(skill, 'references', 'layout.md')));
  assert.ok(await exists(path.join(skill, 'library', 'type.json')));
  assert.ok(!(await exists(path.join(skill, 'scripts'))), 'scripts are not copied');
  assert.ok(!(await exists(path.join(skill, 'assets'))), 'images are not copied');
  assert.deepEqual(
    m.skipped.map((s) => [s.name, s.reason]),
    [
      ['manual', 'its author marked it manual-only'],
      ['ghost', 'the repository has no SKILL.md for it'],
    ],
  );
  const plugin = JSON.parse(await readFile(path.join(out, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.equal(plugin.name, 'blueprint-design');
  assert.deepEqual(JSON.parse(await readFile(path.join(out, 'manifest.json'), 'utf8')).skills, m.skills);
});

test('takes a skill from a nested folder and keeps its when note', async () => {
  const repo = await fakeRepo();
  const out = path.join(await tmp('out'), 'agent-skills');
  const m = await exportSkills({ out, sources: [{ repo: 'someone/taste', skills: [{ folder: 'plugin/skills/polish', when: 'to refine a design' }] }], fetchRepo: localFetch({ 'someone/taste': repo }) });
  assert.deepEqual(m.skills.map((s) => [s.name, s.when]), [['polish', 'to refine a design']]);
  assert.ok(await exists(path.join(out, 'skills', 'polish', 'SKILL.md')));
});

test('refuses a skill folder that could leave the repository, before downloading anything', async () => {
  let fetched = false;
  const fetchRepo = async () => {
    fetched = true;
  };
  for (const folder of ['../secrets', 'a/../../b', '/etc', '-x', 'a/./b', ''])
    await assert.rejects(exportSkills({ out: await tmp('out'), sources: [{ repo: 'someone/taste', skills: [folder] }], fetchRepo }), /not a skill folder path/);
  assert.equal(fetched, false);
});

test('a second export replaces the first', async () => {
  const repo = await fakeRepo();
  const out = path.join(await tmp('out'), 'agent-skills');
  const args = { out, sources: [{ repo: 'someone/taste', skills: ['taste'] }], fetchRepo: localFetch({ 'someone/taste': repo }) };
  await exportSkills(args);
  await writeFile(path.join(out, 'skills', 'stale.md'), 'left over');
  await exportSkills(args);
  assert.ok(!(await exists(path.join(out, 'skills', 'stale.md'))));
});

test('refuses to empty a folder it did not write', async () => {
  const repo = await fakeRepo();
  const out = await tmp('precious');
  await writeFile(path.join(out, 'thesis.docx'), 'do not delete');
  await assert.rejects(exportSkills({ out, sources: [{ repo: 'someone/taste', skills: ['taste'] }], fetchRepo: localFetch({ 'someone/taste': repo }) }), /did not write/);
  assert.ok(await exists(path.join(out, 'thesis.docx')));
});

test('cloneRepo refuses anything that is not owner/name', async () => {
  for (const bad of ['../etc', 'owner/..', '-x/y', 'owner/name; rm -rf /', '--upload-pack=x/y', 'https://evil.example/x', 'just-one-part'])
    await assert.rejects(cloneRepo(bad, await tmp('clone')), /not a GitHub repository name/);
});
