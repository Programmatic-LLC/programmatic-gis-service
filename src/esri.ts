import { GisError } from './errors';
import {
	EsriFetchOptions,
	EsriFetchResult,
	GeoJsonFeature,
	GisLogger,
	GisServiceConfig
} from './types';
import { noopLogger } from './logger';

const LAYER_URL_PATTERN = /^https?:\/\/.+\/(FeatureServer|MapServer)\/\d+$/i;

const DEFAULT_PAGE_SIZE = 1000;
const DEFAULT_MAX_RECORDS = 10000;

export const normalizeLayerUrl = (url: string): string =>
	String(url ?? '')
		.trim()
		.replace(/\/query\/?(\?.*)?$/i, '')
		.replace(/\/+$/, '');

export class EsriModule {
	private logger: GisLogger;

	constructor(config: GisServiceConfig = {}) {
		this.logger = config.logger ?? noopLogger;
	}

	fetchFeatures = async (layerUrl: string, options: EsriFetchOptions = {}): Promise<EsriFetchResult> => {
		const normalized = normalizeLayerUrl(layerUrl);

		if (!LAYER_URL_PATTERN.test(normalized)) {
			throw new GisError(
				'INVALID_ESRI_URL',
				'URL must point to a feature service layer, e.g. https://host/arcgis/rest/services/Name/FeatureServer/0',
				400
			);
		}

		const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
		const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
		const warnings: string[] = [];
		const features: GeoJsonFeature[] = [];
		let moreAvailable = false;

		this.logger.info({
			event: 'gis.esri.fetchFeaturesRequested',
			layerUrl: normalized
		});

		while (features.length < maxRecords) {
			const params = new URLSearchParams({
				where: options.where ?? '1=1',
				outFields: options.outFields ?? '*',
				f: 'geojson',
				resultOffset: String(features.length),
				resultRecordCount: String(Math.min(pageSize, maxRecords - features.length))
			});

			const response = await fetch(`${normalized}/query?${params.toString()}`);

			if (!response.ok) {
				this.logger.warn({
					event: 'gis.esri.fetchFeaturesFailed',
					status: response.status,
					layerUrl: normalized
				});
				throw new GisError('PROVIDER_ERROR', `Feature service request failed with status ${response.status}`, 502);
			}

			const data = (await response.json()) as {
				error?: { message?: string };
				features?: GeoJsonFeature[];
				exceededTransferLimit?: boolean;
				properties?: { exceededTransferLimit?: boolean };
			};

			if (data?.error) {
				throw new GisError(
					'PROVIDER_ERROR',
					`Feature service error: ${data.error.message ?? 'unknown error'}`,
					502,
					data.error
				);
			}

			if (!Array.isArray(data?.features)) {
				throw new GisError('PROVIDER_ERROR', 'Feature service did not return GeoJSON features', 502);
			}

			features.push(...data.features);
			moreAvailable =
				data.exceededTransferLimit === true || data.properties?.exceededTransferLimit === true;

			if (!moreAvailable || data.features.length === 0) {
				break;
			}
		}

		if (moreAvailable && features.length >= maxRecords) {
			warnings.push(`Feature service has more than ${maxRecords} features; results were truncated`);
		}

		this.logger.info({
			event: 'gis.esri.fetchFeaturesSuccessful',
			featureCount: features.length
		});

		return {
			featureCollection: { type: 'FeatureCollection', features },
			warnings
		};
	};
}
