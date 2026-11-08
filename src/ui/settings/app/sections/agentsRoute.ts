/**
 * The Agents page's location, kept in the URL hash so a reload (or a link) lands
 * on the same view:
 *
 *   #agents/roles[/<capability>][?compare=<preset>]
 *   #agents/profiles[/<name>]
 *   #agents/accounts[/<core>]
 *
 * An old Presets link (`#presets…`) redirects to the Roles tab. Anything
 * unrecognised parses to the Roles tab with no selection — never an error, a
 * stale hash must not leave the page blank.
 */
export type AgentsTab = 'roles' | 'profiles' | 'accounts';

export interface AgentsRoute {
  readonly tab: AgentsTab;
  /** The selected role capability (Roles), profile name (Profiles) or agent core (Accounts). */
  readonly selected?: string;
  /** The preset compared against the selected one (Roles only). */
  readonly compare?: string;
}

export function parseAgentsHash(hash: string): AgentsRoute {
  const text = hash.replace(/^#/, '');
  const [path = '', query = ''] = text.split('?', 2);
  const [head, tab, ...rest] = path.split('/');
  const selected = rest.length > 0 ? safeDecode(rest.join('/')) : undefined;
  const compare = new URLSearchParams(query).get('compare') ?? undefined;
  if (head === 'agents' && tab === 'profiles') {
    return selected ? { tab: 'profiles', selected } : { tab: 'profiles' };
  }
  if (head === 'agents' && tab === 'accounts') {
    return selected ? { tab: 'accounts', selected } : { tab: 'accounts' };
  }
  const onRoles = head === 'agents' && tab === 'roles';
  return {
    tab: 'roles',
    ...(onRoles && selected ? { selected } : {}),
    ...(onRoles && compare ? { compare } : {}),
  };
}

export function formatAgentsHash(route: AgentsRoute): string {
  const sel = route.selected ? `/${encodeURIComponent(route.selected)}` : '';
  const query = route.tab === 'roles' && route.compare ? `?compare=${encodeURIComponent(route.compare)}` : '';
  return `#agents/${route.tab}${sel}${query}`;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
