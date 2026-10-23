/**
 * Recording upload (contracts sections 6.10 and 9). <= 100 MiB: one multipart POST (`meta` field first,
 * then `file`). Larger (<= 2 GiB): `uploads` init, 16 MiB parts in order, `complete`. XMLHttpRequest is
 * used because fetch has no upload progress events.
 */
import {
  LIMITS,
  recordingSchema,
  recordingUploadInitResponseSchema,
  type Recording,
  type RecordingUploadInitResponse,
} from '@indiansassist/shared';
import { ApiRequestError, buildUrl, csrfHeaders, request } from './api';

export type UploadProgress = (sentBytes: number, totalBytes: number) => void;

function xhrSend(
  method: string,
  url: string,
  body: XMLHttpRequestBodyInit,
  onProgress?: (loaded: number) => void,
  contentType?: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(csrfHeaders(method))) xhr.setRequestHeader(k, v);
    if (contentType) xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (ev) => onProgress?.(ev.loaded);
    xhr.onerror = () => reject(new ApiRequestError(0, 'network_error', 'Could not reach the server.'));
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        /* non-JSON body */
      }
      if (xhr.status >= 200 && xhr.status < 300) return resolve(json);
      const err = (json as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)
        ?.error;
      reject(
        new ApiRequestError(
          xhr.status,
          (err?.code ?? 'internal') as ApiRequestError['code'],
          err?.message ?? `HTTP ${xhr.status}`,
          err?.details,
        ),
      );
    };
    xhr.send(body);
  });
}

function asRecording(json: unknown): Recording {
  const p = recordingSchema.safeParse(json);
  return (p.success ? p.data : json) as Recording;
}

export async function uploadRecording(
  sessionId: string,
  blob: Blob,
  meta: { mime: string; durationMs?: number },
  onProgress?: UploadProgress,
): Promise<Recording> {
  const total = blob.size;
  if (total <= LIMITS.recordingSingleMaxBytes) {
    const form = new FormData();
    form.append('meta', JSON.stringify(meta));
    form.append('file', blob, 'recording.webm');
    const json = await xhrSend('POST', buildUrl(`/sessions/${sessionId}/recordings`), form, (n) =>
      onProgress?.(n, total),
    );
    onProgress?.(total, total);
    return asRecording(json);
  }
  if (total > LIMITS.recordingMaxBytes) throw new ApiRequestError(413, 'payload_too_large', 'Recording exceeds 2 GiB');
  const init = await request<RecordingUploadInitResponse>('POST', `/sessions/${sessionId}/recordings/uploads`, {
    body: { ...meta, bytes: total },
    schema: recordingUploadInitResponseSchema,
  });
  let sent = 0;
  for (let n = 1; n <= init.parts; n++) {
    const part = blob.slice((n - 1) * init.partSize, Math.min(total, n * init.partSize));
    await xhrSend(
      'PUT',
      buildUrl(`/recordings/uploads/${init.uploadId}/parts/${n}`),
      part,
      (loaded) => onProgress?.(sent + loaded, total),
      'application/octet-stream',
    );
    sent += part.size;
    onProgress?.(sent, total);
  }
  return request<Recording>('POST', `/recordings/uploads/${init.uploadId}/complete`, {
    body: { parts: init.parts },
    schema: recordingSchema,
  });
}
