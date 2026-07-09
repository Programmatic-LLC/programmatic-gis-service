import { GeolocationModule, isPrivateIp } from '../src/geolocation';
import { GisError } from '../src/errors';
import { installFetchMock, jsonResponse } from './helpers';

describe('isPrivateIp', () => {
	it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1'])(
		'treats %s as private',
		(ip) => {
			expect(isPrivateIp(ip)).toBe(true);
		}
	);

	it.each(['8.8.8.8', '172.32.0.1', '203.0.113.10'])('treats %s as public', (ip) => {
		expect(isPrivateIp(ip)).toBe(false);
	});
});

describe('lookupIp', () => {
	it('short-circuits private IPs as United States without calling the provider', async () => {
		const fetchMock = installFetchMock();
		const geolocation = new GeolocationModule({ geoapifyApiKey: 'geo-key' });

		const result = await geolocation.lookupIp('192.168.1.50');

		expect(result).toEqual({ isUnitedStates: true, countryCode: null, isPrivate: true });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('resolves a US IP', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ country: { iso_code: 'US' } }));

		const geolocation = new GeolocationModule({ geoapifyApiKey: 'geo-key' });
		const result = await geolocation.lookupIp('203.0.113.10');

		expect(result.isUnitedStates).toBe(true);
		expect(result.countryCode).toBe('US');
		expect(result.isPrivate).toBe(false);
	});

	it('resolves a non-US IP', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ country: { iso_code: 'CA' } }));

		const geolocation = new GeolocationModule({ geoapifyApiKey: 'geo-key' });
		const result = await geolocation.lookupIp('203.0.113.10');

		expect(result.isUnitedStates).toBe(false);
		expect(result.countryCode).toBe('CA');
	});

	it('throws MISSING_API_KEY with status 503 when no key is configured', async () => {
		installFetchMock();
		const geolocation = new GeolocationModule({});
		const error = await geolocation.lookupIp('203.0.113.10').catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('MISSING_API_KEY');
		expect(error.status).toBe(503);
	});

	it('throws PROVIDER_ERROR with status 503 when the provider fails', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 500));

		const geolocation = new GeolocationModule({ geoapifyApiKey: 'geo-key' });
		const error = await geolocation.lookupIp('203.0.113.10').catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PROVIDER_ERROR');
		expect(error.status).toBe(503);
		expect(error.message).toBe('Location check failed');
	});
});
