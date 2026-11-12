# Blueprint v1 spec

Status: version 1 is built, 11 November 2026. No second person has reviewed it.

## Context

Blueprint is a local whiteboard for designing UI with an AI agent. The agent writes HTML onto artboards. You watch the board in a browser, pin comments on what should change, and tell the agent to check the board. The agent reads the comments, edits the HTML and replies on each pin.

It exists so that UI and UX work does not depend on Paper or Figma. It runs on one machine, for one person, with no account.

Three decisions were made on 11 November 2026:

1. Version 1 shows agent-written HTML only. Live pages from a dev server come in version 2.
2. The agent reads comments when asked. It does not watch the board.
3. Blueprint is installed once. Each project keeps its own board in a `.blueprint/` folder.

## Current state

Verified 11 November 2026.

- When this spec was written, the repository held one empty commit, `14369a9`, with no code and no git remote.
- Node.js v26.13.0 and Google Chrome are installed on the development machine.
- The pattern is the one the Paper design app uses: a local MCP server passes agent tool calls to a page that draws real HTML. Blueprint shares that pattern and none of Paper's code, name or look.

## Proposed change

Three programs share one folder of files.

```
agent ──stdio──> mcp.mjs ──HTTP──> server.mjs ──SSE──> canvas page (browser)
                                       │
                                       └── reads and writes  <project>/.blueprint/
```

- `server.mjs` is the only program that writes the board. One writer means the agent and the browser cannot overwrite each other's changes.
- `mcp.mjs` is what the agent talks to. Each tool is a small HTTP call to the server. If the server is not running for this project, `mcp.mjs` starts it.
- The canvas page loads the board, draws it, and listens on a server-sent events stream. When anything changes, the server sends the new board and the page redraws without a reload.

### Files in this repository

| File | Job |
| --- | --- |
| `server.mjs` | HTTP server on `127.0.0.1`. Serves the canvas page, the API, the event stream and each artboard document. |
| `lib/board.mjs` | Loads, validates and saves the board. Every change to the board is a function here. |
| `lib/screenshot.mjs` | Runs headless Chrome to capture one artboard as a PNG. |
| `mcp.mjs` | MCP server over stdio. Defines the 11 tools. |
| `public/index.html`, `public/app.js`, `public/canvas.js`, `public/comments.js`, `public/styles.css` | The canvas page. |
| `test/*.test.mjs` | Tests, run with `node --test`. |

Dependencies: `@modelcontextprotocol/sdk` 1.32.2 and `zod`. The server and the page use no packages.

### Files in each project

```
<project>/.blueprint/
  board.json            artboard list and comments
  artboards/<id>.html   one file per artboard
  trash/                deleted artboards, kept as files
  server.json           port and process id of the running server
```

HTML lives in its own files so that git diffs stay readable and `board.json` stays small.

### `board.json`

```json
{
  "version": 1,
  "artboards": [
    {
      "id": "ab_k3f9",
      "name": "Pricing card",
      "x": 0,
      "y": 0,
      "width": 1440,
      "height": 900,
      "rev": 1,
      "updatedAt": "2026-11-11T10:00:00.000Z"
    }
  ],
  "comments": [
    {
      "id": "c_p81x",
      "artboardId": "ab_k3f9",
      "x": 320,
      "y": 140,
      "target": { "selector": "main > section:nth-of-type(2) button", "text": "Start free trial" },
      "status": "open",
      "thread": [
        { "author": "user", "text": "Make this button less loud", "at": "2026-11-11T10:05:00.000Z" },
        { "author": "agent", "text": "Changed to an outline style.", "at": "2026-11-11T10:06:10.000Z" }
      ]
    }
  ]
}
```

- Artboard `x` and `y` are positions on the canvas in pixels. Comment `x` and `y` are pixels from the artboard's top left corner.
- `rev` starts at 1 and goes up by one each time the artboard's HTML changes. The page reloads an artboard only when its `rev` changes, so moving or renaming one does not make it flicker.
- `target` is `null` when the helper script cannot name an element.
- `status` is `open` or `resolved`. `author` is `user` or `agent`.
- IDs are `ab_` or `c_` plus four random characters from `a-z0-9`. The server retries on a collision.
- Limits: 100 artboards per board, 2 MB per artboard HTML file, 4,000 characters per comment message, width and height from 100 to 4,000 pixels. The server rejects anything over a limit with HTTP 400 and a message that names the limit.

### HTTP API

All routes are on `http://127.0.0.1:<port>`. Bodies are JSON unless noted.

