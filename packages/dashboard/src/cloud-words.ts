// The words the dashboard says differently on AWS and on Google Cloud: one table per cloud, read wherever a view or a helper
// used to switch on the cloud inline (cloud duplication design §5). Both tables have every key of CloudWords: one missing, or
// one CloudWords lacks, fails the typecheck. The four tables by kind or setting (backendLabels, backendHelp, backendServices,
// settings) are not alike: each cloud names only its own kinds and settings, keyed by the known ones (a misspelt key fails the
// typecheck), and their readers fall back to AWS's kind (format.ts) or to the shared description (settings.ts); nothing checks
// that a kind one cloud names is named by the other. A word both clouds share stays where it is said. A switch on the cloud that
// chooses what to do (which call, card, field or icon element) is not a word: test/CloudWords.test.ts lists those, and fails on a
// new inline word switch.
import { mdiAws, mdiGoogleCloud } from '@mdi/js';
import type { Cloud } from '@dormeto/fleet/clouds';
import type { IdleSettings, Settings } from './types';

// A standalone workload's words (plan 5): who wakes it besides a schedule or a person, where its signals are read and how late,
// the custom metric's source, what marks its resource and what a missing one means, the settings' helps and built-ins, a nap and
// a wake of each of its resource kinds, the onboarding's first step, and discovery's idle share.
export interface StandaloneWords {
  startOutside: string;
  signals: string;
  signalsLate: string;
  metric: string;
  database: string;
  databases: string;
  marker: string;
  missing: string;
  missingFix: string;
  onboards: string;
  idleSource: string;
  help: Readonly<{ idleMinutes: string; idleCpuPercent: string; idleNetworkBytes: string; idleMetric: string; wakeTimeoutSeconds: string }>;
  ranges: Readonly<{ wakeTimeoutSeconds: string }>;
  builtIn: Readonly<Record<keyof IdleSettings, string>>;
  inherit: string;
  naps: ByKind;
}

// The kinds of backends the routers report, on either cloud.
export type RouterBackendKind = 'instance' | 'asg' | 'ecs' | 'k8s' | 'rds-instance' | 'rds-cluster' | 'cloudsql-instance';
type ByKind = Readonly<Partial<Record<RouterBackendKind, string>>>;

export interface CloudWords {
  // The cloud's name, and its mark: Material Design Icons' AWS or Google Cloud mark.
  name: string;
  icon: string;
  // What a row's `account` is.
  owner: string;
  // What a region's location is called, in its tooltip.
  location: string;
  // The region Discovery's filter suggests within an account or a project.
  regionHint: string;
  // What a candidate's requests go to, which discovery reads, onboarding names a workload after and an exclusion targets; what
  // routes to it, its load balancer or URL map, with what excluding that one covers.
  target: string;
  loadBalancer: string;
  loadBalancerScope: string;
  // The kinds of backends: their names, what Dormeto does with them, their services. Google Cloud's name only its own kinds:
  // the others are AWS's (format.ts).
  backendLabels: ByKind;
  backendHelp: ByKind;
  backendServices: ByKind;
  // The settings explained in the cloud's own words, the others as the settings say them (settings.ts).
  settings: Readonly<Partial<Record<keyof Settings, { help: string; range: string }>>>;
  // A wake that failed with nothing healthy behind the load balancer.
  unhealthy: string;
  // What an instance's or a VM's types are, which fallbacks replace.
  types: string;
  // Before an idle share, and in its cell: Google Cloud's is an estimate (Google samples its metrics). Then where it is read.
  idleAbout: string;
  idleMark: string;
  idleSource: string;
  // Prices: of Spot capacity, what the estimate leaves out, and the managed Kubernetes whose control plane keeps running.
  spot: string;
  priceNotes: string;
  kubernetes: string;
  // Hibernation, which Google Cloud's VMs do as a suspension: the setting's name, the noun, the state's word, what a workload
  // module sets, and what the setting does.
  hibernate: string;
  hibernation: string;
  hibernated: string;
  moduleSetting: string;
  hibernateHelp: string;
  hibernateHint: string;
  // The cloud's own tags, which Dormeto's are not: all of them, one, and the copy of a candidate's.
  tags: string;
  tag: string;
  copyTags: string;
  // Onboarding's fields of companion databases and fallback types.
  databasesLabel: string;
  databasesHint: string;
  fallbacksHint: string;
  fallbacksRule: string;
  // What offboarding a workload and waking it do.
  offboarding: string;
  waking: string;
  // Organization access: why onboarding is refused, what the manager holds there (a row's chip, with or without access, and
  // the counts' "without the … role"), the procedure and its link's text.
  noCommand: string;
  accessHolder: string;
  accessOk: string;
  accessMissing: string;
  procedureUrl: string;
  procedureText: string;
  standalone: StandaloneWords;
}

