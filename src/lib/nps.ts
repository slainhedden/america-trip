import type { Park } from '../types';

const PUBLIC_FIND_A_PARK_ENDPOINT = 'https://central.nps.gov/units/api/v1/parks/findapark';
const NPS_PARKS_ENDPOINT = 'https://developer.nps.gov/api/v1/parks';

const HERO_COLORS = ['#8aa39b', '#9c7d5a', '#6d8870', '#cb7f4b', '#667f72', '#6d8fa0', '#b65a3c'];
const NATIONAL_PARK_UNIT_CODES = new Set([
  'acad',
  'arch',
  'badl',
  'bibe',
  'bisc',
  'blca',
  'brca',
  'cany',
  'care',
  'cave',
  'chis',
  'cong',
  'crla',
  'cuva',
  'deva',
  'dena',
  'drto',
  'ever',
  'gaar',
  'glac',
  'glba',
  'grba',
  'grca',
  'grsa',
  'grsm',
  'grte',
  'gumo',
  'hale',
  'havo',
  'hosp',
  'indu',
  'isro',
  'jeff',
  'jotr',
  'katm',
  'kefj',
  'kova',
  'lacl',
  'lavo',
  'maca',
  'meve',
  'mora',
  'neri',
  'noca',
  'npsa',
  'olym',
  'pefo',
  'pinn',
  'redw',
  'romo',
  'sagu',
  'seki',
  'shen',
  'thro',
  'viis',
  'voya',
  'whsa',
  'wica',
  'wrst',
  'yell',
  'yose',
  'zion',
]);

const STATE_NAMES: Record<string, string> = {
  AK: 'Alaska',
  AL: 'Alabama',
  AR: 'Arkansas',
  AS: 'American Samoa',
  AZ: 'Arizona',
  CA: 'California',
  CO: 'Colorado',
  FL: 'Florida',
  HI: 'Hawaii',
  ID: 'Idaho',
  IN: 'Indiana',
  KY: 'Kentucky',
  ME: 'Maine',
  MI: 'Michigan',
  MN: 'Minnesota',
  MO: 'Missouri',
  MT: 'Montana',
  NC: 'North Carolina',
  ND: 'North Dakota',
  NM: 'New Mexico',
  NV: 'Nevada',
  OH: 'Ohio',
  OR: 'Oregon',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VA: 'Virginia',
  VI: 'U.S. Virgin Islands',
  WA: 'Washington',
  WV: 'West Virginia',
  WY: 'Wyoming',
};

type NpsParkRecord = {
  description?: string;
  designation?: string;
  fullName?: string;
  images?: Array<{
    altText?: string;
    caption?: string;
    title?: string;
    url?: string;
  }>;
  latLong?: string;
  latitude?: string;
  longitude?: string;
  parkCode?: string;
  states?: string;
  url?: string;
};

type PublicParkRecord = {
  geometry?: {
    coordinates?: [number, number];
  };
  image?: {
    data?: {
      src?: string;
    };
  };
  name?: string;
  parkCode?: string;
  parkName?: string;
  primaryDesignation?: string;
  stateCode?: string;
};

function getHeroColor(seed: string): string {
  const hash = Array.from(seed).reduce((total, character) => total + character.charCodeAt(0), 0);
  return HERO_COLORS[hash % HERO_COLORS.length];
}

function parseCoordinates(record: NpsParkRecord): [number, number] | null {
  const latitude = Number(record.latitude);
  const longitude = Number(record.longitude);

  if (Number.isFinite(latitude) && Number.isFinite(longitude)) {
    return [longitude, latitude];
  }

  if (!record.latLong) {
    return null;
  }

  const match = record.latLong.match(/lat:\s*([-\d.]+).+long:\s*([-\d.]+)/i);
  if (!match) {
    return null;
  }

  const parsedLatitude = Number(match[1]);
  const parsedLongitude = Number(match[2]);

  if (!Number.isFinite(parsedLatitude) || !Number.isFinite(parsedLongitude)) {
    return null;
  }

  return [parsedLongitude, parsedLatitude];
}

