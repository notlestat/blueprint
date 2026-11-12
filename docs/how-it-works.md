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

Blueprint has no hand drawing, no layers panel, no accounts and no sharing. The agent does not watch for comments. An artboard changes once for each write, so you see a design arrive in steps and not as it is typed.
