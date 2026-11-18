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
export function matchesShortcut(event: KeyboardEvent, shortcut: string) {
  if (event.isComposing || event.repeat || event.composedPath().some(el => el instanceof HTMLElement &&
      (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))) return false;
  const parts = shortcut.toLowerCase().split('+').map(s => s.trim());
  return event.altKey === parts.includes('alt') && event.ctrlKey === parts.includes('ctrl') &&
    event.shiftKey === parts.includes('shift') && event.metaKey === parts.includes('meta') && event.key.toLowerCase() === parts.at(-1);
}
export function isEditing(target: Element | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}
