import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { withFileLockSync } from '../utils/file-lock.js';
import type { FleetState } from './fleet-supervisor-policy.js';

type SupervisorIdentity = Pick<FleetState, 'supervisorPid' | 'supervisorStartedAt'>;

/** Windows has no catchable SIGTERM/SIGHUP. The existing local fleet lock
 * serializes callers; bind each stop request to one supervisor generation. */
export function requestWindowsFleetStop(path: string, identity: SupervisorIdentity): void {
  if (!Number.isSafeInteger(identity.supervisorPid) || identity.supervisorPid <= 1
    || !identity.supervisorStartedAt) throw new Error('Missing supervisor identity');
  withFileLockSync(path, () => {
    atomicWriteFileSync(path, JSON.stringify({
      supervisorPid: identity.supervisorPid,
      supervisorStartedAt: identity.supervisorStartedAt,
    }), { mode: 0o600 });
  });
}

export function consumeWindowsFleetStop(path: string, identity: SupervisorIdentity): boolean {
  if (!existsSync(path)) return false;
  return withFileLockSync(path, () => {
    if (!existsSync(path)) return false;
    let request: Partial<SupervisorIdentity> | null = null;
    try { request = JSON.parse(readFileSync(path, 'utf8')); } catch { /* discard invalid/stale request */ }
    unlinkSync(path);
    return request?.supervisorPid === identity.supervisorPid
      && request?.supervisorStartedAt === identity.supervisorStartedAt;
  });
}
