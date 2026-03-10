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

export type TripState = {
  startPoint: StartPoint | null;
  selectedParkIds: string[];
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
