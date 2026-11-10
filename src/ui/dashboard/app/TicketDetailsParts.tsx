/**
 * The parts of the ticket details drawer's body: the facts sidebar (Karst group from DashboardState, then the groups
 * parsed from the brief), the comments and the attachments. Every string here is provider or user data and renders as
 * text; the only links are http(s) URLs that passed `safeUrl`.
 */
import { safeUrl } from '../../../integrations/attachmentMarkdown.js';
import { TicketRefChip } from '../../shared/TicketRefChip.js';
import { ticketRefView } from '../../shared/ticketRefView.js';
import { Icon } from './Icon.js';
import type { FactGroup, FactRow, TicketDetailsView } from './ticketDetails.js';

function FactValue({ group, row }: { readonly group: string; readonly row: FactRow }) {
  if (row.ref) return <TicketRefChip refView={ticketRefView({ ref: row.ref })} link={false} />;
  const href = group === 'Links' ? safeUrl(row.value) : undefined;
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {row.value}
    </a>
  ) : (
    <>{row.value}</>
  );
}

function FactList({ groups, tags }: { readonly groups: readonly FactGroup[]; readonly tags: readonly string[] }) {
  return (
    <>
      {groups.map((g) => (
        <section key={g.title} className="tdFactGroup" aria-label={g.title}>
          <h4 className="tdFactTitle">{g.title}</h4>
          <dl className="tdFactRows">
            {g.rows.map((row, i) => (
              <div key={`r${i}`} className="tdFactRow">
                {row.label ? <dt>{row.label}</dt> : null}
                <dd>
                  <FactValue group={g.title} row={row} />
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      {tags.length ? (
        <section className="tdFactGroup" aria-label="Tags">
          <h4 className="tdFactTitle">Tags</h4>
          <ul className="tdTags">
            {tags.map((t, i) => (
              <li key={`r${i}`} className="k-chip">
                {t}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

/**
 * Wide container: a sticky sidebar. Narrow container: the same facts in a `<details>` above the body. Both are in the
 * DOM and the container query shows one (`TicketDataDrawer.css`).
 */
export function Facts({ view }: { readonly view: TicketDetailsView }) {
  if (!view.groups.length && !view.tags.length) return null;
  return (
    <>
      <aside className="tdFacts" aria-label="Ticket facts">
        <FactList groups={view.groups} tags={view.tags} />
      </aside>
      <details className="tdFactsFold">
        <summary>Details · status, people, relations, dates</summary>
        <FactList groups={view.groups} tags={view.tags} />
      </details>
    </>
  );
}

export function Comments({ comments }: { readonly comments: TicketDetailsView['comments'] }) {
  if (!comments.length) return null;
  return (
    <section className="tdSection" aria-label="Comments">
      <h4 className="tdSectionTitle">Comments · {comments.length}</h4>
      <ul className="tdComments">
        {comments.map((c, i) => (
          <li key={`r${i}`}>
            <strong>{c.author}</strong>
            <span className="tdCommentText">{c.text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function Attachments({ attachments }: { readonly attachments: TicketDetailsView['attachments'] }) {
  if (!attachments.length) return null;
  return (
    <section className="tdSection" aria-label="Attachments">
      <h4 className="tdSectionTitle">Attachments · {attachments.length}</h4>
      <ul className="tdAttachments">
        {attachments.map((a, i) => {
          const href = a.url ? safeUrl(a.url) : undefined;
          return (
            <li key={`r${i}`}>
              <Icon name="paperclip" />
              {href ? (
                <a href={href} target="_blank" rel="noreferrer noopener">
                  {a.name}
                </a>
              ) : (
                <span>{a.name}</span>
              )}
              {a.size ? <span className="tdDim">{a.size}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
