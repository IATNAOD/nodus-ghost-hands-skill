// Which monitors a vision step looks at, and where a search area is - in physical pixels.
// Pure: the main process passes the displays it knows (Electron ids, labels) merged with the
// helper's physical monitor rectangles.
import type { MonitorKey, MonitorSel, Region, RegionSel } from "./model";

export interface Monitor {
  /** Electron display id */
  id: string;
  /** helper id: \\.\DISPLAY1 */
  device: string;
  name: string;
  primary: boolean;
  /** physical pixels of the virtual desktop */
  bounds: Region;
  scale: number;
}

/** A stored monitor: by id, else the same name and size, else the same size. */
export function findMonitor(monitors: Monitor[], key: MonitorKey): Monitor | null {
  return (
    monitors.find((m) => m.id === key.id && m.bounds.w === key.w && m.bounds.h === key.h) ??
    monitors.find((m) => m.name === key.name && m.bounds.w === key.w && m.bounds.h === key.h) ??
    monitors.find((m) => m.bounds.w === key.w && m.bounds.h === key.h) ??
    null
  );
}

const contains = (bounds: Region, x: number, y: number) => x >= bounds.x && y >= bounds.y && x < bounds.x + bounds.w && y < bounds.y + bounds.h;

/**
 * The monitors of a selection. `active` - of the window in front, `cursor` - under the cursor.
 * @returns [] when a listed monitor is gone (the step fails with monitor-missing)
 */
export function selectMonitors(monitors: Monitor[], sel: MonitorSel | null | undefined, context: { active?: { x: number; y: number } | null; cursor?: { x: number; y: number } | null }): Monitor[] {
  const at = (point: { x: number; y: number } | null | undefined) => (point ? monitors.filter((m) => contains(m.bounds, point.x, point.y)).slice(0, 1) : []);

  switch (sel?.mode) {
    case "primary":
      return monitors.filter((m) => m.primary).slice(0, 1);
    case "active":
      return at(context.active).length ? at(context.active) : monitors.filter((m) => m.primary).slice(0, 1);
    case "cursor":
      return at(context.cursor).length ? at(context.cursor) : monitors.filter((m) => m.primary).slice(0, 1);
    case "list": {
      const found = sel.list.map((key) => findMonitor(monitors, key));
      return found.every(Boolean) ? [...new Set(found as Monitor[])] : [];
    }
    default:
      return monitors;
  }
}

export const isRegionSel = (value: unknown): value is RegionSel => Boolean(value) && typeof value === "object" && "monitor" in (value as object);

/** A search area in physical pixels: a stored one is monitor-local; null when its monitor is gone. */
export function areaRect(monitors: Monitor[], region: RegionSel | Region): Region | null {
  if (!isRegionSel(region)) return region;

  const monitor = findMonitor(monitors, region.monitor);
  if (!monitor) return null;

  const x = Math.max(0, Math.min(region.x, monitor.bounds.w - 1));
  const y = Math.max(0, Math.min(region.y, monitor.bounds.h - 1));
  return { x: monitor.bounds.x + x, y: monitor.bounds.y + y, w: Math.max(1, Math.min(region.w, monitor.bounds.w - x)), h: Math.max(1, Math.min(region.h, monitor.bounds.h - y)) };
}

/** The monitor that holds most of a rectangle. */
export function monitorOf(monitors: Monitor[], rect: Region): Monitor | null {
  let best: Monitor | null = null;
  let area = 0;

  for (const m of monitors) {
    const w = Math.min(rect.x + rect.w, m.bounds.x + m.bounds.w) - Math.max(rect.x, m.bounds.x);
    const h = Math.min(rect.y + rect.h, m.bounds.y + m.bounds.h) - Math.max(rect.y, m.bounds.y);
    if (w > 0 && h > 0 && w * h > area) {
      area = w * h;
      best = m;
    }
  }
  return best;
}

export const keyOf = (monitor: Monitor): MonitorKey => ({ id: monitor.id, name: monitor.name, w: monitor.bounds.w, h: monitor.bounds.h });
