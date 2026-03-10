export type Park = {
  id: string;
  name: string;
  state: string;
  description: string;
  designation: string;
  parkCode: string;
  websiteUrl: string;
  imageUrl?: string;
  heroColor: string;
  coordinates: [number, number];
};

export type StartPointSource = 'search' | 'map_click';

export type StartPoint = {
  label: string;
  coordinates: [number, number];
  source: StartPointSource;
};

export type RouteStopBase = {
  id: string;
  label: string;
  coordinates: [number, number];
};

export type StartRouteStop = RouteStopBase & {
  kind: 'start';
  source: StartPointSource;
};

export type CityRouteStop = RouteStopBase & {
  kind: 'city';
};

export type ParkRouteStop = RouteStopBase & {
  kind: 'park';
  parkCode: string;
  parkId: string;
  state: string;
};

export type RouteStop = StartRouteStop | CityRouteStop | ParkRouteStop;

export type TripState = {
  routeStops: RouteStop[];
};

export type RouteLegSummary = {
  from: string;
  to: string;
  distanceMiles: number;
  durationHours: number;
};

export type RouteSummary = {
  geometry: GeoJSON.LineString | null;
  totalDistanceMiles: number;
  totalDurationHours: number;
  legs: RouteLegSummary[];
  provider: string;
};

export type SearchResult = {
  label: string;
  coordinates: [number, number];
};
