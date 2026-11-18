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
  const pointer = (type: string, x = 100, y = 100) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, screenX: x, screenY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 1 }, isPrimary: { value: true }, pointerType: { value: 'mouse' } });
    target.dispatchEvent(event); return event;
  };
  return { target, send, pointer };
}
describe('浮窗全区域长按拖动', () => {
  it('没有 randomUUID 时也能长按拖动，松手结束并抑制一次点击', () => {
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) });
    const { target, send, pointer } = fixture();
    pointer('pointerdown');
    vi.advanceTimersByTime(299); expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1); expect(send.mock.calls[0][0]).toMatchObject({ phase: 'start', x: 100, y: 100 });
    expect(pointer('pointermove', 140, 160).defaultPrevented).toBe(true);
    expect(send.mock.calls[1][0]).toMatchObject({ phase: 'move', x: 140, y: 160 });
    pointer('pointerup', 150, 170);
    expect(send.mock.calls.at(-2)![0]).toMatchObject({ phase: 'move', x: 150, y: 170 });
    expect(send.mock.calls.at(-1)![0].phase).toBe('end');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true }); target.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true); expect(document.documentElement.classList.contains('reader-dragging')).toBe(false);
  });
  it('快速移动或点击不启动拖动，正文也不允许选字', () => {
    const { target, send, pointer } = fixture();
    const select = new Event('selectstart', { bubbles: true, cancelable: true });
    target.dispatchEvent(select); expect(select.defaultPrevented).toBe(true);
    pointer('pointerdown'); expect(pointer('pointermove', 107).defaultPrevented).toBe(false);
    vi.advanceTimersByTime(400); expect(send).not.toHaveBeenCalled();
    pointer('pointerdown'); pointer('pointerup'); vi.advanceTimersByTime(400); expect(send).not.toHaveBeenCalled();
  });
  it.each(['button', 'input', 'select', 'a'])('%s 不拦截原交互', tag => {
    const { send, pointer } = fixture(tag); pointer('pointerdown'); vi.advanceTimersByTime(400); expect(send).not.toHaveBeenCalled();
  });
  it('失焦、取消和隐藏均结束拖动，不留下捕获或长按计时器', () => {
    const { target, send, pointer } = fixture();
    pointer('pointerdown'); window.dispatchEvent(new Event('blur')); vi.advanceTimersByTime(400); expect(send).not.toHaveBeenCalled();
    pointer('pointerdown'); vi.advanceTimersByTime(300); pointer('pointercancel'); expect(send.mock.calls.at(-1)![0].phase).toBe('end');
    pointer('pointerdown'); vi.advanceTimersByTime(300);
    window.dispatchEvent(new MessageEvent('message', { source: window.parent, data: { type: 'novel-reader-visibility', visible: false } }));
    expect(send.mock.calls.at(-1)![0].phase).toBe('end'); expect(target.hasPointerCapture(1)).toBe(false);
  });
});
