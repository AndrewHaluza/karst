import type { AgentAdapter } from '../../agent/adapter.js';
import type { ApproachDef } from '../../manifest/types.js';
import {
  DEFAULT_TICKET_TYPE,
  isTicketType,
  TICKET_TYPES,
  type TicketType,
} from '../../store/ticketTypes.js';

/**
 * The coupled ticket analyzer (§ ticket form). ONE bounded agent call turns a
 * fetched brief (or a manual prompt) into three tightly-coupled decisions at
 * once: the synthesized implementation prompt, the best-fit development
 * approach, and the affected services. They are decided together because the
 * approach depends on the scope of work and the scope depends on which services
 * the ticket touches — splitting them across separate calls loses that coupling.
 *
 * The decisions are coupled but their DELIVERY is not: the prompt is stored on
 * the ticket, while the approach's method and the services are re-read from the
 * ticket's state at launch (§ context loader / session seed). The user may
 * re-pick either afterwards WITHOUT the prompt being regenerated, so the prompt
 * must carry only WHAT/WHY — an approach's method leaking into it silently
 * overrides whichever approach is finally selected.
 *
 * karst recommends; the user decides. The ticket-form UI applies the result but
 * every field stays editable. Parsing is defensive (the model may wrap the
 * object in prose, and the prompt field itself may carry braces/newlines), and
 * every field degrades to a safe fallback rather than failing the flow. Only an
 * adapter rejection propagates, so the caller can degrade to no analysis.
 */

/** One service offered to the analyzer, with its deterministic keyword score. */
export interface AnalyzeServiceInput {
  name: string;
  description?: string;
  signals: string[];
  /** Deterministic `scoreRepos` hit count — a hint, and the repo fallback. */
  score: number;
}

export interface AnalyzeInput {
  /** Fetched context brief (may be empty for a manual ticket). */
  brief: string;
  /** The user's authored prompt (manual ticket / prior edits), if any. */
  prompt?: string;
  services: AnalyzeServiceInput[];
  /** Enabled + available approaches to choose from. */
  approaches: ApproachDef[];
  /**
   * Ticket this analysis is for, when it already exists. The ticket form runs the
   * analyzer on a DRAFT, so it is usually absent — the call is still recorded,
   * unattributed, because it is real spend (§ token consumption stats).
   */
  ticketId?: number | null;
  /**
   * The inside process run this call belongs to — the scope stage's prefill
   * process. Threaded into `tracking.processRunId` so the spend is attributed
   * to the run the inside view renders (§ token consumption stats).
   */
  processRunId?: number | null;
  /**
   * The resolved launch model id for this analysis (the ticket-analysis
   * process assignment). Absent → the agent CLI's own default, like every
   * other headless call that declares none.
   */
  model?: string;
}

export interface TicketAnalysis {
  prompt: string;
  approachId: string;
  repos: string[];
  reason: string;
  /** Conventional-commit type for `{type}`; always one of `TICKET_TYPES`. */
  type: TicketType;
}

