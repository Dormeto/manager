// Official AWS Architecture Icons (service icons, 64 px set) for the backends of a workload.
import aurora from './assets/aws/aurora.svg';
import ec2 from './assets/aws/ec2.svg';
import ec2AutoScaling from './assets/aws/ec2-auto-scaling.svg';
import ecs from './assets/aws/ecs.svg';
import rds from './assets/aws/rds.svg';

const ICONS: Record<string, string> = { instance: ec2, asg: ec2AutoScaling, ecs, 'rds-instance': rds, 'rds-cluster': aurora };

export const backendIcon = (kind: string): string | null => ICONS[kind] ?? null;
