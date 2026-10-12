// The Spot price history the price book reads (R9.5b): DescribeSpotPriceHistory from the manager's account, an EC2 client
// per region.
import { describe, expect, it } from 'vitest';
import { createSpotPort } from '../src/spot.js';

describe('Spot port', () => {
  it('asks each region with its own client, the input as given', async () => {
    const sent: { region: string; input: unknown }[] = [];
    const port = createSpotPort((region) => ({ send: async (command: { input: unknown }) => { sent.push({ region, input: command.input }); return { SpotPriceHistory: [{ AvailabilityZone: `${region}a`, SpotPrice: '0.019' }] }; } }));
    const input = { InstanceTypes: ['t3.medium'], ProductDescriptions: ['Linux/UNIX'], StartTime: new Date('2026-10-09T12:00:00.000Z') };
    expect((await port.history('eu-west-1', input)).SpotPriceHistory).toEqual([{ AvailabilityZone: 'eu-west-1a', SpotPrice: '0.019' }]);
    await port.history('eu-west-3', input);
    expect(sent).toEqual([{ region: 'eu-west-1', input }, { region: 'eu-west-3', input }]);
  });
});
