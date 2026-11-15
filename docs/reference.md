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
| Note tool | `N`, then click the board. The tool returns to Move after one note. |
| Add a note without the tool | Double-click an empty spot on the board |
| Arrow tool | `A`, then drag from one artboard, note or reference to another |
| Comment tool | `C`, then click an artboard |
| Use tool | `U`. Clicks and scrolling reach inside artboards. `Esc` or `V` goes back to Move, even after a click inside an artboard. |
| Add a reference image | Paste it, drop it on the board, or select **Image** |
| Add a link card | Paste a web address, or drop a link on the board |
| Add a code card | Paste code, or text fenced with three backticks |
| Add an artboard from HTML | Paste HTML |
| Add a note from text | Paste text that is not a web address, code or HTML |
| Select a note, reference or arrow | Click it, or press Tab to reach a note or reference |
| Select an artboard | Click it without dragging, click its name, or select it in the panel |
| Move a note or reference | Drag it |
| Resize a note or reference | Select it, then drag the handle at its bottom right corner |
| Edit a note or code card | Double-click it, or select it and press Enter. Esc or Cmd+Enter saves. In a code card, Tab indents. |
| Open a link card's address | Double-click the card, or select it and press Enter |
| Label an arrow | Double-click the arrow, or select it and press Enter |
| Delete the selection | Delete or Backspace, or select **Delete** in the dock |
| Delete a comment | Open it and select **Delete** |
| Bring back the last deletion | Cmd+Z, or **Undo** in the message that follows a deletion. Undo for an artboard or a comment works until the server restarts. |
| Open Recents | Select **Blueprint** at the top left |
| Delete another project's board, or remove it from Recents | Select **…** on its card in Recents |
| Close a comment card or Recents, clear the selection, or return to the Move tool | Esc |

The panel lists every artboard, note, reference and comment as a button.

## Agent tools

`mcp.mjs` registers 17 tools.

| Tool | Input | Result |
| --- | --- | --- |
| `get_board` | none | The board address, each artboard's id, name, size and position, the open comment counts, and every note, reference and arrow |
| `create_artboard` | `name`, `width?`, `height?`, `html?` | A new artboard. The default size is 1440 by 900. |
| `write_html` | `artboardId`, `html` | Replaces the artboard's HTML |
| `get_html` | `artboardId` | The stored HTML |
| `update_artboard` | `artboardId`, any of `name`, `width`, `height` | The changed artboard |
| `delete_artboard` | `artboardId` | Removes the artboard and its comments. Moves the HTML file to `.blueprint/trash/`. |
| `get_screenshot` | `artboardId` | A PNG of the artboard at its own size |
| `list_comments` | `status?`, `artboardId?` | Comments with position, target element and thread. `status` is `open`, `resolved` or `all`. The default is `open`. |
| `reply_to_comment` | `commentId`, `text` | Adds a reply from the agent |
| `resolve_comment` | `commentId` | Sets the comment's status to `resolved` |
| `get_reference` | `itemId` | One note or reference in full, with its arrows. An image comes back as the picture itself. |
| `add_note` | `text`, `code?`, `width?`, `near?`, `x?`, `y?` | A note from the agent, or a code card when `code` is true. With `near`, it goes in a free spot beside that object. |
| `add_reference` | `path` or `url`, `title?`, `width?`, `near?`, `x?`, `y?` | An image from a file on this machine, or a link card |
| `connect` | `from`, `to`, `label?` | An arrow between two artboards, notes or references |
| `update_item` | `itemId`, any of `text`, `title`, `description`, `width`, `x`, `y` | The changed note or reference |
| `delete_item` | `id` | Removes a note, a reference (with its arrows) or an arrow |
| `finish_working` | none | Clears the agent from the board |

A failed tool call returns an error result with a sentence that names the problem.

## Environment variables

| Variable | Read by | Effect |
| --- | --- | --- |
| `BLUEPRINT_ROOT` | `mcp.mjs` | The project folder. The default is the folder `mcp.mjs` starts in. |
| `BLUEPRINT_CHROME` | `lib/screenshot.mjs` | The path to a Chrome or Chromium binary |
| `BLUEPRINT_HOME` | `server.mjs` | The folder that holds `recents.json`. The default is `~/.blueprint`. |

## Server options

| Option | Effect |
| --- | --- |
| `--root <folder>` | The project folder. The default is the current folder. |
| `--port <number>` | Listen on this port only. Without this option the server tries ports 4400 to 4409. |

## Saved files

```
<project>/.blueprint/
  board.json            artboards, comments, notes, references and arrows
  artboards/<id>.html   one file per artboard
  assets/<hash>.<ext>   reference images, named by a hash of their content
  trash/                HTML of deleted artboards
  server.json           port and process id of the running server

~/.blueprint/
  recents.json          the folder path and last edit time of each project, for Recents
  deleted/<name>-<time>/  a board deleted from Recents: the project's whole .blueprint folder
```

Agent activity is held in memory and is not saved. A deleted note or reference is not kept in `trash/`. Only the last deletion can be brought back, and only while the page stays open.

## Limits

| Item | Limit |
| --- | --- |
| Artboards per board | 100 |
| HTML per artboard | 2 MB |
| Comment message | 4,000 characters |
| Artboard name | 120 characters |
| Artboard width and height | 100 to 4,000 pixels |
| Notes and references per board | 500 |
| Arrows per board | 500 |
| Note and code card text | 10,000 characters |
| Arrow label | 200 characters |
| Note and reference width | 80 to 2,000 pixels |
| Reference image | 10 MB, PNG, JPEG, GIF or WebP |
| Link address | 2,000 characters, `http` or `https` only |
| Projects in Recents | 30 |
| Time before a silent agent is cleared from the board | 90 seconds |

The server rejects a value over a limit with HTTP status 400 and a message that names the limit.

## Source files

| File | Job |
| --- | --- |
| `server.mjs` | The HTTP server: canvas page, JSON API, event stream, artboard documents |
| `lib/board.mjs` | Loads, checks and saves the board |
| `lib/screenshot.mjs` | Captures an artboard with headless Chrome |
| `lib/assets.mjs` | Reads an image's type and size from its first bytes |
| `lib/preview.mjs` | Fetches a link's title and description, and refuses local addresses |
| `lib/recents.mjs` | Reads and writes `recents.json`, and outlines each board for Recents |
| `mcp.mjs` | The MCP server |
| `public/app.js` | The canvas page: board drawing, tools, pointer and key input |
| `public/canvas.js` | Pan, zoom and framing |
| `public/comments.js` | Comment pins and the comment card |
| `public/items.js` | Notes, images and link cards, and note editing |
| `public/connectors.js` | Arrows and their labels |
| `public/recents.js` | The Recents view |
| `public/styles.css` | All styles and colour tokens |
| `test/` | Tests for the board store, the server and the MCP tools |
