#!/usr/bin/env node
// A release of the manager (vision docs/specs/2026-10-06-packaging-design.md, section 4): the manager module with its
// built artifacts, the access and organization modules, the AWS CLI procedure, the Kubernetes rights of the routers'
// group in an EKS cluster (the router's kubernetes/dormeto-router.yaml), checksums and the changelog section, published
// once per version under releases.dormeto.com/manager/<version>/.
// Usage: node scripts/release/release.mjs [--no-build] [--router <router checkout at the pinned version>]
//          [--version <version>] [--out <directory>] [--publish --bucket <bucket>] (AWS_PROFILE: the release account)
//        node scripts/release/release.mjs --versions --bucket <bucket> [--region <region>]
//          writes only manager/versions.json for package.json's version, already published (finishes a stopped publication)
// --version and --out build a release locally, before it is published (dormeto install --release <out>/<version>): the
// files are named with that version, the release lands in <out>/<version>/ (dist/release by default), and the changelog's
// Unreleased section stands for a version without its own. --publish only publishes package.json's version.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

export function changelogSection(changelog, version, { allowUnreleased = false } = {}) {
  const lines = changelog.split('\n');
  let start = lines.findIndex((l) => l === `## ${version}` || l.startsWith(`## ${version} `));
  // A build of unreleased work: its section is the Unreleased one, headed with the version.
  const unreleased = start < 0 && allowUnreleased;
  if (unreleased) start = lines.findIndex((l) => l === '## Unreleased');
  if (start < 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
  const section = lines.slice(start, end < 0 ? undefined : end);
  if (unreleased) section[0] = `## ${version}`;
  return `${section.join('\n').trim()}\n`;
}

// The command line's version and output directory; a published version is a released one, the package's.
export function releaseOptions(args, pkg, manager) {
  const option = (name) => {
    const at = args.indexOf(`--${name}`);
    if (at < 0) return undefined;
    if (!args[at + 1] || args[at + 1].startsWith('--')) throw new Error(`--${name} needs a value`);
    return args[at + 1];
  };
  const version = option('version') ?? pkg.version;
  const publish = args.includes('--publish');
  if (publish && version !== pkg.version) throw new Error(`--publish is refused with --version ${version}: a published version is the package's (${pkg.version})`);
  return { version, out: option('out') ?? join(manager, 'dist/release'), publish };
}

function assertNoAccountValues(dir, paths = files(dir)) {
  for (const file of paths) {
    const text = readFileSync(join(dir, file), 'latin1');
    const found = FORBIDDEN.find((value) => text.includes(value));
    if (found) throw new Error(`account-specific value ${found} in ${file}`);
  }
}

export function buildRelease({ manager, router, modules, out, version, allowUnreleased = false }) {
  const changelog = changelogSection(readFileSync(join(manager, 'CHANGELOG.md'), 'utf8'), version, { allowUnreleased });
  const kubernetes = join(router, 'kubernetes/dormeto-router.yaml');
  if (!existsSync(kubernetes)) throw new Error(`missing build output: ${kubernetes} (the router checkout at the pinned version)`);
  const stage = mkdtempSync(join(tmpdir(), 'dmt-release-stage-'));
  // The manager archive: modules/manager with its artifacts beside, and the access module it uses (../access).
  assembleArtifacts({ manager, router, version, out: join(stage, 'manager/modules/manager/artifacts') });
  // The functions' bundles are zipped in the release: checked from the builds.
  assertNoAccountValues(manager, ['api', 'discovery', 'operations', 'fleet'].flatMap((p) => files(join(manager, 'packages', p, 'dist')).map((f) => join('packages', p, 'dist', f))));
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
  cpSync(kubernetes, join(dir, `dormeto-kubernetes-${version}.yaml`));
  writeFileSync(join(dir, 'dormeto-organization-policy.json'), organizationPolicy(readFileSync(join(stage, 'organization/organization-policy.json'), 'utf8')));
  writeFileSync(join(dir, 'CHANGELOG.md'), changelog);
  assertNoAccountValues(dir);
  const sums = readdirSync(dir).sort().map((f) => `${createHash('sha256').update(readFileSync(join(dir, f))).digest('hex')}  ${f}`);
  writeFileSync(join(dir, 'SHA256SUMS'), `${sums.join('\n')}\n`);
  rmSync(stage, { recursive: true, force: true });
  return { dir, files: readdirSync(dir).sort() };
}

const TYPES = { '.zip': 'application/zip', '.sh': 'text/x-shellscript; charset=utf-8', '.json': 'application/json', '.md': 'text/markdown; charset=utf-8', '.yaml': 'application/yaml; charset=utf-8' };
const newer = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('-')[0].split('.').map(Number));
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

