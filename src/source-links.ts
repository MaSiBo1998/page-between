const LINK_PREFIX = 'novel-source-link:';
const DIGITS = '零一二三四五六七八九';
const NUMBER = '[0-9零〇一二两三四五六七八九十百千万]+';
const chapterPrefix = new RegExp(`^(?:第\\s*(${NUMBER})\\s*[章节回话]|chapter\\s+(\\d+))`, 'i');
const chapterRange = new RegExp(`^(?:第\\s*${NUMBER}\\s*[-—~～至到]\\s*(?:第\\s*)?${NUMBER}\\s*[章节回话]|chapter\\s+\\d+\\s*[-–—~]\\s*\\d+)`, 'i');

function chapterNumber(raw: string) {
  if (/^\d+$/.test(raw)) return Number(raw);
  const value = raw.replace(/〇/g, '零').replace(/两/g, '二');
  if (!/[十百千万]/.test(value)) return Number([...value].map(char => DIGITS.indexOf(char)).join(''));
  let total = 0, section = 0, digit = 0;
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };
  for (const char of value) {
    if (char === '万') { total += (section + digit || 1) * units[char]; section = 0; digit = 0; }
    else if (units[char]) { section += (digit || 1) * units[char]; digit = 0; }
    else if (DIGITS.includes(char)) digit = DIGITS.indexOf(char);
    else return NaN;
  }
  return total + section + digit;
}

function chapterIdentity(raw: string) {
  const title = raw.normalize('NFKC').trim().toLowerCase();
  if (chapterRange.test(title)) return undefined;
  const prefix = title.match(chapterPrefix);
  const rest = title.slice(prefix?.[0].length ?? 0);
  const joined = new RegExp(`第\\s*${NUMBER}\\s*[章节回话]|chapter\\s+\\d+|^\\s*[-—~～至到]\\s*(?:第\\s*)?${NUMBER}`, 'i');
  if (joined.test(rest) || /(?:合章|合并章|未完整|二合一|三合一)/.test(rest)) return undefined;
  const number = prefix ? chapterNumber(prefix[1] || prefix[2]) : undefined;
  if (number !== undefined && (!Number.isSafeInteger(number) || number < 0)) return undefined;
  const name = rest.replace(/[\p{P}\p{Z}\s]/gu, '');
  if (!name && number === undefined) return undefined;
  return { number, name };
}

export function matchSourceChapter(title: string, target: readonly string[]) {
  const identity = chapterIdentity(title);
  if (!identity) return undefined;
  let found: number | undefined;
  let sameNumber = 0;
  for (const [index, candidate] of target.entries()) {
    const other = chapterIdentity(candidate);
    if (identity.number !== undefined && other?.number === identity.number && ++sameNumber > 1) return undefined;
    if (!other || other.number !== identity.number || other.name !== identity.name) continue;
    if (found !== undefined) return undefined;
    found = index;
  }
  return found;
}

export async function linkSources(first: string, second: string) {
  if (first === second) return;
  const pair = [first, second].sort();
  await chrome.storage.local.set({ [LINK_PREFIX + pair.join('|')]: pair });
}

export async function linkedSources(bookId: string) {
  const storage = await chrome.storage.local.get(null);
  const pairs = Object.entries(storage).filter(([key, value]) => key.startsWith(LINK_PREFIX) && Array.isArray(value) && value.length === 2).map(([, pair]) => pair as string[]);
  const linked = new Set([bookId]);
  for (let previous = 0; previous !== linked.size;) {
    previous = linked.size;
    for (const [first, second] of pairs) if (linked.has(first) || linked.has(second)) { linked.add(first); linked.add(second); }
  }
  linked.delete(bookId);
  return [...linked];
}
