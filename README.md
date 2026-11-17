# Blueprint

Blueprint is a canvas where you design UI with your coding agent. The agent draws each screen as a working HTML artboard. You set out the brief beside it with notes, reference images, links and arrows, then pin comments on what to change. The agent reads the board and revises.

The agent can be the one built into the board, which you talk to in a chat panel, or an outside agent such as Claude Code or Codex.

Blueprint runs on your machine and needs no account. Each project keeps its own board in a `.blueprint/` folder next to its code.

## Requirements

- Node.js 22 or later
- Google Chrome, for the `get_screenshot` tool when you run Blueprint from a terminal. The desktop app takes screenshots without it.
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

## Run Blueprint as a desktop app

The desktop app shows the same board in its own window, with a Dock icon and a menu bar. It opens the board you edited last. If you have no boards yet, it makes `~/Blueprint/My first board`.

To run it from your clone, run:

```sh
npm run app
```

To build `Blueprint.app`, run:

```sh
npm run app:build
```

The app is written to `dist/mac-arm64/Blueprint.app`. Move it to `/Applications` to keep it. The build is about 350 MB. It does not include Claude Code or Codex, so its chat agents need the ones installed on the computer. It is not signed, so it runs on the Mac that built it. To give it to other people, sign and notarize it with an Apple Developer ID.

In the **File** menu, **New Board…** (Cmd+N) opens the New board form. **Boards** (Cmd+Shift+B) opens the Boards list.

The app takes artboard screenshots with its own browser engine, so `get_screenshot` does not need Chrome. Each board server that the app starts gets the address of the app's screenshot service. A board server keeps running after you quit the app, and then takes screenshots with Chrome again.

Links on the board open in your default browser. The window shows Blueprint's own pages and nothing else.

## Design in the chat

The chat agent sits in the **Agent** panel on the left of the board. It uses the same board tools as an outside agent.

1. Start the server for your project: `npm start -- --root /path/to/your/project`.
2. Open the address that the server prints.
3. Put the brief on the board: notes, reference images and links.
4. In the **Agent** panel, ask for a design and press Enter. For example: "Mock up a pricing page at desktop and phone sizes from my references."
5. To comment, press `C`, then click the part of an artboard you mean. Type your comment and press Enter.
6. Tell the agent: "Check the board." It reads your comments, edits the HTML and replies on each comment.

To start from an empty artboard, select **Artboard** in the dock or press `F`, then choose Desktop (1440 × 900), Tablet (834 × 1194) or Phone (390 × 844). Ask the agent to design on it by its name, such as "Phone".

While the agent works, the panel lists each step it takes, such as "Wrote Pricing / desktop". To stop it, select the square button. To start a new conversation, select **New**. The board stays as it is.

### Choose the agent

The menu at the top of the **Agent** panel chooses which agent the chat uses:

- **Built-in** is Blueprint's own design agent. It can use the board tools and read its design skills. It cannot run commands, edit project files, or reach the MCP servers and claude.ai connectors you use elsewhere.
- **Claude Code** and **Codex** are your own agents, as you have set them up, with your skills, MCP servers and sign-in. The menu shows "(not found)" for an agent that is not installed.

When you switch agents, the chat keeps its messages and the new agent starts a new conversation.

Your own agent uses the board tools without asking. Before it does anything else, such as run a command, edit a file or call another MCP server, the chat shows what it wants to do with its choices, such as **Yes** and **No**. The agent waits for your answer. Commands that your agent treats as safe, such as `ls`, run without asking, and the chat lists them as steps. Your agent works in the project folder, so it can change the project's files when you allow it.

Each message to your own agent includes your agent's full setup: its instructions, skills and MCP tools. With many of those, each message costs more than a message to the built-in agent.

Blueprint looks for `claude` and `codex` on your `PATH` and in the folders they usually install into, such as `~/.local/bin` and `/opt/homebrew/bin`. If Blueprint cannot find one, set `BLUEPRINT_CLAUDE` or `BLUEPRINT_CODEX` to the program's path before you start the server.

### Sign-in and model

Each agent uses the account its own CLI is signed in to on this computer. The built-in agent runs Claude Code through the Claude Agent SDK, with the installed `claude` when Blueprint finds it. To use an API key instead, set `ANTHROPIC_API_KEY` before you start the server. Anthropic does not let products made for other people offer a claude.ai login without its approval. If you build something on Blueprint for other people, give it an API key.

The built-in agent uses Claude Opus 5.5. To choose another model, set `BLUEPRINT_MODEL` to its model id before you start the server.

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

## Start from the Boards list

Blueprint opens on **Boards**, a list of every board that has run on this computer, each with a small map. Select a board to open it. If its server is not running, Blueprint starts it. To come back to the list, select **Blueprint** at the top left. An address that ends in `#board` opens the board directly, so a reload keeps you on the board you were working on.

To make a board, select **New board**, type a name and select **Create**. Blueprint makes a folder with that name in `~/Blueprint/` and opens its empty board. To keep new boards in another folder, set the `BLUEPRINT_BOARDS` environment variable. A board for a code project lives in the project's own folder instead: start the server there, or let an outside agent start it.

Each open board runs its own server on a port from 4400 to 4409, so ten boards can be open at once.

To delete another project's board, select **…** on its card, then **Delete board**. Blueprint stops that board's server and moves the project's `.blueprint` folder to `~/.blueprint/deleted/`. The project's own files stay where they are. To get the board back, move the folder back into the project and rename it `.blueprint`. To hide a project without deleting its board, select **Remove from list**. You cannot delete the board you have open.

The list keeps the folder paths in `~/.blueprint/recents.json`. To keep the list in another folder, set the `BLUEPRINT_HOME` environment variable.

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
