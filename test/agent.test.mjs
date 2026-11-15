import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createAgent, permit, buildPrompt, describeStep, readSkills } from '../lib/agent.mjs';

// These tests replace the Agent SDK's query() with a script, so they check
// Blueprint's side of the conversation without calling a model.

const tmp = (name) => mkdtemp(path.join(tmpdir(), `blueprint-agent-${name}-`));

// A stand-in for query(). It records the options it was given and yields the
// scripted messages, or waits for the abort signal when told to hang.
function fakeQuery(script, { hang = false, fail } = {}) {
  const calls = [];
  const query = ({ prompt, options }) => {
    calls.push({ prompt, options });
    return (async function* () {
      for (const m of script) yield m;
      if (fail) throw new Error(fail);
      if (hang)
        await new Promise((_, reject) => {
          options.abortController.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
    })();
  };
  return { query, calls };
}

const turn = (session = 's1') => [
  { type: 'system', subtype: 'init', session_id: session },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__blueprint__get_board', input: {} }] } },
  { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'mcp__blueprint__write_html', input: { artboardId: 'ab_aaaa', html: '<h1>x</h1>' } }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: 'I drew the pricing page.' }] } },
  { type: 'result', subtype: 'success', is_error: false, session_id: session, result: 'I drew the pricing page.' },
];

async function setup(script, opts) {
  const root = await tmp('root');
  const dir = path.join(root, '.blueprint');
  await mkdir(dir, { recursive: true });
  const skillsDir = path.join(await tmp('home'), 'agent-skills');
  const fake = fakeQuery(script, opts);
  const board = { artboards: [{ id: 'ab_aaaa', name: 'Pricing / desktop' }] };
  const agent = createAgent({ root, dir, home: path.dirname(skillsDir), skillsDir, getBoard: () => board, query: fake.query });
  await agent.load();
  return { agent, fake, dir, skillsDir, root };
}

test('a turn records the message, the steps and the reply, then saves the chat', async () => {
  const { agent, fake, dir } = await setup(turn());
  const seen = [];
  agent.onChange((s) => seen.push(s.busy));
  assert.equal(agent.send('  Draw a pricing page  ').busy, true);
  await agent.idle();
  const { busy, messages } = agent.state();
  assert.equal(busy, false);
  assert.deepEqual(
    messages.map((m) => [m.role, m.text]),
    [
      ['user', 'Draw a pricing page'],
      ['step', 'Read the board'],
      ['step', 'Wrote Pricing / desktop'],
      ['agent', 'I drew the pricing page.'],
    ],
  );
  assert.equal(fake.calls[0].prompt, 'Draw a pricing page');
  assert.equal(seen.at(-1), false, 'the last change event says the agent is idle');
  const saved = JSON.parse(await readFile(path.join(dir, 'chat.json'), 'utf8'));
  assert.equal(saved.sessionId, 's1');
  assert.equal(saved.messages.length, 4);
});

test('the next message resumes the same session, also after a restart', async () => {
  const { agent, fake, dir, root, skillsDir } = await setup(turn('s1'));
  agent.send('First');
  await agent.idle();
  agent.send('Second');
  await agent.idle();
  assert.equal(fake.calls[0].options.resume, undefined);
  assert.equal(fake.calls[1].options.resume, 's1');

  const again = fakeQuery(turn('s1'));
  const restarted = createAgent({ root, dir, home: path.dirname(skillsDir), skillsDir, query: again.query });
  await restarted.load();
  assert.equal(restarted.state().messages.length, 8);
  restarted.send('Third');
  await restarted.idle();
  assert.equal(again.calls[0].options.resume, 's1');
});

test('a second message while the agent works is refused with 409', async () => {
  const { agent } = await setup([], { hang: true });
  agent.send('Go');
  assert.throws(() => agent.send('Again'), (err) => err.status === 409);
  agent.stop();
  await agent.idle();
});

