/** Collapse display-only blank lines while keeping original chapter offsets. */
export function readerParagraphs(text: string, base = 0): { text: string; offset: number }[] {
  return [...text.matchAll(/[^\r\n]+/g)].filter(match => match[0].trim()).map(match => ({
    text: match[0], offset: base + match.index
  }));
}

/** Old saved positions can fall inside blank lines that are no longer rendered. */
export function paragraphAnchor(elements: HTMLElement[], offset: number): HTMLElement | undefined {
  return elements.find(el => offset <= Number(el.dataset.offset) + (el.textContent?.length || 0)) || elements.at(-1);
}
