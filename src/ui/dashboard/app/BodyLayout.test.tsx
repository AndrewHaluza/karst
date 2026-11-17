// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { headerState, installHeaderDoubles, mountBodyLayout } from './fixtures/headerKit.js';

installHeaderDoubles();
beforeEach(() => {
  delete document.body.dataset.layout;
});

describe('BodyLayout', () => {
  it('writes the layout onto <body data-layout> and follows every host `layout` push', () => {
    const h = mountBodyLayout(headerState());
    expect(document.body.dataset.layout).toBe('centered');
    h.emit({ type: 'layout', layout: 'full' });
    expect(document.body.dataset.layout).toBe('full');
    h.emit({ type: 'layout', layout: 'centered' });
    expect(document.body.dataset.layout).toBe('centered');
  });

  it('keeps the mode the host wrote into the page shell until a `layout` push arrives', () => {
    document.body.dataset.layout = 'full';
    mountBodyLayout(headerState());
    expect(document.body.dataset.layout).toBe('full');
  });
});
