import { afterEach, describe, expect, it, vi } from 'vitest';
import { installReaderDrag } from '../src/reader-drag';

const cleanups: (() => void)[] = [];
afterEach(() => { cleanups.splice(0).forEach(cleanup => cleanup()); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });
function fixture(tag = 'p') {
  vi.useFakeTimers();
  const target = document.createElement(tag); target.textContent = '可选文字'; document.body.append(target);
  let captured = false;
  target.setPointerCapture = () => { captured = true; };
  target.hasPointerCapture = () => captured;
  target.releasePointerCapture = () => { captured = false; };
  const send = vi.fn(); cleanups.push(installReaderDrag(document, send));
  const pointer = (type: string, x = 100, y = 100, pointerType = 'mouse', button = 0) => {
    const buttons = type === 'pointerdown' || type === 'pointermove' ? (button === 2 ? 2 : 1) : 0;
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, screenX: x, screenY: y, button, buttons });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: pointerType } });
    target.dispatchEvent(event); return event;
  };
  return { target, send, pointer };
}
describe('浮窗即时拖动', () => {
  it('没有 randomUUID 时也能即时拖动，松手结束并抑制一次点击', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const { target, send, pointer } = fixture();
    pointer('pointerdown');
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ phase: 'start', x: 100, y: 100 });
    expect(target.hasPointerCapture(1)).toBe(true);
    expect(pointer('pointermove', 140, 160).defaultPrevented).toBe(true);
    expect(send.mock.calls[1][0]).toMatchObject({ phase: 'move', x: 140, y: 160 });
    pointer('pointerup', 150, 170);
    expect(send.mock.calls.at(-2)![0]).toMatchObject({ phase: 'move', x: 150, y: 170 });
    expect(send.mock.calls.at(-1)![0].phase).toBe('end');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }); target.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); expect(document.documentElement.classList.contains('reader-dragging')).toBe(false);
  });
  it('按住不动或轻微抖动不会拖动，正文也不允许选字', () => {
    const { target, send, pointer } = fixture();
    const select = new Event('selectstart', { bubbles: true, cancelable: true });
    target.dispatchEvent(select); expect(select.defaultPrevented).toBe(true);
    pointer('pointerdown'); expect(pointer('pointermove', 102).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(400); expect(send).toHaveBeenCalledTimes(1);
    pointer('pointerup'); expect(send.mock.calls.map(([event]) => event.phase)).toEqual(['start', 'end']);
    expect(target.hasPointerCapture(1)).toBe(false);
  });
  it('只有松手坐标变化时仍视为拖动，不触发正文点击', () => {
    const { target, send, pointer } = fixture();
    pointer('pointerdown'); pointer('pointerup', 108);
    expect(send.mock.calls.map(([event]) => event.phase)).toEqual(['start', 'move', 'end']);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 });
    target.dispatchEvent(click); expect(click.defaultPrevented).toBe(true);
  });
  it.each(['button', 'input', 'select', 'a', 'summary'])('%s 不拦截原交互', tag => {
    const { target, send, pointer } = fixture(tag); pointer('pointerdown'); pointer('pointermove', 120);
    expect(send).not.toHaveBeenCalled(); expect(target.hasPointerCapture(1)).toBe(false);
  });
  it('不拦截右键及触摸', () => {
    const { send, pointer } = fixture();
    pointer('pointerdown', 100, 100, 'mouse', 2); pointer('pointermove', 120);
    pointer('pointerdown', 100, 100, 'touch'); pointer('pointermove', 120, 100, 'touch');
    expect(send).not.toHaveBeenCalled();
  });
  it('失焦、取消和隐藏均结束拖动，不留下捕获', () => {
    const { target, send, pointer } = fixture();
    pointer('pointerdown'); window.dispatchEvent(new Event('blur')); expect(send.mock.calls.map(([event]) => event.phase)).toEqual(['start', 'end']);
    expect(target.hasPointerCapture(1)).toBe(false);
    pointer('pointerdown'); pointer('pointermove', 130); pointer('pointercancel'); expect(send.mock.calls.at(-1)![0].phase).toBe('end');
    pointer('pointerdown'); pointer('pointermove', 130);
    window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { type: 'novel-reader-visibility', visible: false } }));
    expect(send.mock.calls.at(-1)![0].phase).toBe('end'); expect(target.hasPointerCapture(1)).toBe(false);
  });
});
