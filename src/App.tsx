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
import type { Park, RouteSummary, SearchResult, StartPoint, TripState } from './types';

const DEFAULT_VIEW = {
  longitude: -98.5795,
  latitude: 39.8283,
  zoom: 3.45,
};

const DEFAULT_SELECTED_PARK_IDS = ['acad', 'grsm', 'shen'];
const FEATURED_PARK_IDS = ['yell', 'yose', 'grca', 'zion', 'grsm', 'glac', 'olym', 'acad', 'romo', 'arch', 'ever', 'dena'];
const GEOCODING_API_URL = import.meta.env.VITE_GEOCODING_API_URL?.trim();
const GEOCODING_API_KEY = import.meta.env.VITE_GEOCODING_API_KEY?.trim();
const ROUTING_API_URL =
  import.meta.env.VITE_ROUTING_API_URL?.trim() ?? 'https://router.project-osrm.org/route/v1/driving';
const ENV_NPS_API_KEY = import.meta.env.VITE_NPS_API_KEY?.trim() ?? '';
const PANEL_LAYOUT_STORAGE_KEY = 'america-trip-panel-layouts';
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

async function fetchRoute(startPoint: StartPoint, parks: Park[]): Promise<RouteSummary> {
  if (parks.length === 0) {
    return EMPTY_ROUTE;
  }

  const waypoints = [startPoint.coordinates, ...parks.map((park) => park.coordinates)];
  const coordinates = waypoints.map(([lng, lat]) => `${lng},${lat}`).join(';');
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

  const labels = [startPoint.label, ...parks.map((park) => park.name)];
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

export default function App() {
  const initialStateRef = useRef<TripState | null>(loadTripState());
  const initialParkCatalogRef = useRef<Park[]>(loadParkCatalog());
  const initialApiKeyRef = useRef(loadNpsApiKey() || ENV_NPS_API_KEY);
  const mapRef = useRef<MapRef | null>(null);

  const [startPoint, setStartPoint] = useState<StartPoint | null>(
    initialStateRef.current?.startPoint ?? null,
  );
  const [selectedParkIds, setSelectedParkIds] = useState<string[]>(
    initialStateRef.current?.selectedParkIds ?? DEFAULT_SELECTED_PARK_IDS,
  );
  const [parks, setParks] = useState<Park[]>(initialParkCatalogRef.current);
  const [activeParkId, setActiveParkId] = useState<string | null>(null);
  const [apiKey] = useState(initialApiKeyRef.current);
  const [, setParksStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>(
    initialParkCatalogRef.current.length > 0 ? 'ready' : initialApiKeyRef.current ? 'loading' : 'idle',
  );
  const [catalogSource, setCatalogSource] = useState<'public' | 'developer' | 'cache'>(
    initialParkCatalogRef.current.length > 0 ? 'cache' : 'public',
  );
  const [parksError, setParksError] = useState<string | null>(null);
  const [parkFilterQuery, setParkFilterQuery] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [routeSummary, setRouteSummary] = useState<RouteSummary>(EMPTY_ROUTE);
  const [routeStatus, setRouteStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [routeError, setRouteError] = useState<string | null>(null);
  const [selectedState, setSelectedState] = useState<StateSelection | null>(null);
  const [, setStateStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [stateError, setStateError] = useState<string | null>(null);
  const [mapMode, setMapMode] = useState<'inspect' | 'pin-start'>('inspect');
  const [catalogPanelOpen, setCatalogPanelOpen] = useState(false);
  const [routePanelOpen, setRoutePanelOpen] = useState(true);
  const [routeDetailsOpen, setRouteDetailsOpen] = useState(false);
  const [panelLayouts, setPanelLayouts] = useState<PanelLayouts>(() => loadPanelLayouts());

  const parksById = useMemo(
    () => new globalThis.Map(parks.map((park) => [park.id, park])),
    [parks],
  );
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
    () => selectedParkIds.map((id) => parksById.get(id)).filter(Boolean) as Park[],
    [parksById, selectedParkIds],
  );
  const featuredParks = useMemo(
    () => FEATURED_PARK_IDS.map((id) => parksById.get(id)).filter(Boolean) as Park[],
    [parksById],
  );
  const quickPickParks = featuredParks.length > 0 ? featuredParks : parks.slice(0, 12);
  const selectedParkCount = selectedParks.length;
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
          ...parks.filter((park) => !selectedParkIds.includes(park.id)).slice(0, 24),
        ]);

    return base.slice(0, 24);
  }, [filteredParks, parkFilterQuery, parks, quickPickParks, selectedParkIds, selectedParks]);
  const inactiveFeaturedParks = useMemo(
    () => quickPickParks.filter((park) => !selectedParkIds.includes(park.id)),
    [quickPickParks, selectedParkIds],
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

  useEffect(() => {
    saveTripState({
      startPoint,
      selectedParkIds,
    });
  }, [selectedParkIds, startPoint]);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    window.localStorage.setItem(PANEL_LAYOUT_STORAGE_KEY, JSON.stringify(panelLayouts));
  }, [panelLayouts]);

  useEffect(() => {
    function handleViewportResize() {
      setPanelLayouts((current) => ({
        planner: clampPanelLayout(current.planner),
        route: clampPanelLayout(current.route),
        catalog: clampPanelLayout(current.catalog),
        featured: clampPanelLayout(current.featured),
      }));
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
  }, [apiKey]);

  useEffect(() => {
    if (parks.length === 0) {
      return;
    }

    setSelectedParkIds((current) => {
      const valid = current.filter((id) => parksById.has(id));
      if (valid.length > 0 || current.length === 0) {
        return valid;
      }

      return DEFAULT_SELECTED_PARK_IDS.filter((id) => parksById.has(id));
    });
  }, [parks.length, parksById]);

  useEffect(() => {
    if (activeParkId && !parksById.has(activeParkId)) {
      setActiveParkId(null);
    }
  }, [activeParkId, parksById]);

  useEffect(() => {
    if (!startPoint || selectedParks.length === 0) {
      setRouteSummary(EMPTY_ROUTE);
      setRouteStatus('idle');
      setRouteError(null);
      return;
    }

    let cancelled = false;
    const currentStart = startPoint;
    const currentParks = selectedParks;

    async function runRouteRequest() {
      setRouteStatus('loading');
      setRouteError(null);

      try {
        const summary = await fetchRoute(currentStart, currentParks);
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
  }, [selectedParks, startPoint]);

  useEffect(() => {
    if (!startPoint || selectedParks.length === 0 || !routeSummary.geometry) {
      return;
    }

    fitMapToCoordinates(mapRef.current, [startPoint.coordinates, ...selectedParks.map((park) => park.coordinates)]);
  }, [routeSummary.geometry, selectedParks, startPoint]);

  function focusCoordinates(coordinates: [number, number], zoom = 5.8) {
    mapRef.current?.flyTo({
      center: coordinates,
      zoom,
      duration: 900,
    });
  }

  function updatePanelLayout(id: PanelId, layout: PanelLayout) {
    setPanelLayouts((current) => ({
      ...current,
      [id]: layout,
    }));
  }

  function setStartFromSearch(result: SearchResult) {
    const nextStart: StartPoint = {
      label: result.label,
      coordinates: result.coordinates,
      source: 'search',
    };

    setStartPoint(nextStart);
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

    const nextStart: StartPoint = {
      label: `Pinned start (${event.lngLat.lat.toFixed(3)}, ${event.lngLat.lng.toFixed(3)})`,
      coordinates,
      source: 'map_click',
    };

    setStartPoint(nextStart);
    setRoutePanelOpen(true);
    setMapMode('inspect');
    focusCoordinates(nextStart.coordinates, 6.1);
  }

  function togglePark(id: string) {
    setSelectedParkIds((current) =>
      current.includes(id) ? current.filter((parkId) => parkId !== id) : [...current, id],
    );
  }

  function movePark(index: number, direction: -1 | 1) {
    setSelectedParkIds((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }

      const next = [...current];
      const [parkId] = next.splice(index, 1);
      next.splice(nextIndex, 0, parkId);
      return next;
    });
  }

  async function handleSearchSubmit() {
    if (!searchQuery.trim()) {
      return;
    }

    setSearchStatus('loading');
    try {
      const results = await searchPlaces(searchQuery);
      setSearchResults(results);
      setSearchStatus('idle');
    } catch {
      setSearchResults([]);
      setSearchStatus('error');
    }
  }

  function handleSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      void handleSearchSubmit();
    }
  }

  function handleMarkerClick(
    event: ReactMouseEvent<HTMLButtonElement>,
    parkId: string,
    coordinates: [number, number],
  ) {
    event.stopPropagation();
    setActiveParkId(parkId);
    setRoutePanelOpen(true);
    focusCoordinates(coordinates, 5.8);
  }

  function handleQuickPick(park: Park) {
    setActiveParkId(park.id);
    if (!selectedParkIds.includes(park.id)) {
      setSelectedParkIds((current) => [...current, park.id]);
    }
    setRoutePanelOpen(true);
    focusCoordinates(park.coordinates, 5.5);
  }

  function handleFrameRoute() {
    const points = [
      ...(startPoint ? [startPoint.coordinates] : []),
      ...selectedParks.map((park) => park.coordinates),
    ];

    fitMapToCoordinates(mapRef.current, points);
  }

  const catalogSourceLabel =
    catalogSource === 'developer'
      ? 'DEVELOPER FEED'
      : catalogSource === 'cache'
        ? 'LOCAL CACHE'
        : 'PUBLIC FIND A PARK';
  const routeStateLabel =
    routeStatus === 'error' ? 'ROUTE FAIL' : routeStatus === 'loading' ? 'SOLVING' : 'NOMINAL';
  const currentStartMode = startPoint ? (startPoint.source === 'search' ? 'SEARCH LOCK' : 'MANUAL PIN') : 'UNSET';
  const visibleParkCountLabel = parkFilterQuery.trim() ? `${filteredParks.length} MATCHES` : `${parks.length} PARKS`;
  const mapModeLabel = mapMode === 'inspect' ? 'STATE INSPECT' : 'PIN START';
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

          {startPoint ? (
            <Marker longitude={startPoint.coordinates[0]} latitude={startPoint.coordinates[1]}>
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
                onClick={(event) => handleMarkerClick(event, park.id, park.coordinates)}
                aria-label={`Featured park ${park.name}`}
              >
                {park.parkCode.toUpperCase()}
              </button>
            </Marker>
          ))}

          {selectedParks.map((park, index) => (
            <Marker key={park.id} longitude={park.coordinates[0]} latitude={park.coordinates[1]}>
              <button
                type="button"
                className="marker marker--selected"
                style={{ '--park-color': park.heroColor } as CSSProperties}
                onClick={(event) => handleMarkerClick(event, park.id, park.coordinates)}
                aria-label={`${park.name} national park`}
              >
                {String(index + 1).padStart(2, '0')}
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
                  <button type="button" className="nerv-btn" onClick={() => togglePark(activePark.id)}>
                    {selectedParkIds.includes(activePark.id) ? 'Remove From Route' : 'Add To Route'}
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
        <FloatingPanel
          title="Planner"
          className="command-card"
          accent="orange"
          layout={panelLayouts.planner}
          onChange={(layout) => updatePanelLayout('planner', layout)}
        >
          <div className="planner-header">
            <div>
              <p className="console-overline">Road trip planner</p>
              <h1>Plan your route across the parks.</h1>
              <p className="planner-subtitle">
                Search for a start point, inspect a state on the map, or pin a custom origin when you need one.
              </p>
            </div>
            <span className={`status-pill ${mapMode === 'pin-start' ? 'status-pill--orange' : ''}`}>{mapModeLabel}</span>
          </div>

          <div className="mini-facts">
            <div className="fact-chip">
              <span className="data-label">Start</span>
              <strong>{startPoint ? currentStartMode : 'Not set'}</strong>
            </div>
            <div className="fact-chip">
              <span className="data-label">State</span>
              <strong>{selectedState?.name ?? 'Click to inspect'}</strong>
            </div>
            <div className="fact-chip">
              <span className="data-label">Catalog</span>
              <strong>{catalogSourceLabel}</strong>
            </div>
          </div>

          <div className="input-stack">
            <label className="console-input">
              <span className="data-label">Lock start point</span>
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

          {searchStatus === 'error' ? (
            <p className="status-copy status-copy--alert">Search failed. Arm pin mode if you want to drop a start point directly on the map.</p>
          ) : null}

          {parksError ? <p className="status-copy status-copy--alert">{parksError}</p> : null}
          {stateError ? <p className="status-copy status-copy--alert">{stateError}</p> : null}

          {searchResults.length > 0 ? (
            <div className="search-results">
              {searchResults.map((result) => (
                <button
                  key={`${result.label}-${result.coordinates.join(',')}`}
                  type="button"
                  className="search-result"
                  onClick={() => setStartFromSearch(result)}
                >
                  {result.label}
                </button>
              ))}
            </div>
          ) : null}

          <div className="current-lock">
            <span className="data-label">Current start</span>
            <strong>{startPoint?.label ?? 'No origin pinned'}</strong>
            <span>Map click inspects states unless pin mode is armed.</span>
          </div>
        </FloatingPanel>

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
                <h2 className="route-headline">{selectedParkCount > 0 ? `${selectedParkCount} park stops` : 'No stops yet'}</h2>
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
                <strong>{String(selectedParkCount).padStart(2, '0')}</strong>
              </article>
            </div>

            <div className="route-tags">
              {startPoint ? <span className="tag-chip tag-chip--start">Start</span> : null}
              {selectedParks.slice(0, 4).map((park) => (
                <span key={park.id} className="tag-chip">
                  {park.name}
                </span>
              ))}
              {selectedParks.length > 4 ? <span className="tag-chip">+{selectedParks.length - 4} more</span> : null}
            </div>

            {!startPoint ? (
              <div className="alert-block">
                <span className="data-label">Origin required</span>
                <strong>Set a start point before route calculation begins.</strong>
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
                selectedParks.length > 0 ? (
                  <div className="route-detail">
                    <ol className="route-list">
                      {selectedParks.map((park, index) => (
                        <li key={park.id} className="route-stop">
                          <div className="route-stop__meta">
                            <span className="route-stop__index">{String(index + 1).padStart(2, '0')}</span>
                            <div className="route-stop__copy">
                              <strong>{park.name}</strong>
                              <span>{park.state}</span>
                            </div>
                          </div>
                          <div className="route-stop__actions">
                            <button type="button" className="nerv-btn" onClick={() => movePark(index, -1)}>
                              Up
                            </button>
                            <button type="button" className="nerv-btn" onClick={() => movePark(index, 1)}>
                              Down
                            </button>
                            <button type="button" className="nerv-btn danger" onClick={() => togglePark(park.id)}>
                              Remove
                            </button>
                          </div>
                        </li>
                      ))}
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
                  <p className="status-copy">Add parks from the featured row or park index to start building the route.</p>
                )
              ) : null}
            </div>
          </FloatingPanel>
        ) : null}

        {catalogPanelOpen || selectedState ? (
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
                    const isSelected = selectedParkIds.includes(park.id);
                    return (
                      <button
                        key={park.id}
                        type="button"
                        className={`catalog-item ${isSelected ? 'catalog-item--selected' : ''}`}
                        onClick={() => {
                          setActiveParkId(park.id);
                          togglePark(park.id);
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
                      const isSelected = selectedParkIds.includes(park.id);
                      return (
                        <button
                          key={park.id}
                          type="button"
                          className={`catalog-item ${isSelected ? 'catalog-item--selected' : ''}`}
                          onClick={() => {
                            setActiveParkId(park.id);
                            if (!isSelected) {
                              togglePark(park.id);
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
              const isSelected = selectedParkIds.includes(park.id);
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
      </section>
    </div>
  );
}
