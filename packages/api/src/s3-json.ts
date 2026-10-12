// A JSON object of the manager's lists bucket (R6b), or null while it does not exist.
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

export async function readJson<T>(s3: S3Client, bucket: string, key: string): Promise<T | null> {
  try {
    const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return JSON.parse(await out.Body!.transformToString()) as T;
  } catch (err) {
    if ((err as Error).name === 'NoSuchKey') return null;
    throw err;
  }
}
