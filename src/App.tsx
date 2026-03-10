import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  CSSProperties,
  KeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import Map, {
  Layer,
  Marker,
  NavigationControl,
  Popup,
  Source,
  type MapMouseEvent,
  type MapRef,
} from 'react-map-gl/maplibre';
import { fetchNationalParks, fetchPublicNationalParks } from './lib/nps';
import { loadNpsApiKey, loadParkCatalog, loadTripState, saveParkCatalog, saveTripState } from './lib/storage';
import type {
  CityRouteStop,
  Park,
  ParkRouteStop,
  RouteStop,
  RouteSummary,
  SearchResult,
  StartPoint,
  StartRouteStop,
  TripState,
} from './types';

const DEFAULT_VIEW = {
  longitude: -98.5795,
  latitude: 39.8283,
  zoom: 3.45,
};

const DEFAULT_ROUTE_PARK_IDS = ['acad', 'grsm', 'shen'];
const FEATURED_PARK_IDS = ['yell', 'yose', 'grca', 'zion', 'grsm', 'glac', 'olym', 'acad', 'romo', 'arch', 'ever', 'dena'];
const GEOCODING_API_URL = import.meta.env.VITE_GEOCODING_API_URL?.trim();
const GEOCODING_API_KEY = import.meta.env.VITE_GEOCODING_API_KEY?.trim();
const ROUTING_API_URL =
  import.meta.env.VITE_ROUTING_API_URL?.trim() ?? 'https://router.project-osrm.org/route/v1/driving';
const ENV_NPS_API_KEY = import.meta.env.VITE_NPS_API_KEY?.trim() ?? '';
const PANEL_LAYOUT_STORAGE_KEY = 'america-trip-panel-layouts';
const US_STATES_GEOJSON_URL = 'https://raw.githubusercontent.com/PublicaMundi/MappingAPI/master/data/geojson/us-states.json';
const PANEL_MARGIN = 20;
const PANEL_GAP = 16;
const PANEL_ORDER: PanelId[] = ['planner', 'route', 'catalog', 'featured'];
const GRID_BOUNDS = {
  west: -170,
  east: -60,
  south: 15,
  north: 72,
};

const EMPTY_ROUTE: RouteSummary = {
  geometry: null,
  totalDistanceMiles: 0,
  totalDurationHours: 0,
  legs: [],
  provider: 'OSRM-compatible routing',
};

const EMPTY_STATE_LABELS: GeoJSON.FeatureCollection<GeoJSON.Point, { name: string }> = {
  type: 'FeatureCollection',
  features: [],
};

type StateSelection = {
  coordinates: [number, number];
  label: string;
  name: string;
};

type PanelId = 'planner' | 'route' | 'catalog' | 'featured';

type PanelLayout = {
  x: number;
  y: number;
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
};

type PanelLayouts = Record<PanelId, PanelLayout>;

type FloatingPanelProps = {
  accent?: 'orange' | 'cyan';
  children: ReactNode;
  className?: string;
  layout: PanelLayout;
  onChange: (layout: PanelLayout) => void;
  title: string;
};

type StateBoundaryGeometry = GeoJSON.Polygon | GeoJSON.MultiPolygon;

