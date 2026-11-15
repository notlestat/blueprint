# Blueprint

Blueprint is a canvas where you design UI with your coding agent. The agent draws each screen as a working HTML artboard. You set out the brief beside it with notes, reference images, links and arrows, then pin comments on what to change. The agent reads the board and revises.

The agent can be the one built into the board, which you talk to in a chat panel, or an outside agent such as Claude Code or Codex.

Blueprint runs on your machine and needs no account. Each project keeps its own board in a `.blueprint/` folder next to its code.

## Requirements

- Node.js 22 or later
- Google Chrome, for the `get_screenshot` tool only
- For the chat agent: Claude Code, installed and signed in, or an Anthropic API key
- For an outside agent: an agent that speaks MCP over stdio, such as Claude Code or Codex

Blueprint was built and checked on macOS with Chrome. Other systems and browsers are untested.

## Install Blueprint

```sh
git clone https://github.com/notlestat/blueprint.git
cd blueprint
npm install
```

`npm install` downloads about 350 MB. Most of it is the Claude Code binary that the Claude Agent SDK runs for the chat agent.

## Design in the chat

The chat agent sits in the **Agent** panel on the left of the board. It uses the same board tools as an outside agent.

1. Start the server for your project: `npm start -- --root /path/to/your/project`.
2. Open the address that the server prints.
3. Put the brief on the board: notes, reference images and links.
4. In the **Agent** panel, ask for a design and press Enter. For example: "Mock up a pricing page at desktop and phone sizes from my references."
5. To comment, press `C`, then click the part of an artboard you mean. Type your comment and press Enter.
6. Tell the agent: "Check the board." It reads your comments, edits the HTML and replies on each comment.

While the agent works, the panel lists each step it takes, such as "Wrote Pricing / desktop". To stop it, select the square button. To start a new conversation, select **New**. The board stays as it is.

The agent can use Blueprint's board tools and read its design skills. It cannot run commands, edit project files, or reach the MCP servers and claude.ai connectors you use elsewhere.

The agent runs Claude Code through the Claude Agent SDK, with the account that Claude Code is signed in to on this machine. To use an API key instead, set `ANTHROPIC_API_KEY` before you start the server. Anthropic does not let products made for other people offer a claude.ai login without its approval. If you build something on Blueprint for other people, give it an API key.

The agent uses Claude Opus 5.5. To choose another model, set `BLUEPRINT_MODEL` to its model id before you start the server.

## Give the agent design skills

The board sets the direction of a design. Design skills set the craft: type, spacing, layout, copy and motion. By default the chat agent has two:

