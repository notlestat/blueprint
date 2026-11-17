// Runs the user's own coding agent (Claude Code or Codex) for the chat, over
// the Agent Client Protocol (ACP). ACP is a JSON-RPC protocol over stdio that
// editors use to drive coding agents.
//
// Each agent needs a small adapter program that speaks ACP and drives the
// agent's own CLI. Blueprint ships the adapters and points each one at the CLI
// already installed on this computer, signed in as its user.
//
//   Blueprint ──ACP──▶ adapter ──▶ the user's `claude` or `codex`
//                                     └──▶ Blueprint's board tools (mcp.mjs)

import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { client, ndJsonStream } from '@agentclientprotocol/sdk';
import { nodeEnv } from './node-env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP = path.join(HERE, '..', 'mcp.mjs');
const adapter = (specifier) => () => fileURLToPath(import.meta.resolve(specifier));

// `pathEnv` is how each adapter is told where the CLI is. `override` lets
// the user name the CLI's path when Blueprint cannot find it.
export const AGENTS = {
  claude: { name: 'Claude Code', cli: 'claude', pathEnv: 'CLAUDE_CODE_EXECUTABLE', override: 'BLUEPRINT_CLAUDE', adapter: adapter('@agentclientprotocol/claude-agent-acp/dist/index.js') },
  codex: { name: 'Codex', cli: 'codex', pathEnv: 'CODEX_PATH', override: 'BLUEPRINT_CODEX', adapter: adapter('@agentclientprotocol/codex-acp/dist/index.js') },
};

// Started from a terminal inside Claude Code, Blueprint inherits that
// session's variables. Passed on, they make the user's agent act as part of
// that session, which can change its permission mode. So they are removed.
const INHERITED_SESSION = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|EXECPATH|CHILD_SESSION|SESSION_[A-Z_]+|MESSAGING_[A-Z_]+))$/;
export const agentEnv = (env) => Object.fromEntries(Object.entries(env).filter(([k]) => !INHERITED_SESSION.test(k)));

// Is this permission request for one of Blueprint's own board tools? Only a
// positive answer from the agent counts: Claude Code names the MCP server a
// tool belongs to. A request without that, such as a shell command, is not a
// board tool, so the user is asked. Unknown means ask.
export const isBoardTool = (toolCall) => toolCall?._meta?.claudeCode?.mcpServer?.name === 'blueprint';

// The text of an ACP error. Codex puts the useful part in data.message.
export const errorText = (err) => err?.data?.message || err?.message || 'The agent stopped with an error.';

// Start an adapter and open one session. `onUpdate` gets each session/update
// (text, tool calls). `onPermission` gets each permission request and returns
// the chosen option id, or null to cancel.
export async function startSession({ kind, cliPath, cwd, mcpEnv, onUpdate, onPermission, adapterPath }) {
  const spec = AGENTS[kind];
  const child = spawn(process.execPath, [adapterPath || spec.adapter()], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: nodeEnv({ ...agentEnv(process.env), [spec.pathEnv]: cliPath }),
  });
  let stderr = '';
  child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
  const exited = new Promise((resolve) => child.once('exit', resolve));

  const app = client({ name: 'blueprint' })
    .onNotification('session/update', ({ params }) => onUpdate(params.update))
    .onRequest('session/request_permission', async ({ params }) => {
      const optionId = await onPermission(params);
      return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
    });
  const conn = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)));
  const close = () => {
    conn.close();
    child.kill();
  };

  // A missing or broken CLI makes the adapter exit at once. Say so plainly,
  // with the adapter's own last words.
  const orExit = (promise) =>
    Promise.race([
      promise,
      exited.then((code) => {
        throw new Error(`${spec.name} stopped before it answered (exit code ${code}). ${stderr.trim().split('\n').pop() || ''}`.trim());
      }),
    ]);

  try {
    await orExit(conn.agent.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'blueprint', version: '0.1.0' } }));
    const env = Object.entries(nodeEnv(mcpEnv)).map(([name, value]) => ({ name, value: String(value) }));
    const { sessionId } = await orExit(conn.agent.request('session/new', { cwd, mcpServers: [{ name: 'blueprint', command: process.execPath, args: [MCP], env }] }));
    return {
      sessionId,
      prompt: (text) => orExit(conn.agent.request('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })),
      cancel: () => conn.agent.notify('session/cancel', { sessionId }).catch(() => {}),
      close,
    };
  } catch (err) {
    close();
    throw err;
  }
}
