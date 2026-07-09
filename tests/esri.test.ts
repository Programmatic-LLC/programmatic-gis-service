import { EsriModule, normalizeLayerUrl } from '../src/esri';
import { GisError } from '../src/errors';
import { installFetchMock, jsonResponse } from './helpers';

const LAYER_URL = 'https://services5.arcgis.com/abc123/arcgis/rest/services/Trails/FeatureServer/0';

const lineFeature = (id: number) => ({
	type: 'Feature',
	properties: { OBJECTID: id },
	geometry: { type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] }
});

describe('normalizeLayerUrl', () => {
	it('strips /query suffixes and trailing slashes', () => {
		expect(normalizeLayerUrl(`${LAYER_URL}/query`)).toBe(LAYER_URL);
		expect(normalizeLayerUrl(`${LAYER_URL}/query?where=1=1&f=geojson`)).toBe(LAYER_URL);
		expect(normalizeLayerUrl(`${LAYER_URL}/`)).toBe(LAYER_URL);
		expect(normalizeLayerUrl(`  ${LAYER_URL}  `)).toBe(LAYER_URL);
	});
});

describe('fetchFeatures', () => {
	it('fetches a single page of GeoJSON features', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'FeatureCollection', features: [lineFeature(1), lineFeature(2)] }));

		const esri = new EsriModule();
		const result = await esri.fetchFeatures(LAYER_URL);

		expect(result.featureCollection.features).toHaveLength(2);
		expect(result.warnings).toEqual([]);

		const requestedUrl = fetchMock.mock.calls[0][0] as string;
		expect(requestedUrl).toContain(`${LAYER_URL}/query?`);
		expect(requestedUrl).toContain('f=geojson');
		expect(requestedUrl).toContain('resultOffset=0');
	});

	it('paginates while the transfer limit is exceeded', async () => {
		const fetchMock = installFetchMock();
		fetchMock
			.mockResolvedValueOnce(
				jsonResponse({
					type: 'FeatureCollection',
					features: [lineFeature(1), lineFeature(2)],
					properties: { exceededTransferLimit: true }
				})
			)
			.mockResolvedValueOnce(jsonResponse({ type: 'FeatureCollection', features: [lineFeature(3)] }));

		const esri = new EsriModule();
		const result = await esri.fetchFeatures(LAYER_URL, { pageSize: 2 });

		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(result.featureCollection.features).toHaveLength(3);

		const secondUrl = fetchMock.mock.calls[1][0] as string;
		expect(secondUrl).toContain('resultOffset=2');
	});

	it('truncates at maxRecords with a warning', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValue(
			jsonResponse({
				type: 'FeatureCollection',
				features: [lineFeature(1), lineFeature(2)],
				exceededTransferLimit: true
			})
		);

		const esri = new EsriModule();
		const result = await esri.fetchFeatures(LAYER_URL, { pageSize: 2, maxRecords: 4 });

		expect(result.featureCollection.features).toHaveLength(4);
		expect(result.warnings.some((warning) => warning.includes('truncated'))).toBe(true);
	});

	it('accepts layer URLs with a /query suffix', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ type: 'FeatureCollection', features: [lineFeature(1)] }));

		const esri = new EsriModule();
		const result = await esri.fetchFeatures(`${LAYER_URL}/query`);

		expect(result.featureCollection.features).toHaveLength(1);
	});

	it('rejects URLs that are not feature service layers', async () => {
		installFetchMock();
		const esri = new EsriModule();

		for (const badUrl of ['https://example.com/data.geojson', 'not a url', `${LAYER_URL.replace('/0', '')}`, 'ftp://host/FeatureServer/0']) {
			const error = await esri.fetchFeatures(badUrl).catch((e) => e);
			expect(error).toBeInstanceOf(GisError);
			expect(error.code).toBe('INVALID_ESRI_URL');
			expect(error.status).toBe(400);
		}
	});

	it('surfaces Esri error payloads returned with HTTP 200', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({ error: { message: 'Invalid query parameters' } }));

		const esri = new EsriModule();
		const error = await esri.fetchFeatures(LAYER_URL).catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PROVIDER_ERROR');
		expect(error.message).toContain('Invalid query parameters');
	});

	it('throws PROVIDER_ERROR on HTTP failures', async () => {
		const fetchMock = installFetchMock();
		fetchMock.mockResolvedValueOnce(jsonResponse({}, false, 404));

		const esri = new EsriModule();
		const error = await esri.fetchFeatures(LAYER_URL).catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PROVIDER_ERROR');
		expect(error.status).toBe(502);
	});
});
