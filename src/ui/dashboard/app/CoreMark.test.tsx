// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { AgentId } from './InsideParts.js';
import type { AgentExecutionView } from '../../../model/inside/types.js';

const exec = { provider: 'claude', providerLabel: 'Claude Code', modelLabel: 'Model A' } as unknown as AgentExecutionView;

describe('agent core mark (tight tier, UI-R10c exception)', () => {
  afterEach(cleanup);

  it('names the core for assistive tech and shows "core · model" as the tooltip text', () => {
    const { container } = render(<AgentId x={exec} />);
    const mark = container.querySelector('.agent-mark');
    expect(mark?.getAttribute('role')).toBe('img');
    expect(mark?.getAttribute('aria-label')).toBe('Claude Code');
    expect(mark?.getAttribute('data-tip')).toBe('Claude Code · Model A');
    expect(mark?.getAttribute('tabindex')).toBe('0');
  });

  it('uses the core name alone when no model is known', () => {
    const { container } = render(<AgentId x={{ ...exec, modelLabel: '' } as AgentExecutionView} />);
    expect(container.querySelector('.agent-mark')?.getAttribute('data-tip')).toBe('Claude Code');
  });

  it('keeps the visible core and model text for the wider tiers', () => {
    const { container } = render(<AgentId x={exec} />);
    expect(container.querySelector('.agent-core')?.textContent).toBe('Claude Code');
    expect(container.querySelector('.agent-model')?.textContent).toBe('Model A');
  });
});