// Versions here are x.y.z: newest first, by the numbers.
const byNewest = (a, b) => (newer(a.version, b.version) ? -1 : newer(b.version, a.version) ? 1 : 0);

// manager/versions.json: the published versions, newest first, with their router, the oldest CLI whose install they can
// update (minCli) and their date. Missing or malformed, it is rebuilt from the versions in the bucket (their router and
// minCli unknown); this version's entry is then written in full.
export async function publishVersions({ s3, bucket, version, router, minCli, now = () => new Date().toISOString() }) {
  const { ListObjectsV2Command, GetObjectCommand, PutObjectCommand } = await import('@aws-sdk/client-s3');
  let versions = null;
  try {
    const existing = JSON.parse(await (await s3.send(new GetObjectCommand({ Bucket: bucket, Key: 'manager/versions.json' }))).Body.transformToString());
    if (Array.isArray(existing?.versions)) versions = existing.versions;
  } catch (err) {
    if (err.name !== 'NoSuchKey' && !(err instanceof SyntaxError)) throw err;
  }
  if (!versions) {
    versions = [];
    let token;
    do {
      const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'manager/', ContinuationToken: token }));
      for (const { Key, LastModified } of page.Contents ?? []) {
        const found = /^manager\/(\d+\.\d+\.\d+)\/SHA256SUMS$/.exec(Key);
        if (found) versions.push({ version: found[1], router: null, minCli: null, published: new Date(LastModified).toISOString() });
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }
  versions = [...versions.filter((v) => v.version !== version), { version, router, minCli: minCli ?? null, published: now() }].sort(byNewest);
  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: 'manager/versions.json', Body: JSON.stringify({ versions }), ContentType: 'application/json', CacheControl: 'no-cache',
  }));
}

// --versions: only versions.json, for a version whose SHA256SUMS (put last) is in the bucket; nothing is written otherwise.
export async function resumeVersions({ s3, bucket, version, ...rest }) {
  const { ListObjectsV2Command } = await import('@aws-sdk/client-s3');
  const listed = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `manager/${version}/SHA256SUMS`, MaxKeys: 1 }));
  if (!listed.KeyCount) throw new Error(`${version} is not published (no s3://${bucket}/manager/${version}/SHA256SUMS)`);
  await publishVersions({ s3, bucket, version, ...rest });
}

export async function publishRelease({ s3, bucket, version, router, minCli, dir, now = () => new Date().toISOString() }) {
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
  await publishVersions({ s3, bucket, version, router, minCli, now });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name) => { const at = args.indexOf(`--${name}`); return at < 0 ? undefined : args[at + 1]; };
  const manager = fileURLToPath(new URL('../..', import.meta.url));
  const pkg = JSON.parse(readFileSync(join(manager, 'package.json'), 'utf8'));
  if (args.includes('--versions')) {
    const bucket = option('bucket');
    if (!bucket) throw new Error('--versions needs --bucket');
    const { S3Client } = await import('@aws-sdk/client-s3');
    await resumeVersions({ s3: new S3Client({ region: option('region') ?? 'eu-west-1' }), bucket, version: pkg.version, router: pkg.dormeto.router, minCli: pkg.dormeto.minCli });
    console.log(`wrote s3://${bucket}/manager/versions.json for ${pkg.version}`);
    process.exit(0);
  }
  const git = (...a) => execFileSync('git', a, { cwd: manager, encoding: 'utf8' }).trim();
  if (git('status', '--porcelain')) throw new Error('the working tree has changes: a release is built from a commit');
  const { version, out, publish } = releaseOptions(args, pkg, manager);
  if (version === pkg.version && git('tag', '--list', `v${pkg.version}`)) throw new Error(`tag v${pkg.version} exists: bump the version`);
  if (!args.includes('--no-build')) execFileSync('npm', ['run', 'build'], { cwd: manager, stdio: 'inherit' });
  const release = buildRelease({ manager, router: option('router') ?? join(manager, '../router'), modules: join(manager, 'infra/terraform/modules'), out, version, allowUnreleased: version !== pkg.version });
  for (const file of release.files) console.log(`${String(statSync(join(release.dir, file)).size).padStart(10)}  ${file}`);
  if (publish) {
    const bucket = option('bucket');
    if (!bucket) throw new Error('--publish needs --bucket');
    const { S3Client } = await import('@aws-sdk/client-s3');
    await publishRelease({ s3: new S3Client({ region: option('region') ?? 'eu-west-1' }), bucket, version: pkg.version, router: pkg.dormeto.router, minCli: pkg.dormeto.minCli, dir: release.dir });
    git('tag', '-a', `v${pkg.version}`, '-m', `Dormeto manager ${pkg.version}`);
    console.log(`published ${pkg.version} to s3://${bucket}/manager/${pkg.version}/, tagged v${pkg.version}`);
  }
  console.log(basename(release.dir));
}
