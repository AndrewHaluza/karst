import { describe, expect, it } from 'vitest';
import { remoteSh, sshQuote } from './sshQuote.js';

describe('sshQuote', () => {
  it('wraps a plain string in single quotes', () => {
    expect(sshQuote('echo hi')).toBe("'echo hi'");
  });

  it('escapes a single quote as close, escaped quote, reopen', () => {
    expect(sshQuote("it's")).toBe("'it'\\''s'");
    expect(sshQuote("'")).toBe("''\\'''");
  });

  it('keeps command substitution inert', () => {
    expect(sshQuote('$(rm -rf /)')).toBe("'$(rm -rf /)'");
    expect(sshQuote('`id`')).toBe("'`id`'");
  });

  it('keeps a newline inside the quotes', () => {
    expect(sshQuote('line1\nline2')).toBe("'line1\nline2'");
  });

  it('keeps a semicolon inside the quotes', () => {
    expect(sshQuote('a; rm -rf /')).toBe("'a; rm -rf /'");
  });

  it('keeps a leading dash, so it can never be read as an option', () => {
    expect(sshQuote('-oProxyCommand=evil')).toBe("'-oProxyCommand=evil'");
  });

  it('quotes the empty string as two single quotes', () => {
    expect(sshQuote('')).toBe("''");
  });

  it('always starts and ends with exactly one outermost single quote', () => {
    for (const s of ['', 'a', "a'b", '-x', '$(x)', 'a\nb']) {
      expect(sshQuote(s).startsWith("'")).toBe(true);
      expect(sshQuote(s).endsWith("'")).toBe(true);
    }
  });
});

describe('remoteSh', () => {
  it('runs one script through sh, never through the remote login shell', () => {
    expect(remoteSh('echo hi')).toBe("sh -c 'echo hi'");
    expect(remoteSh('if true; then echo ok; fi')).toBe("sh -c 'if true; then echo ok; fi'");
  });

  it('quotes the script as one argument', () => {
    expect(remoteSh("echo 'quoted'")).toBe("sh -c 'echo '\\''quoted'\\'''");
    expect(remoteSh('')).toBe("sh -c ''");
  });
});
