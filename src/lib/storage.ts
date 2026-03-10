import type { Park, TripState } from '../types';

const TRIP_STORAGE_KEY = 'america-trip-planner-state';
const PARK_CATALOG_STORAGE_KEY = 'america-trip-planner-park-catalog';
const NPS_API_KEY_STORAGE_KEY = 'america-trip-planner-nps-api-key';

export function loadTripState(): TripState | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const raw = window.localStorage.getItem(TRIP_STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as TripState;
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
