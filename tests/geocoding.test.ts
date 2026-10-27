import { GeocodingModule } from '../src/geocoding';
import { GisError } from '../src/errors';
import { installFetchMock, jsonResponse } from './helpers';

const mapboxFeature = (routablePoints?: { name: string; latitude: number; longitude: number }[]) => ({
	properties: {
		mapbox_id: 'mb-123',
		feature_type: 'address',
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
		expect(requestedUrl).toContain('limit=5');
		expect(requestedUrl).toContain('format=json');
	});

	it('does not restrict results to street level, so house numbers can rank first', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'geo-key' });
		await geocoding.autocomplete('123 Main');

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).not.toContain('type=');
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
		expect(requestedUrl).toContain('postcode=19107');
		expect(requestedUrl).toContain('region=Pennsylvania');
	});

	it('omits address fields the suggestion does not carry instead of sending "undefined"', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent({ street: 'Main St', city: 'Philadelphia', country_code: 'us' });

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).not.toContain('undefined');
		expect(requestedUrl).not.toContain('address_number=');
		expect(requestedUrl).not.toContain('postcode=');
		expect(requestedUrl).toContain('street=Main+St');
		expect(requestedUrl).toContain('place=Philadelphia');
	});

	it('omits address fields that are present but empty', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent({ ...suggestion, housenumber: '   ', postcode: '' });

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).not.toContain('address_number=');
		expect(requestedUrl).not.toContain('postcode=');
		expect(requestedUrl).toContain('street=Main+St');
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
			longitude: -75.16,
			matchType: 'address'
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

	it('defaults the country and drops missing address parts', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent({ street: 'Main St' });

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).toContain('country=us');
		expect(requestedUrl).toContain('street=Main+St');
		expect(requestedUrl).not.toContain('undefined');
	});

	it('searches free text when the address has no separate street', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent({ formatted: ' 123 Main St, Philadelphia, PA 19107 ', city: 'Philadelphia' });

		const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(requestedUrl.searchParams.get('q')).toBe('123 Main St, Philadelphia, PA 19107');
		expect(requestedUrl.searchParams.get('permanent')).toBe('true');
		expect(requestedUrl.searchParams.has('place')).toBe(false);
	});

	it('keeps the structured search when a street is given alongside formatted text', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ features: [mapboxFeature()], attribution: 'Mapbox' }));

		const geocoding = new GeocodingModule({ mapboxApiKey: 'mb-key' });
		await geocoding.geocodePermanent({ ...suggestion, formatted: '123 Main St, Philadelphia' });

		const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(requestedUrl.searchParams.has('q')).toBe(false);
		expect(requestedUrl.searchParams.get('street')).toBe('Main St');
	});
});

describe('geocodeSearch', () => {
	const geoapifyResult = {
		lat: 41.36,
		lon: -82.1,
		name: 'Old Mill',
		address_line1: '12 Mill St',
		address_line2: 'Elyria, OH 44035, United States of America',
		city: 'Elyria',
		state_code: 'OH',
		postcode: '44035',
		country_code: 'us',
		result_type: 'building',
		datasource: { sourcename: 'openstreetmap', attribution: '© OpenStreetMap contributors', license: 'Open Database License' }
	};

	it('geocodes free text through the Geoapify search endpoint', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ results: [geoapifyResult] }));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'ga-key' });
		const result = await geocoding.geocodeSearch({ formatted: '12 Mill St, Elyria, OH' });

		const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(requestedUrl.origin + requestedUrl.pathname).toBe('https://api.geoapify.com/v1/geocode/search');
		expect(requestedUrl.searchParams.get('text')).toBe('12 Mill St, Elyria, OH');
		expect(requestedUrl.searchParams.get('filter')).toBe('countrycode:us');
		expect(result).toEqual({
			attribution: {
				provider: 'geoapify',
				sourcename: 'openstreetmap',
				attribution: '© OpenStreetMap contributors',
				license: 'Open Database License'
			},
			mapboxId: undefined,
			name: 'Old Mill',
			addressLine1: '12 Mill St',
			addressLine2: 'Elyria, OH 44035, United States of America',
			city: 'Elyria',
			state: 'OH',
			postalCode: '44035',
			country: 'US',
			latitude: 41.36,
			longitude: -82.1,
			matchType: 'building'
		});
	});

	it('sends structured parts when a street is given', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ results: [geoapifyResult] }));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'ga-key' });
		await geocoding.geocodeSearch({ housenumber: '12', street: 'Mill St', city: 'Elyria', postcode: '' });

		const requestedUrl = new URL(fetchMock.mock.calls[0][0] as string);
		expect(requestedUrl.searchParams.get('housenumber')).toBe('12');
		expect(requestedUrl.searchParams.get('street')).toBe('Mill St');
		expect(requestedUrl.searchParams.has('postcode')).toBe(false);
		expect(requestedUrl.searchParams.has('text')).toBe(false);
	});

	it('throws NO_RESULTS when nothing matches', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'ga-key' });
		const error = await geocoding.geocodeSearch({ formatted: 'nowhere' }).catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('NO_RESULTS');
	});

	it('throws PROVIDER_ERROR when Geoapify fails', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ message: 'bad key' }, false, 401));

		const geocoding = new GeocodingModule({ geoapifyApiKey: 'ga-key' });
		const error = await geocoding.geocodeSearch({ formatted: '12 Mill St' }).catch((e) => e);

		expect(error.code).toBe('PROVIDER_ERROR');
	});

	it('throws MISSING_API_KEY when no Geoapify key is configured', async () => {
		const geocoding = new GeocodingModule({});
		const error = await geocoding.geocodeSearch({ formatted: '12 Mill St' }).catch((e) => e);

		expect(error.code).toBe('MISSING_API_KEY');
	});
});
