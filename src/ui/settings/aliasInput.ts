/**
 * The alias field of the add wizard takes a name (`claude-work`) or pasted alias text
 * (`alias claude-work='CLAUDE_CONFIG_DIR=$HOME/.cw claude'`). The host needs the name
 * and, for pasted text, the text; this finds both. It does not parse the command.
 */
export interface AliasInput {
  readonly alias: string;
  readonly text?: string;
}

const NAME = /^[A-Za-z0-9._-]+$/;
const PASTED = /^\s*(?:alias\s+)?([A-Za-z0-9._-]+)=/;

/** `null` when the input is pasted text with no readable alias name. */
export function parseAliasInput(raw: string): AliasInput | null {
  const input = raw.trim();
  if (NAME.test(input)) return { alias: input };
  const name = PASTED.exec(input)?.[1];
  return name === undefined ? null : { alias: name, text: input };
}
