# Reference

## Canvas controls

| Action | Control |
| --- | --- |
| Pan | Two-finger scroll, drag on the canvas, or the arrow keys. Shift with an arrow key pans further. |
| Zoom | Pinch, or Cmd-scroll. The range is 10% to 400%. |
| Show every artboard | `1`, or **Fit** |
| Reset zoom to 100% | Select the zoom percentage |
| Move an artboard | Drag the artboard's name |
| Move tool | `V` |
| Comment tool | `C`, then click an artboard |
| Use tool | `U`. Clicks and scrolling reach inside artboards. |
| Close a comment card, or return to the Move tool | Esc |

The panel lists every artboard and every comment as a button.

## Agent tools

`mcp.mjs` registers 11 tools.

| Tool | Input | Result |
| --- | --- | --- |
| `get_board` | none | The board address, each artboard's id, name, size and position, and the open comment counts |
| `create_artboard` | `name`, `width?`, `height?`, `html?` | A new artboard. The default size is 1440 by 900. |
| `write_html` | `artboardId`, `html` | Replaces the artboard's HTML |
| `get_html` | `artboardId` | The stored HTML |
| `update_artboard` | `artboardId`, any of `name`, `width`, `height` | The changed artboard |
| `delete_artboard` | `artboardId` | Removes the artboard and its comments. Moves the HTML file to `.blueprint/trash/`. |
| `get_screenshot` | `artboardId` | A PNG of the artboard at its own size |
| `list_comments` | `status?`, `artboardId?` | Comments with position, target element and thread. `status` is `open`, `resolved` or `all`. The default is `open`. |
| `reply_to_comment` | `commentId`, `text` | Adds a reply from the agent |
| `resolve_comment` | `commentId` | Sets the comment's status to `resolved` |
| `finish_working` | none | Clears the agent from the board |

A failed tool call returns an error result with a sentence that names the problem.

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `BLUEPRINT_ROOT` | `mcp.mjs` | The project folder. The default is the folder `mcp.mjs` starts in. |
| `BLUEPRINT_CHROME` | `lib/screenshot.mjs` | The path to a Chrome or Chromium binary |

## Server options

| Option | Effect |
| --- | --- |
| `--root <folder>` | The project folder. The default is the current folder. |
| `--port <number>` | Listen on this port only. Without this option the server tries ports 4400 to 4409. |

## Saved files

```
<project>/.blueprint/
  board.json            artboard list and comments
  artboards/<id>.html   one file per artboard
  trash/                HTML of deleted artboards
  server.json           port and process id of the running server
```

Agent activity is held in memory and is not saved.

## Limits

| Item | Limit |
| --- | --- |
| Artboards per board | 100 |
| HTML per artboard | 2 MB |
| Comment message | 4,000 characters |
| Artboard name | 120 characters |
| Artboard width and height | 100 to 4,000 pixels |
| Time before a silent agent is cleared from the board | 90 seconds |

The server rejects a value over a limit with HTTP status 400 and a message that names the limit.

## Source files

| File | Job |
| --- | --- |
| `server.mjs` | The HTTP server: canvas page, JSON API, event stream, artboard documents |
| `lib/board.mjs` | Loads, checks and saves the board |
| `lib/screenshot.mjs` | Captures an artboard with headless Chrome |
| `mcp.mjs` | The MCP server |
| `public/app.js` | The canvas page: board drawing, tools, pointer and key input |
| `public/canvas.js` | Pan, zoom and framing |
| `public/comments.js` | Comment pins and the comment card |
| `public/styles.css` | All styles and colour tokens |
| `test/` | Tests for the board store, the server and the MCP tools |