| Method and path | Body | Returns |
| --- | --- | --- |
| `GET /api/health` | none | `{ ok, root, version }` |
| `GET /api/board` | none | the board |
| `GET /api/events` | none | event stream; one `board` event per change, carrying the board |
| `POST /api/artboards` | `{ name, width?, height?, html? }` | the new artboard |
| `PATCH /api/artboards/:id` | any of `{ name, x, y, width, height }` | the artboard |
| `GET /api/artboards/:id/html` | none | the stored HTML as text |
| `PUT /api/artboards/:id/html` | HTML as text | the artboard |
| `DELETE /api/artboards/:id` | none | `{ ok }`; the file moves to `trash/` |
| `GET /api/artboards/:id/screenshot` | none | PNG |
| `POST /api/comments` | `{ artboardId, x, y, text, target? }` | the comment |
| `POST /api/comments/:id/replies` | `{ author, text }` | the comment |
| `PATCH /api/comments/:id` | `{ status }` | the comment |
| `GET /artboard/:id` | none | the artboard as a full HTML document |

Defaults: a new artboard is 1440 by 900. The server places it 80 pixels to the right of the rightmost artboard, at `y = 0`.

Stored HTML may be a full document or a fragment. If it has no `<html` tag, `GET /artboard/:id` wraps it in a minimal document. A helper script, defined in `lib/board.mjs`, is added to the served document and never to the stored file. It tells the canvas which element sits under a comment pin.

Errors return `{ "error": "<plain sentence>" }` with status 400 for bad input, 403 for a refused origin, 404 for an unknown ID and 500 for anything else.

### MCP tools

| Tool | Input | Result |
| --- | --- | --- |
| `get_board` | none | board URL, artboards (id, name, size) and the count of open comments on each |
| `create_artboard` | `name`, `width?`, `height?`, `html?` | the new artboard id |
| `write_html` | `artboardId`, `html` | confirmation; replaces the whole artboard |
| `get_html` | `artboardId` | the stored HTML |
| `update_artboard` | `artboardId`, any of `name`, `width`, `height` | the artboard |
| `delete_artboard` | `artboardId` | confirmation; the file moves to `trash/` |
| `get_screenshot` | `artboardId` | a PNG image of the artboard at its own size |
| `list_comments` | `status?` (default `open`), `artboardId?` | comments with thread and target |
| `reply_to_comment` | `commentId`, `text` | the comment; the reply's author is `agent` |
| `resolve_comment` | `commentId` | the comment with status `resolved` |
| `finish_working` | none | confirmation; clears this agent from the board |

`mcp.mjs` uses the directory it was started in as the project root. `BLUEPRINT_ROOT` overrides it.

### Agent activity

Added 11 November 2026, after version 1. The board shows which agent is working on which artboard.

- Each `mcp.mjs` process makes one random id for its session. Before a tool runs, it sends `POST /api/activity` with `{ agentId, name, action, artboardId? | commentId? }`. `name` comes from the MCP client's own name. `action` is one of `looking`, `reading`, `writing`, `creating`, `resizing`, `replying`, `resolving`.
- `{ agentId, done: true }` removes the agent. `mcp.mjs` sends it from `finish_working` and when its session ends. The server also drops an agent that sends nothing for 90 seconds.
- The server keeps activity in memory and sends it to the page as an `activity` event on the same stream as the board. `GET /api/activity` returns the current list. Activity is never written to `board.json`.
- The page draws a ring and a name tag on each artboard that has an agent on it, and one status line per agent. Selecting a status line frames that artboard.
- Not built: a moving agent cursor, and showing HTML as it is typed. An artboard changes once per `write_html` call.

### Starting the server

1. `mcp.mjs` reads `.blueprint/server.json` and calls `GET /api/health` on that port.
2. If the answer's `root` matches this project, it uses that server.
3. Otherwise it starts `server.mjs --root <project>` as a detached process and waits up to 5 seconds for health.
4. The server tries port 4400. If a server for another project holds it, it tries 4401 to 4409, then fails with a message that lists the ten ports.

`npm start -- --root <project>` starts the same server by hand.

### Canvas page

- Pan with two-finger scroll, by dragging the canvas, or with the arrow keys. Zoom with pinch or Cmd-scroll, from 10% to 400%, centred on the pointer. A "Fit" button and the `1` key show every artboard.
- Each artboard is an `iframe` pointed at `/artboard/:id`, with its name above it. Drag the name to move the artboard.
- Three tools. Move (`V`) pans and moves artboards. Comment (`C`) pins a comment where you click. Use (`U`) lets clicks and scrolling reach inside artboards, to try hover states and forms. In Move and Comment, a transparent cover over each `iframe` catches the pointer so the canvas keeps control.
- One panel lists the artboards and, below them, every comment. Selecting an artboard frames it. Selecting a comment opens its thread. Every item is a button, so the whole board works from the keyboard. This is the only sidebar.
- Pins are numbered in the order the comments were made. Selecting a pin opens its thread in a card beside it, where you can reply, resolve or reopen. The card is drawn on the screen and not on the board, so it stays one size at any zoom.
- Motion respects `prefers-reduced-motion`. Translucent panels become solid under `prefers-reduced-transparency` and `prefers-contrast: more`.

### Visual direction

Chosen on 11 November 2026: clean and quiet, on the lines of Apple's system apps and Grok's chat page. Three earlier concepts (a drawing sheet, a light table and a page proof) were set aside.