test('stop ends the turn and says so', async () => {
  const { agent } = await setup([{ type: 'system', subtype: 'init', session_id: 's1' }], { hang: true });
  agent.send('Go');
  agent.stop();
  await agent.idle();
  assert.equal(agent.state().busy, false);
  assert.deepEqual(agent.state().messages.at(-1).text, 'Stopped.');
});

test('stop also ends a turn that is already running', async () => {
  const { agent, fake } = await setup([{ type: 'system', subtype: 'init', session_id: 's1' }], { hang: true });
  agent.send('Go');
  while (!fake.calls.length) await new Promise((r) => setTimeout(r, 1)); // wait until query() has started
  agent.stop();
  await agent.idle();
  assert.equal(agent.state().busy, false);
  assert.equal(agent.state().messages.at(-1).text, 'Stopped.');
});

test('a failed run shows the reason in the chat', async () => {
  const { agent } = await setup([{ type: 'result', subtype: 'success', is_error: true, session_id: 's1', result: 'Not logged in. Please run /login.' }]);
  agent.send('Go');
  await agent.idle();
  assert.deepEqual(agent.state().messages.at(-1), { ...agent.state().messages.at(-1), role: 'error', text: 'Not logged in. Please run /login.' });
});

test('a usage limit shows once, not three times', async () => {
  const limit = "You've hit your 5-hour limit";
  const script = [
    { type: 'assistant', error: 'rate_limit', message: { content: [{ type: 'text', text: limit }] } },
    { type: 'result', subtype: 'success', is_error: true, session_id: 's1', result: limit },
  ];
  // The real SDK also throws after an error result.
  const { agent } = await setup(script, { fail: `Claude Code returned an error result: ${limit}` });
  agent.send('Go');
  await agent.idle();
  assert.deepEqual(agent.state().messages.filter((m) => m.role !== 'user').map((m) => [m.role, m.text]), [['error', limit]]);
});

test('an empty or oversized message is refused', async () => {
  const { agent } = await setup(turn());
  assert.throws(() => agent.send('   '), /Write a message/);
  assert.throws(() => agent.send('x'.repeat(8001)), /limit is 8000/);
});

test('clear forgets the conversation and the session', async () => {
  const { agent, fake } = await setup(turn('s1'));
  agent.send('First');
  await agent.idle();
  await agent.clear();
  assert.equal(agent.state().messages.length, 0);
  agent.send('Fresh start');
  await agent.idle();
  assert.equal(fake.calls[1].options.resume, undefined);
});

test('without exported skills the agent gets no file tools and no plugin', async () => {
  const { agent, fake } = await setup(turn());
  agent.send('Go');
  await agent.idle();
  const o = fake.calls[0].options;
  assert.deepEqual(o.tools, []);
  assert.deepEqual(o.plugins, []);
  assert.deepEqual(o.settingSources, []);
  assert.equal(o.strictMcpConfig, true);
  assert.deepEqual(o.settings, { autoMemoryEnabled: false, disableClaudeAiConnectors: true, syncClaudeAiSkills: false, syncClaudeAiPlugins: false });
  assert.deepEqual(Object.keys(o.mcpServers), ['blueprint']);
  assert.equal(o.mcpServers.blueprint.env.BLUEPRINT_AGENT_NAME, 'Blueprint agent');
  assert.match(o.systemPrompt, /npm run skills/);
});

