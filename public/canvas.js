// The camera. The whole board is one element (#world) with one CSS transform.
// cam.x and cam.y are where the board's origin sits on screen; cam.z is the zoom.

const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const GRID = 24;

export function createCanvas(viewport, world, { onChange }) {
  const cam = { x: 0, y: 0, z: 1 };
  let frame = 0;

  function apply() {
    world.style.transform = `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`;
    // The dot grid is a background on the viewport, moved and scaled to match.
    viewport.style.backgroundPosition = `${cam.x}px ${cam.y}px`;
    viewport.style.backgroundSize = `${GRID * cam.z}px ${GRID * cam.z}px`;
    document.documentElement.style.setProperty('--z', cam.z);
    onChange(cam);
  }

  // Zoom so the board point under (cx, cy) stays under it.
  function zoomAt(cx, cy, z) {
    z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
    cam.x = cx - (cx - cam.x) * (z / cam.z);
    cam.y = cy - (cy - cam.y) * (z / cam.z);
    cam.z = z;
    apply();
  }

  // Glide to a camera position. Used only for Fit and for jumping to an
  // artboard, which happen now and then. Direct panning never animates.
  function glideTo(target) {
    cancelAnimationFrame(frame);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
      Object.assign(cam, target);
      return apply();
    }
    const from = { ...cam };
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 320);
      const k = 1 - Math.pow(1 - t, 4); // strong ease-out
      cam.x = from.x + (target.x - from.x) * k;
      cam.y = from.y + (target.y - from.y) * k;
      cam.z = from.z + (target.z - from.z) * k;
      apply();
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
  }

  // Frame a rectangle of the board (in board pixels) inside the part of the
  // window that the floating panels leave free. `inset` is that free area's margins.
  function frameRect(rect, { animate = true, maxZoom = 1, inset = { top: 80, right: 40, bottom: 96, left: 40 } } = {}) {
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    const freeW = Math.max(innerWidth - inset.left - inset.right, 120);
    const freeH = Math.max(innerHeight - inset.top - inset.bottom, 120);
    const z = Math.max(MIN_ZOOM, Math.min(freeW / w, freeH / h, maxZoom));
    const target = { x: inset.left + (freeW - w * z) / 2 - rect.x * z, y: inset.top + (freeH - h * z) / 2 - rect.y * z, z };
    if (animate) glideTo(target);
    else {
      Object.assign(cam, target);
      apply();
    }
  }

  // Trackpad: two fingers pan. A pinch arrives as a wheel event with ctrlKey set.
  viewport.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      cancelAnimationFrame(frame);
      if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, cam.z * Math.exp(-e.deltaY * 0.01));
      else {
        cam.x -= e.deltaX;
        cam.y -= e.deltaY;
        apply();
      }
    },
    { passive: false },
  );

  return {
    cam,
    apply,
    zoomAt,
    frameRect,
    panBy(dx, dy) {
      cancelAnimationFrame(frame);
      cam.x += dx;
      cam.y += dy;
      apply();
    },
    // Screen point -> board point.
    toBoard: (sx, sy) => ({ x: (sx - cam.x) / cam.z, y: (sy - cam.y) / cam.z }),
  };
}
