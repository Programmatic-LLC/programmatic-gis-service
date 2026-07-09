import { GisError } from './errors';
import {
	BuildMixedModeRouteOptions,
	GeoJsonGeometry,
	GisLogger,
	GisServiceConfig,
	LegModeResolution,
	Position,
	Route,
	RouteLeg,
	RouteMode,
	RoutingThresholds,
	TourRouteLeg,
	TourRouteResult,
	Waypoint
} from './types';
import { noopLogger } from './logger';

const GEOAPIFY_ROUTING_ENDPOINT = 'https://api.geoapify.com/v1/routing';
const ALLOWED_MODES: RouteMode[] = ['walk', 'drive', 'bicycle'];

export const DEFAULT_WALK_THRESHOLD_METERS = 800;
export const DEFAULT_DRIVE_SHORT_THRESHOLD_METERS = 200;

export const haversineMeters = (a: Waypoint, b: Waypoint): number => {
	const R = 6371000;
	const toRad = (deg: number) => (deg * Math.PI) / 180;
	const dLat = toRad(b.lat - a.lat);
	const dLon = toRad(b.lon - a.lon);
	const lat1 = toRad(a.lat);
	const lat2 = toRad(b.lat);
	const h =
		Math.sin(dLat / 2) ** 2 +
		Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
	return 2 * R * Math.asin(Math.sqrt(h));
};

export const resolveLegMode = (
	from: Waypoint,
	to: Waypoint,
	override: RouteMode | null | undefined,
	baseMode: RouteMode,
	thresholds: RoutingThresholds = {}
): LegModeResolution => {
	if (override && ALLOWED_MODES.includes(override)) {
		return { mode: override, autoSuggested: false };
	}

	const walkThreshold = thresholds.walkThresholdMeters ?? DEFAULT_WALK_THRESHOLD_METERS;
	const driveShortThreshold = thresholds.driveShortThresholdMeters ?? DEFAULT_DRIVE_SHORT_THRESHOLD_METERS;
	const distance = haversineMeters(from, to);

	if (distance > walkThreshold && baseMode !== 'drive') {
		return { mode: 'drive', autoSuggested: true };
	}

	if (distance < driveShortThreshold && baseMode === 'drive') {
		return { mode: 'walk', autoSuggested: true };
	}

	return { mode: baseMode, autoSuggested: false };
};

const toLines = (geometry: GeoJsonGeometry): Position[][] =>
	geometry.type === 'MultiLineString'
		? (geometry.coordinates as Position[][])
		: [geometry.coordinates as Position[]];

export class RoutingModule {
	private geoapifyApiKey?: string;
	private logger: GisLogger;
	thresholds: RoutingThresholds;

	constructor(config: GisServiceConfig = {}) {
		this.geoapifyApiKey = config.geoapifyApiKey;
		this.logger = config.logger ?? noopLogger;
		this.thresholds = {
			walkThresholdMeters: config.routing?.walkThresholdMeters ?? DEFAULT_WALK_THRESHOLD_METERS,
			driveShortThresholdMeters: config.routing?.driveShortThresholdMeters ?? DEFAULT_DRIVE_SHORT_THRESHOLD_METERS
		};
	}

	route = async (waypoints: Waypoint[], mode: RouteMode = 'walk', rawOutput = false): Promise<Route> => {
		if (!Array.isArray(waypoints) || waypoints.length < 2) {
			throw new GisError('INVALID_INPUT', 'At least two waypoints are required', 400);
		}

		for (const p of waypoints) {
			if (typeof p.lat !== 'number' || typeof p.lon !== 'number') {
				throw new GisError('INVALID_INPUT', 'Each waypoint must include numeric lat and lon', 400);
			}
		}

		if (!ALLOWED_MODES.includes(mode)) {
			throw new GisError('INVALID_INPUT', `invalid routing mode: ${mode}`, 400);
		}

		if (!this.geoapifyApiKey) {
			throw new GisError('MISSING_API_KEY', 'Geoapify API key is not configured', 500);
		}

		const waypointString = waypoints
			.map((p) => `${p.lat},${p.lon}`)
			.join('|');

		const params = new URLSearchParams({
			waypoints: waypointString,
			mode,
			units: 'imperial',
			apiKey: this.geoapifyApiKey
		});

		const url = `${GEOAPIFY_ROUTING_ENDPOINT}?${params.toString()}`;

		this.logger.info({
			event: 'gis.routing.routeRequested',
			mode,
			waypointCount: waypoints.length
		});

		const response = await fetch(url);

		if (!response.ok) {
			const body = (await response.json()) as { message?: string };
			this.logger.warn({
				event: 'gis.routing.routeRequestFailed',
				status: response.status,
				message: body.message
			});

			if (body.message?.includes('Too long distance')) {
				throw new GisError('ROUTE_TOO_LONG', 'Destinations are too far apart.', 400);
			}

			throw new GisError('PROVIDER_ERROR', body.message ?? 'Route request failed', 500);
		}

		const data = (await response.json()) as {
			features?: { geometry: GeoJsonGeometry; properties?: { time?: number; distance?: number; legs?: RouteLeg[] } }[];
		};

		const feature = data.features?.[0];
		if (!feature) {
			this.logger.warn({
				event: 'gis.routing.routeNoResults',
				waypointCount: waypoints.length,
				mode
			});
			throw new GisError('NO_RESULTS', 'No Geoapify route results found', 500);
		}

		if (rawOutput) {
			return data as unknown as Route;
		}

		const seconds = feature.properties?.time;

		const result: Route = {
			distanceMiles: feature.properties?.distance as number,
			durationSeconds: seconds ?? null,
			geometry: feature.geometry,
			legs: feature.properties?.legs ?? [],
			raw: data,
			mode
		};

		this.logger.info({
			event: 'gis.routing.routeRequestSuccessful'
		});

		return result;
	};

