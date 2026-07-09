import { RoutingModule, resolveLegMode } from '../src/routing';
import { GisError } from '../src/errors';
import { Route, RouteMode, Waypoint } from '../src/types';
import { installFetchMock, jsonResponse } from './helpers';

const makeRoutingWithMockedRoute = () => {
	const routing = new RoutingModule({ geoapifyApiKey: 'test-key' });
	const routeMock = jest.fn(async (waypoints: Waypoint[], mode: RouteMode): Promise<Route> => {
		const legCount = waypoints.length - 1;
		return {
			mode,
			distanceMiles: legCount,
			durationSeconds: legCount * 100,
			legs: Array.from({ length: legCount }, (_, i) => ({ distance: 1, index: i })),
			geometry: {
				type: 'MultiLineString',
				coordinates: Array.from({ length: legCount }, () => [[0, 0], [1, 1]])
			},
			raw: {}
		};
	});
	routing.route = routeMock as unknown as typeof routing.route;
	return { routing, routeMock };
};

const near = (n: number): Waypoint => ({ lat: 39.9 + n * 0.001, lon: -75.1 });
const far = (n: number): Waypoint => ({ lat: 39.9 + n * 0.05, lon: -75.1 });

describe('resolveLegMode', () => {
	it('uses an explicit override regardless of distance', () => {
		expect(resolveLegMode(near(0), far(1), 'walk', 'walk')).toEqual({ mode: 'walk', autoSuggested: false });
	});

	it('auto-suggests drive when a leg exceeds the walk threshold', () => {
		expect(resolveLegMode(near(0), far(1), null, 'walk')).toEqual({ mode: 'drive', autoSuggested: true });
	});

	it('keeps the base mode for short legs', () => {
		expect(resolveLegMode(near(0), near(1), null, 'bicycle')).toEqual({ mode: 'bicycle', autoSuggested: false });
	});

	it('does not override when the base mode is already drive', () => {
		expect(resolveLegMode(near(0), far(1), null, 'drive')).toEqual({ mode: 'drive', autoSuggested: false });
	});

	it('auto-suggests walk for very short legs in a driving tour', () => {
		expect(resolveLegMode(near(0), near(1), null, 'drive')).toEqual({ mode: 'walk', autoSuggested: true });
	});

	it('honors custom thresholds', () => {
		expect(resolveLegMode(near(0), near(1), null, 'walk', { walkThresholdMeters: 50 })).toEqual({
			mode: 'drive',
			autoSuggested: true
		});
	});
});