const AWS: CloudWords = {
  name: 'AWS',
  icon: mdiAws,
  owner: 'Account',
  location: 'AWS location',
  regionHint: 'eu-west-1',
  target: 'target group',
  loadBalancer: 'load balancer',
  loadBalancerScope: 'every rule on it',
  backendLabels: { instance: 'EC2 instance', asg: 'Auto Scaling group', ecs: 'ECS service', k8s: 'Kubernetes workload', 'rds-instance': 'RDS instance', 'rds-cluster': 'Aurora cluster' },
  backendHelp: {
    instance: 'started and stopped by Dormeto',
    asg: 'its instances are started and stopped through the group',
    ecs: 'scaled to zero tasks when it naps, and back when it wakes',
    k8s: 'a Deployment or StatefulSet on Amazon EKS, scaled to zero replicas when it naps, back to its replicas when it wakes',
    'rds-instance': 'a companion database, stopped after the application and started before it',
    'rds-cluster': 'a companion database, stopped after the application and started before it',
  },
  backendServices: { instance: 'Amazon EC2', asg: 'Amazon EC2 Auto Scaling', ecs: 'Amazon ECS', k8s: 'Amazon EKS', 'rds-instance': 'Amazon RDS', 'rds-cluster': 'Amazon Aurora' },
  settings: {},
  unhealthy: 'no healthy target',
  types: 'instance types',
  idleAbout: '',
  idleMark: '',
  idleSource: 'From the load balancer\'s CloudWatch metric RequestCount for this target group, hour by hour, read by discovery: no onboarding needed. Every request counts, bots and scanners '
    + 'included: an estimate of how long it could sleep.',
  spot: 'Spot at Spot prices',
  priceNotes: '',
  kubernetes: 'EKS',
  hibernate: 'Hibernate',
  hibernation: 'Hibernation',
  hibernated: 'hibernated',
  moduleSetting: 'hibernate',
  hibernateHelp: 'Decides whether the EC2 instances outside an Auto Scaling group (not ECS) that were launched with hibernation are hibernated instead of stopped when the '
    + 'workload naps. Dormeto does not enable hibernation on an instance: it is chosen when the instance is launched. A workload with fallback instance types does not hibernate '
    + 'unless it is set to On on the workload itself.',
  hibernateHint: 'EC2 instances outside an Auto Scaling group (not ECS) launched with hibernation are hibernated instead of stopped at a nap; with fallback instance types, only if On',
  tags: 'AWS tags',
  tag: 'AWS tag',
  copyTags: 'Copy the target group\'s AWS tags',
  databasesLabel: 'Companion databases (optional)',
  databasesHint: 'RDS instance identifiers, or cluster:<identifier>, comma separated: stopped after the application, started before it',
  fallbacksHint: 'EC2 instances only, comma separated, in order: tried when AWS has no capacity for their own type at a wake; their own type comes back at the next nap',
  fallbacksRule: 'At most 5 EC2 instance types, for example t3a.medium, m6i.large',
  offboarding: 'The workload is woken, then Dormeto removes what onboarding added: the waker from its rules, the waker target group, the tags. A workload written in Terraform is '
    + 'offboarded by removing its workload module.',
  waking: 'The backends start now; the route switches back to the application once a target is healthy.',
  noCommand: 'Its account has no command role',
  accessHolder: 'role',
  accessOk: 'assumed',
  accessMissing: 'missing',
  // The website's page, with the roles' Terraform modules and AWS CLI commands.
  procedureUrl: 'https://dormeto.com/organization-access.html',
  procedureText: 'How to set up the roles',
  standalone: {
    startOutside: 'a start made in AWS',
    signals: 'CloudWatch',
    signalsLate: 'CloudWatch publishes the signals minutes late: an idle nap comes up to 15 minutes after the idle window.',
    metric: 'A CloudWatch metric',
    database: 'a database',
    databases: 'its databases',
    marker: 'its dormeto:workload tag',
    missing: 'It was deleted, or lost its dormeto:workload tag: nothing of it is stopped or started.',
    missingFix: 'Offboard the workload, or tag the resource again (its value is the workload\'s id): the router finds it at its next check.',
    onboards: 'The router of its account and region tags it and its databases, installing itself first if needed.',
    idleSource: 'From CloudWatch\'s metrics of the resource',
    help: {
      idleMinutes: 'Time with every idle signal under its threshold before the workload naps; the check reads them every 5 minutes, and an idle nap comes up to 15 minutes after the window, as CloudWatch publishes the signals late. Nothing wakes it on demand: a schedule, a person or a start made in AWS does.',
      wakeTimeoutSeconds: 'Longest a wake may take before the workload is marked FAILED; the check retries it until it succeeds or a person naps it.',
      idleCpuPercent: 'Idle while the CPU\'s maximum stays under this percentage (CloudWatch\'s CPUUtilization of the instance, group, service or database).',
      idleNetworkBytes: 'Idle while the bytes in and out, a minute, stay under this number (EC2\'s NetworkIn and NetworkOut, RDS\'s throughput); an ECS service has none without Container Insights.',
      idleMetric: 'Idle while one CloudWatch metric stays under its threshold; ${resource} in a dimension is the resource\'s own id. A database\'s built-in: its connections under 1.',
    },
    ranges: { wakeTimeoutSeconds: '60 to 3,600 s; built-in 10 min, 30 min for a database.' },
    builtIn: { idleCpuPercent: 'under 5 %, off for a database', idleNetworkBytes: 'off', idleMetric: 'off; a database\'s connections under 1' },
    inherit: 'a 120-minute idle window, CPU under 5 % (off for a database), network off, no custom metric (a database\'s connections under 1)',
    naps: {
      instance: 'A nap stops the instance (or hibernates it), then its databases; a wake starts them in reverse.',
      asg: 'A nap sets the group\'s capacity to 0, then stops its databases; a wake reverses both.',
      ecs: 'A nap sets the service\'s desired count to 0, then stops its databases; a wake reverses both.',
      'rds-instance': 'A nap stops the database and a wake starts it; AWS starts it again after 7 days.',
      'rds-cluster': 'A nap stops the Aurora cluster and a wake starts it; AWS starts it again after 7 days.',
    },
  },
};

