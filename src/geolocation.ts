import { GisError } from './errors';
import { GisLogger, GisServiceConfig, IpLocation } from './types';
import { noopLogger } from './logger';

const GEOAPIFY_IPINFO_ENDPOINT = 'https://api.geoapify.com/v1/ipinfo';

const PRIVATE_IP_PATTERNS = [
	/^127\./,
	/^10\./,
	/^172\.(1[6-9]|2[0-9]|3[0-1])\./,
	/^192\.168\./,
	/^::1$/,
	/^::ffff:127\./,
	/^fc00:/i,
	/^fe80:/i
];

export const isPrivateIp = (ip: string): boolean =>
	PRIVATE_IP_PATTERNS.some((pattern) => pattern.test(ip));

export class GeolocationModule {
	private geoapifyApiKey?: string;
	private logger: GisLogger;

	constructor(config: GisServiceConfig = {}) {
		this.geoapifyApiKey = config.geoapifyApiKey;
		this.logger = config.logger ?? noopLogger;
	}

	lookupIp = async (ip: string): Promise<IpLocation> => {
		if (isPrivateIp(ip)) {
			return { isUnitedStates: true, countryCode: null, isPrivate: true };
		}

		if (!this.geoapifyApiKey) {
			throw new GisError('MISSING_API_KEY', 'Location service unavailable', 503);
		}

		const params = new URLSearchParams({
			ip,
			apiKey: this.geoapifyApiKey
		});

		const url = `${GEOAPIFY_IPINFO_ENDPOINT}?${params.toString()}`;
		const response = await fetch(url);

		if (!response.ok) {
			throw new GisError('PROVIDER_ERROR', 'Location check failed', 503);
		}

		const data = (await response.json()) as { country?: { iso_code?: string } };
		const countryCode = data?.country?.iso_code ?? null;

		return {
			isUnitedStates: countryCode === 'US',
			countryCode,
			isPrivate: false,
			raw: data
		};
	};
}