	buildMixedModeRoute = async ({
		orderedWaypoints,
		legOverrides = [],
		baseMode = 'walk',
		onWrapError
	}: BuildMixedModeRouteOptions): Promise<TourRouteResult> => {
		const firstWaypoint = orderedWaypoints[0];
		const lastWaypoint = orderedWaypoints[orderedWaypoints.length - 1];
		const isCircular =
			firstWaypoint.lat === lastWaypoint.lat &&
			firstWaypoint.lon === lastWaypoint.lon;

		const pathLegModes: LegModeResolution[] = [];
		for (let i = 0; i < orderedWaypoints.length - 1; i++) {
			pathLegModes.push(
				resolveLegMode(orderedWaypoints[i], orderedWaypoints[i + 1], legOverrides[i], baseMode, this.thresholds)
			);
		}

		const legs: TourRouteLeg[] = [];
		const lines: Position[][] = [];
		let distanceMiles = 0;
		let durationSeconds = 0;

		let runStart = 0;
		while (runStart < pathLegModes.length) {
			const runMode = pathLegModes[runStart].mode;
			let runEnd = runStart;
			while (runEnd + 1 < pathLegModes.length && pathLegModes[runEnd + 1].mode === runMode) {
				runEnd++;
			}

			const runWaypoints = orderedWaypoints.slice(runStart, runEnd + 2);
			const runResult = await this.route(runWaypoints, runMode);

			const runMiles = Number(runResult.distanceMiles) || 0;
			const runLegDistances = runResult.legs.map((leg) => Number(leg.distance) || 0);
			const runLegTotal = runLegDistances.reduce((sum, d) => sum + d, 0);

			runResult.legs.forEach((leg, idx) => {
				const legMeta = pathLegModes[runStart + idx];
				const legMiles = runLegTotal > 0
					? runMiles * (runLegDistances[idx] / runLegTotal)
					: runMiles / runResult.legs.length;
				legs.push({ ...leg, mode: legMeta.mode, autoSuggested: legMeta.autoSuggested, distanceMiles: legMiles });
			});

			toLines(runResult.geometry).forEach((line) => lines.push(line));
			distanceMiles += runMiles;
			durationSeconds += runResult.durationSeconds ?? 0;

			runStart = runEnd + 1;
		}

		if (isCircular && legs.length > 0) {
			const returnLeg = legs[legs.length - 1];
			returnLeg.isReturn = true;
			distanceMiles -= Number(returnLeg.distanceMiles) || 0;
			durationSeconds -= Number(returnLeg.time) || 0;
		}

		if (!isCircular) {
			try {
				const wrapMeta = resolveLegMode(
					lastWaypoint,
					firstWaypoint,
					legOverrides[orderedWaypoints.length - 1],
					baseMode,
					this.thresholds
				);

				const wrapResult = await this.route([lastWaypoint, firstWaypoint], wrapMeta.mode);
				const wrapLeg = wrapResult.legs[0];

				if (wrapLeg) {
					legs.push({
						...wrapLeg,
						mode: wrapMeta.mode,
						autoSuggested: wrapMeta.autoSuggested,
						distanceMiles: Number(wrapResult.distanceMiles) || 0,
						isReturn: true
					});
					toLines(wrapResult.geometry).forEach((line) => lines.push(line));
				}
			} catch (wrapErr) {
				if (onWrapError) {
					onWrapError(wrapErr);
				}
			}
		}

		return {
			mode: baseMode,
			distanceMiles,
			durationSeconds,
			waypoints: orderedWaypoints,
			legs,
			geom: { type: 'MultiLineString', coordinates: lines }
		};
	};
}
