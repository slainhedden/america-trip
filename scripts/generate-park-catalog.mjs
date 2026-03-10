import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '..');
const outputPath = path.join(repoRoot, 'src', 'data', 'parks-catalog.json');

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

const STATE_NAMES = {
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

function getHeroColor(seed) {
  const hash = Array.from(seed).reduce((total, character) => total + character.charCodeAt(0), 0);
  return HERO_COLORS[hash % HERO_COLORS.length];
}

function parseCoordinates(record) {
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

function formatStateLabel(stateCodes) {
  if (!stateCodes) {
    return 'United States';
  }

  return stateCodes
    .split(',')
    .map((stateCode) => STATE_NAMES[stateCode.trim()] ?? stateCode.trim())
    .join(' / ');
}

function normalizeParkName(fullName, designation) {
  return fullName.endsWith(designation) ? fullName.slice(0, -designation.length).trim() : fullName;
}

function toPark(record) {
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

function toPublicPark(record) {
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

async function fetchJson(url, init) {
  const response = await fetch(url, init);

  if (!response.ok) {
    throw new Error(`Request failed with status ${response.status} for ${url}`);
  }

  return response.json();
}

async function fetchDeveloperCatalog(apiKey) {
  const requestUrl = new URL(NPS_PARKS_ENDPOINT);
  requestUrl.searchParams.set('limit', '600');
  requestUrl.searchParams.set('fields', 'images');

  const payload = await fetchJson(requestUrl.toString(), {
    headers: {
      Accept: 'application/json',
      'X-Api-Key': apiKey,
    },
  });

  return (payload.data ?? [])
    .map(toPark)
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function fetchPublicCatalog() {
  const requestUrl = new URL(PUBLIC_FIND_A_PARK_ENDPOINT);
  requestUrl.searchParams.set('pagesize', '1000');
  requestUrl.searchParams.set('sort', 'name asc');
  requestUrl.searchParams.set('apikey', 'CfJDEBe7xKJ8v6xZOMkh7AaUGF70dBe3');

  const payload = await fetchJson(requestUrl.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  return payload
    .map(toPublicPark)
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function hasExistingCatalog() {
  try {
    await access(outputPath);
    return true;
  } catch {
    return false;
  }
}

async function writeCatalog(parks, source) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(parks, null, 2)}\n`);
  console.log(`Generated ${parks.length} national parks from the ${source} feed.`);
}

async function main() {
  const apiKey = process.env.NPS_API_KEY?.trim() ?? '';

  try {
    if (apiKey) {
      try {
        const parks = await fetchDeveloperCatalog(apiKey);
        await writeCatalog(parks, 'developer');
        return;
      } catch (error) {
        console.warn(`Developer feed failed: ${error instanceof Error ? error.message : String(error)}`);
        console.warn('Falling back to the public Find a Park feed.');
      }
    }

    const parks = await fetchPublicCatalog();
    await writeCatalog(parks, 'public');
  } catch (error) {
    if (await hasExistingCatalog()) {
      console.warn(`Park catalog refresh skipped: ${error instanceof Error ? error.message : String(error)}`);
      console.warn(`Using existing catalog at ${path.relative(repoRoot, outputPath)}.`);
      return;
    }

    throw error;
  }
}

main().catch((error) => {
  console.error(`Unable to generate the park catalog: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
