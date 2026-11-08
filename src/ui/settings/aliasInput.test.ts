import { describe, expect, it } from 'vitest';
import { parseAliasInput } from './aliasInput.js';

describe('parseAliasInput', () => {
  it('takes a plain name as the alias to look up', () => {
    expect(parseAliasInput('  claude-work ')).toEqual({ alias: 'claude-work' });
  });
  it('takes the name and the text from a pasted alias line', () => {
    const text = "alias claude-work='CLAUDE_CONFIG_DIR=$HOME/.cw claude'";
    expect(parseAliasInput(text)).toEqual({ alias: 'claude-work', text });
    const bare = "cw='CLAUDE_CONFIG_DIR=$HOME/.cw claude'";
    expect(parseAliasInput(`\n${bare}\n`)).toEqual({ alias: 'cw', text: bare });
  });
  it('refuses text with no alias name', () => {
    expect(parseAliasInput('CLAUDE_CONFIG_DIR=/x claude')).toEqual({ alias: 'CLAUDE_CONFIG_DIR', text: 'CLAUDE_CONFIG_DIR=/x claude' });
    expect(parseAliasInput('some words here')).toBeNull();
    expect(parseAliasInput('')).toBeNull();
  });
});
