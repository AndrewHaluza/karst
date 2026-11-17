// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { headerState, installHeaderDoubles, mountBodyLayout } from './fixtures/headerKit.js';

installHeaderDoubles();

describe('BodyLayout', () => {
  it('writes the layout onto <body data-layout> and follows every host `layout` push', () => {
    const h = mountBodyLayout(headerState());
    expect(document.body.dataset.layout).toBe('centered');
    h.emit({ type: 'layout', layout: 'full' });
    expect(document.body.dataset.layout).toBe('full');
    h.emit({ type: 'layout', layout: 'centered' });
    expect(document.body.dataset.layout).toBe('centered');
  });
});