- [taste-skill](https://github.com/Leonxlnx/taste-skill), the lead skill, which the agent loads before every design.
- [impeccable](https://github.com/pbakaus/impeccable), which the agent loads to refine or review a design. A comment such as "make this bolder" or "the type feels off" matches one of its commands, such as `bolder` or `typeset`.

To download them, run:

```sh
npm run skills
```

The script reads `skills.config.json`, which lists the GitHub repositories to download from, the skill folders to take, and the lead skills. It downloads only the folders it needs, copies each skill into `~/.blueprint/agent-skills/`, and prints what it copied, the commit it came from, and what it skipped.

The agent reads files but cannot run them, so the script copies only text: `SKILL.md`, its reference files and its JSON data. Scripts and images stay behind. The agent skips any step that runs a script and checks its work with screenshots instead. A skill that its author marked as manual-only is skipped.

The agent loads the lead skills before it designs, on the next message after you run the script. Where a skill's default style conflicts with your references, the agent follows the references. To pick up a newer version of a skill, run the script again.

To add a skill, add its repository and folder to `skills.config.json`. For example, `{ "repo": "owner/repo", "skills": ["folder"] }` takes `skills/folder/SKILL.md` from that repository. For a skill in another folder, give its path, such as `plugin/skills/impeccable`. To tell the agent when to use a skill that is not a lead skill, write the entry as `{ "folder": "...", "when": "..." }`. The note goes into the agent's instructions.

## Connect an outside agent

To design from Claude Code, Codex or another agent instead of the chat, register `mcp.mjs` as an MCP server. In Claude Code, run this command with the real path to your clone:

```sh
claude mcp add --scope user blueprint -- node /path/to/blueprint/mcp.mjs
```

For another agent, add a stdio server with the command `node` and the argument `/path/to/blueprint/mcp.mjs`.

Blueprint treats the folder that the agent starts `mcp.mjs` in as the project. To use a different folder, set the `BLUEPRINT_ROOT` environment variable to that folder's path.

## Design with an outside agent

1. Open your agent in the project you are designing for.
2. Ask for a design. For example: "Use Blueprint to mock up a pricing page at desktop and phone sizes."
3. Ask the agent for the board address, then open the address in your browser. The first board is at `http://127.0.0.1:4400`.
4. To comment, press `C`, then click the part of an artboard you mean. Type your comment and press Enter.
5. Tell the agent: "Check the board." The agent reads your comments, edits the HTML, and replies on each comment.
6. To close a comment, open it and select **Resolve**.

The agent reads comments only when you ask. It does not watch the board.

## Give the agent references

Put the brief on the board beside the artboards. The agent reads every note, reference and arrow with `get_board`, and sees each image with `get_reference`.

- To add a note, press `N` and click the board, or double-click an empty spot. Type, then press Esc.
- To add an image, paste it, drop it on the board, or select **Image**. Blueprint takes PNG, JPEG, GIF and WebP files up to 10 MB.
- To add a link, paste a web address. The card shows the page's title if Blueprint can fetch the page.
- To add code, paste it. Blueprint shows it on a code card in a fixed-width font, with its spacing kept. Code fenced with three backticks always becomes a code card.
- To turn HTML into an artboard, paste the HTML. The new artboard renders it, and is named from the HTML's `<title>` or first heading.
- To draw an arrow, press `A` and drag from one artboard, note or reference to another. To label the arrow, double-click it.

To delete an artboard, a note, a reference or an arrow, select it and press Delete, or select **Delete** in the dock. To select an artboard, click it without dragging. To delete a comment, open it and select **Delete**. Press Cmd+Z, or select **Undo** in the message that appears, to bring back the last thing you deleted. A deleted artboard's HTML stays in `.blueprint/trash/`.

The agent can add notes, references and arrows too. Each note and reference that the agent adds has a blue **Agent** label above it.

## Switch between boards

Select **Blueprint** at the top left to open Recents. Recents lists every project whose board has run on this machine, each with a small map of its board. Select a project to open its board. If that project's server is not running, Blueprint starts it.

To delete another project's board, select **…** on its card, then **Delete board**. Blueprint stops that board's server and moves the project's `.blueprint` folder to `~/.blueprint/deleted/`. The project's own files stay where they are. To get the board back, move the folder back into the project and rename it `.blueprint`. To hide a project without deleting its board, select **Remove from list**. You cannot delete the board you have open.

Recents keeps the folder paths in `~/.blueprint/recents.json`. To keep the list in another folder, set the `BLUEPRINT_HOME` environment variable.

## Watch the agent work

While an agent uses Blueprint, the board shows what the agent is doing. The chat agent appears as "Blueprint agent".

- A pill at the top names the agent and its action, for example "Claude Code is writing Pricing / desktop". To go to that artboard, select the pill.
- The artboard that the agent is on has a blue ring and a tag with the agent's name.
- A new artboard fades in. An artboard redraws each time the agent writes to it.

The ring clears when the agent calls `finish_working`, when the agent's session ends, or after 90 seconds with no tool call.

## Start the server yourself

An outside agent starts the server on its first tool call. For the chat agent, start the server by hand:

```sh
npm start -- --root /path/to/your/project
```

The server prints its address. It tries port 4400 first. If another project's board holds port 4400, the server uses the next free port, up to 4409.

## Keep designs with your code

To keep designs with the code, commit the `.blueprint/` folder. It holds the artboards, the notes and arrows in `board.json`, and the reference images in `assets/`. Add `.blueprint/server.json` to the project's `.gitignore`, because that file only records the port of a running server. The chat with the chat agent is in `.blueprint/chat.json`. Add that file to `.gitignore` too if you want to keep the conversation out of the repository.

## Run the tests

```sh
npm test
```

The tests cover the board store, the notes, references and arrows, the HTTP routes, the origin and host checks, the MCP tools as an agent calls them, the chat agent, and the skills export. The chat agent's tests replace the model with a script, so they run offline and cost nothing. No automated test drives the canvas page. That page was checked by hand in Chrome.

## More documentation

- [Reference](docs/reference.md) lists the controls, the agent tools, the saved files, and the limits.
- [How Blueprint works](docs/how-it-works.md) explains the design and the security model.
- [SPEC.md](SPEC.md) holds the board format, the HTTP routes, and the acceptance criteria.