// What Google fixes at 0 (G5's levels), said so.
const FIXED = 'Fixed at 0 on Google Cloud.';

const GOOGLE_CLOUD: CloudWords = {
  name: 'Google Cloud',
  icon: mdiGoogleCloud,
  owner: 'Project',
  location: 'Google Cloud location',
  regionHint: 'europe-west2 or global',
  target: 'backend service',
  loadBalancer: 'URL map',
  loadBalancerScope: 'every backend service it names',
  backendLabels: { instance: 'Compute Engine VM', asg: 'Managed instance group', k8s: 'Kubernetes workload', 'cloudsql-instance': 'Cloud SQL instance' },
  backendHelp: {
    k8s: 'a Deployment or StatefulSet on Google Kubernetes Engine, scaled to zero replicas when it naps, back to its replicas when it wakes',
    'cloudsql-instance': 'a companion database, stopped after the application and started before it',
  },
  backendServices: { instance: 'Compute Engine', asg: 'Compute Engine managed instance group', k8s: 'Google Kubernetes Engine', 'cloudsql-instance': 'Cloud SQL' },
  // No request held, no drain of its own; its waker is a Cloud Run service whose wakes go on across Cloud Tasks.
  settings: {
    waitSeconds: { help: 'The waker holds no request on Google Cloud: it answers the waiting page at once, and the page waits for the wake.', range: FIXED },
    drainSeconds: { help: 'A nap\'s switch on Google Cloud is a URL map change, and the backend service\'s own connection draining applies.', range: FIXED },
    maxHolders: { help: 'No request is held on Google Cloud: visitors get the waiting page at once.', range: FIXED },
    wakeTimeoutSeconds: {
      help: 'Longest a wake may take before the workload is marked FAILED; the next request then retries the wake. Wakes continue across the router\'s Cloud Tasks, so long starts such as Cloud SQL databases are supported.',
      range: 'Longer than the slowest start of the backends (VMs, managed instance groups, a Cloud SQL database), at most 1,700 s.',
    },
  },
  // Its backends pass a backend service's health check: it has no targets.
  unhealthy: 'no healthy backend',
  types: 'machine types',
  idleAbout: 'about ',
  idleMark: '~',
  idleSource: 'From Cloud Monitoring\'s request count of the load balancer for this backend service, hour by hour, read by discovery: no onboarding needed. Google samples these '
    + 'metrics, and every request counts, bots and scanners included: an estimate of how long it could sleep.',
  spot: 'Spot VMs at Spot prices',
  // What its prices leave out or estimate (the Google Cloud manager design's §9.2).
  priceNotes: 'Windows licenses are not counted; a suspended VM\'s memory, which Google still bills, is subtracted; Cloud SQL (MySQL and PostgreSQL) is priced for custom, '
    + 'shared-core and Enterprise Plus N tiers (others not priced).',
  kubernetes: 'GKE',
  hibernate: 'Suspend instead of stop',
  hibernation: 'Suspension',
  hibernated: 'suspended',
  moduleSetting: 'it',
  hibernateHelp: 'Decides whether the VMs of the workload are suspended instead of stopped when it naps: a suspended VM keeps its memory and resumes faster. A VM that cannot be '
    + 'suspended (with a GPU or a TPU, confidential, or with more than 208 GB of memory) is stopped. After 60 days Compute Engine stops a suspended VM itself. A workload with '
    + 'fallback machine types is not suspended unless it is set to On on the workload itself.',
  hibernateHint: 'The VMs are suspended instead of stopped at a nap, and resume faster; one that cannot be suspended is stopped; with fallback machine types, only if On',
  tags: 'Google Cloud labels',
  tag: 'label',
  copyTags: 'Copy the VMs\' labels',
  databasesLabel: 'Companion Cloud SQL instances (optional)',
  databasesHint: 'Cloud SQL instance names, comma separated: stopped after the application, started before it',
  fallbacksHint: 'VMs only, comma separated, in order: tried when Compute Engine has no capacity for their own type at a wake; their own type comes back at the next nap',
  fallbacksRule: 'At most 5 Compute Engine machine types, each once, for example e2-medium, n2-standard-4',
  offboarding: 'The workload is woken, then Dormeto removes what onboarding added: its waker backend service, its routing in the URL map, the tags.',
  waking: 'The backends start now; the route switches back to the application once its backend service\'s health check passes.',
  noCommand: 'Its project cannot be acted in',
  accessHolder: 'account',
  accessOk: 'has access',
  accessMissing: 'missing access',
  // The Google Cloud connection on the website: the two service accounts, their scopes and grants, dormeto gcp connect.
  procedureUrl: 'https://dormeto.com/configuration.html#connection',
  procedureText: 'How to connect Google Cloud',
  standalone: {
    startOutside: 'a start made in Google Cloud',
    signals: 'Cloud Monitoring',
    signalsLate: 'Cloud Monitoring publishes the signals minutes late: an idle nap comes up to 15 minutes after the idle window.',
    metric: 'A Cloud Monitoring metric',
    database: 'a Cloud SQL instance',
    databases: 'its Cloud SQL instances',
    marker: 'the tag dormeto=managed',
    // The router cannot read the tag: a resource is missing when Google says it is deleted (router docs/scenarios/standalone.md).
    missing: 'It was deleted: nothing of it is stopped or started.',
    missingFix: 'Offboard the workload.',
    onboards: 'The manager binds the tag dormeto=managed to it and its Cloud SQL instances, and the project\'s router records the workload.',
    idleSource: 'From Cloud Monitoring\'s metrics of the resource',
    help: {
      idleMinutes: 'Time with every idle signal under its threshold before the workload naps; the check reads them every 5 minutes, and an idle nap comes up to 15 minutes after the window, as Cloud Monitoring publishes the signals late. Nothing wakes it on demand: a schedule, a person or a start made in Google Cloud does.',
      wakeTimeoutSeconds: 'Longest a wake may take before the workload is marked FAILED; the check retries it until it succeeds or a person naps it.',
      idleCpuPercent: 'Idle while the CPU\'s maximum stays under this percentage (Cloud Monitoring\'s CPU utilization of the VM, the group\'s VMs or the Cloud SQL instance).',
      idleNetworkBytes: 'Idle while the bytes in and out, a minute, stay under this number (Cloud Monitoring\'s received and sent bytes of the VM or the group\'s VMs); a Cloud SQL instance\'s network is not read.',
      idleMetric: 'Idle while one Cloud Monitoring metric stays under its threshold, aligned each minute; ${resource} in its filter is the resource\'s name. A Cloud SQL instance\'s built-in: its connections under 1.',
    },
    ranges: { wakeTimeoutSeconds: '60 to 1,700 s; built-in 10 min, 28 min 20 s for a Cloud SQL instance.' },
    builtIn: { idleCpuPercent: 'under 5 %, off for a Cloud SQL instance', idleNetworkBytes: 'off', idleMetric: 'off; a Cloud SQL instance\'s connections under 1' },
    inherit: 'a 120-minute idle window, CPU under 5 % (off for a Cloud SQL instance), network off, no custom metric (a Cloud SQL instance\'s connections under 1)',
    naps: {
      instance: 'A nap stops the VM (or suspends it), then its Cloud SQL instances; a wake starts them in reverse. A Spot VM Google preempts is read as a stop made outside Dormeto.',
      asg: 'A nap resizes the managed instance group to 0, its autoscaler off, then stops its Cloud SQL instances; a wake reverses both.',
      'cloudsql-instance': 'A nap stops the Cloud SQL instance and a wake starts it.',
    },
  },
};

const WORDS: Record<Cloud, CloudWords> = { aws: AWS, gcp: GOOGLE_CLOUD };
// A row that names no cloud (an older API's), or one this dashboard does not know: AWS's, as the switches said.
export const cloudWords = (cloud: Cloud | null | undefined): CloudWords => (cloud && Object.hasOwn(WORDS, cloud) ? WORDS[cloud] : AWS);
