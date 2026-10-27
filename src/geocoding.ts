import { GisError } from './errors';
import {
	AddressSuggestion,
	AutocompleteResponse,
	GeocodedAddress,
	GisLogger,
	GisServiceConfig
} from './types';
import { noopLogger } from './logger';

const GEOAPIFY_AUTOCOMPLETE_ENDPOINT = 'https://api.geoapify.com/v1/geocode/autocomplete';
const GEOAPIFY_SEARCH_ENDPOINT = 'https://api.geoapify.com/v1/geocode/search';
const MAPBOX_FORWARD_ENDPOINT = 'https://api.mapbox.com/search/geocode/v6/forward';

interface GeoapifySearchResult {
	lat?: number;
	lon?: number;
	name?: string;
	address_line1?: string;
	address_line2?: string;
	city?: string;
	state_code?: string;
	state?: string;
	postcode?: string;
	country_code?: string;
	result_type?: string;
	datasource?: Record<string, unknown>;
}

const hasText = (value: unknown): boolean =>
	value !== undefined && value !== null && String(value).trim() !== '';

interface MapboxRoutablePoint {
	name: string;
	latitude: number;
	longitude: number;
}

interface MapboxFeature {
	properties: {
		mapbox_id?: string;
		feature_type?: string;
		name?: string;
		name_preferred?: string;
		place_formatted?: string;
		coordinates: {
			latitude: number;
			longitude: number;
			routable_points?: MapboxRoutablePoint[];
		};
		context?: {
			address?: { name?: string };
			place?: { name?: string };
			region?: { region_code?: string };
			postcode?: { name?: string };
			country?: { country_code?: string };
		};
	};
}

export class GeocodingModule {
	private geoapifyApiKey?: string;
	private mapboxApiKey?: string;
	private limit: number;
	private logger: GisLogger;

	constructor(config: GisServiceConfig = {}) {
		this.geoapifyApiKey = config.geoapifyApiKey;
		this.mapboxApiKey = config.mapboxApiKey;
		this.limit = config.autocompleteLimit ?? 5;
		this.logger = config.logger ?? noopLogger;
	}

	autocomplete = async (text: string): Promise<AutocompleteResponse> => {
		if (!text || typeof text !== 'string') {
			throw new GisError('INVALID_INPUT', 'address autocomplete requires a non-empty text string', 400);
		}

		if (!this.geoapifyApiKey) {
			throw new GisError('MISSING_API_KEY', 'Geoapify API key is not configured', 500);
		}

		const params = new URLSearchParams({
			text,
			limit: String(this.limit),
			apiKey: this.geoapifyApiKey,
			format: 'json'
		});

		const url = `${GEOAPIFY_AUTOCOMPLETE_ENDPOINT}?${params.toString()}`;
		const response = await fetch(url);

		if (!response.ok) {
			const body = (await response.json()) as { message?: string };
			this.logger.warn({
				event: 'gis.geocoding.autocompleteFailure',
				message: body.message
			});
			throw new GisError('PROVIDER_ERROR', body.message ?? 'Address autocomplete failed', 500);
		}

		return (await response.json()) as AutocompleteResponse;
	};

	geocodePermanent = async (suggestion: AddressSuggestion): Promise<GeocodedAddress> => {
		if (!suggestion) {
			throw new GisError('INVALID_INPUT', 'Geoapify result required for Mapbox geocoding', 400);
		}

		if (!this.mapboxApiKey) {
			throw new GisError('MISSING_API_KEY', 'Mapbox API key is not configured', 500);
		}

		const {
			housenumber,
			street,
			postcode,
			city,
			state,
			country_code,
			formatted
		} = suggestion;

		const params = new URLSearchParams({
			country: String(country_code || 'us'),
			access_token: this.mapboxApiKey,
			entrances: 'true',
			limit: '1',
			permanent: 'true'
		});

		if (!hasText(street) && hasText(formatted)) {
			params.set('q', String(formatted).trim());
		} else {
			const optionalParams: Record<string, unknown> = {
				address_number: housenumber,
				street,
				postcode,
				place: city,
				region: state
			};

			Object.entries(optionalParams).forEach(([key, value]) => {
				if (!hasText(value)) {
					return;
				}

				params.set(key, String(value));
			});
		}

		const url = `${MAPBOX_FORWARD_ENDPOINT}?${params.toString()}`;
		const response = await fetch(url);

		if (!response.ok) {
			const body = await response.text();
			this.logger.warn({
				event: 'gis.geocoding.permanentGeocodeFailure',
				message: body
			});
			throw new GisError('PROVIDER_ERROR', `Mapbox error ${response.status}: ${body}`, 500);
		}

		const data = (await response.json()) as { features?: MapboxFeature[]; attribution?: unknown };

		if (!data.features?.length) {
			this.logger.warn({
				event: 'gis.geocoding.permanentGeocodeNoResults',
				query: params.toString()
			});
			throw new GisError('NO_RESULTS', 'No Mapbox results found', 500);
		}

		return this.normalizeMapboxFeature(data.features[0], data.attribution);
	};

