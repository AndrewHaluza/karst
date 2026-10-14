// Host-side verifier model: the host binds identity by PATH (one file per ticket worktree),
// then accepts only lines whose ticket+stage match what the host expects. Line content is untrusted.
import fs from 'node:fs';
const [file, ticket, stage] = process.argv.slice(2);
const out = { accepted: [], rejected: [] };
for (const l of fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  let e; try { e = JSON.parse(l); } catch { out.rejected.push({ line: l, why: 'malformed' }); continue; }
  if (e.event !== 'impl-complete') continue;
  if (e.ticket !== ticket) out.rejected.push({ line: l, why: `ticket ${e.ticket} != ${ticket}` });
  else if (e.stage !== stage) out.rejected.push({ line: l, why: `stage ${e.stage} != ${stage}` });
  else out.accepted.push(l);
}
console.log(JSON.stringify(out, null, 1));
process.exit(out.rejected.length > 0 && out.accepted.length === 1 ? 0 : 1);
