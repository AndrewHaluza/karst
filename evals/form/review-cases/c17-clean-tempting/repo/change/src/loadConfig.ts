export type Settings = Record<string, string>;

export function pick(settings: Map<string, string>, key: string): string {
  if (!settings.has(key)) {
    throw new Error(`missing setting: ${key}`);
  }
  return settings.get(key)!;
}

export function parseSettings(text: string, source: string): Settings {
  try {
    const raw: unknown = JSON.parse(text);
    if (typeof raw !== 'object' || raw === null) {
      throw new TypeError('settings must be an object');
    }
    return raw as Settings;
  } catch (err) {
    throw new Error(`cannot read settings from ${source}`, { cause: err });
  }
}
