import { DEFAULT_READER, type ReaderPrefs } from './types';

export async function readerPrefs(): Promise<ReaderPrefs> {
  const saved = await chrome.storage.local.get(['readerPrefs', 'readerAppearanceVersion']);
  const prefs = { ...DEFAULT_READER, ...saved.readerPrefs };
  if ((saved.readerAppearanceVersion || 0) < 1) {
    // Migrate only the previous untouched default palette; preserve custom styles.
    if (prefs.background === '#f5f1e7' && prefs.opacity === 0.92) {
      prefs.background = DEFAULT_READER.background; prefs.opacity = DEFAULT_READER.opacity;
    }
    await chrome.storage.local.set({ readerPrefs: prefs, readerAppearanceVersion: 1 });
  }
  return prefs;
}
export async function saveReaderPrefs(patch: Partial<ReaderPrefs>) {
  const prefs = { ...await readerPrefs(), ...patch };
  await chrome.storage.local.set({ readerPrefs: prefs }); return prefs;
}
export function clampFrame(prefs: ReaderPrefs, width: number, height: number): ReaderPrefs {
  const w = Math.min(Math.max(280, prefs.width), width), h = Math.min(Math.max(180, prefs.height), height);
  return { ...prefs, width: w, height: h, x: Math.max(0, Math.min(prefs.x, width - w)), y: Math.max(0, Math.min(prefs.y, height - h)) };
}
export type ResizeDirection = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';

export function resizeFrame(origin: ReaderPrefs, direction: ResizeDirection, dx: number, dy: number, viewportWidth: number, viewportHeight: number): ReaderPrefs {
  const frame = clampFrame(origin, viewportWidth, viewportHeight);
  const west = direction.endsWith('w'), north = direction.startsWith('n');
  const right = frame.x + frame.width, bottom = frame.y + frame.height;
  const maxWidth = west ? right : viewportWidth - frame.x;
  const maxHeight = north ? bottom : viewportHeight - frame.y;
  const width = west || direction.endsWith('e') ? Math.min(maxWidth, Math.max(Math.min(280, viewportWidth), frame.width + (west ? -dx : dx))) : frame.width;
  const height = north || direction.startsWith('s') ? Math.min(maxHeight, Math.max(Math.min(180, viewportHeight), frame.height + (north ? -dy : dy))) : frame.height;
  return { ...frame, x: west ? right - width : frame.x, y: north ? bottom - height : frame.y, width, height };
}
const shortcutModifiers = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
const shortcutKey = /^[A-Z0-9]$|^F(?:[1-9]|1[0-2])$/;

export function normalizeReaderShortcut(value: string) {
  const parts = value.toUpperCase().split('+').map(part => part.trim());
  const key = parts.pop();
  const modifiers = shortcutModifiers.filter(modifier => parts.includes(modifier.toUpperCase()));
  if (!key || !shortcutKey.test(key) || parts.length !== modifiers.length || !modifiers.some(modifier => modifier !== 'Shift')) return;
  return [...modifiers, key].join('+');
}

function eventShortcutKey(event: KeyboardEvent) {
  return event.shiftKey && /^Digit[0-9]$/.test(event.code) ? event.code.slice(-1) : event.key.toUpperCase();
}

export function recordReaderShortcut(event: KeyboardEvent) {
  if (event.isComposing || event.repeat || event.getModifierState('AltGraph')) return;
  const key = eventShortcutKey(event);
  if (!shortcutKey.test(key) || (!event.altKey && !event.ctrlKey && !event.metaKey)) return;
  if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey && /^[ACVXYZ]$/.test(key)) return;
  return [event.ctrlKey && 'Ctrl', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta', key].filter(Boolean).join('+');
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string, allowEditing = false) {
  if (event.isComposing || event.repeat || event.getModifierState('AltGraph') || (!allowEditing && event.composedPath().some(el => el instanceof HTMLElement && isEditing(el)))) return false;
  const parts = shortcut.toLowerCase().split('+').map(s => s.trim());
  return event.altKey === parts.includes('alt') && event.ctrlKey === parts.includes('ctrl') &&
    event.shiftKey === parts.includes('shift') && event.metaKey === parts.includes('meta') && eventShortcutKey(event).toLowerCase() === parts.at(-1);
}
export function isEditing(target: Element | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
