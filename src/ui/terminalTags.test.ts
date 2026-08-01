import { describe, expect, it } from 'vitest';
import { KARST_LAUNCH_ENV, KARST_TICKET_ENV } from './session.js';
import {
  forgetTerminalTagByName,
  MAX_TERMINAL_TAGS,
  parseTerminalTags,
  rememberTerminalTag,
  terminalIdentity,
  type TerminalTag,
} from './terminalTags.js';

describe('parseTerminalTags', () => {
  it('reads back what was written', () => {
    const tags: TerminalTag[] = [
      { ticketId: 7, name: 'Karst: ABC-1' },
      { ticketId: 9, name: 'Karst: ABC-2', launchId: 'launch-9' },
    ];
    expect(parseTerminalTags(JSON.parse(JSON.stringify(tags)))).toEqual(tags);
  });

  it('drops everything that is not a usable tag', () => {
    // Persisted state is external data by the time it is read back: a rewritten
    // workspace-state file must degrade to "no tags", never to a coerced ticket.
    expect(parseTerminalTags(undefined)).toEqual([]);
    expect(parseTerminalTags('nope')).toEqual([]);
    expect(
      parseTerminalTags([
        null,
        { ticketId: 0, name: 'zero' },
        { ticketId: -1, name: 'negative' },
        { ticketId: 1.5, name: 'fractional' },
        { ticketId: '7', name: 'stringy' },
        { ticketId: 7 },
        { ticketId: 7, name: '' },
        // A record with a corrupt generation is refused whole: a tag adopts a
        // terminal AND restores its hook identity, so half of one is not half
        // as useful, it is a session whose hooks answer under a wrong name.
        { ticketId: 7, name: 'bad-launch', launchId: 42 },
        { ticketId: 7, name: 'good' },
      ]),
    ).toEqual([{ ticketId: 7, name: 'good' }]);
  });
});

describe('rememberTerminalTag', () => {
  it('records a launch without mutating what it was given', () => {
    const tags: TerminalTag[] = [{ ticketId: 7, name: 'Karst: ABC-1' }];
    const next = rememberTerminalTag(tags, {
      ticketId: 9,
      name: 'Karst: ABC-2',
      launchId: 'launch-9',
    });

    expect(tags).toEqual([{ ticketId: 7, name: 'Karst: ABC-1' }]);
    expect(next).toEqual([
      { ticketId: 7, name: 'Karst: ABC-1' },
      { ticketId: 9, name: 'Karst: ABC-2', launchId: 'launch-9' },
    ]);
  });

  it('replaces the previous tag for the same ticket', () => {
    // One live terminal per ticket: a relaunch under a new name must not leave
    // the old name behind to adopt some unrelated tab later.
    const tags = rememberTerminalTag([{ ticketId: 7, name: 'old' }], {
      ticketId: 7,
      name: 'new',
      launchId: 'launch-2',
    });
    expect(tags).toEqual([{ ticketId: 7, name: 'new', launchId: 'launch-2' }]);
  });

  it('keeps only the most recent launches once the registry is full', () => {
    // A close normally drops a tag, but a crash or a missed close event does
    // not. The cap keeps a window's registry bounded either way, and drops the
    // oldest — the launches least likely to still have a terminal.
    let tags: TerminalTag[] = [];
    for (let i = 1; i <= MAX_TERMINAL_TAGS + 5; i++) {
      tags = rememberTerminalTag(tags, { ticketId: i, name: `Karst: ${i}` });
    }
    expect(tags).toHaveLength(MAX_TERMINAL_TAGS);
    expect(tags[0]).toEqual({ ticketId: 6, name: 'Karst: 6' });
    expect(tags.at(-1)).toEqual({
      ticketId: MAX_TERMINAL_TAGS + 5,
      name: `Karst: ${MAX_TERMINAL_TAGS + 5}`,
    });
  });

  it('replaces the previous tag holding the same name', () => {
    const tags = rememberTerminalTag([{ ticketId: 7, name: 'shared' }], {
      ticketId: 9,
      name: 'shared',
    });
    expect(tags).toEqual([{ ticketId: 9, name: 'shared' }]);
  });
});

describe('forgetTerminalTagByName', () => {
  it('drops the closed terminal and keeps the rest', () => {
    const tags: TerminalTag[] = [
      { ticketId: 7, name: 'a' },
      { ticketId: 9, name: 'b' },
    ];
    expect(forgetTerminalTagByName(tags, 'a')).toEqual([{ ticketId: 9, name: 'b' }]);
    expect(tags).toHaveLength(2);
  });

  it('returns the same array when nothing matches', () => {
    const tags: TerminalTag[] = [{ ticketId: 7, name: 'a' }];
    expect(forgetTerminalTagByName(tags, 'b')).toBe(tags);
  });
});

describe('terminalIdentity', () => {
  const tags: TerminalTag[] = [
    { ticketId: 7, name: 'Karst: ABC-1', launchId: 'launch-7' },
  ];

  it('reads the launch environment while it is still there', () => {
    expect(
      terminalIdentity(
        { [KARST_TICKET_ENV]: '9', [KARST_LAUNCH_ENV]: 'launch-9' },
        'Karst: ABC-1',
        tags,
      ),
    ).toEqual({ ticketId: 9, launchId: 'launch-9' });
  });

  it('falls back to the launch name once the environment is gone', () => {
    // The reload case: VS Code revives a terminal by reattaching to its
    // persistent process, and the ext-host handle it hands back carries no
    // creationOptions.env at all. The name is what survives.
    expect(terminalIdentity(undefined, 'Karst: ABC-1', tags)).toEqual({
      ticketId: 7,
      launchId: 'launch-7',
    });
  });

  it('has no identity for a terminal karst never launched', () => {
    expect(terminalIdentity(undefined, 'zsh', tags)).toBeUndefined();
    expect(terminalIdentity(undefined, undefined, tags)).toBeUndefined();
    expect(terminalIdentity({}, 'zsh', tags)).toBeUndefined();
  });

  it('refuses a name two tickets both answer to', () => {
    // Adoption hands a terminal the ticket's prompts. An ambiguous name is not
    // evidence, so it resolves to nothing rather than to a coin flip.
    const ambiguous: TerminalTag[] = [
      { ticketId: 7, name: 'Karst' },
      { ticketId: 9, name: 'Karst' },
    ];
    expect(terminalIdentity(undefined, 'Karst', ambiguous)).toBeUndefined();
  });
});
