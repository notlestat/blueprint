// The chat with the user's own agent over ACP. A fake adapter
// (test/fake-acp-agent.mjs) stands in for Claude Code, so no model is called.

import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAgent, describeAcpStep } from '../lib/agent.mjs';
import { isBoardTool, agentEnv, errorText } from '../lib/acp.mjs';
import { findCli } from '../lib/find-cli.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-acp-agent.mjs');
let agent, root;

// Wait until the chat state passes a check.
const until = (check, ms = 10000) =>
  new Promise((resolve, reject) => {
    if (check(agent.state())) return resolve(agent.state());
    const timer = setTimeout(() => (off(), reject(new Error('Timed out waiting for the chat.'))), ms);
    const off = agent.onChange((s) => {
      if (check(s)) {
        clearTimeout(timer);
        off();
        resolve(s);
      }
    });
  });

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'blueprint-acp-'));
  await mkdir(path.join(root, '.blueprint'));
  // A Claude Code session variable, as if Blueprint were started from a
  // terminal inside Claude Code. It must not reach the user's agent.
  process.env.CLAUDECODE = '1';
  agent = createAgent({
    root,
    dir: path.join(root, '.blueprint'),
    home: root,
    skillsDir: path.join(root, 'skills'),
    findCli: async (name) => (name === 'claude' ? '/fake/bin/claude' : null),
    adapters: { claude: FAKE },
  });
  await agent.load();
});
after(async () => {
  delete process.env.CLAUDECODE;
  await agent.close();
});

test('the chat lists each agent, and whether its CLI was found', () => {
  const s = agent.state();
  assert.equal(s.agent, 'builtin');
  assert.deepEqual(
    s.agents.map((a) => [a.id, a.available]),
    [['builtin', true], ['claude', true], ['codex', false]],
  );
});

test('an agent whose CLI is missing cannot be chosen', async () => {
  await assert.rejects(agent.setAgent('codex'), /cannot find Codex/);
  await assert.rejects(agent.setAgent('cursor'), /agent must be one of/);
});

test("the user's agent runs board tools freely and puts anything else to the user", async () => {
  await agent.setAgent('claude');
  assert.equal(agent.state().agent, 'claude');
  agent.send('Mock up a pricing page');

  const asking = await until((s) => s.pending);
  assert.equal(asking.pending.agent, 'Claude Code');
  assert.equal(asking.pending.title, 'mcp__blueprint__x; touch proof.txt', 'a title that looks like a board tool is not proof');
  assert.equal(asking.pending.detail, 'touch proof.txt');
  assert.deepEqual(asking.pending.options.map((o) => o.id), ['allow-once', 'allow-always', 'reject']);
  assert.ok(asking.messages.some((m) => m.role === 'step' && m.text === 'Read the board'));
  assert.ok(asking.messages.some((m) => m.role === 'agent' && m.text === 'Looking at the board.'), 'text pieces are joined into one line');

  agent.answer(asking.pending.id, 'reject');
  await agent.idle();
  const s = agent.state();
  assert.equal(s.busy, false);
  assert.equal(s.pending, null);
  assert.ok(s.messages.some((m) => m.text === 'You refused mcp__blueprint__x; touch proof.txt'));
  const reply = s.messages.at(-1).text;
  assert.match(reply, /board=allow-once/, 'the board tool was allowed without asking');
  assert.match(reply, /bash=reject/, "the user's refusal reached the agent");
  assert.match(reply, /brief=yes/, 'the first message tells the agent how to work in Blueprint');
  assert.match(reply, /cli=\/fake\/bin\/claude/, 'the adapter is pointed at the CLI that was found');
  assert.match(reply, /inherited=none/, "the terminal's Claude Code session variables are removed");
});

test('a later message in the same session does not repeat the brief', async () => {
  agent.send('Now a phone size');
  const asking = await until((s) => s.pending);
  agent.answer(asking.pending.id, 'allow-once');
  await agent.idle();
  assert.match(agent.state().messages.at(-1).text, /bash=allow-once brief=no/);
});

