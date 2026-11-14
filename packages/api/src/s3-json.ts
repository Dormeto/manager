// A JSON object of the manager's lists bucket (R6b), or null while it does not exist.
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await out.Body!.transformToString()) as T;
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return null;
    throw err;
  }
}

// Rewrites a JSON object whole (the last write wins), and answers its ETag as S3 gives it (quotes included).
export async function writeJson(s3: S3Client, bucket: string, key: string, doc: unknown): Promise<string | undefined> {
  return (await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(doc), ContentType: 'application/json' }))).ETag;
}

// A JSON object and its ETag as S3 gives it (quotes included), read at once; null while it does not exist. Not JSON: its text.
export async function readJsonWithEtag(s3: S3Client, bucket: string, key: string): Promise<{ doc: unknown; etag: string } | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = await out.Body!.transformToString();
    try {
      return { doc: JSON.parse(text) as unknown, etag: out.ETag ?? '' };
    } catch {
      return { doc: text, etag: out.ETag ?? '' };
    }
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return null;
    throw err;
  }
}

// An object's ETag as S3 gives it (quotes included), null while it does not exist (HeadObject says NotFound).
export async function etagOf(s3: S3Client, bucket: string, key: string): Promise<string | null> {
  try {
    return (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))).ETag ?? null;
  } catch (err) {
    if (['NotFound', 'NoSuchKey'].includes((err as Error).name)) return null;
    throw err;
  }
}
