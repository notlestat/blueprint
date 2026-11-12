# Blueprint

Blueprint is a local whiteboard for designing UI with an AI agent. The agent writes HTML onto artboards. You watch the board in your browser, pin comments on what to change, and tell the agent to check the board.

Blueprint runs on your machine and needs no account. Each project keeps its own board in a `.blueprint/` folder next to its code.

## Requirements

- Node.js 22 or later
- Google Chrome, for the `get_screenshot` tool only
- An agent that speaks MCP over stdio, such as Claude Code or Codex

Blueprint was built and checked on macOS with Chrome. Other systems and browsers are untested.

## Install Blueprint

```sh
git clone https://github.com/notlestat/blueprint.git
cd blueprint
npm install
```

## Connect your agent

Register `mcp.mjs` as an MCP server. In Claude Code, run this command with the real path to your clone:

```sh
claude mcp add --scope user blueprint -- node /path/to/blueprint/mcp.mjs
```

For another agent, add a stdio server with the command `node` and the argument `/path/to/blueprint/mcp.mjs`.

Blueprint treats the folder that the agent starts `mcp.mjs` in as the project. To use a different folder, set the `BLUEPRINT_ROOT` environment variable to that folder's path.

## Design with your agent

1. Open your agent in the project you are designing for.
2. Ask for a design. For example: "Use Blueprint to mock up a pricing page at desktop and phone sizes."
3. Ask the agent for the board address, then open the address in your browser. The first board is at `http://127.0.0.1:4400`.
4. To comment, press `C`, then click the part of an artboard you mean. Type your comment and press Enter.
5. Tell the agent: "Check the board." The agent reads your comments, edits the HTML, and replies on each comment.
6. To close a comment, open it and select **Resolve**.

The agent reads comments only when you ask. It does not watch the board.

## Watch the agent work

While an agent uses Blueprint, the board shows what the agent is doing:

- A pill at the top names the agent and its action, for example "Claude Code is writing Pricing / desktop". To go to that artboard, select the pill.
- The artboard that the agent is on has a blue ring and a tag with the agent's name.
- A new artboard fades in. An artboard redraws each time the agent writes to it.

The ring clears when the agent calls `finish_working`, when the agent's session ends, or after 90 seconds with no tool call.

## Start the server yourself

The agent starts the server on its first tool call. To start the server by hand, run:

```sh
npm start -- --root /path/to/your/project
```

The server prints its address. It tries port 4400 first. If another project's board holds port 4400, the server uses the next free port, up to 4409.

## Keep designs with your code

To keep designs with the code, commit the `.blueprint/` folder. Add `.blueprint/server.json` to the project's `.gitignore`, because that file only records the port of a running server.

## Run the tests

```sh
npm test
```

The tests cover the board store, the HTTP routes, the origin and host checks, and the MCP tools as an agent calls them. No test drives the canvas page. That page was checked by hand in Chrome.

## More documentation

- [Reference](docs/reference.md) lists the controls, the agent tools, the saved files, and the limits.
- [How Blueprint works](docs/how-it-works.md) explains the design and the security model.
- [SPEC.md](SPEC.md) holds the board format, the HTTP routes, and the acceptance criteria.