	normalizeMapboxFeature = (feature: MapboxFeature, attribution: unknown): GeocodedAddress => {
		const { properties } = feature;

		let latitude = properties.coordinates.latitude;
		let longitude = properties.coordinates.longitude;
		if (properties.coordinates.routable_points) {
			const entrance = properties.coordinates.routable_points.find((point) => point.name === 'entrance');
			const defaultLocation = properties.coordinates.routable_points.find((point) => point.name === 'default');
			if (entrance) {
				latitude = entrance.latitude;
				longitude = entrance.longitude;
			} else if (defaultLocation) {
				latitude = defaultLocation.latitude;
				longitude = defaultLocation.longitude;
			}
		}

		const context = properties.context || {};

		return {
			attribution,
			mapboxId: properties.mapbox_id,
			name: properties.name_preferred || properties.name,
			addressLine1: context.address?.name || properties.name,
			addressLine2: properties.place_formatted,
			city: context.place?.name || null,
			state: context.region?.region_code || null,
			postalCode: context.postcode?.name || null,
			country: context.country?.country_code || 'US',
			latitude,
			longitude,
			matchType: properties.feature_type || null
		};
	};

	geocodeSearch = async (suggestion: AddressSuggestion): Promise<GeocodedAddress> => {
		if (!suggestion) {
			throw new GisError('INVALID_INPUT', 'An address is required for Geoapify geocoding', 400);
		}

		if (!this.geoapifyApiKey) {
			throw new GisError('MISSING_API_KEY', 'Geoapify API key is not configured', 500);
		}

		const { housenumber, street, postcode, city, state, country_code, formatted } = suggestion;
		const params = new URLSearchParams({
			filter: `countrycode:${String(country_code || 'us').toLowerCase()}`,
			limit: '1',
			format: 'json',
			apiKey: this.geoapifyApiKey
		});

		if (!hasText(street) && hasText(formatted)) {
			params.set('text', String(formatted).trim());
		} else {
			const optionalParams: Record<string, unknown> = { housenumber, street, postcode, city, state };
			Object.entries(optionalParams).forEach(([key, value]) => {
				if (hasText(value)) {
					params.set(key, String(value));
				}
			});
		}

		const response = await fetch(`${GEOAPIFY_SEARCH_ENDPOINT}?${params.toString()}`);

		if (!response.ok) {
			const body = await response.text();
			this.logger.warn({
				event: 'gis.geocoding.searchFailure',
				message: body
			});
			throw new GisError('PROVIDER_ERROR', `Geoapify error ${response.status}: ${body}`, 500);
		}

		const data = (await response.json()) as { results?: GeoapifySearchResult[] };
		const result = data.results?.[0];

		if (!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lon)) {
			this.logger.warn({ event: 'gis.geocoding.searchNoResults' });
			throw new GisError('NO_RESULTS', 'No Geoapify results found', 500);
		}

		return {
			attribution: { provider: 'geoapify', ...(result.datasource || {}) },
			mapboxId: undefined,
			name: result.name || result.address_line1,
			addressLine1: result.address_line1,
			addressLine2: result.address_line2,
			city: result.city || null,
			state: result.state_code || result.state || null,
			postalCode: result.postcode || null,
			country: (result.country_code || 'US').toUpperCase(),
			latitude: result.lat as number,
			longitude: result.lon as number,
			matchType: result.result_type || null
		};
	};
}
