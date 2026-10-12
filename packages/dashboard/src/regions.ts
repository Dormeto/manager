// AWS regions with their location (as the AWS console names it) and country, and the country's flag (flag-icons, MIT;
// only these flags are bundled).
import flagAe from 'flag-icons/flags/4x3/ae.svg';
import flagAu from 'flag-icons/flags/4x3/au.svg';
import flagBh from 'flag-icons/flags/4x3/bh.svg';
import flagBr from 'flag-icons/flags/4x3/br.svg';
import flagCa from 'flag-icons/flags/4x3/ca.svg';
import flagCh from 'flag-icons/flags/4x3/ch.svg';
import flagCn from 'flag-icons/flags/4x3/cn.svg';
import flagDe from 'flag-icons/flags/4x3/de.svg';
import flagEs from 'flag-icons/flags/4x3/es.svg';
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
import flagNz from 'flag-icons/flags/4x3/nz.svg';
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
  za: flagZa,
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

export interface RegionInfo {
  code: string;
  location: string | null;
  country: string | null;
  flag: string | null; // image URL
}

export function regionInfo(code: string): RegionInfo {
  const [location, country] = REGIONS[code] ?? [];
  return { code, location: location ?? null, country: country ? COUNTRIES[country]! : null, flag: country ? FLAGS[country]! : null };
}

export const partitionOf = (region: string): string => (region.startsWith('cn-') ? 'aws-cn' : region.startsWith('us-gov-') ? 'aws-us-gov' : 'aws');
