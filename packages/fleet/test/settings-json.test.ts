// The organization's settings.json as the fleet function reads it (Google Cloud manager design §5.5; router push design
// §6.2, §6.3): its ETag as S3 gives it and its text, none while it doesn't exist; each call bounded, 3 s to connect and 10 s
// of silence.
import { S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createSettingsJson, S3_OPTIONS } from '../src/settings-json.js';

const BUCKET = 'dmt-dev-manager-ip-lists-121014831971';
type Command = { constructor: { name: string }; input: unknown };
const failure = (name: string) => Object.assign(new Error(name), { name });

// S3 answering each command as `answer` says.
function fakeS3(answer: (command: string) => unknown) {
  const sent: { command: string; input: unknown }[] = [];
  return {
    sent,
    s3: {
      send: async (command: Command) => {
        sent.push({ command: command.constructor.name, input: command.input });
        const out = answer(command.constructor.name);
        if (out instanceof Error) throw out;
        return out;
      },
    },
  };
}

describe('settings.json for the pushes to Google Cloud routers', () => {
  it('reads its ETag and its text as S3 gives them, from the lists bucket', async () => {
    const { s3, sent } = fakeS3((command) => (command === 'HeadObjectCommand' ? { ETag: '"abc"' } : { ETag: '"abc"', Body: { transformToString: async () => '{"workloads":{}}' } }));
    const settings = createSettingsJson({ s3: s3 as never, bucket: BUCKET });
    expect(await settings.etag()).toBe('"abc"');
    expect(await settings.read()).toEqual({ etag: '"abc"', text: '{"workloads":{}}' });
    expect(sent).toEqual([
      { command: 'HeadObjectCommand', input: { Bucket: BUCKET, Key: 'settings.json' } }, { command: 'GetObjectCommand', input: { Bucket: BUCKET, Key: 'settings.json' } },
    ]);
  });

  it('answers none while it doesn\'t exist (HeadObject\'s NotFound, GetObject\'s NoSuchKey) or without a bucket, and throws any other failure', async () => {
    const { s3 } = fakeS3((command) => failure(command === 'HeadObjectCommand' ? 'NotFound' : 'NoSuchKey'));
    const settings = createSettingsJson({ s3: s3 as never, bucket: BUCKET });
    expect([await settings.etag(), await settings.read()]).toEqual([null, null]);
    const none = fakeS3(() => ({}));
    expect([await createSettingsJson({ s3: none.s3 as never, bucket: undefined }).etag(), none.sent]).toEqual([null, []]);
    const denied = fakeS3(() => failure('AccessDenied'));
    await expect(createSettingsJson({ s3: denied.s3 as never, bucket: BUCKET }).etag()).rejects.toThrow('AccessDenied');
  });

  it('bounds each call: 3 s to connect, then 10 s of silence (socketTimeout: past a requestTimeout the HTTP handler only logs)', async () => {
    const client = new S3Client({ region: 'eu-west-1', ...S3_OPTIONS });
    // The options the client's HTTP handler resolved.
    const config = await (client.config.requestHandler as unknown as { configProvider: Promise<Record<string, unknown>> }).configProvider;
    expect([config.connectionTimeout, config.socketTimeout]).toEqual([3_000, 10_000]);
  });
});
