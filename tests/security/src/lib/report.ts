import type { CheckResult, RunMeta, Status } from './results';

const ORDER: Status[] = ['fail', 'unverified', 'blocked', 'not_applicable', 'pass'];
const LABEL: Record<Status, string> = { pass: 'pass', fail: 'FAIL', unverified: 'unverified', blocked: 'blocked', not_applicable: 'n/a' };
const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, '<br>');

export function renderReport(meta: RunMeta, results: CheckResult[], blocking: CheckResult[]): string {
  const suites = [...new Set(results.map((r) => r.suite))];
  const count = (rs: CheckResult[], s: Status) => rs.filter((r) => r.status === s).length;
  const lines: string[] = [];
  lines.push('# Security harness run');
  lines.push('');
  lines.push(`- Commit: \`${meta.gitCommit.slice(0, 12)}\`${meta.gitDirty ? ' (working tree had uncommitted changes)' : ''}`);
  lines.push(`- Platform: ${meta.platform}, Node ${meta.node}`);
  lines.push(`- Target: ${meta.target.apiUrl ?? 'none'}${meta.target.disposable ? ' (disposable stack, deleted after the run)' : ''}`);
  lines.push(`- Started ${meta.startedAt}, finished ${meta.finishedAt}`);
  lines.push(`- Result: **${blocking.length ? `${blocking.length} blocking failure(s)` : 'no blocking failures'}**`);
  lines.push('');
  lines.push('A check passes only when its assertion ran and held. `unverified` = could not run here (platform/tool); `blocked` = deliberately not run; neither counts as passing.');
  lines.push('');
  lines.push('| Suite | pass | FAIL | unverified | blocked | n/a |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const s of suites) {
    const rs = results.filter((r) => r.suite === s);
    lines.push(`| security/${s} | ${count(rs, 'pass')} | ${count(rs, 'fail')} | ${count(rs, 'unverified')} | ${count(rs, 'blocked')} | ${count(rs, 'not_applicable')} |`);
  }
  lines.push(`| **total** | ${count(results, 'pass')} | ${count(results, 'fail')} | ${count(results, 'unverified')} | ${count(results, 'blocked')} | ${count(results, 'not_applicable')} |`);
  lines.push('');
  const failing = results.filter((r) => r.status === 'fail');
  if (failing.length) {
    lines.push('## Failures');
    lines.push('');
    for (const r of failing) {
      lines.push(`### ${r.id} (${r.severity})${r.finding ? ` — ${r.finding}` : ''}`);
      lines.push('');
      lines.push(r.title);
      lines.push('');
      if (r.acceptedRisk) lines.push(`Accepted risk **${r.acceptedRisk.id}** (owner ${r.acceptedRisk.owner}, expires ${r.acceptedRisk.expires}): ${r.acceptedRisk.rationale}`, '');
      lines.push('```');
      lines.push(r.evidence);
      lines.push('```');
      lines.push('');
    }
  }
  for (const s of suites) {
    lines.push(`## security/${s}`);
    lines.push('');
    lines.push('| Status | Check | Evidence |');
    lines.push('|---|---|---|');
    const rs = results.filter((r) => r.suite === s).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
    for (const r of rs) {
      const ev = r.evidence.length > 300 ? `${r.evidence.slice(0, 300)}…` : r.evidence;
      lines.push(`| ${LABEL[r.status]} | \`${r.id}\` ${esc(r.title)}${r.finding ? ` (${r.finding})` : ''} | ${esc(ev)} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}
