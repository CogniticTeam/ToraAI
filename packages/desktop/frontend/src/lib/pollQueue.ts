import { getEmail, getUsername } from '@/utils/authStore';
import { cloudFetch } from '@/utils/modelSync';

export type PendingVote = {
  pollId: string; title: string; submissionId: string; account: string;
  items: { optionId: string; score?: number }[]; deviceId: string;
  createdAt: string; failedReason?: string;
};

const QUEUE_KEY = 'cocode_poll_queue_v1';
const DEVICE_KEY = 'cocode_poll_device_v1';
export const QUEUE_EVENT = 'cocode-polls-queue-changed';
export const currentAccount = () => getEmail() || getUsername() || '';

export function readQueue(): PendingVote[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    return Array.isArray(value) ? value as PendingVote[] : [];
  } catch { return []; }
}

export function saveQueue(queue: PendingVote[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  window.dispatchEvent(new Event(QUEUE_EVENT));
}

export function deviceId(): string {
  let value = localStorage.getItem(DEVICE_KEY);
  if (!value) { value = crypto.randomUUID(); localStorage.setItem(DEVICE_KEY, value); }
  return value;
}

let pendingSync: Promise<void> | null = null;
export function syncPendingVotes(): Promise<void> {
  if (pendingSync) return pendingSync;
  if (!navigator.onLine) return Promise.resolve();
  pendingSync = (async () => {
    const account = currentAccount();
    const queue = readQueue();
    for (const pending of [...queue]) {
      if (pending.account !== account || pending.failedReason) continue;
      try {
        const response = await cloudFetch(`/polls/${pending.pollId}/votes`, {
          method: 'POST', body: JSON.stringify({ submissionId: pending.submissionId, items: pending.items, deviceId: pending.deviceId }),
        });
        if (response.ok) {
          const index = queue.findIndex(item => item.submissionId === pending.submissionId);
          if (index >= 0) queue.splice(index, 1);
        } else if (response.status < 500 && response.status !== 401) {
          const body = await response.json().catch(() => ({}));
          const target = queue.find(item => item.submissionId === pending.submissionId);
          if (target) target.failedReason = body.detail || `HTTP ${response.status}`;
        } else break;
        saveQueue(queue);
      } catch { break; }
    }
  })().finally(() => { pendingSync = null; });
  return pendingSync;
}

export function installPollQueueSync(): () => void {
  const sync = () => { void syncPendingVotes(); };
  window.addEventListener('online', sync);
  window.addEventListener('cocode-auth-changed', sync);
  const timer = window.setInterval(sync, 30_000);
  sync();
  return () => {
    window.removeEventListener('online', sync);
    window.removeEventListener('cocode-auth-changed', sync);
    window.clearInterval(timer);
  };
}
