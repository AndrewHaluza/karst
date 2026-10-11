import { describe, expect, it } from 'vitest';
import { channelFor, launchHasMcp } from './karstCommandText.js';
import { renderDoneMarkerInstruction } from './workflowCommand.js';
import { renderGuideInstruction } from '../cli/guide.js';
import { MARKER_REFUSED, MCP_TOOLS_PREFERRED } from './promptText.js';

const supported = { surfaces: { mcpConfigInteractive: { supported: true } } } as never;
const unsupported = { surfaces: { mcpConfigInteractive: { supported: false } } } as never;
const base = { hookChannel: {}, cliEntry: '/c', dbPath: '/d' };

describe('launchHasMcp', () => {
  it('true only when core, channel, cli and db all present', () => {
    expect(launchHasMcp({ adapter: supported, ...base })).toBe(true);
    expect(launchHasMcp({ adapter: unsupported, ...base })).toBe(false);
    expect(launchHasMcp({ adapter: supported, ...base, hookChannel: undefined })).toBe(false);
    expect(launchHasMcp({ adapter: supported, ...base, cliEntry: undefined })).toBe(false);
    expect(launchHasMcp({ adapter: supported, ...base, dbPath: '' })).toBe(false);
    expect(launchHasMcp({ adapter: {} as never, ...base })).toBe(false);
  });
  it('maps to channel', () => {
    expect(channelFor(true)).toBe('mcp');
    expect(channelFor(false)).toBe('cli-env');
  });
});

describe('MCP-first marker text', () => {
  const cmd = 'node "$KARST_CLI" stage impl pass --db "$KARST_DB"';
  it('impl names stage, notes, artifact tools with CLI fallback', () => {
    const t = renderDoneMarkerInstruction(cmd, 'K-1', 'impl');
    expect(t).toContain('call the karst MCP tool `stage` with { stage: "impl" } to record the done marker');
    expect(t).toContain('If the tool is not available, run');
    expect(t).toContain('`notes` with { action: "post"');
    expect(t).toContain('`artifact` with { path: "<path>", kind: "<kind>" }');
    expect(t).toContain(`run \`${cmd} K-1\``);
    expect(t).toContain('do not retry blindly');
    expect(t).toContain(MARKER_REFUSED);
  });
  it('fix stage has no notes ask', () => {
    const t = renderDoneMarkerInstruction('node "$KARST_CLI" stage fix pass', 'K-1', 'fix');
    expect(t).toContain('{ stage: "fix" }');
    expect(t).not.toContain('`notes`');
  });
  it('no mcpStage keeps CLI-only text', () => {
    const t = renderDoneMarkerInstruction(cmd, 'K-1');
    expect(t).not.toContain('MCP tool');
    expect(t).toContain('request approval to run this exact marker command');
  });
  it('guide pointer per channel', () => {
    expect(renderGuideInstruction('node x guide', true)).toContain('call the karst MCP tool `guide`');
    const cli = renderGuideInstruction('node x guide');
    expect(cli).toBe(
      'To understand how Karst works and what this CLI can do, run `node x guide` and read its output. ' +
        MCP_TOOLS_PREFERRED,
    );
  });
});