const SATELLITE_STYLE = {
  version: 8 as const,
  sources: {
    satellite: {
      type: 'raster' as const,
      tiles: ['https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
      tileSize: 256,
      attribution: 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      maxzoom: 19,
    },
  },
  layers: [
    {
      id: 'satellite',
      type: 'raster' as const,
      source: 'satellite',
    },
  ],
};

function getViewportSize() {
  if (typeof window === 'undefined') {
    return { width: 1440, height: 960 };
  }

  return {
    width: window.innerWidth,
    height: window.innerHeight,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  if (maximum < minimum) {
    return minimum;
  }

  return Math.min(Math.max(value, minimum), maximum);
}

function clampPanelLayout(layout: PanelLayout): PanelLayout {
  const viewport = getViewportSize();
  const width = clamp(layout.width, layout.minWidth, Math.max(layout.minWidth, viewport.width - PANEL_MARGIN * 2));
  const height = clamp(layout.height, layout.minHeight, Math.max(layout.minHeight, viewport.height - PANEL_MARGIN * 2));

  return {
    ...layout,
    width,
    height,
    x: clamp(layout.x, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.width - width - PANEL_MARGIN)),
    y: clamp(layout.y, PANEL_MARGIN, Math.max(PANEL_MARGIN, viewport.height - height - PANEL_MARGIN)),
  };
}

function getOverlapArea(a: PanelLayout, b: PanelLayout, padding = PANEL_GAP): number {
  const left = Math.max(a.x - padding / 2, b.x - padding / 2);
  const right = Math.min(a.x + a.width + padding / 2, b.x + b.width + padding / 2);
  const top = Math.max(a.y - padding / 2, b.y - padding / 2);
  const bottom = Math.min(a.y + a.height + padding / 2, b.y + b.height + padding / 2);

  if (left >= right || top >= bottom) {
    return 0;
  }

  return (right - left) * (bottom - top);
}

function hasOverlap(layout: PanelLayout, others: PanelLayout[]): boolean {
  return others.some((other) => getOverlapArea(layout, other) > 0);
}

function buildCandidateLayout(layout: PanelLayout, x: number, y: number): PanelLayout {
  return clampPanelLayout({
    ...layout,
    x,
    y,
  });
}

function getAnchoredPanelLayout(id: PanelId, layout: PanelLayout): PanelLayout {
  const viewport = getViewportSize();
  const rightX = Math.max(PANEL_MARGIN, viewport.width - layout.width - PANEL_MARGIN);
  const bottomY = Math.max(PANEL_MARGIN, viewport.height - layout.height - PANEL_MARGIN);
  const centeredX = Math.max(PANEL_MARGIN, Math.round((viewport.width - layout.width) / 2));

  switch (id) {
    case 'planner':
      return buildCandidateLayout(layout, PANEL_MARGIN, PANEL_MARGIN);
    case 'route':
      return buildCandidateLayout(layout, rightX, PANEL_MARGIN);
    case 'catalog':
      return buildCandidateLayout(layout, PANEL_MARGIN, bottomY);
    case 'featured':
      return buildCandidateLayout(layout, centeredX, bottomY);
  }
}

function getPanelCandidates(id: PanelId, layout: PanelLayout, placed: Partial<PanelLayouts>): PanelLayout[] {
  const viewport = getViewportSize();
  const rightX = Math.max(PANEL_MARGIN, viewport.width - layout.width - PANEL_MARGIN);
  const bottomY = Math.max(PANEL_MARGIN, viewport.height - layout.height - PANEL_MARGIN);
  const centeredX = Math.max(PANEL_MARGIN, Math.round((viewport.width - layout.width) / 2));
  const belowPlannerY = placed.planner
    ? Math.min(bottomY, placed.planner.y + placed.planner.height + PANEL_GAP)
    : PANEL_MARGIN;
  const belowRouteY = placed.route
    ? Math.min(bottomY, placed.route.y + placed.route.height + PANEL_GAP)
    : PANEL_MARGIN;
  const rightOfPlannerX = placed.planner
    ? Math.min(rightX, placed.planner.x + placed.planner.width + PANEL_GAP)
    : rightX;
  const leftOfRouteX = placed.route
    ? Math.max(PANEL_MARGIN, placed.route.x - layout.width - PANEL_GAP)
    : PANEL_MARGIN;

  const positions: Array<[number, number]> = [[layout.x, layout.y]];

  switch (id) {
    case 'planner':
      positions.push(
        [PANEL_MARGIN, PANEL_MARGIN],
        [leftOfRouteX, PANEL_MARGIN],
        [PANEL_MARGIN, bottomY],
        [rightX, PANEL_MARGIN],
      );
      break;
    case 'route':
      positions.push(
        [rightX, PANEL_MARGIN],
        [rightOfPlannerX, PANEL_MARGIN],
        [rightX, belowPlannerY],
        [rightX, bottomY],
        [PANEL_MARGIN, PANEL_MARGIN],
      );
      break;
    case 'catalog':
      positions.push(
        [PANEL_MARGIN, bottomY],
        [PANEL_MARGIN, belowPlannerY],
        [leftOfRouteX, bottomY],
        [rightX, bottomY],
        [PANEL_MARGIN, PANEL_MARGIN],
      );
      break;
    case 'featured':
      positions.push(
        [centeredX, bottomY],
        [PANEL_MARGIN, bottomY],
        [rightX, bottomY],
        [centeredX, Math.max(PANEL_MARGIN, bottomY - Math.round(layout.height * 0.2))],
        [PANEL_MARGIN, belowRouteY],
      );
      break;
  }

  const deduped = new Set<string>();
  return positions
    .map(([x, y]) => buildCandidateLayout(layout, x, y))
    .filter((candidate) => {
      const key = `${candidate.x}:${candidate.y}:${candidate.width}:${candidate.height}`;
      if (deduped.has(key)) {
        return false;
      }
      deduped.add(key);
      return true;
    });
}

function pickBestPanelLayout(id: PanelId, layout: PanelLayout, placed: Partial<PanelLayouts>): PanelLayout {
  const candidates = getPanelCandidates(id, clampPanelLayout(layout), placed);
  const others = Object.values(placed);
  const anchor = getAnchoredPanelLayout(id, layout);
  const withoutOverlap = candidates.find((candidate) => !hasOverlap(candidate, others));

  if (withoutOverlap) {
    return withoutOverlap;
  }

  return candidates.reduce((best, candidate) => {
    const overlapScore = others.reduce((total, other) => total + getOverlapArea(candidate, other), 0);
    const bestOverlap = others.reduce((total, other) => total + getOverlapArea(best, other), 0);
    if (overlapScore !== bestOverlap) {
      return overlapScore < bestOverlap ? candidate : best;
    }

    const distanceScore = Math.abs(candidate.x - anchor.x) + Math.abs(candidate.y - anchor.y);
    const bestDistance = Math.abs(best.x - anchor.x) + Math.abs(best.y - anchor.y);
    return distanceScore < bestDistance ? candidate : best;
  });
}

function reconcilePanelLayouts(layouts: PanelLayouts, changedId?: PanelId): PanelLayouts {
  const order = changedId ? [changedId, ...PANEL_ORDER.filter((id) => id !== changedId)] : PANEL_ORDER;
  const placed: Partial<PanelLayouts> = {};

  for (const id of order) {
    placed[id] = pickBestPanelLayout(id, layouts[id], placed);
  }

  return {
    planner: placed.planner ?? clampPanelLayout(layouts.planner),
    route: placed.route ?? clampPanelLayout(layouts.route),
    catalog: placed.catalog ?? clampPanelLayout(layouts.catalog),
    featured: placed.featured ?? clampPanelLayout(layouts.featured),
  };
}

function getDefaultPanelLayouts(): PanelLayouts {
  const viewport = getViewportSize();
  const plannerWidth = Math.min(360, viewport.width - PANEL_MARGIN * 2);
  const routeWidth = Math.min(310, viewport.width - PANEL_MARGIN * 2);
  const catalogWidth = Math.min(320, viewport.width - PANEL_MARGIN * 2);
  const featuredWidth = Math.min(Math.max(700, viewport.width * 0.58), viewport.width - PANEL_MARGIN * 2);
  const featuredHeight = 190;

  return reconcilePanelLayouts({
    planner: clampPanelLayout({
      x: PANEL_MARGIN,
      y: PANEL_MARGIN,
      width: plannerWidth,
      height: 330,
      minWidth: 300,
      minHeight: 250,
    }),
    route: clampPanelLayout({
      x: viewport.width - routeWidth - PANEL_MARGIN,
      y: PANEL_MARGIN,
      width: routeWidth,
      height: 238,
      minWidth: 260,
      minHeight: 190,
    }),
    catalog: clampPanelLayout({
      x: PANEL_MARGIN,
      y: viewport.height - 300,
      width: catalogWidth,
      height: 280,
      minWidth: 260,
      minHeight: 220,
    }),
    featured: clampPanelLayout({
      x: Math.max(PANEL_MARGIN, Math.round((viewport.width - featuredWidth) / 2)),
      y: viewport.height - featuredHeight - PANEL_MARGIN,
      width: featuredWidth,
      height: featuredHeight,
      minWidth: 420,
      minHeight: 180,
    }),
  });
}

function loadPanelLayouts(): PanelLayouts {
  const defaults = getDefaultPanelLayouts();
  if (typeof window === 'undefined') {
    return defaults;
  }

  try {
    const stored = window.localStorage.getItem(PANEL_LAYOUT_STORAGE_KEY);
    if (!stored) {
      return defaults;
    }

    const parsed = JSON.parse(stored) as Partial<Record<PanelId, Partial<PanelLayout>>>;

    return reconcilePanelLayouts({
      planner: clampPanelLayout({ ...defaults.planner, ...parsed.planner }),
      route: clampPanelLayout({ ...defaults.route, ...parsed.route }),
      catalog: clampPanelLayout({ ...defaults.catalog, ...parsed.catalog }),
      featured: clampPanelLayout({ ...defaults.featured, ...parsed.featured }),
    });
  } catch {
    return defaults;
  }
}

function FloatingPanel({ accent = 'orange', children, className, layout, onChange, title }: FloatingPanelProps) {
  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const origin = layout;

    function handleMove(moveEvent: PointerEvent) {
      onChange(
        clampPanelLayout({
          ...origin,
          x: origin.x + (moveEvent.clientX - startX),
          y: origin.y + (moveEvent.clientY - startY),
        }),
      );
    }

    function handleUp() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  function beginResize(event: ReactPointerEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();

    const startX = event.clientX;
    const startY = event.clientY;
    const origin = layout;

    function handleMove(moveEvent: PointerEvent) {
      onChange(
        clampPanelLayout({
          ...origin,
          width: origin.width + (moveEvent.clientX - startX),
          height: origin.height + (moveEvent.clientY - startY),
        }),
      );
    }

    function handleUp() {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
    }

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
  }

  return (
    <section
      className={`console-card floating-panel floating-panel--${accent} ${className ?? ''}`}
      style={{
        left: layout.x,
        top: layout.y,
        width: layout.width,
        height: layout.height,
      }}
    >
      <button type="button" className="floating-panel__handle" onPointerDown={beginDrag}>
        <span>{title}</span>
        <span>Drag</span>
      </button>
      <div className="floating-panel__content">{children}</div>
      <button type="button" className="floating-panel__resize" aria-label={`Resize ${title}`} onPointerDown={beginResize} />
    </section>
  );
}

function formatMiles(value: number): string {
  return `${Math.round(value).toLocaleString()} MI`;
}

function formatHours(value: number): string {
  if (value < 1) {
    return `${Math.round(value * 60)} MIN`;
  }

  return `${value.toFixed(1)} HR`;
}

function createCoordinateGrid(stepDegrees: number): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];
  const precision = stepDegrees < 5 ? 2 : 0;

  for (let latitude = GRID_BOUNDS.south; latitude <= GRID_BOUNDS.north; latitude += stepDegrees) {
    const lat = Number(latitude.toFixed(precision));
    features.push({
      type: 'Feature',
      properties: { axis: 'lat' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [GRID_BOUNDS.west, lat],
          [GRID_BOUNDS.east, lat],
        ],
      },
    });
  }

  for (let longitude = GRID_BOUNDS.west; longitude <= GRID_BOUNDS.east; longitude += stepDegrees) {
    const lng = Number(longitude.toFixed(precision));
    features.push({
      type: 'Feature',
      properties: { axis: 'lng' },
      geometry: {
        type: 'LineString',
        coordinates: [
          [lng, GRID_BOUNDS.south],
          [lng, GRID_BOUNDS.north],
        ],
      },
    });
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}

