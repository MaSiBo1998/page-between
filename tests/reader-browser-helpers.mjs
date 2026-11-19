export async function revealToolbar(reader) {
  const header = reader.locator('.reader.is-reading[data-controls=auto] .reader-header');
  if (await header.count()) await header.hover({ position: { x: 24, y: 9 } });
}

export async function openChapter(reader, index) {
  const tab = reader.getByRole('tab', { name: '目录', exact: true });
  if (await tab.getAttribute('aria-selected') !== 'true') { await revealToolbar(reader); await tab.click(); }
  await reader.getByRole('searchbox', { name: '搜索章节' }).fill(String(index + 1));
  await reader.locator(`.chapter-list button[data-chapter-index="${index}"]`).click();
}

export const chapterIndex = reader => reader.locator('.continuous-reader').getAttribute('data-chapter-index');
