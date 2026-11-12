// The list of projects that have a Blueprint board, for the Recents view.
//
// Each project keeps its own board in its own folder, and each runs its own
// server. To show them all in one place, every server adds its project to one
// shared file, ~/.blueprint/recents.json (BLUEPRINT_HOME moves it). The list
// holds folder paths only. Board contents are read from each project's folder
// when the Recents view asks for them.

import { mkdir, readFile, writeFile, rename, cp, rm, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_PROJECTS = 30;

export const defaultHome = () => process.env.BLUEPRINT_HOME || path.join(homedir(), '.blueprint');

async function readList(home) {
  const data = await readFile(path.join(home, 'recents.json'), 'utf8').then(JSON.parse).catch(() => null);
  return Array.isArray(data?.projects) ? data.projects.filter((p) => typeof p?.root === 'string') : [];
}

// Two servers can write at once, so write a temporary file and rename it.
// The last writer wins, which loses at most one "last edited" time.
async function writeList(home, projects) {
  await mkdir(home, { recursive: true });
  const file = path.join(home, 'recents.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ version: 1, projects }, null, 2) + '\n');
  await rename(tmp, file);
}

export async function touchProject(home, root, editedAt = new Date().toISOString()) {
  const list = (await readList(home)).filter((p) => p.root !== root);
  list.unshift({ root, editedAt });
  await writeList(home, list.slice(0, MAX_PROJECTS));
}

export async function forgetProject(home, root) {
  await writeList(home, (await readList(home)).filter((p) => p.root !== root));
}

export async function isKnownProject(home, root) {
  return (await readList(home)).some((p) => p.root === root);
}

// Is a Blueprint server running for this folder? Returns { url, pid } from the
// server's own answer, or null. The pid comes from the server, not from the
// file, so it can be trusted to name that server's process.
export async function runningServer(root) {
  const info = await readFile(path.join(root, '.blueprint', 'server.json'), 'utf8').then(JSON.parse).catch(() => null);
  if (!Number.isInteger(info?.port)) return null;
  const h = await fetch(`http://127.0.0.1:${info.port}/api/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.json())
    .catch(() => null);
  return h?.root === root ? { url: `http://127.0.0.1:${info.port}`, pid: h.pid } : null;
}
export const runningUrl = async (root) => (await runningServer(root))?.url || null;

// Signal 0 checks that a process exists without touching it. Pids 0, 1 and
// negative numbers mean "a group" or "everything" to kill(), so never pass them.
const isRealPid = (pid) => Number.isInteger(pid) && pid > 1;
function alive(pid) {
  if (!isRealPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // it exists but belongs to someone else
  }
}

// A small outline of a board for its Recents card: one box per artboard and
// item, in board pixels. The page draws them as a map.
const list = (v) => (Array.isArray(v) ? v.filter((x) => x && typeof x === 'object') : []);
function outline(board) {
  const kind = { code: 'n', note: 'n', image: 'i', link: 'l' };
  const boxes = [
    ...list(board.artboards).map((a) => ({ k: 'a', x: a.x, y: a.y, w: a.width, h: a.height })),
    ...list(board.items).map((i) => ({ k: kind[i.type] || 'n', x: i.x, y: i.y, w: i.width, h: i.height || (i.type === 'link' ? 90 : 120) })),
  ];
  return boxes.filter((b) => [b.x, b.y, b.w, b.h].every(Number.isFinite)).slice(0, 200);
}

export async function listProjects(home) {
  const projects = await readList(home);
  // One unreadable or malformed board must not take the whole list down, so
  // each project is read on its own and a bad one shows as missing.
  return Promise.all(
    projects.map(async (p) => {
      const base = { root: p.root, name: path.basename(p.root), editedAt: p.editedAt };
      try {
        const board = await readFile(path.join(p.root, '.blueprint', 'board.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (!board || typeof board !== 'object') throw new Error('no board');
        return {
          ...base,
          missing: false,
          artboards: list(board.artboards).length,
          items: list(board.items).length,
          openComments: list(board.comments).filter((c) => c.status === 'open').length,
          outline: outline(board),
          url: await runningUrl(p.root),
        };
      } catch {
        return { ...base, missing: true, artboards: 0, items: 0, openComments: 0, outline: [], url: null };
      }
    }),
  );
}

// Delete a project's board: stop its server if one is running, then move its
// .blueprint folder to <home>/deleted/. Moving, not erasing, means a mistake
// can be undone by moving the folder back. The project's own files are never
// touched, only its .blueprint folder.
export async function deleteBoard(home, root) {
  const dir = path.join(root, '.blueprint');
  await access(path.join(dir, 'board.json'));
  // The Recents list itself lives in home. A board whose folder is home, or
  // holds it, cannot be moved into home/deleted.
  const inside = (a, b) => a === b || a.startsWith(b + path.sep);
  if (inside(path.resolve(home), dir) || inside(dir, path.resolve(home)))
    throw new Error("That board's folder holds Blueprint's own settings, so it cannot be deleted from Recents.");

  const info = await readFile(path.join(dir, 'server.json'), 'utf8').then(JSON.parse).catch(() => null);
  const running = await runningServer(root);
  if (running) {
    // Only signal the pid the running server reported about itself.
    if (!isRealPid(running.pid) || running.pid !== info?.pid) throw new Error(`Could not confirm which process runs the board for ${path.basename(root)}. Stop it and try again.`);
    if (running.pid === process.pid) throw new Error('That board is served by this process.');
    process.kill(running.pid, 'SIGTERM');
    // Wait for it to finish saving and exit, so nothing writes into the folder after the move.
    const deadline = Date.now() + 4000;
    while (alive(running.pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    if (alive(running.pid)) throw new Error(`The board for ${path.basename(root)} is still running. Stop it and try again.`);
  } else if (alive(info?.pid)) {
    // server.json names a live process that did not answer. It may be a busy
    // Blueprint server, so moving the folder could lose its next save.
    throw new Error(`The board for ${path.basename(root)} may still be running. Stop it and try again. If no board is running, delete .blueprint/server.json in that folder.`);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(home, 'deleted', `${path.basename(root)}-${stamp}`);
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await rename(dir, target);
  } catch (err) {
    // rename cannot cross disks. Copy, then remove the original.
    if (err.code !== 'EXDEV') throw err;
    await cp(dir, target, { recursive: true });
    await rm(dir, { recursive: true, force: true });
  }
  await forgetProject(home, root);
  return target;
}