- The system font, with one weight step for emphasis.
- Near-black ground in dark mode and soft grey in light mode, following the system setting. A fine dot grid moves with the board.
- All interface floats on one translucent material: a title pill, a tool dock, the panel and the thread card. Nothing is docked to an edge.
- One accent colour, blue, for pins, counts, the send button and focus rings.
- Motion follows two rules. Anything you drag tracks the pointer exactly, with no easing. Anything that opens does so in under 200 ms with a strong ease-out, and actions started from the keyboard do not animate.

### Security

The page displays HTML that an agent wrote, so the server treats that HTML as untrusted.

- The server binds to `127.0.0.1` only.
- It rejects any request whose `Host` header is not `127.0.0.1:<port>` or `localhost:<port>`. This stops a website from reaching the server through DNS tricks.
- It rejects any request that changes data when the `Origin` header is present and is not the server's own origin.
- `/artboard/:id` is served with `Content-Security-Policy: sandbox allow-scripts`, and each `iframe` has `sandbox="allow-scripts"`. Scripts in a mockup can run, but they have no access to the canvas page or the API.
- Known and accepted: a mockup can load images, fonts and scripts from the internet, and any program on this machine can call the API.

## Acceptance criteria

1. With no server running, calling `create_artboard` from an agent in project A starts the server and creates `A/.blueprint/board.json` and `A/.blueprint/artboards/<id>.html`.
2. With the canvas page open, `write_html` changes the visible artboard within 1 second and without a page reload.
3. `get_screenshot` returns a PNG whose pixel size equals the artboard's width and height.
4. Dropping a pin and typing a message adds a comment to `board.json` with `artboardId`, `x`, `y`, the message, and a `target` that names the element under the pin.
5. `list_comments` returns that comment. `reply_to_comment` makes the reply appear in the open thread within 1 second. `resolve_comment` changes the pin to its resolved style.
6. Stopping and restarting the server loses no artboards and no comments.
7. A script inside a mockup that calls `fetch('/api/board')` gets no board data.
8. A `POST` to `/api/comments` with `Origin: https://example.com` returns 403. A `GET` with `Host: evil.test` returns 403.
9. Starting a second agent in project B while A's server runs gives B its own server on the next port, and A's board is unchanged.
10. `delete_artboard` moves the HTML file to `trash/` and removes the artboard and its comments from the board.
11. Every limit in the `board.json` section returns HTTP 400 with a message that names the limit.
12. With the keyboard alone, a user can reach the artboard list, open a comment, reply and resolve it.
13. `node --test` passes.

State on 11 November 2026: tests cover criteria 1, 3, 5 (the tool side), 6, 8, 9, 10, 11 and 13. Criteria 2, 4 and 5 (the page side) were checked by hand in Chrome. Criterion 7 rests on the sandbox and on the test that the API sends no CORS header; it was not run from inside a live mockup. Criterion 12 was checked in part: focus moves into a thread and back to its pin, but a full keyboard-only pass was not done.

## Testing plan

| Layer | What | Count |
| --- | --- | --- |
| Unit | `lib/board.mjs`: create, update, delete, comment, reply, resolve, limits, ID collisions, fragment wrapping | 14 |
| Integration | HTTP API against a temporary folder: every route, the origin and host checks, the event stream, restart | 12 |
| End to end | An MCP client starts `mcp.mjs`, creates an artboard, writes HTML, takes a screenshot, lists and resolves a comment | 3 |
| Browser | Chrome, by hand and with screenshots: pan, zoom, live update, pin, thread, keyboard path, reduced motion | 7 checks |

Not covered in v1: Safari, Firefox, screen readers and touch screens.

## Build order

```
1 Board store and server ──> 2 Canvas: draw, pan, zoom ──> 4 Comment pins ──> 5 Comment tools
                         └─> 3 MCP tools and live update ─────────────────┘
```

Step 1 comes first because every other part reads or writes the board through it. Steps 2 and 3 do not depend on each other. Comments come last because they need both a canvas to pin on and tools to answer with.

## Effort estimate

| Part | Human | With an agent |
| --- | --- | --- |
| Board store and server | 1 day | 30 min |
| Canvas page | 2 days | 1 hour |
| MCP tools, server start, screenshot | 1 day | 30 min |
| Comments, pins and helper script | 1.5 days | 45 min |
| Tests and browser checks | 1.5 days | 45 min |

These are estimates, not measurements.

## Rollback

Blueprint changes nothing outside its own repository and each project's `.blueprint/` folder. To remove it from a project, delete that folder and remove the Blueprint entry from the agent's MCP settings.

## Out of scope

- Artboards that show a live dev server page (version 2)
- A mode where the agent watches for comments
- A layers panel
- Momentum after a pan gesture, and pinch on touch screens
- Drawing or editing shapes and text by hand on the canvas
- Editing HTML in the browser
- More than one person on a board, accounts or sharing
- Export to Figma, images or framework code
- A desktop app wrapper
