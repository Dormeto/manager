// AWS regions with their location (as the AWS console names it) and country, Google Cloud regions with theirs (as Google's
// locations name it: https://cloud.google.com/compute/docs/regions-zones), and the country's flag (flag-icons, MIT; only
// these flags are bundled).
import { isRegion, type Cloud } from '@dormeto/fleet/clouds';
import { cloudWords } from './cloud-words';
import flagAe from 'flag-icons/flags/4x3/ae.svg';
import flagAu from 'flag-icons/flags/4x3/au.svg';
import flagBe from 'flag-icons/flags/4x3/be.svg';
import flagBh from 'flag-icons/flags/4x3/bh.svg';
import flagBr from 'flag-icons/flags/4x3/br.svg';
import flagCa from 'flag-icons/flags/4x3/ca.svg';
import flagCh from 'flag-icons/flags/4x3/ch.svg';
import flagCl from 'flag-icons/flags/4x3/cl.svg';
import flagCn from 'flag-icons/flags/4x3/cn.svg';
import flagDe from 'flag-icons/flags/4x3/de.svg';
import flagEs from 'flag-icons/flags/4x3/es.svg';
import flagFi from 'flag-icons/flags/4x3/fi.svg';
import flagFr from 'flag-icons/flags/4x3/fr.svg';
import flagGb from 'flag-icons/flags/4x3/gb.svg';
import flagHk from 'flag-icons/flags/4x3/hk.svg';
import flagId from 'flag-icons/flags/4x3/id.svg';
import flagIe from 'flag-icons/flags/4x3/ie.svg';
import flagIl from 'flag-icons/flags/4x3/il.svg';
import flagIn from 'flag-icons/flags/4x3/in.svg';
import flagIt from 'flag-icons/flags/4x3/it.svg';
import flagJp from 'flag-icons/flags/4x3/jp.svg';
import flagKr from 'flag-icons/flags/4x3/kr.svg';
import flagMx from 'flag-icons/flags/4x3/mx.svg';
import flagMy from 'flag-icons/flags/4x3/my.svg';
import flagNl from 'flag-icons/flags/4x3/nl.svg';
import flagNz from 'flag-icons/flags/4x3/nz.svg';
import flagPl from 'flag-icons/flags/4x3/pl.svg';
import flagQa from 'flag-icons/flags/4x3/qa.svg';
import flagSa from 'flag-icons/flags/4x3/sa.svg';
import flagSe from 'flag-icons/flags/4x3/se.svg';
import flagSg from 'flag-icons/flags/4x3/sg.svg';
import flagTh from 'flag-icons/flags/4x3/th.svg';
import flagTw from 'flag-icons/flags/4x3/tw.svg';
import flagUs from 'flag-icons/flags/4x3/us.svg';
import flagZa from 'flag-icons/flags/4x3/za.svg';

const FLAGS: Record<string, string> = {
  ae: flagAe, au: flagAu, bh: flagBh, br: flagBr, ca: flagCa, ch: flagCh, cn: flagCn, de: flagDe, es: flagEs,
  fr: flagFr, gb: flagGb, hk: flagHk, id: flagId, ie: flagIe, il: flagIl, in: flagIn, it: flagIt, jp: flagJp,
  kr: flagKr, mx: flagMx, my: flagMy, nz: flagNz, se: flagSe, sg: flagSg, th: flagTh, tw: flagTw, us: flagUs,
  za: flagZa, be: flagBe, cl: flagCl, fi: flagFi, nl: flagNl, pl: flagPl, qa: flagQa, sa: flagSa,
};
const COUNTRIES: Record<string, string> = {
  ae: 'United Arab Emirates',
  au: 'Australia',
  bh: 'Bahrain',
  br: 'Brazil',
  ca: 'Canada',
  ch: 'Switzerland',
  cn: 'China',
  de: 'Germany',
  es: 'Spain',
  fr: 'France',
  gb: 'United Kingdom',
  hk: 'Hong Kong',
  id: 'Indonesia',
  ie: 'Ireland',
  il: 'Israel',
  in: 'India',
  it: 'Italy',
  jp: 'Japan',
  kr: 'South Korea',
  mx: 'Mexico',
  my: 'Malaysia',
  nz: 'New Zealand',
  se: 'Sweden',
  sg: 'Singapore',
  th: 'Thailand',
  tw: 'Taiwan',
  us: 'United States',
  za: 'South Africa',
  be: 'Belgium',
  cl: 'Chile',
  fi: 'Finland',
  nl: 'Netherlands',
  pl: 'Poland',
  qa: 'Qatar',
  sa: 'Saudi Arabia',
};
const REGIONS: Record<string, [location: string, country: string]> = {
  'us-east-1': ['US East (N. Virginia)', 'us'],
  'us-east-2': ['US East (Ohio)', 'us'],
  'us-west-1': ['US West (N. California)', 'us'],
  'us-west-2': ['US West (Oregon)', 'us'],
  'us-gov-east-1': ['AWS GovCloud (US-East)', 'us'],
  'us-gov-west-1': ['AWS GovCloud (US-West)', 'us'],
  'af-south-1': ['Africa (Cape Town)', 'za'],
  'ap-east-1': ['Asia Pacific (Hong Kong)', 'hk'],
  'ap-east-2': ['Asia Pacific (Taipei)', 'tw'],
  'ap-south-1': ['Asia Pacific (Mumbai)', 'in'],
  'ap-south-2': ['Asia Pacific (Hyderabad)', 'in'],
  'ap-southeast-1': ['Asia Pacific (Singapore)', 'sg'],
  'ap-southeast-2': ['Asia Pacific (Sydney)', 'au'],
  'ap-southeast-3': ['Asia Pacific (Jakarta)', 'id'],
  'ap-southeast-4': ['Asia Pacific (Melbourne)', 'au'],
  'ap-southeast-5': ['Asia Pacific (Malaysia)', 'my'],
  'ap-southeast-6': ['Asia Pacific (New Zealand)', 'nz'],
  'ap-southeast-7': ['Asia Pacific (Thailand)', 'th'],
  'ap-northeast-1': ['Asia Pacific (Tokyo)', 'jp'],
  'ap-northeast-2': ['Asia Pacific (Seoul)', 'kr'],
  'ap-northeast-3': ['Asia Pacific (Osaka)', 'jp'],
  'ca-central-1': ['Canada (Central)', 'ca'],
  'ca-west-1': ['Canada West (Calgary)', 'ca'],
  'cn-north-1': ['China (Beijing)', 'cn'],
  'cn-northwest-1': ['China (Ningxia)', 'cn'],
  'eu-central-1': ['Europe (Frankfurt)', 'de'],
  'eu-central-2': ['Europe (Zurich)', 'ch'],
  'eu-west-1': ['Europe (Ireland)', 'ie'],
  'eu-west-2': ['Europe (London)', 'gb'],
  'eu-west-3': ['Europe (Paris)', 'fr'],
  'eu-south-1': ['Europe (Milan)', 'it'],
  'eu-south-2': ['Europe (Spain)', 'es'],
  'eu-north-1': ['Europe (Stockholm)', 'se'],
  'il-central-1': ['Israel (Tel Aviv)', 'il'],
  'me-south-1': ['Middle East (Bahrain)', 'bh'],
  'me-central-1': ['Middle East (UAE)', 'ae'],
  'mx-central-1': ['Mexico (Central)', 'mx'],
  'sa-east-1': ['South America (São Paulo)', 'br'],
};

