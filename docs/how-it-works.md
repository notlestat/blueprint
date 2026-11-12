# How Blueprint works

## Why artboards are real HTML

A design tool can draw its own shapes, or it can show real web pages. Blueprint shows real pages. Each artboard is an HTML file in an `iframe`, so what you review is what a browser renders. A design that looks right on the board looks the same in the product, and the agent can move the HTML into the codebase without a translation step.

The cost is that you cannot edit a design by hand on the canvas. Every change goes through the agent.

## Three programs, one writer

```
agent ──stdio──> mcp.mjs ──HTTP──> server.mjs ──events──> canvas page
                                       │
                                       └── reads and writes  <project>/.blueprint/
```

The agent and the browser both change the board. If each wrote the file directly, a comment that you saved while the agent was writing could vanish. So only `server.mjs` writes. `mcp.mjs` and the canvas page both send it requests, and the server applies the requests one at a time.

`lib/board.mjs` holds every rule about a valid board: the size limits, the id format, and which fields a comment needs. The server has no rules of its own, which keeps the tests for those rules in one place.

The server saves by writing a temporary file and renaming it over `board.json`. A rename either happens or does not, so a crash during a save cannot leave half a board on disk.

## How the page stays live

The canvas page opens one long-lived connection to the server, a server-sent event stream. When the board changes, the server sends the whole board down that connection and the page redraws. The page never asks "has anything changed?".

Sending the whole board each time is wasteful on paper. At the 100-artboard limit the board is small, because artboard HTML lives in separate files, and the simpler code is worth more than the saved bytes.

Each artboard carries a `rev` number that goes up when its HTML changes. The page reloads an `iframe` only when `rev` changes, so moving or renaming an artboard does not make it flicker.

## How comments find their element

A comment stores a position in artboard pixels. Blueprint also records the element under the pin, so "make this button quieter" tells the agent which button.

The canvas page cannot look inside an artboard, because of the sandbox described below. The server adds a small script to every artboard document as it serves it. The canvas page sends that script a message with a position, and the script answers with a CSS selector and a short text label. The stored HTML file never contains the script.

## Why notes and references are not artboards

An artboard is a design, so it is real HTML in a sandbox. A note, an image or a link card is part of the brief, so it is plain data in `board.json` that the canvas page draws itself. The difference matters in three places:

- You can type into a note on the canvas. Artboards change only through the agent.
- The agent reads a note as text and an image as a picture, through `get_board` and `get_reference`. It does not have to parse HTML to find out what you meant.
- Nothing in a note runs. The page writes note text and link titles with `textContent`, so a pasted `<script>` shows up as text.

Each item records an `author`, either `user` or `agent`. The board shows an **Agent** label on the agent's notes and references, so you can tell the brief from the agent's answers.

## How arrows follow what you drag

An arrow stores only the ids at its two ends. The page draws it from the boxes it finds on screen, not from the saved positions. While you drag a note, its box moves on screen before the move is saved, and the arrow follows it on every pointer move. Each end stops where the line from one box's centre to the other leaves the box, so an arrow points at the edge of a note and not into its middle.

Deleting either end deletes the arrow. The store does this in the same save as the delete, so `board.json` never holds an arrow with a missing end.

## How reference images are kept safe

An uploaded image is stored in `.blueprint/assets/` under a name made from a hash of its bytes. The same image pasted twice is stored once, and a name can never point outside the folder.

Blueprint decides what a file is from its first bytes, not from its name or the type the browser claims. It accepts PNG, JPEG, GIF and WebP. It refuses SVG, because an SVG file can hold a script. Images are served with their real type, `X-Content-Type-Options: nosniff` and a sandbox policy. A file that somehow passed the byte check still cannot run as a page.

## Why link previews check the address

When you paste a web address, the server fetches the page to read its title. The server, not your browser, makes that request. Without a check, a link card could make Blueprint read a router's admin page or another service on your machine. So before each request and each redirect, `lib/preview.mjs` looks up the host and refuses loopback, private and link-local addresses. A refused or failed fetch leaves the host name as the card's title.

The check runs on the address the lookup returns. A host whose address changes between the lookup and the request can still slip through. For a preview that only reads a page title, I judged that risk acceptable.

## How Recents finds other boards

Each project has its own server and its own port, so no single server knows every board. When a server starts, and a second after each edit, it writes its project's folder path to `~/.blueprint/recents.json`. Recents reads that list and opens each project's `board.json` from disk to draw its map. It does not ask the other servers, because the canvas page's security policy only lets it talk to its own server.

Deleting a board from Recents moves it instead of erasing it. Blueprint stops the board's server, waits for the process to exit so nothing writes into the folder afterwards, and moves the project's `.blueprint` folder to `~/.blueprint/deleted/`. Only the `.blueprint` folder moves. The board you have open cannot be deleted from inside itself, because its server would still be writing into a folder that had moved. If an agent later calls a Blueprint tool in that project, it starts a fresh, empty board.

Opening a project from Recents can start that project's server. The server starts one only for a folder already in the list that still holds a board. A request cannot name an arbitrary folder and have a server started there.

## How the board shows an agent at work

Each `mcp.mjs` process makes a random id for its session. Before a tool runs, `mcp.mjs` tells the server which agent is doing what to which artboard. The server sends that list to the page on the same event stream as the board.

Activity lives in memory only. It describes the present moment and means nothing after a restart. A crashed agent cannot say that it has left, so the server drops any agent that sends nothing for 90 seconds.

## Security

An agent writes the HTML on your artboards, and that HTML can include scripts. Blueprint treats it as untrusted.

- **The server listens on `127.0.0.1` only.** Other machines on your network cannot reach it.
- **The server checks the `Host` header.** A website can point its own domain at `127.0.0.1` and then ask your browser to load it, which is called DNS rebinding. Such a request carries the website's name in `Host`, and the server refuses it.
- **The server checks the `Origin` header on every request that changes data.** A request from another website, or from inside an artboard, is refused.
- **Each artboard is sandboxed twice.** The `iframe` has `sandbox="allow-scripts"`, and the server sends the same rule as a header on the artboard document. Scripts run, but in a sealed origin that cannot read the canvas page or the API's answers.
- **The canvas page has a strict content security policy.** It loads only its own files and builds its interface with text nodes, so comment text cannot become markup.

Two things are not blocked, by choice. An artboard can load images, fonts and scripts from the internet, because real designs need them. Any program on your machine can call the server, because any such program can already edit the files.

## What Blueprint leaves out

Blueprint has no freehand drawing, no shapes, no layers panel, no accounts and no sharing. The agent does not watch for comments. An artboard changes once for each write, so you see a design arrive in steps and not as it is typed.

Undo covers only the last deletion of a note, a reference or an arrow. Moves, resizes and text edits cannot be undone.
