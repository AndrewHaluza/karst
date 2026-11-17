export type Settings = Record<string, string>;

export function pick(settings: Settings, key: string): string {
  if (!Object.hasOwn(settings, key)) {
    throw new Error(`missing setting: ${key}`);
  }
  return settings[key]!;
}

export function parseSettings(text: string, source: string): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`cannot read settings from ${source}`, { cause: err });
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new TypeError(`settings in ${source} must be an object`);
  }
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== 'string') {
      throw new TypeError(`setting ${key} in ${source} must be a string`);
    }
  }
  return raw as Settings;
}
