import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const BASE_BRANCH = 'codex/windows';
export const SYNC_BRANCH = 'codex/sync-upstream';
const UPSTREAM = 'deepcoldy/botmux';

/** Fetch and fast-forward only. Tests use real disposable Git repositories. */
export function syncBranches({ cwd = process.cwd(), upstreamUrl, dryRun = false }) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const ancestor = (older, newer) => {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd, encoding: 'utf8' });
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(result.stderr || 'Git ancestry check failed');
  };
  git('fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*');
  git('fetch', '--no-tags', upstreamUrl, '+refs/heads/master:refs/remotes/upstream/master');
  const upstream = git('rev-parse', 'refs/remotes/upstream/master');
  const base = git('rev-parse', `refs/remotes/origin/${BASE_BRANCH}`);
  const mirror = git('rev-parse', 'refs/remotes/origin/master');
  if (!ancestor(mirror, upstream)) {
    throw new Error('master has diverged from upstream; refusing to overwrite commits. Resolve it manually.');
  }
  const needsPr = !ancestor(upstream, base);
  const refs = [];
  if (mirror !== upstream) refs.push(`${upstream}:refs/heads/master`);
  if (needsPr) {
    const existing = spawnSync('git', ['rev-parse', '--verify', `refs/remotes/origin/${SYNC_BRANCH}`], { cwd, encoding: 'utf8' });
    if (existing.status === 0 && !ancestor(existing.stdout.trim(), upstream)) {
      throw new Error('The managed sync branch has diverged; refusing a force push.');
    }
    if (existing.status !== 0 || existing.stdout.trim() !== upstream) refs.push(`${upstream}:refs/heads/${SYNC_BRANCH}`);
  }
  // A rejected ref prevents ALL remote updates; never rewrite the Windows branch.
  if (!dryRun && refs.length) git('push', '--atomic', 'origin', ...refs);
  return { upstream, base, needsPr, refs, dryRun };
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (repo !== 'wangzexi0302/botmux-windows') throw new Error('This workflow is configured only for wangzexi0302/botmux-windows.');
  const api = (endpoint, body) => JSON.parse(execFileSync('gh', [
    'api', endpoint, ...(body ? ['--method', 'POST', '--input', '-'] : []),
  ], { encoding: 'utf8', input: body ? JSON.stringify(body) : undefined }));
  const upstreamRepo = api(`repos/${UPSTREAM}`);
  if (upstreamRepo.default_branch !== 'master') throw new Error('Upstream default branch changed; update the sync configuration.');
  const target = api(`repos/${repo}`);
  if (!target.fork || target.parent?.full_name !== UPSTREAM) throw new Error('Target is not the expected fork.');
  const result = syncBranches({ upstreamUrl: `https://github.com/${UPSTREAM}.git`, dryRun: process.argv.includes('--dry-run') });
  const output = (name, value) => {
    console.log(`${name}=${value}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  };
  const summary = text => {
    console.log(text);
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  };
  output('validate', 'false');
  if (result.dryRun || !result.needsPr) {
    summary(result.dryRun ? `Dry run: ${JSON.stringify(result)}` : 'Windows 分支已包含当前上游提交，无需同步 PR。');
    return;
  }
  const owner = repo.split('/')[0];
  const pulls = api(`repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${SYNC_BRANCH}`)}&base=${encodeURIComponent(BASE_BRANCH)}&sort=updated&direction=desc&per_page=100`);
  const current = pulls.find(pr => pr.state === 'open');
  const marker = `<!-- botmux-upstream-sync base:${result.base} head:${result.upstream} -->`;
  if (current?.body?.includes(marker)) {
    summary(`同步 PR 未变化：[查看 PR](${current.html_url})。`);
    return;
  }
  if (current && !current.body?.includes('<!-- botmux-upstream-sync ')) throw new Error('Existing PR is not managed by this workflow; refusing to overwrite its description.');
  if (!current && pulls.some(pr => !pr.merged_at && pr.state === 'closed' && pr.head.sha === result.upstream)) {
    summary('此上游版本的同步 PR 已被关闭；保留人工决定，等待上游新提交。');
    return;
  }
  const runUrl = `https://github.com/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const body = `${marker}\n\n同步 [上游 master](https://github.com/${UPSTREAM}/commits/master) 到 Windows 维护分支。\n\n- 上游提交：\`${result.upstream}\`\n- Windows 基线：\`${result.base}\`\n- [Windows / Linux 合并结果验证](${runUrl})\n\n保留 Windows 适配，使用 merge commit 合并。发生冲突或测试失败时先修复；此工作流不会自动合并或发布。`;
  let pr;
  if (current) {
    // PATCH uses an explicit method; keeping api() POST-only for create avoids
    // implicit method selection based on the presence of CLI fields.
    pr = JSON.parse(execFileSync('gh', ['api', `repos/${repo}/pulls/${current.number}`, '--method', 'PATCH', '--input', '-'], {
      encoding: 'utf8', input: JSON.stringify({ body }),
    }));
  } else {
    pr = api(`repos/${repo}/pulls`, { base: BASE_BRANCH, head: SYNC_BRANCH, title: 'chore(sync): 同步上游 master 更新', body });
  }
  output('validate', 'true');
  output('ref', `refs/pull/${pr.number}/merge`);
  output('head_sha', result.upstream);
  summary(`已准备[同步 PR #${pr.number}](${pr.html_url})。随后验证合并结果；冲突会导致检出合并引用失败，需要人工解决。`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
