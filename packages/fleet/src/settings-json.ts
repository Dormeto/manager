// The organization's settings.json in the manager's lists bucket (written by the API), as the fleet function reads it to push
// it to the Google Cloud routers (Google Cloud manager design §5.5; router push design §6.2, §6.3): its ETag as S3 gives it
// (quotes included), and its text; none while it doesn't exist.
import { GetObjectCommand, HeadObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { withoutIdleSignals } from './idle-signals.js';

// The S3 client's bounds: 3 s to connect, then 10 s of silence (socketTimeout; past a requestTimeout the HTTP handler only
// logs, unless told to throw).
export const S3_OPTIONS = { maxAttempts: 2, requestHandler: { connectionTimeout: 3_000, socketTimeout: 10_000 } };
export const SETTINGS_KEY = 'settings.json';

// HeadObject says NotFound, GetObject NoSuchKey (with s3:ListBucket on the bucket; without it, S3 answers 403).
const absent = (err: unknown) => ['NotFound', 'NoSuchKey'].includes((err as Error).name);

export function createSettingsJson({ s3, bucket }: { s3: Pick<S3Client, 'send'>; bucket: string | undefined }) {
  return {
    async etag(): Promise<string | null> {
      if (!bucket) return null;
      try {
        return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: SETTINGS_KEY }))).ETag ?? null;
      } catch (err) {
        if (absent(err)) return null;
        throw err;
      }
    },
    async read(): Promise<{ etag: string; text: string } | null> {
      if (!bucket) return null;
      try {
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: SETTINGS_KEY }));
        return { etag: out.ETag ?? '', text: await out.Body!.transformToString() };
      } catch (err) {
        if (absent(err)) return null;
        throw err;
      }
    },
  };
}

export type SettingsJson = Pick<ReturnType<typeof createSettingsJson>, 'etag' | 'read'>;

// settings.json as `manager-settings` pushes it, with its ETag; pushed as it is when it is not JSON: the router reads it as
// unset and says it is unreadable, as an AWS router does. Null while it doesn't exist. Without the idle signals: a Google
// Cloud router has none yet (standalone workloads).
export async function settingsDocument(settings: Pick<SettingsJson, 'read'>): Promise<{ etag: string; settings: unknown } | null> {
  const read = await settings.read();
  if (!read) return null;
  try {
    return { etag: read.etag, settings: withoutIdleSignals(JSON.parse(read.text) as unknown) };
  } catch {
    return { etag: read.etag, settings: read.text };
  }
}