test('an answer must match the waiting request and one of its options', async () => {
  assert.throws(() => agent.answer('nope', 'reject'), /already been answered/);
  agent.send('One more');
  const asking = await until((s) => s.pending);
  assert.throws(() => agent.answer(asking.pending.id, 'delete-everything'), /not one of the choices/);
  agent.answer(asking.pending.id, null);
  await agent.idle();
  assert.match(agent.state().messages.at(-1).text, /bash=cancelled/);
});

test('Stop cancels a turn that is waiting on the agent', async () => {
  agent.send('WAIT_FOR_CANCEL');
  await until((s) => s.busy);
  await new Promise((r) => setTimeout(r, 200));
  agent.stop();
  await agent.idle();
  assert.equal(agent.state().busy, false);
  assert.equal(agent.state().messages.at(-1).text, 'Stopped.');
});

test('switching agents keeps the chat and starts a new conversation', async () => {
  const before = agent.state().messages.length;
  await agent.setAgent('builtin');
  const s = agent.state();
  assert.equal(s.agent, 'builtin');
  assert.equal(s.messages.length, before + 1);
  assert.match(s.messages.at(-1).text, /Switched to the built-in agent/);
});

test('only a positive MCP server name counts as a board tool', () => {
  assert.equal(isBoardTool({ _meta: { claudeCode: { mcpServer: { name: 'blueprint' } } } }), true);
  assert.equal(isBoardTool({ title: 'mcp__blueprint__get_board' }), false);
  assert.equal(isBoardTool({ _meta: { claudeCode: { toolName: 'Bash' } } }), false);
  assert.equal(isBoardTool({ _meta: { claudeCode: { mcpServer: { name: 'cosmos' } } } }), false);
  assert.equal(isBoardTool(undefined), false);
});

test("agentEnv removes the terminal's Claude Code session variables and keeps the rest", () => {
  const env = agentEnv({ PATH: '/bin', HOME: '/h', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'x', CLAUDE_CODE_CHILD_SESSION: '1', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CONFIG_DIR: '/c', ANTHROPIC_API_KEY: 'k' });
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH']);
});

test('errorText prefers the reason Codex puts in data.message', () => {
  assert.equal(errorText({ message: 'Internal error', data: { message: 'You have hit your usage limit.' } }), 'You have hit your usage limit.');
  assert.equal(errorText(new Error('Boom')), 'Boom');
});

test('describeAcpStep names board tools as the built-in agent does, and hides ToolSearch', () => {
  const name = () => 'Pricing';
  assert.equal(describeAcpStep({ _meta: { claudeCode: { toolName: 'mcp__blueprint__write_html' } }, rawInput: { artboardId: 'ab_1' } }, name), 'Wrote Pricing');
  assert.equal(describeAcpStep({ title: 'ToolSearch' }, name), null);
  assert.equal(describeAcpStep({ title: 'ls -la' }, name), 'Used ls -la');
});

test('findCli searches PATH, then the usual folders, and honours an override', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'blueprint-cli-'));
  const bin = path.join(dir, 'bin');
  await mkdir(bin);
  await writeFile(path.join(bin, 'claude'), '#!/bin/sh\n');
  await chmod(path.join(bin, 'claude'), 0o755);
  assert.equal(await findCli('claude', { env: { PATH: bin }, home: dir }), path.join(bin, 'claude'));
  assert.equal(await findCli('claude', { env: { PATH: '/usr/bin' }, home: dir }), null, 'not on PATH and not in a usual folder');
  await mkdir(path.join(dir, '.local', 'bin'), { recursive: true });
  await writeFile(path.join(dir, '.local', 'bin', 'claude'), '#!/bin/sh\n');
  await chmod(path.join(dir, '.local', 'bin', 'claude'), 0o755);
  assert.equal(await findCli('claude', { env: { PATH: '/usr/bin' }, home: dir }), path.join(dir, '.local', 'bin', 'claude'), 'found in ~/.local/bin, as an app opened from Finder needs');
  assert.equal(await findCli('claude', { override: path.join(dir, 'missing'), env: { PATH: bin }, home: dir }), null, 'a broken override is not silently replaced');
});
