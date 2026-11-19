import { describe, expect, it } from 'vitest';
import { resizeFrame } from '../src/reader-prefs';
import { DEFAULT_READER } from '../src/types';

const origin = { ...DEFAULT_READER, x: 100, y: 150, width: 500, height: 400 };

describe('reader corner resize', () => {
  it.each([
    { corner: 'nw', dx: -50, dy: -40, x: 50, y: 110 },
    { corner: 'ne', dx: 50, dy: -40, x: 100, y: 110 },
    { corner: 'sw', dx: -50, dy: 40, x: 50, y: 150 },
    { corner: 'se', dx: 50, dy: 40, x: 100, y: 150 },
  ] as const)('holds the opposite corner of $corner during expansion and shrink', ({ corner, dx, dy, x, y }) => {
    expect(resizeFrame(origin, corner, dx, dy, 1000, 800)).toMatchObject({ x, y, width: 550, height: 440 });
    expect(resizeFrame(origin, corner, -dx, -dy, 1000, 800)).toMatchObject({ x: 200 - x, y: 300 - y, width: 450, height: 360 });
  });

  it('preserves the anchors at both limits', () => {
    expect(resizeFrame(origin, 'nw', -1000, -1000, 1000, 800)).toMatchObject({ x: 0, y: 0, width: 600, height: 550 });
    expect(resizeFrame(origin, 'nw', 1000, 1000, 1000, 800)).toMatchObject({ x: 320, y: 370, width: 280, height: 180 });
    expect(resizeFrame(origin, 'se', 1000, 1000, 1000, 800)).toMatchObject({ x: 100, y: 150, width: 900, height: 650 });
  });

  it.each([
    { edge: 'n', x: 100, y: 110, width: 500, height: 440 },
    { edge: 's', x: 100, y: 150, width: 500, height: 360 },
    { edge: 'w', x: 50, y: 150, width: 550, height: 400 },
    { edge: 'e', x: 100, y: 150, width: 450, height: 400 },
  ] as const)('resizes only one axis at $edge', ({ edge, ...expected }) => {
    expect(resizeFrame(origin, edge, -50, -40, 1000, 800)).toMatchObject(expected);
  });

  it('uses the whole viewport if it is smaller than the minimum', () => {
    expect(resizeFrame(origin, 'sw', 40, 90, 260, 160)).toMatchObject({ x: 0, y: 0, width: 260, height: 160 });
  });
});
