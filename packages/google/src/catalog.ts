// The Cloud Billing Catalog (services.skus.list) as the manager's discovery account reads it: a service's SKUs in USD, a
// page at a time (5000 a page), for the savings job's price book (the API never reads it: a request would wait for 45 MB).
// A page is bounded to 60 s, the whole page and not only its silence.
import type { GoogleConnection } from './google.js';
import { GoogleError } from './errors.js';
import { connectCommand } from './router.js';
import type { createGoogleSource } from './source.js';

const PAGE_MS = 60_000;

type Source = Pick<ReturnType<typeof createGoogleSource>, 'current'>;

// A page of a service's SKUs, as Google's JSON gives it (the shape of the fleet's CatalogSku: this package doesn't import it).
export interface CatalogSku {
  description?: string;
  category?: { resourceFamily?: string; resourceGroup?: string; usageType?: string };
  serviceRegions?: string[];
  pricingInfo?: { pricingExpression?: { usageUnit?: string; tieredRates?: { startUsageAmount?: number; unitPrice?: { currencyCode?: string; units?: string; nanos?: number } }[] } }[];
}
export interface CatalogPage { skus?: CatalogSku[]; nextPageToken?: string }

const envOf = (connection: GoogleConnection) => connection.pool.replace(/^dmt-/, '');

export function catalogPort(source: Source) {
  return {
    async skus(service: string, pageToken?: string) {
      const current = await source.current();
      if (!current) throw new Error('no Google Cloud connection');
      const url = `https://cloudbilling.googleapis.com/v1/services/${service}/skus?currencyCode=USD&pageSize=5000${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
      try {
        return await current.google.call<CatalogPage>('discovery', 'GET', url, undefined, { silenceMs: PAGE_MS, signal: AbortSignal.timeout(PAGE_MS) });
      } catch (error) {
        if (error instanceof GoogleError && (error.status === 403 || error.status === 404)) {
          throw new Error(`The Cloud Billing API refused the discovery account (${error.message}): ${connectCommand(current.connection.project, envOf(current.connection))} gives it the access`);
        }
        throw error;
      }
    },
  };
}
