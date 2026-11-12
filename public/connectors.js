// Arrows between things on the board. They are drawn in one SVG layer inside
// #world, so they pan and zoom with everything else. Each end is measured from
// the page (offsetLeft, offsetWidth...), not from the saved board, so an arrow
// follows an artboard or note while you drag it, before the move is saved.

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

export function createConnectors({ world, getBoard, rectOf, getZoom }) {
  const svg = svgEl('svg', { class: 'links', 'aria-hidden': 'true' });
  const draft = svgEl('path', { class: 'link-draft' });
  svg.append(draft);
  world.prepend(svg); // first child: arrows sit under artboards and notes
  const labels = document.createElement('div');
  labels.className = 'link-labels';
  world.append(labels);

  let selectedId = null;

  // Where the line from a box's centre towards (tx, ty) leaves the box, plus a gap.
  function edgePoint(r, tx, ty, gap) {
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const dx = tx - cx;
    const dy = ty - cy;
    if (!dx && !dy) return { x: cx, y: cy };
    const sx = dx ? r.width / 2 / Math.abs(dx) : Infinity;
    const sy = dy ? r.height / 2 / Math.abs(dy) : Infinity;
    const s = Math.min(sx, sy);
    const len = Math.hypot(dx, dy);
    return { x: cx + dx * s + (dx / len) * gap, y: cy + dy * s + (dy / len) * gap };
  }

  // A line from box a to a point or box b, with an arrowhead at the b end.
  function geometry(a, b) {
    const z = getZoom();
    const gap = 6 / z;
    const bc = 'width' in b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : b;
    const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
    const p1 = edgePoint(a, bc.x, bc.y, gap);
    const p2 = 'width' in b ? edgePoint(b, ac.x, ac.y, gap) : b;
    const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
    const ux = (p2.x - p1.x) / len;
    const uy = (p2.y - p1.y) / len;
    const head = 9 / z; // arrowhead size stays the same on screen at any zoom
    const back = { x: p2.x - ux * head, y: p2.y - uy * head };
    const wing = head * 0.55;
    return {
      p1,
      p2,
      line: `M${p1.x},${p1.y} L${back.x},${back.y}`,
      head: `M${p2.x},${p2.y} L${back.x - uy * wing},${back.y + ux * wing} L${back.x + uy * wing},${back.y - ux * wing} Z`,
      mid: { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 },
    };
  }

  const groups = new Map(); // connector id -> { g, line, head, hit, label }

  function render() {
    // Read every box first, then write. Mixing the two makes the browser
    // recompute layout once per arrow instead of once in total.
    const drawn = [];
    for (const c of getBoard().connectors) {
      const a = rectOf(c.from);
      const b = rectOf(c.to);
      if (a && b) drawn.push({ c, geo: geometry(a, b) });
    }
    const seen = new Set();
    for (const { c, geo } of drawn) {
      seen.add(c.id);
      let entry = groups.get(c.id);
      if (!entry) {
        const g = svgEl('g', { class: 'link' });
        g.dataset.connector = c.id;
        const hit = svgEl('path', { class: 'link-hit' });
        const line = svgEl('path', { class: 'link-line' });
        const head = svgEl('path', { class: 'link-head' });
        g.append(hit, line, head);
        svg.append(g);
        const label = document.createElement('div');
        label.className = 'link-label';
        label.dataset.connector = c.id;
        labels.append(label);
        entry = { g, line, head, hit, label };
        groups.set(c.id, entry);
      }
      entry.line.setAttribute('d', geo.line);
      entry.hit.setAttribute('d', `M${geo.p1.x},${geo.p1.y} L${geo.p2.x},${geo.p2.y}`);
      entry.head.setAttribute('d', geo.head);
      entry.g.classList.toggle('selected', c.id === selectedId);
      entry.label.textContent = c.label || '';
      entry.label.hidden = !c.label;
      entry.label.classList.toggle('selected', c.id === selectedId);
      entry.label.style.left = geo.mid.x + 'px';
      entry.label.style.top = geo.mid.y + 'px';
      entry.mid = geo.mid;
    }
    for (const [id, entry] of groups) {
      if (!seen.has(id)) {
        entry.g.remove();
        entry.label.remove();
        groups.delete(id);
      }
    }
  }

  return {
    render,
    select(id) {
      selectedId = id;
      render();
    },
    // The line that follows the pointer while you draw a new arrow.
    showDraft(fromId, point, overId) {
      const a = rectOf(fromId);
      if (!a) return;
      const b = overId && overId !== fromId ? rectOf(overId) : null;
      const geo = geometry(a, b || point);
      draft.setAttribute('d', `${geo.line} ${geo.head}`);
      draft.style.display = 'inline';
    },
    hideDraft() {
      draft.style.display = 'none';
    },
    midpointOf: (id) => groups.get(id)?.mid || null,
  };
}
