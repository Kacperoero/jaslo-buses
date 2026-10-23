import { Injectable, computed, signal } from '@angular/core';

/** A start or end point of a remembered route. */
export interface SavedPoint {
  lat: number;
  lng: number;
  name: string;
  isStop?: boolean;
  stopId?: string;
}

export interface RecentRoute {
  from: SavedPoint;
  to: SavedPoint;
}

const STORAGE_KEY = 'jakdojade-jaslo:favorites:v1';
const MAX_RECENT_STOPS = 6;
const MAX_RECENT_ROUTES = 5;

interface StoredState {
  favoriteStopIds: string[];
  recentStopIds: string[];
  recentRoutes: RecentRoute[];
}

/**
 * Favourite stops, recently viewed stops and recent routes of this user.
 * Kept in the browser (localStorage) – it is per device, and the app works without it
 * (e.g. in private mode the lists just start empty each time).
 */
@Injectable({
  providedIn: 'root'
})
export class FavoritesService {
  private state = signal<StoredState>(load());

  readonly favoriteStopIds = computed(() => this.state().favoriteStopIds);
  readonly recentStopIds = computed(() => this.state().recentStopIds);
  readonly recentRoutes = computed(() => this.state().recentRoutes);
  private readonly favoriteSet = computed(() => new Set(this.state().favoriteStopIds));

  isFavorite(stopId: string): boolean {
    return this.favoriteSet().has(stopId);
  }

  /** Adds or removes a favourite; returns whether the stop is a favourite now. */
  toggleFavorite(stopId: string): boolean {
    const nowFavorite = !this.isFavorite(stopId);
    this.update(s => ({
      ...s,
      favoriteStopIds: nowFavorite
        ? [...s.favoriteStopIds, stopId]
        : s.favoriteStopIds.filter(id => id !== stopId)
    }));
    return nowFavorite;
  }

  /** Remembers a viewed stop (most recent first, no duplicates). */
  addRecentStop(stopId: string): void {
    this.update(s => ({
      ...s,
      recentStopIds: [stopId, ...s.recentStopIds.filter(id => id !== stopId)].slice(0, MAX_RECENT_STOPS)
    }));
  }

  /** Remembers a searched route (most recent first, no duplicates). */
  addRecentRoute(from: SavedPoint, to: SavedPoint): void {
    const route: RecentRoute = { from: pick(from), to: pick(to) };
    const key = routeKey(route);
    this.update(s => ({
      ...s,
      recentRoutes: [route, ...s.recentRoutes.filter(r => routeKey(r) !== key)].slice(0, MAX_RECENT_ROUTES)
    }));
  }

  removeRecentRoute(route: RecentRoute): void {
    const key = routeKey(route);
    this.update(s => ({ ...s, recentRoutes: s.recentRoutes.filter(r => routeKey(r) !== key) }));
  }

  private update(change: (s: StoredState) => StoredState): void {
    const next = change(this.state());
    this.state.set(next);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Storage blocked or full – keep the lists for this session only
    }
  }
}

function load(): StoredState {
  const empty: StoredState = { favoriteStopIds: [], recentStopIds: [], recentRoutes: [] };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    return {
      favoriteStopIds: Array.isArray(parsed.favoriteStopIds) ? parsed.favoriteStopIds.filter(isString) : [],
      recentStopIds: Array.isArray(parsed.recentStopIds) ? parsed.recentStopIds.filter(isString) : [],
      recentRoutes: Array.isArray(parsed.recentRoutes) ? parsed.recentRoutes.filter(isRoute) : []
    };
  } catch {
    return empty;
  }
}

/** Only the fields we need – keeps storage small and free of anything else on the object. */
function pick(p: SavedPoint): SavedPoint {
  return p.isStop && p.stopId
    ? { lat: p.lat, lng: p.lng, name: p.name, isStop: true, stopId: p.stopId }
    : { lat: p.lat, lng: p.lng, name: p.name };
}

function routeKey(r: RecentRoute): string {
  const k = (p: SavedPoint) => p.stopId ?? `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  return `${k(r.from)}>${k(r.to)}`;
}

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isPoint(v: unknown): v is SavedPoint {
  const p = v as SavedPoint;
  return !!p && typeof p.lat === 'number' && typeof p.lng === 'number' && typeof p.name === 'string';
}

function isRoute(v: unknown): v is RecentRoute {
  const r = v as RecentRoute;
  return !!r && isPoint(r.from) && isPoint(r.to);
}
