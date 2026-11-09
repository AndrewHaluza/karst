/**
 * The ticket details drawer's view model, built once when the drawer opens (the drawer never refreshes it). Pure:
 * the stored brief is parsed with `parseBriefSections` (the inverse of `renderBrief`), the facts sidebar groups are
 * assembled from DashboardState and the parsed brief, and the tab list follows the visibility rules. Brief and
 * description are data, so everything here stays plain strings for the renderer to show as text.
 */
import { briefSourceLabel } from '../../../model/briefSource.js';
import { parseBriefSections, type ParsedBrief } from '../../../integrations/briefMarkdown.js';
import type { DashboardState } from '../state.js';

export type DetailsTabId = 'brief' | 'desc' | 'raw';

export interface DetailsTab {
  readonly id: DetailsTabId;
  readonly label: string;
}

export interface FactRow {
  readonly label: string;
  readonly value: string;
  /** Set for a row drawn with the shared `TicketRefChip` (the parent ticket of a sub-task). */
  readonly ref?: string;
}

export interface FactGroup {
  readonly title: string;
  readonly rows: readonly FactRow[];
}

export interface TicketDetailsView {
  /** `ticketDataText(state)`: what Copy/Open as Markdown and the "As sent to agent" tab carry. */
  readonly text: string;
  readonly idLabel: string;
  readonly key: string | null;
  readonly title: string;
  readonly provider: string | null;
  readonly ticketUrl: string | null;
  readonly sourceLabel: string | null;
  readonly tabs: readonly DetailsTab[];
  /** Main-column Markdown of the `brief` tab (the brief body, or the description when there is no brief). */
  readonly main: string;
  readonly original: string | null;
  readonly planning: string | null;
  readonly comments: ParsedBrief['comments'];
  readonly attachments: ParsedBrief['attachments'];
  /** Facts sidebar: Karst first, then the brief groups; a group exists only when it has rows. */
  readonly groups: readonly FactGroup[];
  readonly tags: readonly string[];
  readonly empty: boolean;
}

const EMPTY_PARSED: ParsedBrief = { body: '', planning: null, details: [], people: [], relations: [], dates: [], links: [], tags: [], comments: [], attachments: [] };

const group = (title: string, rows: readonly FactRow[]): FactGroup[] => (rows.length ? [{ title, rows }] : []);

function karstRows(state: DashboardState): FactRow[] {
  const rows: FactRow[] = [];
  if (state.origin) rows.push({ label: 'From', value: state.origin });
  if (state.subtaskParent) rows.push({ label: 'Sub-task of', value: state.subtaskParent.ref, ref: state.subtaskParent.ref });
  if (state.priority) rows.push({ label: 'Priority', value: state.priority });
  if (state.approach) rows.push({ label: 'Approach', value: [state.approach.id, ...state.approach.phases].join(' · ') });
  const repos = [...new Set(state.worktrees.map((w) => w.serviceName ?? w.repoDisplay))];
  if (repos.length) rows.push({ label: 'Repos', value: repos.join(', ') });
  return rows;
}

function tabsOf(hasBrief: boolean, hasOriginal: boolean, hasMain: boolean): DetailsTab[] {
  if (!hasMain) return [];
  const tabs: DetailsTab[] = [{ id: 'brief', label: hasBrief ? 'Brief' : 'Description' }];
  if (hasOriginal) tabs.push({ id: 'desc', label: 'Original description' });
  tabs.push({ id: 'raw', label: 'As sent to agent' });
  return tabs;
}

/** `text` is `ticketDataText(state)`, passed in so this module does not import the overlay stack that imports it. */
export function buildTicketDetails(state: DashboardState, text: string): TicketDetailsView {
  const brief = (state.brief || '').trim();
  const description = (state.description || '').trim();
  const parsed = brief ? parseBriefSections(brief) : EMPTY_PARSED;
  const main = brief ? parsed.body : description;
  const hasMain = Boolean(brief || description);
  // The description is shown on its own only when it is not already the brief.
  const original = brief && description && description !== brief && description !== parsed.body ? description : null;
  const kv = (rows: ParsedBrief['details']): FactRow[] => rows.map((r) => ({ label: r.label, value: r.value }));
  return {
    text,
    idLabel: state.idLabel,
    key: state.key,
    title: state.title ?? '',
    provider: state.provider,
    ticketUrl: state.ticketUrl,
    sourceLabel: briefSourceLabel(state.briefSource),
    tabs: tabsOf(Boolean(brief), original !== null, hasMain),
    main,
    original,
    planning: parsed.planning || null,
    comments: parsed.comments,
    attachments: parsed.attachments,
    groups: [
      ...group('Karst', karstRows(state)),
      ...group('Details', kv(parsed.details)),
      ...group('People', kv(parsed.people)),
      ...group('Relations', kv(parsed.relations)),
      ...group('Dates', kv(parsed.dates)),
      ...group('Links', parsed.links.map((l) => ({ label: '', value: l }))),
    ],
    tags: parsed.tags,
    empty: !hasMain,
  };
}