// Google Cloud regions (every region Google lists today, 43).
const GOOGLE_REGIONS: Record<string, [location: string, country: string]> = {
  'africa-south1': ['Johannesburg', 'za'],
  'asia-east1': ['Taiwan', 'tw'],
  'asia-east2': ['Hong Kong', 'hk'],
  'asia-northeast1': ['Tokyo', 'jp'],
  'asia-northeast2': ['Osaka', 'jp'],
  'asia-northeast3': ['Seoul', 'kr'],
  'asia-south1': ['Mumbai', 'in'],
  'asia-south2': ['Delhi', 'in'],
  'asia-southeast1': ['Singapore', 'sg'],
  'asia-southeast2': ['Jakarta', 'id'],
  'asia-southeast3': ['Bangkok', 'th'],
  'australia-southeast1': ['Sydney', 'au'],
  'australia-southeast2': ['Melbourne', 'au'],
  'europe-central2': ['Warsaw', 'pl'],
  'europe-north1': ['Finland', 'fi'],
  'europe-north2': ['Stockholm', 'se'],
  'europe-southwest1': ['Madrid', 'es'],
  'europe-west1': ['Belgium', 'be'],
  'europe-west2': ['London', 'gb'],
  'europe-west3': ['Frankfurt', 'de'],
  'europe-west4': ['Netherlands', 'nl'],
  'europe-west6': ['Zurich', 'ch'],
  'europe-west8': ['Milan', 'it'],
  'europe-west9': ['Paris', 'fr'],
  'europe-west10': ['Berlin', 'de'],
  'europe-west12': ['Turin', 'it'],
  'me-central1': ['Doha', 'qa'],
  'me-central2': ['Dammam', 'sa'],
  'me-west1': ['Tel Aviv', 'il'],
  'northamerica-northeast1': ['Montréal', 'ca'],
  'northamerica-northeast2': ['Toronto', 'ca'],
  'northamerica-south1': ['Querétaro', 'mx'],
  'southamerica-east1': ['São Paulo', 'br'],
  'southamerica-west1': ['Santiago', 'cl'],
  'us-central1': ['Iowa', 'us'],
  'us-east1': ['South Carolina', 'us'],
  'us-east4': ['Northern Virginia', 'us'],
  'us-east5': ['Columbus', 'us'],
  'us-south1': ['Dallas', 'us'],
  'us-west1': ['Oregon', 'us'],
  'us-west2': ['Los Angeles', 'us'],
  'us-west3': ['Salt Lake City', 'us'],
  'us-west4': ['Las Vegas', 'us'],
};

export interface RegionInfo {
  code: string;
  location: string | null;
  country: string | null;
  flag: string | null; // image URL
}

export function regionInfo(code: string): RegionInfo {
  const [location, country] = REGIONS[code] ?? GOOGLE_REGIONS[code] ?? [];
  return { code, location: location ?? null, country: country ? COUNTRIES[country]! : null, flag: country ? FLAGS[country]! : null };
}

export const partitionOf = (region: string): string => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');

// The cloud a region code belongs to, from its shape (the two shapes never overlap); null for anything else.
export const regionCloud = (code: string): Cloud | null => (isRegion('aws', code) ? 'aws' : isRegion('gcp', code) ? 'gcp' : null);
// What a region's location is called, for the tooltip.
export const regionKind = (code: string): string | null => {
  const cloud = regionCloud(code);
  return cloud ? cloudWords(cloud).location : null;
};