function buildPrompt(input: AnalyzeInput): string {
  const approachList = input.approaches
    .map((a) => `- ${a.id}: ${a.description ?? a.label}`)
    .join('\n');
  const serviceList = input.services
    .map((s) => {
      const desc = s.description ? ` — ${s.description}` : '';
      const sig = s.signals.length ? ` [signals: ${s.signals.join(', ')}]` : '';
      const hint = s.score > 0 ? ` (keyword score: ${s.score})` : '';
      return `- ${s.name}${desc}${sig}${hint}`;
    })
    .join('\n');
  const prompt = input.prompt?.trim();
  const brief = input.brief.trim();
  return [
    `You analyze a software ticket and produce THREE coupled decisions at once:`,
    `(1) a clear, implementation-ready prompt for the coding agent — synthesize`,
    `it from the ticket; do NOT merely copy the brief;`,
    `(2) the best-fit development approach for the scope of work;`,
    `(3) the services (repos) the work will touch.`,
    ``,
    `The three are decided together, but they are DELIVERED to the coding agent`,
    `separately: the approach's own method and the selected services are already`,
    `given to it from the ticket's stored state. The prompt outlives this`,
    `analysis — the user may pick a different approach or different services`,
    `afterwards, and the prompt is NOT regenerated. So the prompt must be`,
    `approach-agnostic and service-agnostic: state WHAT to achieve and WHY`,
    `(the problem, the goal, the constraints, the acceptance criteria).`,
    `It must not prescribe HOW to work — no workflow, methodology, phases,`,
    `stages, step ordering, research/plan/approve gates, or "do not implement`,
    `until X" instructions; those come from the approach, whichever one is`,
    `finally selected. It must not name repos, services, or paths; those come`,
    `from the selected services. Put the approach rationale in "reason", never`,
    `in "prompt".`,
    ``,
    `Available approaches:`,
    approachList,
    ``,
    `Available services (keyword score = how strongly the ticket text matched`,
    `each service's signal words; a hint, not a rule):`,
    serviceList,
    ``,
    ...(prompt ? [`Author's prompt / intent:`, prompt, ``] : []),
    ...(brief ? [`Fetched ticket brief:`, brief, ``] : []),
    `Also classify the work as ONE conventional-commit type, from exactly this`,
    `list: ${TICKET_TYPES.join(', ')}. It becomes the branch prefix and the commit`,
    `/ PR subject type, so pick what the change IS, not how it is developed.`,
    ``,
    `Respond with ONLY a single JSON object of the form:`,
    `{"prompt": "<the synthesized agent prompt>", "approach": "<one approach id`,
    `from the list>", "repos": ["<service names from the list that are in`,
    `scope>"], "reason": "<one short sentence on the approach choice>",`,
    `"type": "<one conventional-commit type from the list>"}`,
  ].join('\n');
}

/**
 * Extract the first balanced-brace JSON object from arbitrary text, honoring
 * string literals (so braces/quotes inside the `prompt` value don't confuse the
 * scan). Returns the raw slice, or null when no balanced object is found.
 */
function extractFirstJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

interface RawAnalysis {
  prompt?: unknown;
  approach?: unknown;
  repos?: unknown;
  reason?: unknown;
  type?: unknown;
}

function parse(raw: string): RawAnalysis | null {
  const slice = extractFirstJsonObject(raw);
  if (!slice) return null;
  try {
    const parsed = JSON.parse(slice);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as RawAnalysis;
  } catch {
    return null;
  }
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Analyze a ticket into a coupled {prompt, approach, repos, reason}. Runs one
 * headless agent call and folds the result over safe fallbacks:
 * - prompt → the model's synthesized prompt, else the author's prompt, else the
 *   brief text (never blank when either input has content);
 * - approach → validated against `approaches`, else `approaches[0]` (or '' when
 *   none are configured — defensive; callers should pass a non-empty list);
 * - repos → the model's picks filtered to known service names, else the
 *   keyword-scored services (score > 0) — the offline fallback;
 * - reason → the model's sentence, else '';
 * - type → the model's pick when it is in `TICKET_TYPES`, else `feat`.
 */
export async function analyzeTicket(
  adapter: AgentAdapter,
  input: AnalyzeInput,
): Promise<TicketAnalysis> {
  const result = await adapter.runHeadless({
    prompt: buildPrompt(input),
    cwd: '.',
    model: input.model,
    tracking: {
      callSite: 'ticket-analysis',
      ticketId: input.ticketId ?? null,
      processRunId: input.processRunId ?? null,
    },
  });
  const parsed = parse(result.raw);

  const knownServices = new Set(input.services.map((s) => s.name));
  const scoredRepos = input.services.filter((s) => s.score > 0).map((s) => s.name);
  const fallbackPrompt = input.prompt?.trim() || input.brief.trim();
  const fallbackApproach = input.approaches[0]?.id ?? '';

  const modelPrompt = str(parsed?.prompt).trim();
  const modelApproach = str(parsed?.approach);
  const modelRepos = Array.isArray(parsed?.repos)
    ? parsed!.repos.filter((r): r is string => typeof r === 'string' && knownServices.has(r))
    : [];

  const approachId = input.approaches.some((a) => a.id === modelApproach)
    ? modelApproach
    : fallbackApproach;

  return {
    prompt: modelPrompt || fallbackPrompt,
    approachId,
    repos: modelRepos.length ? modelRepos : scoredRepos,
    reason: str(parsed?.reason),
    type: isTicketType(parsed?.type) ? parsed.type : DEFAULT_TICKET_TYPE,
  };
}