describe('buildMixedModeRoute', () => {
	it('routes a uniform walking tour in a single call plus wrap-around', async () => {
		const { routing, routeMock } = makeRoutingWithMockedRoute();
		const result = await routing.buildMixedModeRoute({
			orderedWaypoints: [near(0), near(1), near(2)],
			legOverrides: [null, null, null],
			baseMode: 'walk'
		});

		expect(routeMock).toHaveBeenCalledTimes(2);
		expect(routeMock.mock.calls.every(([, mode]) => mode === 'walk')).toBe(true);
		expect(result.legs).toHaveLength(3);
		expect(result.legs.every((l) => l.mode === 'walk')).toBe(true);
		expect(result.mode).toBe('walk');
	});

	it('splits the route into per-mode segments when a middle leg requires driving', async () => {
		const { routing, routeMock } = makeRoutingWithMockedRoute();
		const result = await routing.buildMixedModeRoute({
			orderedWaypoints: [near(0), near(1), far(20), near(0)],
			legOverrides: [null, null, null, null],
			baseMode: 'walk'
		});

		const modes = routeMock.mock.calls.map(([, mode]) => mode);
		expect(modes).toContain('walk');
		expect(modes).toContain('drive');
		expect(result.legs.some((l) => l.mode === 'drive' && l.autoSuggested)).toBe(true);
		expect(result.legs.some((l) => l.mode === 'walk')).toBe(true);
	});

	it('omits the wrap-around call for a circular tour', async () => {
		const { routing, routeMock } = makeRoutingWithMockedRoute();
		const start = near(0);
		await routing.buildMixedModeRoute({
			orderedWaypoints: [start, near(1), start],
			legOverrides: [null, null, null],
			baseMode: 'walk'
		});

		expect(routeMock).toHaveBeenCalledTimes(1);
	});

	it('reports forward-only distance and duration, excluding the return leg', async () => {
		const { routing } = makeRoutingWithMockedRoute();
		const result = await routing.buildMixedModeRoute({
			orderedWaypoints: [near(0), near(1)],
			legOverrides: [null, null],
			baseMode: 'walk'
		});

		expect(result.distanceMiles).toBe(1);
		expect(result.durationSeconds).toBe(100);
		expect(result.legs).toHaveLength(2);
		expect(result.legs[result.legs.length - 1].isReturn).toBe(true);
		expect(result.legs[0].isReturn).toBeUndefined();
		expect(result.legs[0].distanceMiles).toBe(1);
	});

	it('swallows wrap-around failures and still returns the path', async () => {
		const { routing, routeMock } = makeRoutingWithMockedRoute();
		routeMock
			.mockImplementationOnce(async (waypoints: Waypoint[], mode: RouteMode) => ({
				mode,
				distanceMiles: 1,
				durationSeconds: 100,
				legs: [{ distance: 1 }],
				geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] },
				raw: {}
			}))
			.mockImplementationOnce(async () => {
				throw new Error('wrap failed');
			});

		const onWrapError = jest.fn();
		const result = await routing.buildMixedModeRoute({
			orderedWaypoints: [near(0), near(1)],
			legOverrides: [null, null],
			baseMode: 'walk',
			onWrapError
		});

		expect(onWrapError).toHaveBeenCalled();
		expect(result.legs).toHaveLength(1);
	});
});

describe('route', () => {
	it('normalizes a successful Geoapify routing response', async () => {
		const fetchMock = installFetchMock();
		const raw = {
			features: [
				{
					geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]]] },
					properties: { distance: 2.5, time: 1800, legs: [{ distance: 2.5, time: 1800, steps: [] }] }
				}
			]
		};
		fetchMock.mockResolvedValueOnce(jsonResponse(raw));

		const routing = new RoutingModule({ geoapifyApiKey: 'test-key' });
		const result = await routing.route([near(0), near(1)], 'walk');

		expect(result.distanceMiles).toBe(2.5);
		expect(result.durationSeconds).toBe(1800);
		expect(result.legs).toHaveLength(1);
		expect(result.geometry.type).toBe('MultiLineString');
		expect(result.mode).toBe('walk');
		expect(result.raw).toEqual(raw);

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).toContain('https://api.geoapify.com/v1/routing');
		expect(requestedUrl).toContain('units=imperial');
		expect(requestedUrl).toContain('mode=walk');
	});

	it('returns the raw provider payload when rawOutput is set', async () => {
		const fetchMock = installFetchMock();
		const raw = { features: [{ geometry: { type: 'LineString', coordinates: [] }, properties: {} }] };
		fetchMock.mockResolvedValueOnce(jsonResponse(raw));

		const routing = new RoutingModule({ geoapifyApiKey: 'test-key' });
		const result = await routing.route([near(0), near(1)], 'walk', true);

		expect(result).toEqual(raw);
	});

	it('maps the too-long-distance provider error to ROUTE_TOO_LONG with status 400', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'Too long distance between points' }, false, 400));

		const routing = new RoutingModule({ geoapifyApiKey: 'test-key' });
		const error = await routing.route([near(0), far(50)], 'walk').catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('ROUTE_TOO_LONG');
		expect(error.status).toBe(400);
		expect(error.message).toBe('Destinations are too far apart.');
	});

	it('rejects fewer than two waypoints', async () => {
		const routing = new RoutingModule({ geoapifyApiKey: 'test-key' });
		const error = await routing.route([near(0)], 'walk').catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('INVALID_INPUT');
	});

	it('rejects an invalid mode', async () => {
		const routing = new RoutingModule({ geoapifyApiKey: 'test-key' });
		const error = await routing.route([near(0), near(1)], 'fly' as RouteMode).catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('INVALID_INPUT');
	});
});
