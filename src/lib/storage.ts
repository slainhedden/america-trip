import type { Park, ParkRouteStop, RouteStop, StartPointSource, StartRouteStop, TripState } from '../types';

const TRIP_STORAGE_KEY = 'america-trip-planner-state';
const PARK_CATALOG_STORAGE_KEY = 'america-trip-planner-park-catalog';
const NPS_API_KEY_STORAGE_KEY = 'america-trip-planner-nps-api-key';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCoordinatePair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === 'number' &&
    Number.isFinite(value[0]) &&
    typeof value[1] === 'number' &&
    Number.isFinite(value[1])
  );
}

function getString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function isNonEmptyString(value: string | null): value is string {
  return typeof value === 'string' && value.length > 0;
}

function toStartSource(value: unknown): StartPointSource {
  return value === 'map_click' ? 'map_click' : 'search';
}

function createParkStop(park: Park): ParkRouteStop {
  return {
    id: `park:${park.id}`,
    kind: 'park',
    label: park.name,
    coordinates: park.coordinates,
    parkCode: park.parkCode.toUpperCase(),
    parkId: park.id,
    state: park.state,
  };
}

function createLegacyParkStop(parkId: string): ParkRouteStop {
  return {
    id: `park:${parkId}`,
    kind: 'park',
    label: parkId.toUpperCase(),
    coordinates: [Number.NaN, Number.NaN],
    parkCode: parkId.toUpperCase(),
    parkId,
    state: 'Loading park details',
  };
}

function normalizeRouteStops(stops: RouteStop[]): RouteStop[] {
  let startStop: StartRouteStop | null = null;
  const seenParkIds = new Set<string>();
  const orderedStops: RouteStop[] = [];

  for (const stop of stops) {
    if (stop.kind === 'start') {
      if (!startStop) {
        startStop = { ...stop, id: 'start' };
      }
      continue;
    }

    if (stop.kind === 'park') {
      if (seenParkIds.has(stop.parkId)) {
        continue;
      }
      seenParkIds.add(stop.parkId);
    }

    orderedStops.push(stop);
  }

  return startStop ? [startStop, ...orderedStops] : orderedStops;
}

function parseStartStop(value: unknown): StartRouteStop | null {
  if (!isRecord(value)) {
    return null;
  }

  const label = getString(value.label);
  const coordinates = isCoordinatePair(value.coordinates) ? value.coordinates : null;
  if (!label || !coordinates) {
    return null;
  }

  return {
    id: 'start',
    kind: 'start',
    label,
    coordinates,
    source: toStartSource(value.source),
  };
}

function parseRouteStop(value: unknown, parksById: globalThis.Map<string, Park>): RouteStop | null {
  if (!isRecord(value)) {
    return null;
  }

  switch (value.kind) {
    case 'start':
      return parseStartStop(value);
    case 'city': {
      const label = getString(value.label);
      const coordinates = isCoordinatePair(value.coordinates) ? value.coordinates : null;
      if (!label || !coordinates) {
        return null;
      }

      return {
        id: getString(value.id) ?? 'city:stored',
        kind: 'city',
        label,
        coordinates,
      };
    }
    case 'park': {
      const parkId = getString(value.parkId);
      if (!parkId) {
        return null;
      }

      const park = parksById.get(parkId);
      if (park) {
        return createParkStop(park);
      }

      return {
        id: getString(value.id) ?? `park:${parkId}`,
        kind: 'park',
        label: getString(value.label) ?? parkId.toUpperCase(),
        coordinates: isCoordinatePair(value.coordinates) ? value.coordinates : [Number.NaN, Number.NaN],
        parkCode: getString(value.parkCode) ?? parkId.toUpperCase(),
        parkId,
        state: getString(value.state) ?? 'Stored park stop',
      };
    }
    default:
      return null;
  }
}

function migrateTripState(rawState: unknown, parks: Park[]): TripState | null {
  if (!isRecord(rawState)) {
    return null;
  }

  const parksById = new globalThis.Map(parks.map((park) => [park.id, park]));

  if (Array.isArray(rawState.routeStops)) {
    return {
      routeStops: normalizeRouteStops(
        rawState.routeStops
          .map((stop) => parseRouteStop(stop, parksById))
          .filter(Boolean) as RouteStop[],
      ),
    };
  }

  if ('startPoint' in rawState || 'selectedParkIds' in rawState) {
    const startStop = parseStartStop(rawState.startPoint);
    const parkStops = Array.isArray(rawState.selectedParkIds)
      ? rawState.selectedParkIds
          .map((parkId) => getString(parkId))
          .filter(isNonEmptyString)
          .map((parkId) => parksById.get(parkId) ?? createLegacyParkStop(parkId)) as ParkRouteStop[]
      : [];

    return {
      routeStops: normalizeRouteStops([...(startStop ? [startStop] : []), ...parkStops]),
    };
  }

  return null;
}

export function loadTripState(parks: Park[] = []): TripState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(TRIP_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return migrateTripState(JSON.parse(raw), parks);
  } catch {
    return null;
  }
}

export function saveTripState(state: TripState): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(TRIP_STORAGE_KEY, JSON.stringify(state));
}

export function loadParkCatalog(): Park[] {
  if (typeof window === 'undefined') {
    return [];
  }

  const raw = window.localStorage.getItem(PARK_CATALOG_STORAGE_KEY);
  if (!raw) {
    return [];
  }

  try {
    return JSON.parse(raw) as Park[];
  } catch {
    return [];
  }
}

export function saveParkCatalog(parks: Park[]): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(PARK_CATALOG_STORAGE_KEY, JSON.stringify(parks));
}

export function loadNpsApiKey(): string {
  if (typeof window === 'undefined') {
    return '';
  }

  return window.localStorage.getItem(NPS_API_KEY_STORAGE_KEY) ?? '';
}

export function saveNpsApiKey(apiKey: string): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(NPS_API_KEY_STORAGE_KEY, apiKey);
}

export function clearNpsApiKey(): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.removeItem(NPS_API_KEY_STORAGE_KEY);
}