function formatStateLabel(stateCodes: string | undefined): string {
  if (!stateCodes) {
    return 'United States';
  }

  return stateCodes
    .split(',')
    .map((stateCode) => STATE_NAMES[stateCode.trim()] ?? stateCode.trim())
    .join(' / ');
}

function normalizeParkName(fullName: string, designation: string): string {
  return fullName.endsWith(designation) ? fullName.slice(0, -designation.length).trim() : fullName;
}

function toPark(record: NpsParkRecord): Park | null {
  if (!record.parkCode || !record.fullName || !record.designation || !NATIONAL_PARK_UNIT_CODES.has(record.parkCode)) {
    return null;
  }

  const coordinates = parseCoordinates(record);
  if (!coordinates) {
    return null;
  }

  const imageUrl = record.images?.find((image) => image.url)?.url;

  return {
    id: record.parkCode,
    parkCode: record.parkCode,
    name: normalizeParkName(record.fullName, record.designation),
    state: formatStateLabel(record.states),
    designation: record.designation,
    description: record.description?.trim() || 'Official National Park Service information available for this park.',
    imageUrl,
    heroColor: getHeroColor(record.parkCode),
    coordinates,
    websiteUrl: record.url ?? `https://www.nps.gov/${record.parkCode}`,
  };
}

function toPublicPark(record: PublicParkRecord): Park | null {
  if (!record.parkCode || !record.parkName || !NATIONAL_PARK_UNIT_CODES.has(record.parkCode)) {
    return null;
  }

  const coordinates = record.geometry?.coordinates;
  if (!coordinates || coordinates.length < 2) {
    return null;
  }

  const imagePath = record.image?.data?.src;

  return {
    id: record.parkCode,
    parkCode: record.parkCode,
    name: record.parkName.trim(),
    state: formatStateLabel(record.stateCode),
    designation: record.primaryDesignation?.trim() ?? 'National Park',
    description: `${record.parkName.trim()} is part of the official National Park Service Find a Park catalog.`,
    imageUrl: imagePath ? `https://www.nps.gov${imagePath}` : undefined,
    heroColor: getHeroColor(record.parkCode),
    coordinates: [coordinates[0], coordinates[1]],
    websiteUrl: `https://www.nps.gov/${record.parkCode.toLowerCase()}/index.htm`,
  };
}

export async function fetchNationalParks(apiKey: string): Promise<Park[]> {
  const trimmedApiKey = apiKey.trim();
  if (!trimmedApiKey) {
    throw new Error('Add a free NPS API key to load the official national park catalog.');
  }

  const requestUrl = new URL(NPS_PARKS_ENDPOINT);
  requestUrl.searchParams.set('limit', '600');
  requestUrl.searchParams.set('fields', 'images');

  const response = await fetch(requestUrl.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Api-Key': trimmedApiKey,
    },
  });

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new Error('The NPS API key was rejected. Check it and try again.');
    }

    if (response.status === 429) {
      throw new Error('The NPS API rate limit was reached. Try again later.');
    }

    throw new Error('Unable to load official National Park Service data right now.');
  }

  const payload = (await response.json()) as {
    data?: NpsParkRecord[];
  };

  return (payload.data ?? [])
    .map(toPark)
    .filter((park): park is Park => park !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export async function fetchPublicNationalParks(): Promise<Park[]> {
  const requestUrl = new URL(PUBLIC_FIND_A_PARK_ENDPOINT);
  requestUrl.searchParams.set('pagesize', '1000');
  requestUrl.searchParams.set('sort', 'name asc');
  requestUrl.searchParams.set('apikey', 'CfJDEBe7xKJ8v6xZOMkh7AaUGF70dBe3');

  const response = await fetch(requestUrl.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Unable to load the public NPS Find a Park feed right now.');
  }

  const payload = (await response.json()) as PublicParkRecord[];

  return payload
    .map(toPublicPark)
    .filter((park): park is Park => park !== null)
    .sort((left, right) => left.name.localeCompare(right.name));
}