function createParkMap(parks: Park[]): globalThis.Map<string, Park> {
  return new globalThis.Map(parks.map((park) => [park.id, park]));
}

function dedupeParks(parks: Park[]): Park[] {
  const seen = new Set<string>();

  return parks.filter((park) => {
    if (seen.has(park.id)) {
      return false;
    }

    seen.add(park.id);
    return true;
  });
}

function createStopId(prefix: string): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  if (randomId) {
    return `${prefix}:${randomId}`;
  }

  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;
}

function hasValidCoordinates(coordinates: [number, number]): boolean {
  return Number.isFinite(coordinates[0]) && Number.isFinite(coordinates[1]);
}

function createStartStop(startPoint: StartPoint): StartRouteStop {
  return {
    id: 'start',
    kind: 'start',
    label: startPoint.label,
    coordinates: startPoint.coordinates,
    source: startPoint.source,
  };
}

function createCityStop(result: SearchResult): CityRouteStop {
  return {
    id: createStopId('city'),
    kind: 'city',
    label: result.label,
    coordinates: result.coordinates,
  };
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

function hydrateRouteStop(stop: RouteStop, parksById: globalThis.Map<string, Park>): RouteStop {
  if (stop.kind !== 'park') {
    return stop;
  }

  const park = parksById.get(stop.parkId);
  return park ? createParkStop(park) : stop;
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

function buildDefaultRouteStops(parksById: globalThis.Map<string, Park>): RouteStop[] {
  return DEFAULT_ROUTE_PARK_IDS.map((parkId) => parksById.get(parkId)).filter(Boolean).map((park) => createParkStop(park as Park));
}

function getRouteStopMeta(stop: RouteStop): string {
  switch (stop.kind) {
    case 'start':
      return stop.source === 'search' ? 'Search origin' : 'Pinned origin';
    case 'city':
      return 'City stop';
    case 'park':
      return stop.state;
  }
}

function getRouteStopKindLabel(stop: RouteStop): string {
  switch (stop.kind) {
    case 'start':
      return 'START';
    case 'city':
      return 'CITY';
    case 'park':
      return '⛺ TENT';
  }
}

const MINOR_GRID = createCoordinateGrid(5);
const MAJOR_GRID = createCoordinateGrid(10);

function matchesStateLabel(park: Park, stateName: string): boolean {
  const target = stateName.trim().toLowerCase();
  if (!target) {
    return false;
  }

  return park.state
    .split('/')
    .map((segment) => segment.trim().toLowerCase())
    .some((segment) => segment === target);
}

async function searchPlaces(query: string): Promise<SearchResult[]> {
  const trimmedQuery = query.trim();
  if (!trimmedQuery) {
    return [];
  }

  if (GEOCODING_API_URL) {
    const geocodingUrl = new URL(GEOCODING_API_URL);
    geocodingUrl.searchParams.set('q', trimmedQuery);
    geocodingUrl.searchParams.set('limit', '5');
    if (GEOCODING_API_KEY) {
      geocodingUrl.searchParams.set('key', GEOCODING_API_KEY);
    }

    const response = await fetch(geocodingUrl.toString());
    if (!response.ok) {
      throw new Error('Unable to search locations.');
    }

    const data = (await response.json()) as {
      features?: Array<{
        place_name?: string;
        center?: [number, number];
      }>;
    };

    return (data.features ?? [])
      .filter((feature) => feature.place_name && feature.center)
      .map((feature) => ({
        label: feature.place_name as string,
        coordinates: feature.center as [number, number],
      }));
  }

  const fallbackUrl = new URL('https://nominatim.openstreetmap.org/search');
  fallbackUrl.searchParams.set('q', trimmedQuery);
  fallbackUrl.searchParams.set('format', 'jsonv2');
  fallbackUrl.searchParams.set('limit', '5');

  const response = await fetch(fallbackUrl.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Unable to search locations.');
  }

  const data = (await response.json()) as Array<{
    display_name: string;
    lat: string;
    lon: string;
  }>;

  return data.map((item) => ({
    label: item.display_name,
    coordinates: [Number(item.lon), Number(item.lat)],
  }));
}

async function fetchRoute(stops: RouteStop[]): Promise<RouteSummary> {
  if (stops.length < 2 || stops[0]?.kind !== 'start') {
    return EMPTY_ROUTE;
  }

  const coordinates = stops.map((stop) => `${stop.coordinates[0]},${stop.coordinates[1]}`).join(';');
  const routeUrl = new URL(`${ROUTING_API_URL}/${coordinates}`);
  routeUrl.searchParams.set('overview', 'full');
  routeUrl.searchParams.set('geometries', 'geojson');
  routeUrl.searchParams.set('steps', 'false');

  const response = await fetch(routeUrl.toString());
  if (!response.ok) {
    throw new Error('Unable to calculate driving route.');
  }

  const data = (await response.json()) as {
    routes?: Array<{
      geometry: GeoJSON.LineString;
      distance: number;
      duration: number;
      legs?: Array<{
        distance: number;
        duration: number;
      }>;
    }>;
  };

  const route = data.routes?.[0];
  if (!route) {
    throw new Error('No route found for the selected stops.');
  }

  const labels = stops.map((stop) => stop.label);
  const legs = (route.legs ?? []).map((leg, index) => ({
    from: labels[index] ?? `Stop ${index + 1}`,
    to: labels[index + 1] ?? `Stop ${index + 2}`,
    distanceMiles: leg.distance * 0.000621371,
    durationHours: leg.duration / 3600,
  }));

  return {
    geometry: route.geometry,
    totalDistanceMiles: route.distance * 0.000621371,
    totalDurationHours: route.duration / 3600,
    legs,
    provider: 'OSRM-compatible routing',
  };
}

async function reverseLookupState(coordinates: [number, number]): Promise<StateSelection | null> {
  const reverseUrl = new URL('https://nominatim.openstreetmap.org/reverse');
  reverseUrl.searchParams.set('lat', String(coordinates[1]));
  reverseUrl.searchParams.set('lon', String(coordinates[0]));
  reverseUrl.searchParams.set('format', 'jsonv2');
  reverseUrl.searchParams.set('addressdetails', '1');
  reverseUrl.searchParams.set('zoom', '5');

  const response = await fetch(reverseUrl.toString(), {
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('Unable to inspect the clicked state.');
  }

  const data = (await response.json()) as {
    address?: {
      state?: string;
      territory?: string;
    };
    display_name?: string;
  };

  const stateName = data.address?.state ?? data.address?.territory;
  if (!stateName) {
    return null;
  }

  return {
    name: stateName,
    label: data.display_name ?? stateName,
    coordinates,
  };
}

function fitMapToCoordinates(map: MapRef | null, coordinates: Array<[number, number]>) {
  if (!map || coordinates.length === 0) {
    return;
  }

  if (coordinates.length === 1) {
    map.flyTo({
      center: coordinates[0],
      zoom: 6.2,
      duration: 900,
    });
    return;
  }

  const [firstLng, firstLat] = coordinates[0];
  let west = firstLng;
  let east = firstLng;
  let south = firstLat;
  let north = firstLat;

  for (const [lng, lat] of coordinates.slice(1)) {
    west = Math.min(west, lng);
    east = Math.max(east, lng);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }

  const compact = window.innerWidth < 980;
  map.fitBounds(
    [
      [west, south],
      [east, north],
    ],
    {
      duration: 1100,
      padding: compact ? 76 : { top: 150, right: 420, bottom: 220, left: 420 },
      maxZoom: compact ? 5.4 : 5.9,
    },
  );
}

function getPolygonBounds(polygon: GeoJSON.Position[][]) {
  let west = Number.POSITIVE_INFINITY;
  let east = Number.NEGATIVE_INFINITY;
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;

  for (const ring of polygon) {
    for (const coordinate of ring) {
      west = Math.min(west, coordinate[0]);
      east = Math.max(east, coordinate[0]);
      south = Math.min(south, coordinate[1]);
      north = Math.max(north, coordinate[1]);
    }
  }

  return { west, east, south, north };
}

function buildStateLabelCandidate(feature: GeoJSON.Feature<StateBoundaryGeometry, { name?: string }>) {
  const name = feature.properties?.name?.trim();
  if (!name || !feature.geometry) {
    return null;
  }

  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  let bestBounds: ReturnType<typeof getPolygonBounds> | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const polygon of polygons) {
    const bounds = getPolygonBounds(polygon);
    const score = Math.abs(bounds.east - bounds.west) * Math.abs(bounds.north - bounds.south);
    if (score > bestScore) {
      bestScore = score;
      bestBounds = bounds;
    }
  }

  if (!bestBounds || !Number.isFinite(bestScore)) {
    return null;
  }

  return {
    name,
    score: bestScore,
    coordinates: [((bestBounds.west + bestBounds.east) / 2) as number, ((bestBounds.south + bestBounds.north) / 2) as number] as [
      number,
      number,
    ],
  };
}

async function fetchStateLabelPoints(): Promise<GeoJSON.FeatureCollection<GeoJSON.Point, { name: string }>> {
  const response = await fetch(US_STATES_GEOJSON_URL);
  if (!response.ok) {
    throw new Error('Unable to load state label geometry.');
  }

  const data = (await response.json()) as GeoJSON.FeatureCollection<StateBoundaryGeometry, { name?: string }>;
  const bestByName = new globalThis.Map<string, { coordinates: [number, number]; score: number }>();

  for (const feature of data.features) {
    const candidate = buildStateLabelCandidate(feature);
    if (!candidate) {
      continue;
    }

    const existing = bestByName.get(candidate.name);
    if (!existing || candidate.score > existing.score) {
      bestByName.set(candidate.name, {
        coordinates: candidate.coordinates,
        score: candidate.score,
      });
    }
  }

  return {
    type: 'FeatureCollection',
    features: Array.from(bestByName.entries()).map(([name, entry]) => ({
      type: 'Feature',
      properties: { name },
      geometry: {
        type: 'Point',
        coordinates: entry.coordinates,
      },
    })),
  };
}

export default function App() {
  const initialParkCatalogRef = useRef<Park[]>(loadParkCatalog());
  const initialStateRef = useRef<TripState | null>(loadTripState(initialParkCatalogRef.current));
  const hadStoredTripStateRef = useRef(initialStateRef.current !== null);
  const initialApiKeyRef = useRef(loadNpsApiKey() || ENV_NPS_API_KEY);
  const mapRef = useRef<MapRef | null>(null);
  const searchRequestIdRef = useRef(0);

  const [routeStops, setRouteStops] = useState<RouteStop[]>(
    () => initialStateRef.current?.routeStops ?? buildDefaultRouteStops(createParkMap(initialParkCatalogRef.current)),
  );
  const [parks, setParks] = useState<Park[]>(initialParkCatalogRef.current);
  const [activeParkId, setActiveParkId] = useState<string | null>(null);
  const [apiKey] = useState(initialApiKeyRef.current);
  const [, setParksStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    initialParkCatalogRef.current.length > 0 ? 'ready' : initialApiKeyRef.current ? 'loading' : 'idle',
  );
  const [, setCatalogSource] = useState<'public' | 'developer' | 'cache'>(
    initialParkCatalogRef.current.length > 0 ? 'cache' : 'public',
  );
  const [parksError, setParksError] = useState<string | null>(null);
  const [parkFilterQuery, setParkFilterQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [routeSummary, setRouteSummary] = useState<RouteSummary>(EMPTY_ROUTE);
  const [routeStatus, setRouteStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [selectedState, setSelectedState] = useState<StateSelection | null>(null);
  const [, setStateStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stateError, setStateError] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<'inspect' | 'pin-start'>('inspect');
  const [plannerPanelOpen, setPlannerPanelOpen] = useState(true);
  const [catalogPanelOpen, setCatalogPanelOpen] = useState(false);
  const [catalogPanelVisible, setCatalogPanelVisible] = useState(true);
  const [routePanelOpen, setRoutePanelOpen] = useState(true);
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false);
  const [featuredPanelOpen, setFeaturedPanelOpen] = useState(true);
  const [panelLayouts, setPanelLayouts] = useState<PanelLayouts>(() => loadPanelLayouts());
  const [stateLabelPoints, setStateLabelPoints] = useState(EMPTY_STATE_LABELS);

  const parksById = useMemo(() => createParkMap(parks), [parks]);
  const hydratedRouteStops = useMemo(
    () => normalizeRouteStops(routeStops.map((stop) => hydrateRouteStop(stop, parksById))),
    [parksById, routeStops],
  );
  const startStop = useMemo(
    () => (hydratedRouteStops[0]?.kind === 'start' ? (hydratedRouteStops[0] as StartRouteStop) : null),
    [hydratedRouteStops],
  );
  const travelStops = useMemo(() => (startStop ? hydratedRouteStops.slice(1) : hydratedRouteStops), [hydratedRouteStops, startStop]);
  const routeableTravelStops = useMemo(
    () => travelStops.filter((stop) => hasValidCoordinates(stop.coordinates)),
    [travelStops],
  );
  const hasPendingRouteStopData = useMemo(
    () => travelStops.some((stop) => !hasValidCoordinates(stop.coordinates)),
    [travelStops],
  );
  const routeableStops = useMemo(() => {
    if (!startStop || !hasValidCoordinates(startStop.coordinates) || hasPendingRouteStopData) {
      return [];
    }

    return [startStop, ...routeableTravelStops];
  }, [hasPendingRouteStopData, routeableTravelStops, startStop]);
  const routeStopOrder = useMemo(
    () => new globalThis.Map(travelStops.map((stop, index) => [stop.id, index + 1])),
    [travelStops],
  );
  const routeMarkerOrder = useMemo(
    () => new globalThis.Map(routeableTravelStops.map((stop, index) => [stop.id, index + 1])),
    [routeableTravelStops],
  );
  const parkRouteStops = useMemo(
    () => travelStops.filter((stop): stop is ParkRouteStop => stop.kind === 'park'),
    [travelStops],
  );
  const cityRouteStops = useMemo(
    () => travelStops.filter((stop): stop is CityRouteStop => stop.kind === 'city' && hasValidCoordinates(stop.coordinates)),
    [travelStops],
  );
  const routeParkIds = useMemo(() => new Set(parkRouteStops.map((stop) => stop.parkId)), [parkRouteStops]);
  const filteredParks = useMemo(() => {
    const query = parkFilterQuery.trim().toLowerCase();
    if (!query) {
      return parks;
    }

    return parks.filter((park) =>
      `${park.name} ${park.state} ${park.designation} ${park.parkCode}`.toLowerCase().includes(query),
    );
  }, [parkFilterQuery, parks]);
  const selectedParks = useMemo(
    () => parkRouteStops.map((stop) => parksById.get(stop.parkId)).filter(Boolean) as Park[],
    [parkRouteStops, parksById],
  );
  const featuredParks = useMemo(
    () => FEATURED_PARK_IDS.map((id) => parksById.get(id)).filter(Boolean) as Park[],
    [parksById],
  );
  const quickPickParks = featuredParks.length > 0 ? featuredParks : parks.slice(0, 12);
  const activePark = activeParkId ? parksById.get(activeParkId) ?? null : null;
  const stateParks = useMemo(
    () => (selectedState ? parks.filter((park) => matchesStateLabel(park, selectedState.name)) : []),
    [parks, selectedState],
  );
  const catalogPreview = useMemo(() => {
    const base = parkFilterQuery.trim()
      ? filteredParks
      : dedupeParks([
          ...selectedParks,
          ...quickPickParks,
          ...parks.filter((park) => !routeParkIds.has(park.id)).slice(0, 24),
        ]);

    return base.slice(0, 24);
  }, [filteredParks, parkFilterQuery, parks, quickPickParks, routeParkIds, selectedParks]);
  const inactiveFeaturedParks = useMemo(
    () => quickPickParks.filter((park) => !routeParkIds.has(park.id)),
    [quickPickParks, routeParkIds],
  );
  const routeFeature = useMemo(() => {
    if (!routeSummary.geometry) {
      return null;
    }

    return {
      type: 'Feature' as const,
      geometry: routeSummary.geometry,
      properties: {},
    };
  }, [routeSummary.geometry]);
  const mappableRouteCoordinates = useMemo(
    () => hydratedRouteStops.filter((stop) => hasValidCoordinates(stop.coordinates)).map((stop) => stop.coordinates),
    [hydratedRouteStops],
  );
  const plannedStopCount = hydratedRouteStops.length;

  useEffect(() => {
    if (!hadStoredTripStateRef.current && hydratedRouteStops.length === 0 && parks.length === 0) {
      return;
    }

    saveTripState({
      routeStops: hydratedRouteStops,
    });
  }, [hydratedRouteStops, parks.length]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(panelLayouts));
  }, [panelLayouts]);

  useEffect(() => {
    let cancelled = false;

    async function loadStateLabels() {
      try {
        const nextStateLabelPoints = await fetchStateLabelPoints();
        if (!cancelled) {
          setStateLabelPoints(nextStateLabelPoints);
        }
      } catch {
        if (!cancelled) {
          setStateLabelPoints(EMPTY_STATE_LABELS);
        }
      }
    }

    void loadStateLabels();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const trimmedQuery = searchQuery.trim();
    if (!trimmedQuery) {
      searchRequestIdRef.current += 1;
      setSearchResults([]);
      setSearchStatus('idle');
      setSearchedQuery('');
      return;
    }

    const timeoutId = window.setTimeout(() => {
      void runSearch(trimmedQuery);
    }, 240);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [searchQuery]);

  useEffect(() => {
    function handleViewportResize() {
      setPanelLayouts((current) =>
        reconcilePanelLayouts({
          planner: clampPanelLayout(current.planner),
          route: clampPanelLayout(current.route),
          catalog: clampPanelLayout(current.catalog),
          featured: clampPanelLayout(current.featured),
        }),
      );
    }

    window.addEventListener('resize', handleViewportResize);

    return () => {
      window.removeEventListener('resize', handleViewportResize);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadOfficialParks() {
      setParksStatus('loading');
      setParksError(null);

      try {
        const nextParks = apiKey ? await fetchNationalParks(apiKey) : await fetchPublicNationalParks();
        if (!cancelled) {
          setParks(nextParks);
          saveParkCatalog(nextParks);
          setCatalogSource(apiKey ? 'developer' : 'public');
          setParksStatus('ready');
        }
      } catch (error) {
        if (apiKey) {
          try {
            const fallbackParks = await fetchPublicNationalParks();
            if (!cancelled) {
              setParks(fallbackParks);
              saveParkCatalog(fallbackParks);
              setCatalogSource('public');
              setParksStatus('ready');
              setParksError('Developer feed failed. Falling back to the public NPS Find a Park catalog.');
            }
            return;
          } catch {
            // Fall through to shared error handling.
          }
        }

        if (!cancelled) {
          setParksStatus(parks.length > 0 ? 'ready' : 'error');
          setParksError(error instanceof Error ? error.message : 'Unable to load official National Park Service data.');
        }
      }
    }

    void loadOfficialParks();

    return () => {
      cancelled = true;
    };
  }, [apiKey, parks.length]);

  useEffect(() => {
    if (parks.length === 0) {
      return;
    }

    setRouteStops((current) => {
      const next = normalizeRouteStops(current.map((stop) => hydrateRouteStop(stop, parksById)));
      if (next.length === 0 && !hadStoredTripStateRef.current) {
        return buildDefaultRouteStops(parksById);
      }

      return JSON.stringify(current) === JSON.stringify(next) ? current : next;
    });
  }, [parks.length, parksById]);

  useEffect(() => {
    if (activeParkId && !parksById.has(activeParkId)) {
      setActiveParkId(null);
    }
  }, [activeParkId, parksById]);

  useEffect(() => {
    if (routeableStops.length < 2) {
      setRouteSummary(EMPTY_ROUTE);
      setRouteStatus('idle');
      setRouteError(null);
      return;
    }

    let cancelled = false;
    const currentStops = routeableStops;

    async function runRouteRequest() {
      setRouteStatus('loading');
      setRouteError(null);

      try {
        const summary = await fetchRoute(currentStops);
        if (!cancelled) {
          setRouteSummary(summary);
          setRouteStatus('idle');
        }
      } catch (error) {
        if (!cancelled) {
          setRouteSummary(EMPTY_ROUTE);
          setRouteStatus('error');
          setRouteError(error instanceof Error ? error.message : 'Unable to calculate route.');
        }
      }
    }

    void runRouteRequest();

    return () => {
      cancelled = true;
    };
  }, [routeableStops]);

  useEffect(() => {
    if (!routeSummary.geometry || routeableStops.length < 2) {
      return;
    }

    fitMapToCoordinates(
      mapRef.current,
      routeableStops.map((stop) => stop.coordinates),
    );
  }, [routeSummary.geometry, routeableStops]);

  function focusCoordinates(coordinates: [number, number], zoom = 5.8) {
    mapRef.current?.flyTo({
      center: coordinates,
      zoom,
      duration: 900,
    });
  }

  function updatePanelLayout(id: PanelId, layout: PanelLayout) {
    setPanelLayouts((current) => reconcilePanelLayouts({ ...current, [id]: layout }, id));
  }

  function setStartFromSearch(result: SearchResult) {
    const nextStart = createStartStop({
      label: result.label,
      coordinates: result.coordinates,
      source: 'search',
    });

    setRouteStops((current) => [nextStart, ...current.filter((stop) => stop.kind !== 'start')]);
    setSearchQuery(result.label);
    setSearchResults([]);
    setRoutePanelOpen(true);
    setMapMode('inspect');
    focusCoordinates(result.coordinates);
  }

  function addCityStopFromSearch(result: SearchResult) {
    if (!startStop) {
      return;
    }

    setRouteStops((current) => [...normalizeRouteStops(current), createCityStop(result)]);
    setSearchQuery(result.label);
    setSearchResults([]);
    setRoutePanelOpen(true);
    setMapMode('inspect');
    focusCoordinates(result.coordinates);
  }

  async function inspectStateAtCoordinates(coordinates: [number, number]) {
    setStateStatus('loading');
    setStateError(null);

    try {
      const nextState = await reverseLookupState(coordinates);
      setSelectedState(nextState);
      setStateStatus('idle');
      if (!nextState) {
        setStateError('No state-level park data is available for that location.');
      }
    } catch (error) {
      setSelectedState(null);
      setStateStatus('error');
      setStateError(error instanceof Error ? error.message : 'Unable to inspect the clicked state.');
    }
  }

  function handleMapClick(event: MapMouseEvent) {
    if ((event.originalEvent.target as HTMLElement | null)?.closest('.maplibregl-marker, .maplibregl-popup')) {
      return;
    }

    const coordinates: [number, number] = [event.lngLat.lng, event.lngLat.lat];
    if (mapMode === 'inspect') {
      void inspectStateAtCoordinates(coordinates);
      return;
    }

    const nextStart = createStartStop({
      label: `Pinned start (${event.lngLat.lat.toFixed(3)}, ${event.lngLat.lng.toFixed(3)})`,
      coordinates,
      source: 'map_click',
    });

    setRouteStops((current) => [nextStart, ...current.filter((stop) => stop.kind !== 'start')]);
    setRoutePanelOpen(true);
    setMapMode('inspect');
    focusCoordinates(nextStart.coordinates, 6.1);
  }

  function isParkSelected(parkId: string): boolean {
    return routeParkIds.has(parkId);
  }

  function togglePark(park: Park) {
    setRouteStops((current) => {
      const normalized = normalizeRouteStops(current);
      const exists = normalized.some((stop) => stop.kind === 'park' && stop.parkId === park.id);
      if (exists) {
        return normalized.filter((stop) => !(stop.kind === 'park' && stop.parkId === park.id));
      }

      return [...normalized, createParkStop(park)];
    });
  }

  function removeRouteStop(stopId: string) {
    setRouteStops((current) => current.filter((stop) => stop.id !== stopId));
  }

  function moveRouteStop(index: number, direction: -1 | 1) {
    setRouteStops((current) => {
      const normalized = normalizeRouteStops(current);
      const firstMovableIndex = normalized[0]?.kind === 'start' ? 1 : 0;
      const nextIndex = index + direction;
      if (index < firstMovableIndex || nextIndex < firstMovableIndex || nextIndex >= normalized.length) {
        return current;
      }

      const next = [...normalized];
      const [stop] = next.splice(index, 1);
      next.splice(nextIndex, 0, stop);
      return next;
    });
  }

  async function runSearch(query: string) {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      setSearchResults([]);
      setSearchStatus('idle');
      setSearchedQuery('');
      return;
    }

    const requestId = ++searchRequestIdRef.current;
    setSearchStatus('loading');

    try {
      const results = await searchPlaces(trimmedQuery);
      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      setSearchResults(results);
      setSearchStatus('idle');
      setSearchedQuery(trimmedQuery);
    } catch {
      if (requestId !== searchRequestIdRef.current) {
        return;
      }

      setSearchResults([]);
      setSearchStatus('error');
      setSearchedQuery(trimmedQuery);
    }
  }

  async function handleSearchSubmit() {
    await runSearch(searchQuery);
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleSearchSubmit();
    }
  }

  function handleParkMarkerClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    parkId: string,
    coordinates: [number, number],
  ) {
    event.stopPropagation();
    setActiveParkId(parkId);
    setRoutePanelOpen(true);
    focusCoordinates(coordinates, 5.8);
  }

  function handleRouteStopMarkerClick(event: ReactMouseEvent<HTMLButtonElement>, stop: RouteStop) {
    event.stopPropagation();
    if (stop.kind === 'park') {
      setActiveParkId(stop.parkId);
    } else {
      setActiveParkId(null);
    }
    setRoutePanelOpen(true);
    focusCoordinates(stop.coordinates, stop.kind === 'city' ? 6.2 : 5.8);
  }

  function handleQuickPick(park: Park) {
    setActiveParkId(park.id);
    if (!isParkSelected(park.id)) {
      togglePark(park);
    }
    setRoutePanelOpen(true);
    focusCoordinates(park.coordinates, 5.5);
  }

  function handleFrameRoute() {
    fitMapToCoordinates(mapRef.current, mappableRouteCoordinates);
  }

  const routeStateLabel =
    routeStatus === 'error' ? 'ROUTE FAIL' : routeStatus === 'loading' ? 'SOLVING' : 'NOMINAL';
  const currentStartMode = startStop ? (startStop.source === 'search' ? 'SEARCH LOCK' : 'MANUAL PIN') : 'UNSET';
  const visibleParkCountLabel = parkFilterQuery.trim() ? `${filteredParks.length} MATCHES` : `${parks.length} PARKS`;
  const inspectorCountLabel = selectedState ? `${stateParks.length} PARKS IN ${selectedState.name.toUpperCase()}` : 'STATE INSPECT';

  return (
    <div className="console-shell">
      <section className="console-map-shell">
        <Map
          ref={mapRef}
          initialViewState={DEFAULT_VIEW}
          mapStyle={SATELLITE_STYLE}
          onClick={handleMapClick}
        >
          <NavigationControl position="bottom-right" />

          <Source id="minor-grid" type="geojson" data={MINOR_GRID}>
            <Layer
              id="minor-grid-line"
              type="line"
              paint={{
                'line-color': '#20F0FF',
                'line-width': 1,
                'line-opacity': 0.07,
              }}
            />
          </Source>

          <Source id="major-grid" type="geojson" data={MAJOR_GRID}>
            <Layer
              id="major-grid-line"
              type="line"
              paint={{
                'line-color': '#20F0FF',
                'line-width': 1.3,
                'line-opacity': 0.14,
              }}
            />
          </Source>

          <Source id="states" type="geojson" data={US_STATES_GEOJSON_URL}>
            <Layer
              id="state-fill"
              type="fill"
              paint={{
                'fill-color': '#06160e',
                'fill-opacity': 0.04,
              }}
            />
            <Layer
              id="state-outline"
              type="line"
              paint={{
                'line-color': '#d4e7c8',
                'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.8, 6, 1.8],
                'line-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.28, 6, 0.72],
              }}
            />
            {selectedState ? (
              <Layer
                id="state-fill-active"
                type="fill"
                filter={['==', ['get', 'name'], selectedState.name]}
                paint={{
                  'fill-color': '#163b20',
                  'fill-opacity': 0.22,
                }}
              />
            ) : null}
            {selectedState ? (
              <Layer
                id="state-outline-active"
                type="line"
                filter={['==', ['get', 'name'], selectedState.name]}
                paint={{
                  'line-color': '#f1ff9a',
                  'line-width': ['interpolate', ['linear'], ['zoom'], 3, 1.4, 6, 3.2],
                  'line-opacity': 0.95,
                }}
              />
            ) : null}
          </Source>

          <Source id="state-label-points" type="geojson" data={stateLabelPoints}>
            <Layer
              id="state-labels"
              type="symbol"
              minzoom={3}
              layout={{
                'text-field': ['get', 'name'],
                'text-font': ['Open Sans Semibold', 'Arial Unicode MS Bold'],
                'text-size': ['interpolate', ['linear'], ['zoom'], 3, 10, 5, 14],
                'text-letter-spacing': 0.08,
                'text-max-width': 8,
                'text-transform': 'uppercase',
              }}
              paint={{
                'text-color': '#f5fee3',
                'text-halo-color': 'rgba(4, 11, 7, 0.86)',
                'text-halo-width': 1.6,
                'text-opacity': ['interpolate', ['linear'], ['zoom'], 3, 0.24, 4, 0.76, 5, 0.92],
              }}
            />
          </Source>

          {startStop ? (
            <Marker longitude={startStop.coordinates[0]} latitude={startStop.coordinates[1]}>
              <button type="button" className="marker marker--start" aria-label="Trip starting point">
                START
              </button>
            </Marker>
          ) : null}

          {inactiveFeaturedParks.map((park) => (
            <Marker key={`featured-${park.id}`} longitude={park.coordinates[0]} latitude={park.coordinates[1]}>
              <button
                type="button"
                className="marker marker--featured"
                onClick={(event) => handleParkMarkerClick(event, park.id, park.coordinates)}
                aria-label={`Featured park ${park.name}`}
              >
                {park.parkCode.toUpperCase()}
              </button>
            </Marker>
          ))}

          {cityRouteStops.map((stop) => (
            <Marker key={stop.id} longitude={stop.coordinates[0]} latitude={stop.coordinates[1]}>
              <button
                type="button"
                className="marker marker--city"
                onClick={(event) => handleRouteStopMarkerClick(event, stop)}
                aria-label={`${stop.label} city stop`}
              >
                <span className="marker__flag">CITY</span>
                <span>{String(routeMarkerOrder.get(stop.id) ?? 0).padStart(2, '0')}</span>
              </button>
            </Marker>
          ))}

          {parkRouteStops.filter((stop) => hasValidCoordinates(stop.coordinates)).map((stop) => (
            <Marker key={stop.id} longitude={stop.coordinates[0]} latitude={stop.coordinates[1]}>
              <button
                type="button"
                className="marker marker--selected"
                onClick={(event) => handleRouteStopMarkerClick(event, stop)}
                aria-label={`${stop.label} national park route stop`}
              >
                <span className="marker__flag">⛺</span>
                <span>{String(routeMarkerOrder.get(stop.id) ?? 0).padStart(2, '0')}</span>
              </button>
            </Marker>
          ))}

          {routeFeature ? (
            <Source id="route" type="geojson" data={routeFeature}>
              <Layer
                id="route-line-glow"
                type="line"
                paint={{
                  'line-color': '#20F0FF',
                  'line-width': 8,
                  'line-opacity': 0.24,
                }}
              />
              <Layer
                id="route-line"
                type="line"
                paint={{
                  'line-color': '#FF9830',
                  'line-width': 4,
                  'line-opacity': 0.96,
                  'line-blur': 0.45,
                }}
              />
            </Source>
          ) : null}

          {activePark ? (
            <Popup
              longitude={activePark.coordinates[0]}
              latitude={activePark.coordinates[1]}
              closeButton={true}
              closeOnClick={false}
              onClose={() => setActiveParkId(null)}
              maxWidth="320px"
            >
              <div className="popup-card">
                <span className="popup-card__eyebrow">{activePark.designation}</span>
                <strong>{activePark.name}</strong>
                <span>{activePark.state}</span>
                <p>{activePark.description}</p>
                <div className="popup-card__actions">
                  <button type="button" className="nerv-btn" onClick={() => togglePark(activePark)}>
                    {isParkSelected(activePark.id) ? 'Remove From Route' : 'Add To Route'}
                  </button>
                  <a href={activePark.websiteUrl} target="_blank" rel="noreferrer">
                    Open official park page
                  </a>
                </div>
              </div>
            </Popup>
          ) : null}
        </Map>

        <div className="map-wash" />
        <div className="measurement-overlay console-grid-overlay" />
        <div className="panel-toggle-bar">
          <button type="button" className={`panel-toggle ${plannerPanelOpen ? 'panel-toggle--active' : ''}`} onClick={() => setPlannerPanelOpen((value) => !value)}>
            Planner
          </button>
          <button type="button" className={`panel-toggle ${routePanelOpen ? 'panel-toggle--active' : ''}`} onClick={() => setRoutePanelOpen((value) => !value)}>
            Route
          </button>
          <button
            type="button"
            className={`panel-toggle ${catalogPanelVisible ? 'panel-toggle--active' : ''}`}
            onClick={() => setCatalogPanelVisible((value) => !value)}
          >
            State/Index
          </button>
          <button
            type="button"
            className={`panel-toggle ${featuredPanelOpen ? 'panel-toggle--active' : ''}`}
            onClick={() => setFeaturedPanelOpen((value) => !value)}
          >
            Featured
          </button>
        </div>

        {plannerPanelOpen ? (
          <FloatingPanel
            title="Planner"
            className="command-card"
            accent="orange"
            layout={panelLayouts.planner}
            onChange={(layout) => updatePanelLayout('planner', layout)}
          >
            <p className="planner-lede">Pick a start location, inspect the current state, then manage the route.</p>

            <div className="mini-facts mini-facts--planner">
              <div className="fact-chip">
                <span className="data-label">Start</span>
                <strong>{startStop ? currentStartMode : 'Not set'}</strong>
              </div>
              <div className="fact-chip">
                <span className="data-label">Current state</span>
                <strong>{selectedState?.name ?? 'Click to inspect'}</strong>
              </div>
            </div>

            <div className="input-stack">
              <label className="console-input console-input--search">
                <span className="data-label">Search start point</span>
                <div className="console-input__row">
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={handleSearchKeyDown}
                    placeholder="Search city, airport, or landmark"
                  />
                  <button type="button" className="nerv-btn primary" onClick={() => void handleSearchSubmit()}>
                    Search
                  </button>
                </div>

                {searchStatus === 'loading' ? <p className="status-copy search-feedback">Searching for matching start locations...</p> : null}

                {searchResults.length > 0 ? (
                  <div className="search-results search-results--popover">
                    {searchResults.map((result) => (
                      <article key={`${result.label}-${result.coordinates.join(',')}`} className="search-result">
                        <div className="search-result__copy">{result.label}</div>
                        <div className="search-result__actions">
                          <button type="button" className="nerv-btn primary" onClick={() => setStartFromSearch(result)}>
                            Set Start
                          </button>
                          <button
                            type="button"
                            className="nerv-btn"
                            disabled={!startStop}
                            onClick={() => addCityStopFromSearch(result)}
                          >
                            Add City
                          </button>
                        </div>
                      </article>
                    ))}
                    {!startStop ? (
                      <p className="status-copy search-results__hint">Set a start first, then search again to add cities as intermediate stops.</p>
                    ) : null}
                  </div>
                ) : null}

                {searchStatus === 'error' ? (
                  <p className="status-copy status-copy--alert search-feedback">
                    Search failed. Arm pin mode if you want to drop a start point directly on the map.
                  </p>
                ) : null}

                {searchedQuery && searchStatus === 'idle' && searchResults.length === 0 ? (
                  <p className="status-copy search-feedback">No matching start locations found for "{searchedQuery}".</p>
                ) : null}
              </label>

              <div className="command-card__actions">
                <button type="button" className="nerv-btn" onClick={handleFrameRoute}>
                  Frame Route
                </button>
                <button
                  type="button"
                  className={`nerv-btn ${routePanelOpen ? 'primary' : ''}`}
                  onClick={() => setRoutePanelOpen((value) => !value)}
                >
                  {routePanelOpen ? 'Hide Route' : 'Show Route'}
                </button>
                <button
                  type="button"
                  className={`nerv-btn ${mapMode === 'pin-start' ? 'primary' : ''}`}
                  onClick={() => setMapMode((value) => (value === 'pin-start' ? 'inspect' : 'pin-start'))}
                >
                  {mapMode === 'pin-start' ? 'Cancel Pin Mode' : 'Pin Start On Map'}
                </button>
                <button
                  type="button"
                  className={`nerv-btn ${catalogPanelOpen ? 'primary' : ''}`}
                  onClick={() => setCatalogPanelOpen((value) => !value)}
                >
                  {catalogPanelOpen ? 'Close Park Index' : 'Open Park Index'}
                </button>
              </div>
            </div>

            {parksError ? <p className="status-copy status-copy--alert">{parksError}</p> : null}
            {stateError ? <p className="status-copy status-copy--alert">{stateError}</p> : null}

            <div className="current-lock">
              <span className="data-label">Current start</span>
              <strong>{startStop?.label ?? 'No origin pinned'}</strong>
              <span>Map click inspects states unless pin mode is armed.</span>
            </div>
          </FloatingPanel>
        ) : null}

        {routePanelOpen ? (
          <FloatingPanel
            title="Route"
            className="route-panel"
            accent="cyan"
            layout={panelLayouts.route}
            onChange={(layout) => updatePanelLayout('route', layout)}
          >
            <div className="panel-head panel-head--route">
              <div>
                <span className="data-label">Current route</span>
                <h2 className="route-headline">{plannedStopCount > 0 ? `${plannedStopCount} total stops` : 'No stops yet'}</h2>
              </div>
              <span className={`status-pill ${routeStatus === 'error' ? 'status-pill--alert' : routeStatus === 'loading' ? 'status-pill--orange' : ''}`}>
                {routeStateLabel}
              </span>
            </div>

            <div className="summary-grid">
              <article>
                <span>Total Miles</span>
                <strong>{routeSummary.totalDistanceMiles > 0 ? formatMiles(routeSummary.totalDistanceMiles) : '--'}</strong>
              </article>
              <article>
                <span>Drive Time</span>
                <strong>{routeSummary.totalDurationHours > 0 ? formatHours(routeSummary.totalDurationHours) : '--'}</strong>
              </article>
              <article>
                <span>Stops</span>
                <strong>{String(plannedStopCount).padStart(2, '0')}</strong>
              </article>
            </div>

            <div className="route-tags">
              {startStop ? <span className="tag-chip tag-chip--start">Start</span> : null}
              {travelStops.slice(0, 4).map((stop) => (
                <span key={stop.id} className={`tag-chip ${stop.kind === 'park' ? 'tag-chip--park' : 'tag-chip--city'}`}>
                  {stop.kind === 'park' ? '⛺ ' : 'City '}
                  {stop.label}
                </span>
              ))}
              {travelStops.length > 4 ? <span className="tag-chip">+{travelStops.length - 4} more</span> : null}
            </div>

            {!startStop ? (
              <div className="alert-block">
                <span className="data-label">Origin required</span>
                <strong>Set a start point before route calculation begins.</strong>
              </div>
            ) : null}

            {hasPendingRouteStopData ? (
              <div className="alert-block">
                <span className="data-label">Syncing stops</span>
                <strong>Waiting for park stop details to finish loading before routing.</strong>
              </div>
            ) : null}

            {routeError ? (
              <div className="alert-block alert-block--danger">
                <span className="data-label">Routing error</span>
                <strong>{routeError}</strong>
              </div>
            ) : null}

            <div className="route-section route-section--compact">
              <button
                type="button"
                className="nerv-btn"
                onClick={() => setRouteDetailsOpen((value) => !value)}
              >
                {routeDetailsOpen ? 'Hide route details' : 'Show route details'}
              </button>

              {routeDetailsOpen ? (
                hydratedRouteStops.length > 0 ? (
                  <div className="route-detail">
                    <ol className="route-list">
                      {hydratedRouteStops.map((stop, index) => {
                        const isStart = stop.kind === 'start';
                        const canMoveUp = !isStart && index > (startStop ? 1 : 0);
                        const canMoveDown = !isStart && index < hydratedRouteStops.length - 1;
                        return (
                          <li key={stop.id} className={`route-stop route-stop--${stop.kind}`}>
                            <div className="route-stop__meta">
                              <span className="route-stop__index">
                                {isStart ? 'ST' : String(routeStopOrder.get(stop.id) ?? 0).padStart(2, '0')}
                              </span>
                              <div className="route-stop__copy">
                                <strong>{stop.label}</strong>
                                <span>{getRouteStopMeta(stop)}</span>
                              </div>
                            </div>
                            <div className="route-stop__actions">
                              <span className={`route-stop__badge route-stop__badge--${stop.kind}`}>{getRouteStopKindLabel(stop)}</span>
                              {!isStart ? (
                                <>
                                  <button type="button" className="nerv-btn" disabled={!canMoveUp} onClick={() => moveRouteStop(index, -1)}>
                                    Up
                                  </button>
                                  <button type="button" className="nerv-btn" disabled={!canMoveDown} onClick={() => moveRouteStop(index, 1)}>
                                    Down
                                  </button>
                                  <button type="button" className="nerv-btn danger" onClick={() => removeRouteStop(stop.id)}>
                                    Remove
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </li>
                        );
                      })}
                    </ol>

                    {routeSummary.legs.length > 0 ? (
                      <div className="leg-list">
                        {routeSummary.legs.map((leg) => (
                          <article key={`${leg.from}-${leg.to}`} className="leg-card">
                            <strong>
                              {leg.from} / {leg.to}
                            </strong>
                            <span>
                              {formatMiles(leg.distanceMiles)} // {formatHours(leg.durationHours)}
                            </span>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <p className="status-copy">Route segments will appear here after routing finishes.</p>
                    )}
                  </div>
                ) : (
                  <p className="status-copy">Set a start, then add city or park stops to build the route.</p>
                )
              ) : null}
            </div>
          </FloatingPanel>
        ) : null}

        {catalogPanelVisible && (catalogPanelOpen || selectedState) ? (
          <FloatingPanel
            title={catalogPanelOpen ? 'Park Index' : 'State Parks'}
            className="catalog-panel"
            accent="orange"
            layout={panelLayouts.catalog}
            onChange={(layout) => updatePanelLayout('catalog', layout)}
          >
            {catalogPanelOpen ? (
              <>
                <div className="panel-head">
                  <div>
                    <span className="data-label">Park index</span>
                    <h2 className="panel-title">Browse all parks</h2>
                  </div>
                  <span className="status-pill">{visibleParkCountLabel}</span>
                </div>

                <label className="console-input">
                  <span className="data-label">Filter parks</span>
                  <input
                    value={parkFilterQuery}
                    onChange={(event) => setParkFilterQuery(event.target.value)}
                    placeholder="Utah, Zion, Yellowstone, Alaska"
                  />
                </label>

                <div className="catalog-list">
                  {catalogPreview.map((park) => {
                    const isSelected = isParkSelected(park.id);
                    return (
                      <button
                        key={park.id}
                        type="button"
                        className={`catalog-item ${isSelected ? 'catalog-item--selected' : ''}`}
                        onClick={() => {
                          setActiveParkId(park.id);
                          togglePark(park);
                          focusCoordinates(park.coordinates, 5.4);
                        }}
                      >
                        <span className="catalog-item__code">{park.parkCode.toUpperCase()}</span>
                        <div className="catalog-item__body">
                          <strong>{park.name}</strong>
                          <span>{park.state}</span>
                        </div>
                        <span className="catalog-item__status">{isSelected ? 'QUEUED' : 'ADD'}</span>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="panel-head">
                  <div>
                    <span className="data-label">State parks</span>
                    <h2 className="panel-title">{selectedState?.name ?? 'State inspection'}</h2>
                  </div>
                  <span className="status-pill">{inspectorCountLabel}</span>
                </div>

                <p className="status-copy">
                  {selectedState?.label ?? 'Click a state on the map to surface its National Park Service sites.'}
                </p>

                <div className="catalog-list">
                  {stateParks.length > 0 ? (
                    stateParks.map((park) => {
                      const isSelected = isParkSelected(park.id);
                      return (
                        <button
                          key={park.id}
                          type="button"
                          className={`catalog-item ${isSelected ? 'catalog-item--selected' : ''}`}
                          onClick={() => {
                            setActiveParkId(park.id);
                            if (!isSelected) {
                              togglePark(park);
                            }
                            focusCoordinates(park.coordinates, 5.4);
                          }}
                        >
                          <span className="catalog-item__code">{park.parkCode.toUpperCase()}</span>
                          <div className="catalog-item__body">
                            <strong>{park.name}</strong>
                            <span>{park.state}</span>
                          </div>
                          <span className="catalog-item__status">{isSelected ? 'QUEUED' : 'ADD'}</span>
                        </button>
                      );
                    })
                  ) : (
                    <p className="status-copy">No national parks matched that clicked state.</p>
                  )}
                </div>
              </>
            )}
          </FloatingPanel>
        ) : null}

        {featuredPanelOpen ? (
          <FloatingPanel
            title="Featured Parks"
            className="featured-panel"
            accent="cyan"
            layout={panelLayouts.featured}
            onChange={(layout) => updatePanelLayout('featured', layout)}
          >
            <div className="panel-head">
              <div>
                <span className="data-label">Featured parks</span>
                <h2 className="panel-title">Quick add the major parks</h2>
              </div>
              <span className="status-pill">QUICK ADD</span>
            </div>

            <div className="featured-rail">
              {quickPickParks.map((park) => {
                const isSelected = isParkSelected(park.id);
                const cardStyle = park.imageUrl
                  ? {
                      backgroundImage: `linear-gradient(180deg, rgba(2,8,18,0.12), rgba(2,8,18,0.92)), url(${park.imageUrl})`,
                    }
                  : {
                      background:
                        `linear-gradient(180deg, rgba(2,8,18,0.12), rgba(2,8,18,0.92)), linear-gradient(135deg, ${park.heroColor}, #0f1630 72%)`,
                    };

                return (
                  <button
                    key={park.id}
                    type="button"
                    className={`featured-card ${isSelected ? 'featured-card--selected' : ''}`}
                    style={cardStyle as CSSProperties}
                    onClick={() => handleQuickPick(park)}
                  >
                    <span className="featured-card__eyebrow">{park.designation}</span>
                    <strong>{park.name}</strong>
                    <span>{park.state}</span>
                    <span className="featured-card__status">{isSelected ? 'IN ROUTE' : 'ADD TO ROUTE'}</span>
                  </button>
                );
              })}
            </div>
          </FloatingPanel>
        ) : null}
      </section>
    </div>
  );
}
