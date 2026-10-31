import { describe, expect, it } from 'vitest';
import { renderSandboxMarkerInstruction, sandboxMarkerCommand, scrubHostCli } from './sandboxInstructions.js';

describe('sandboxMarkerCommand', () => {
  it('derives script and events paths from the container-visible run dir (docker)', () => {
    expect(sandboxMarkerCommand({ runDir: '/karst-bridge/7', core: 'opencode2', stage: 'impl' }))
      .toBe('node /karst-bridge/7/opencode2/emit-marker.cjs /karst-bridge/7/events.ndjson impl');
  });
  it('uses the same host path for sbx and the fix stage', () => {
    expect(sandboxMarkerCommand({ runDir: '/g/events/7', core: 'claude', stage: 'fix' }))
      .toBe('node /g/events/7/claude/emit-marker.cjs /g/events/7/events.ndjson fix');
  });
});

describe('renderSandboxMarkerInstruction', () => {
  const text = renderSandboxMarkerInstruction({ runDir: '/karst-bridge/7', core: 'opencode2', stage: 'impl' });
  it('names the command and the three exit codes', () => {
    expect(text).toContain('`node /karst-bridge/7/opencode2/emit-marker.cjs /karst-bridge/7/events.ndjson impl`');
    expect(text).toMatch(/0 = accepted/);
    expect(text).toMatch(/1 = refused.*stderr.*do not retry/);
    expect(text).toMatch(/3 = queued.*NOT a failure.*do not loop-retry/);
    expect(text).toContain('uncommitted changes block the marker');
    expect(text).toContain('records nothing in events.ndjson');
  });
  it('carries no host CLI, db, approval tail or MCP call', () => {
    expect(text).not.toMatch(/KARST_CLI|KARST_DB|--db|--manifest|stage \w+ pass|outside the workspace sandbox|MCP tool `/);
    expect(scrubHostCli(text).scrubbed).toBe(0);
  });
});

describe('scrubHostCli', () => {
  it('replaces host command spans and MCP tool calls', () => {
    const out = scrubHostCli('Run `node "$KARST_CLI" context --db "$KARST_DB" K-1` then call the karst MCP tool `guide`. Keep `npm test`.');
    expect(out.text).toBe('Run (not available in the sandbox) then (not available in the sandbox). Keep `npm test`.');
    expect(out.scrubbed).toBe(2);
  });
  it('leaves clean text untouched', () => {
    expect(scrubHostCli('nothing here')).toEqual({ text: 'nothing here', scrubbed: 0 });
  });
});

describe('scrubHostCli deferred MCP hint', () => {
  it('strips the ToolSearch hint', () => {
    const hint = 'karst MCP tools may be deferred: load them first with ToolSearch `select:mcp__karst__context,mcp__karst__stage`.';
    const out = scrubHostCli(`${hint} Then work.`);
    expect(out.text).not.toContain('deferred');
    expect(out.text).not.toContain('ToolSearch');
    expect(out.scrubbed).toBe(1);
  });
});
