#!/usr/bin/env node
// A release of the manager (vision docs/specs/2026-10-06-packaging-design.md, section 4): the manager module with its
// built artifacts, the access and organization modules, the AWS CLI procedure, checksums and the changelog section,
// published once per version under releases.dormeto.com/manager/<version>/.
// Usage: node scripts/release/release.mjs [--no-build] [--publish --bucket <bucket>] (AWS_PROFILE: the release account)
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assembleArtifacts } from './artifacts.mjs';
import { accessScript, organizationPolicy } from './access-script.mjs';

// Values of our own accounts and organization: never in a release (a release holds no account-specific value).
const FORBIDDEN = ['121014831971', '038606077307', '809706483662', 'o-vvk0115ixn', 'kloudy'];
// What the repository's modules hold beside the module itself.
const LOCAL = /(^|\/)(tests|\.terraform|\.build|artifacts)(\/|$)|\.terraform\.lock\.hcl$|\.tfstate/;

const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)).map((f) => join(e.name, f)) : [e.name]));
const copyModule = (from, to) => cpSync(from, to, { recursive: true, filter: (path) => !LOCAL.test(relative(from, path)) });
const zip = (dir, archive) => execFileSync('zip', ['-X', '-r', '-q', archive, '.'], { cwd: dir });

export function changelogSection(changelog, version) {
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  return `${lines.slice(start, end < 0 ? undefined : end).join('\n').trim()}\n`;
}

function assertNoAccountValues(dir) {
  for (const file of files(dir)) {
    const text = readFileSync(join(dir, file), 'latin1');
    const found = FORBIDDEN.find((value) => text.includes(value));
    if (found) throw new Error(`account-specific value ${found} in ${file}`);
  }
}

export function buildRelease({ manager, router, modules, out, version }) {
  const changelog = changelogSection(readFileSync(join(manager, 'CHANGELOG.md'), 'utf8'), version);
  const stage = mkdtempSync(join(tmpdir(), 'dmt-release-stage-'));
  // The manager archive: modules/manager with its artifacts beside, and the access module it uses (../access).
  assembleArtifacts({ manager, router, out: join(stage, 'manager/modules/manager/artifacts') });
  copyModule(join(modules, 'manager'), join(stage, 'manager/modules/manager'));
  for (const target of ['manager/modules/access', 'access']) {
    copyModule(join(modules, 'access'), join(stage, target));
    cpSync(join(stage, 'manager/modules/manager/artifacts/router/router-boundary.json'), join(stage, target, 'router-boundary.json'));
  }
  copyModule(join(modules, 'organization'), join(stage, 'organization'));
  assertNoAccountValues(stage);

  const dir = join(out, version);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  zip(join(stage, 'manager'), join(dir, `terraform-aws-dormeto-${version}.zip`));
  zip(join(stage, 'access'), join(dir, `dormeto-access-${version}.zip`));
  zip(join(stage, 'organization'), join(dir, `dormeto-organization-${version}.zip`));
  const access = join(stage, 'access');
  writeFileSync(join(dir, `dormeto-access-commands-${version}.sh`), accessScript({
    version,
    discoveryPolicy: readFileSync(join(access, 'discovery-policy.json'), 'utf8'),
    commandPolicy: readFileSync(join(access, 'command-role/command-policy.json'), 'utf8'),
    boundary: readFileSync(join(access, 'router-boundary.json'), 'utf8'),
  }), { mode: 0o755 });
  writeFileSync(join(dir, 'dormeto-organization-policy.json'), organizationPolicy(readFileSync(join(stage, 'organization/organization-policy.json'), 'utf8')));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  assertNoAccountValues(dir);
  const sums = readdirSync(dir).sort().map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  rmSync(stage, { recursive: true, force: true });
  return { dir, files: readdirSync(dir).sort() };
}

const TYPES = { '.zip': 'application/zip', '.sh': 'text/x-shellscript; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8' };
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

export async function publishRelease({ s3, bucket, version, router, dir, now = () => new Date().toISOString() }) {
  const { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  const prefix = `manager/${version}/`;
  // A published version is never overwritten: refused before anything is written, and each put is conditional.
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 1 }));
  if (listed.KeyCount) throw new Error(`${version} is already published (s3://${bucket}/${prefix})`);
  // The checksums last: a version with its SHA256SUMS is complete.
  for (const file of [...readdirSync(dir).filter((f) => f !== 'SHA256SUMS').sort(), 'SHA256SUMS']) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: `${prefix}${file}`, Body: readFileSync(join(dir, file)), IfNoneMatch: '*',
      ContentType: TYPES[extname(file)] ?? 'text/plain; charset=utf-8', CacheControl: 'public, max-age=31536000, immutable',
    }));
  }
  let latest = null;
  try {
    latest = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'manager/latest.json' }))).Body.transformToString());
  } catch (err) {
    if (err.name !== 'NoSuchKey') throw err;
  }
  if (!latest || newer(version, latest.version)) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket, Key: 'manager/latest.json', Body: JSON.stringify({ version, router, published: now() }), ContentType: 'application/json', CacheControl: 'no-cache',
    }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  const manager = fileURLToPath(new URL('../..', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(manager, 'package.json'), 'utf8'));
  const git = (...a) => execFileSync('git', a, { cwd: manager, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('the working tree has changes: a release is built from a commit');
  if (git('tag', '--list', `v${pkg.version}`)) throw new Error(`tag v${pkg.version} exists: bump the version`);
  if (!args.includes('--no-build')) execFileSync('npm', ['run', 'build'], { cwd: manager, stdio: 'inherit' });
  const release = buildRelease({ manager, router: join(manager, '../router'), modules: join(manager, 'infra/terraform/modules'), out: join(manager, 'dist/release'), version: pkg.version });
  for (const file of release.files) console.log(`${String(statSync(join(release.dir, file)).size).padStart(10)}  ${file}`);
  if (args.includes('--publish')) {
    const bucket = option('bucket');
    if (!bucket) throw new Error('--publish needs --bucket');
    const { S3Client } = await import('@aws-sdk/client-s3');
    await publishRelease({ s3: new S3Client({ region: option('region') ?? 'eu-west-1' }), bucket, version: pkg.version, router: pkg.dormeto.router, dir: release.dir });
    git('tag', '-a', `v${pkg.version}`, '-m', `Dormeto manager ${pkg.version}`);
    console.log(`published ${pkg.version} to s3://${bucket}/manager/${pkg.version}/, tagged v${pkg.version}`);
  }
  console.log(basename(release.dir));
}
