export type Position = number[];

export interface PointGeometry {
	type: 'Point';
	coordinates: Position;
}

export interface LineStringGeometry {
	type: 'LineString';
	coordinates: Position[];
}

export interface MultiLineStringGeometry {
	type: 'MultiLineString';
	coordinates: Position[][];
}

export interface GeoJsonGeometry {
	type: string;
	coordinates?: unknown;
	geometries?: GeoJsonGeometry[];
	[key: string]: unknown;
}

export interface GeoJsonFeature {
	type: 'Feature';
	geometry: GeoJsonGeometry | null;
	properties: Record<string, unknown> | null;
	[key: string]: unknown;
}

export interface FeatureCollection {
	type: 'FeatureCollection';
	features: GeoJsonFeature[];
	[key: string]: unknown;
}

export interface GisLogger {
	info: (payload: Record<string, unknown>) => void;
	warn: (payload: Record<string, unknown>) => void;
}

export interface RoutingThresholds {
	walkThresholdMeters?: number;
	driveShortThresholdMeters?: number;
}

export interface GisServiceConfig {
	geoapifyApiKey?: string;
	mapboxApiKey?: string;
	logger?: GisLogger;
	autocompleteLimit?: number;
	routing?: RoutingThresholds;
}

export type RouteMode = 'walk' | 'drive' | 'bicycle';

export interface Waypoint {
	lat: number;
	lon: number;
	[key: string]: unknown;
}

export interface AddressSuggestion {
	formatted?: string;
	lat?: number;
	lon?: number;
	housenumber?: string;
	street?: string;
	postcode?: string;
	city?: string;
	state?: string;
	country_code?: string;
	address_line1?: string;
	address_line2?: string;
	[key: string]: unknown;
}

export interface AutocompleteResponse {
	results: AddressSuggestion[];
	[key: string]: unknown;
}

export interface GeocodedAddress {
	attribution: unknown;
	mapboxId: string | undefined;
	name: string | undefined;
	addressLine1: string | undefined;
	addressLine2: string | undefined;
	city: string | null;
	state: string | null;
	postalCode: string | null;
	country: string;
	latitude: number;
	longitude: number;
}

export interface RouteLeg {
	distance?: number;
	time?: number;
	steps?: unknown[];
	[key: string]: unknown;
}

export interface Route {
	distanceMiles: number;
	durationSeconds: number | null;
	geometry: GeoJsonGeometry;
	legs: RouteLeg[];
	raw: unknown;
	mode: RouteMode;
}

export interface TourRouteLeg extends RouteLeg {
	mode: RouteMode;
	autoSuggested: boolean;
	distanceMiles: number;
	isReturn?: boolean;
}

export interface TourRouteResult {
	mode: RouteMode;
	distanceMiles: number;
	durationSeconds: number;
	waypoints: Waypoint[];
	legs: TourRouteLeg[];
	geom: MultiLineStringGeometry;
}

export interface LegModeResolution {
	mode: RouteMode;
	autoSuggested: boolean;
}

export interface BuildMixedModeRouteOptions {
	orderedWaypoints: Waypoint[];
	legOverrides?: (RouteMode | null | undefined)[];
	baseMode?: RouteMode;
	onWrapError?: (error: unknown) => void;
}

export interface IpLocation {
	isUnitedStates: boolean;
	countryCode: string | null;
	isPrivate: boolean;
	raw?: unknown;
}

export type SpatialFileFormat = 'geojson' | 'gpx' | 'kml' | 'kmz' | 'shapefile';

export interface ParsedSpatialFile {
	format: SpatialFileFormat;
	featureCollection: FeatureCollection;
	warnings: string[];
}

export interface EsriFetchOptions {
	where?: string;
	outFields?: string;
	maxRecords?: number;
	pageSize?: number;
}

export interface EsriFetchResult {
	featureCollection: FeatureCollection;
	warnings: string[];
}
