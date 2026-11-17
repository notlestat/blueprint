// A stand-in for an ACP adapter such as claude-agent-acp, for test/acp.test.mjs.
// It speaks ACP on stdio. Each prompt asks permission for one board tool and
// one shell command, then replies with what it was told and what it saw:
//
//   board=<option> bash=<option> brief=<yes|no> cli=<path> inherited=<value>
//
// A prompt containing WAIT_FOR_CANCEL waits until Blueprint cancels it.

import { Readable, Writable } from 'node:stream';
import { agent, ndJsonStream } from '@agentclientprotocol/sdk';

const cancels = new Map(); // sessionId -> resolve

const ask = (client, sessionId, toolCall) =>
  client
    .request('session/request_permission', {
      sessionId,
      toolCall,
      options: [
        { optionId: 'allow-once', name: 'Yes', kind: 'allow_once' },
        { optionId: 'allow-always', name: 'Yes, and do not ask again', kind: 'allow_always' },
        { optionId: 'reject', name: 'No', kind: 'reject_once' },
      ],
    })
    .then((r) => (r.outcome.outcome === 'selected' ? r.outcome.optionId : 'cancelled'));

agent({ name: 'fake-acp-agent' })
  .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: {}, authMethods: [] }))
  .onRequest('session/new', () => ({ sessionId: `s${Date.now()}` }))
  .onNotification('session/cancel', ({ params }) => cancels.get(params.sessionId)?.())
  .onRequest('session/prompt', async ({ params, client }) => {
    const { sessionId } = params;
    const text = params.prompt.map((b) => b.text || '').join('');
    const say = (t) => client.notify('session/update', { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } });
    if (text.includes('WAIT_FOR_CANCEL')) {
      await new Promise((resolve) => cancels.set(sessionId, resolve));
      return { stopReason: 'cancelled' };
    }
    await say('Looking ');
    await say('at the board.');
    const board = { toolCallId: 't1', title: 'mcp__blueprint__get_board', kind: 'other', rawInput: {}, _meta: { claudeCode: { toolName: 'mcp__blueprint__get_board', mcpServer: { name: 'blueprint' } } } };
    await client.notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', ...board } });
    const boardAnswer = await ask(client, sessionId, board);
    // A shell command whose title starts like a board tool, and has no proof
    // that it is one. It must still be put to the user.
    const bash = { toolCallId: 't2', title: 'mcp__blueprint__x; touch proof.txt', kind: 'execute', rawInput: { command: 'touch proof.txt' } };
    await client.notify('session/update', { sessionId, update: { sessionUpdate: 'tool_call', ...bash } });
    const bashAnswer = await ask(client, sessionId, bash);
    await say(`board=${boardAnswer} bash=${bashAnswer} brief=${text.includes('How to work:') ? 'yes' : 'no'} cli=${process.env.CLAUDE_CODE_EXECUTABLE} inherited=${process.env.CLAUDECODE ?? 'none'}`);
    return { stopReason: 'end_turn' };
  })
  .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
