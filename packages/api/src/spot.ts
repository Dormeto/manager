// The Spot price history the price book reads (docs/specs/2026-10-09-sharper-savings-design.md, R9.5b):
// DescribeSpotPriceHistory from the manager's account, an EC2 client per region (AWS SDK v3 of the nodejs24.x runtime).
import { DescribeSpotPriceHistoryCommand, EC2Client, type DescribeSpotPriceHistoryCommandInput } from '@aws-sdk/client-ec2';
import type { SpotPort } from '@dormeto/fleet';

type Sender = { send(command: DescribeSpotPriceHistoryCommand): Promise<Awaited<ReturnType<SpotPort['history']>>> };

export function createSpotPort(clientOf: (region: string) => Sender = (region) => new EC2Client({ region })): SpotPort {
  const clients = new Map<string, Sender>();
  return {
    history(region, input) {
      let client = clients.get(region);
      if (!client) clients.set(region, (client = clientOf(region)));
      // The SDK types instance types as its own list: a type it does not know yet is still asked.
      return client.send(new DescribeSpotPriceHistoryCommand(input as DescribeSpotPriceHistoryCommandInput));
    },
  };
}