test('with exported skills the agent loads them as a plugin, by qualified name', async () => {
  const { agent, fake, skillsDir } = await setup(turn());
  await mkdir(skillsDir, { recursive: true });
  const manifest = {
    sources: [{ repo: 'someone/taste', commit: 'abc1234' }],
    lead: ['design-taste'],
    skills: [{ name: 'design-taste' }, { name: 'motion', when: 'to add motion' }],
  };
  await writeFile(path.join(skillsDir, 'manifest.json'), JSON.stringify(manifest));
  agent.send('Go');
  await agent.idle();
  const o = fake.calls[0].options;
  assert.deepEqual(o.tools, ['Read', 'Skill']);
  assert.deepEqual(o.skills, ['blueprint-design:design-taste', 'blueprint-design:motion']);
  assert.deepEqual(o.plugins, [{ type: 'local', path: skillsDir }]);
  assert.equal(o.cwd, skillsDir);
  assert.match(o.systemPrompt, /Before you design, load these skills with the Skill tool and follow them: blueprint-design:design-taste\./);
  assert.match(o.systemPrompt, /when the work calls for it: blueprint-design:motion \(to add motion\)\./);
  assert.match(o.systemPrompt, /follow the references/);
  assert.deepEqual(agent.state().skills, ['design-taste', 'motion']);
});

test('permit allows board tools and skill files, and refuses everything else', async () => {
  const skillsDir = path.join(await tmp('perm'), 'agent-skills');
  await mkdir(path.join(skillsDir, 'skills', 'a'), { recursive: true });
  await writeFile(path.join(skillsDir, 'skills', 'a', 'SKILL.md'), '# a');
  const outside = path.join(await tmp('outside'), 'secret.txt');
  await writeFile(outside, 'secret');
  await symlink(outside, path.join(skillsDir, 'skills', 'a', 'link.md'));

  const allowed = async (name, input) => (await permit(name, input, skillsDir)).behavior === 'allow';
  assert.equal(await allowed('mcp__blueprint__write_html', { html: '' }), true);
  assert.equal(await allowed('Read', { file_path: path.join(skillsDir, 'skills', 'a', 'SKILL.md') }), true);
  assert.equal(await allowed('Read', { file_path: 'skills/a/SKILL.md' }), true, 'relative to the skills folder');
  assert.equal(await allowed('Read', { file_path: outside }), false);
  assert.equal(await allowed('Read', { file_path: path.join(skillsDir, '..', 'recents.json') }), false);
  assert.equal(await allowed('Read', { file_path: path.join(skillsDir, 'skills', 'a', 'link.md') }), false, 'a symlink out of the folder');
  assert.equal(await allowed('Bash', { command: 'ls' }), false);
  assert.equal(await allowed('Write', { file_path: path.join(skillsDir, 'x') }), false);
  assert.equal(await allowed('mcp__other__thing', {}), false);
});

test('a refused tool call shows up in the chat', async () => {
  const { agent, fake } = await setup([], { hang: true });
  agent.send('Go');
  while (!fake.calls.length) await new Promise((r) => setTimeout(r, 1));
  const decision = await fake.calls[0].options.canUseTool('mcp__claude_ai_Notion__notion-fetch', {});
  assert.equal(decision.behavior, 'deny');
  assert.equal(agent.state().messages.at(-1).text, 'Blocked mcp__claude_ai_Notion__notion-fetch');
  agent.stop();
  await agent.idle();
});

test('describeStep names artboards and skills in plain words', () => {
  const names = (id) => (id === 'ab_aaaa' ? 'Hero' : '');
  assert.equal(describeStep('mcp__blueprint__write_html', { artboardId: 'ab_aaaa' }, names), 'Wrote Hero');
  assert.equal(describeStep('mcp__blueprint__create_artboard', { name: 'Pricing' }, names), 'Created Pricing');
  assert.equal(describeStep('Skill', { skill: 'blueprint-design:better-ui' }), 'Loaded the better-ui skill');
  assert.equal(describeStep('mcp__blueprint__something_new', {}), 'Used something_new');
});

test('readSkills ignores a missing or empty manifest', async () => {
  const dir = await tmp('skills');
  assert.equal(await readSkills(dir), null);
  await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ skills: [] }));
  assert.equal(await readSkills(dir), null);
  assert.match(buildPrompt(null), /No design skills are installed/);
});
