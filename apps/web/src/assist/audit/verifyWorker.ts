/** Offline JSONL verifier worker (contracts section 12 /app/audit): runs the shared verifier off the UI thread. */
import { verifyAuditJsonl } from '@indiansassist/shared';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<string>) => void) | null;
  postMessage: (m: unknown) => void;
};

scope.onmessage = (e: MessageEvent<string>) => {
  try {
    scope.postMessage({ ok: true, result: verifyAuditJsonl(e.data) });
  } catch (err) {
    scope.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
