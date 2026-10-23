// A JSON object of the manager's lists bucket (R6b), or null while it does not exist.
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await out.Body!.transformToString()) as T;
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return null;
    throw err;
  }
}

// Rewrites a JSON object whole (the last write wins).
export async function writeJson(s3: S3Client, bucket: string, key: string, doc: unknown): Promise<void> {
  await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: JSON.stringify(doc), ContentType: 'application/json' }));
}
