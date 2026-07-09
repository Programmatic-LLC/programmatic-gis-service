import { GeocodingModule } from '../src/geocoding';
import { GisError } from '../src/errors';
import { installFetchMock, jsonResponse } from './helpers';

const mapboxFeature = (routablePoints?: { name: string; latitude: number; longitude: number }[]) => ({
	properties: {
		mapbox_id: 'mb-123',
		name: '123 Main St',
		name_preferred: '123 Main Street',
		place_formatted: 'Philadelphia, Pennsylvania 19107, United States',
		coordinates: {
			latitude: 39.95,
			longitude: -75.16,
			...(routablePoints ? { routable_points: routablePoints } : {})
		},
		context: {
			address: { name: '123 Main Street' },
			place: { name: 'Philadelphia' },
			region: { region_code: 'PA' },
			postcode: { name: '19107' },
			country: { country_code: 'US' }
		}
	}
});

describe('autocomplete', () => {
	it('returns the raw Geoapify response body', async () => {
		const fetchMock = installFetchMock();
		const body = { results: [{ formatted: '123 Main St', lat: 39.95, lon: -75.16 }] };
		fetchMock.mockResolvedValueOnce(jsonResponse(body));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'geo-key' });
		const result = await geocoding.autocomplete('123 Main');

		expect(result).toEqual(body);
		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).toContain('https://api.geoapify.com/v1/geocode/autocomplete');
		expect(requestedUrl).toContain('type=street');
		expect(requestedUrl).toContain('limit=5');
		expect(requestedUrl).toContain('format=json');
	});

	it('throws PROVIDER_ERROR with the provider message on failure', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'quota exceeded' }, false, 429));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'geo-key' });
		const error = await geocoding.autocomplete('123 Main').catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PROVIDER_ERROR');
		expect(error.status).toBe(500);
		expect(error.message).toBe('quota exceeded');
	});

	it('rejects empty input', async () => {
		const geocoding = new GeocodingModule({ geoapifyApiKey: 'geo-key' });
		const error = await geocoding.autocomplete('').catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('INVALID_INPUT');
	});

	it('throws MISSING_API_KEY when no Geoapify key is configured', async () => {
		const geocoding = new GeocodingModule({});
		const error = await geocoding.autocomplete('123 Main').catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('MISSING_API_KEY');
	});
});

describe('geocodePermanent', () => {
	const suggestion = {
		housenumber: '123',
		street: 'Main St',
		postcode: '19107',
		city: 'Philadelphia',
		state: 'Pennsylvania',
		country_code: 'us'
	};

	it('requests a permanent Mapbox geocode with entrances', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent(suggestion);

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).toContain('https://api.mapbox.com/search/geocode/v6/forward');
		expect(requestedUrl).toContain('permanent=true');
		expect(requestedUrl).toContain('entrances=true');
		expect(requestedUrl).toContain('limit=1');
		expect(requestedUrl).toContain('address_number=123');
	});

	it('normalizes the Mapbox feature into a GeocodedAddress', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		const result = await geocoding.geocodePermanent(suggestion);

		expect(result).toEqual({
			attribution: 'Mapbox',
			mapboxId: 'mb-123',
			name: '123 Main Street',
			addressLine1: '123 Main Street',
			addressLine2: 'Philadelphia, Pennsylvania 19107, United States',
			city: 'Philadelphia',
			state: 'PA',
			postalCode: '19107',
			country: 'US',
			latitude: 39.95,
			longitude: -75.16
		});
	});

	it('prefers the entrance routable point over the raw coordinate', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				features: [
					mapboxFeature([
						{ name: 'default', latitude: 39.951, longitude: -75.161 },
						{ name: 'entrance', latitude: 39.952, longitude: -75.162 }
					])
				],
				attribution: 'Mapbox'
			})
		);

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		const result = await geocoding.geocodePermanent(suggestion);

		expect(result.latitude).toBe(39.952);
		expect(result.longitude).toBe(-75.162);
	});

	it('falls back to the default routable point when there is no entrance', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(
			jsonResponse({
				features: [mapboxFeature([{ name: 'default', latitude: 39.951, longitude: -75.161 }])],
				attribution: 'Mapbox'
			})
		);

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		const result = await geocoding.geocodePermanent(suggestion);

		expect(result.latitude).toBe(39.951);
		expect(result.longitude).toBe(-75.161);
	});

	it('throws NO_RESULTS when Mapbox returns no features', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [] }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		const error = await geocoding.geocodePermanent(suggestion).catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('NO_RESULTS');
		expect(error.message).toBe('No Mapbox results found');
	});

	it('coerces missing address parts the same way as URLSearchParams', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent({ street: 'Main St' });

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).toContain('address_number=undefined');
		expect(requestedUrl).toContain('country=us');
	});
});
