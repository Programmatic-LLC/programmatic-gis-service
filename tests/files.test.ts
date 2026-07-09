import JSZip from 'jszip';
import {
	countPoints,
	detectAndParse,
	extractLineGeometry,
	parseGeoJson,
	parseGpx,
	parseKml,
	parseKmz
} from '../src/files';
import { GisError } from '../src/errors';
import { FeatureCollection } from '../src/types';

const GPX_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1">
	<trk>
		<name>Test Trail</name>
		<trkseg>
			<trkpt lat="39.9" lon="-75.1"><ele>10</ele></trkpt>
			<trkpt lat="39.901" lon="-75.101"><ele>12</ele></trkpt>
			<trkpt lat="39.902" lon="-75.102"><ele>14</ele></trkpt>
		</trkseg>
	</trk>
</gpx>`;

const KML_FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
	<Document>
		<Placemark>
			<name>Test Trail</name>
			<LineString>
				<coordinates>-75.1,39.9,0 -75.101,39.901,0 -75.102,39.902,0</coordinates>
			</LineString>
		</Placemark>
	</Document>
</kml>`;

describe('parseGeoJson', () => {
	it('accepts a FeatureCollection', () => {
		const input = JSON.stringify({
			type: 'FeatureCollection',
			features: [
				{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] }, properties: {} }
			]
		});

		const result = parseGeoJson(input);
		expect(result.format).toBe('geojson');
		expect(result.featureCollection.features).toHaveLength(1);
	});

	it('wraps a bare LineString geometry', () => {
		const input = JSON.stringify({ type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] });
		const result = parseGeoJson(input);
		expect(result.featureCollection.features[0].geometry?.type).toBe('LineString');
	});

	it('wraps a bare MultiLineString geometry', () => {
		const input = JSON.stringify({ type: 'MultiLineString', coordinates: [[[-75.1, 39.9], [-75.101, 39.901]]] });
		const result = parseGeoJson(input);
		expect(result.featureCollection.features[0].geometry?.type).toBe('MultiLineString');
	});

	it('wraps a single Feature', () => {
		const input = JSON.stringify({
			type: 'Feature',
			geometry: { type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] },
			properties: { name: 'x' }
		});
		const result = parseGeoJson(input);
		expect(result.featureCollection.features).toHaveLength(1);
	});

	it('rejects invalid JSON', () => {
		expect(() => parseGeoJson('not json {')).toThrow(GisError);
		try {
			parseGeoJson('not json {');
		} catch (error) {
			expect((error as GisError).code).toBe('PARSE_FAILED');
			expect((error as GisError).status).toBe(400);
		}
	});

	it('rejects JSON that is not GeoJSON', () => {
		try {
			parseGeoJson(JSON.stringify({ hello: 'world' }));
			throw new Error('should have thrown');
		} catch (error) {
			expect((error as GisError).code).toBe('PARSE_FAILED');
		}
	});
});

describe('parseGpx', () => {
	it('parses GPX tracks into line features', () => {
		const result = parseGpx(GPX_FIXTURE);
		expect(result.format).toBe('gpx');
		const lineFeature = result.featureCollection.features.find((f) => f.geometry?.type === 'LineString');
		expect(lineFeature).toBeDefined();
	});

	it('rejects malformed XML', () => {
		try {
			parseGpx('<gpx><unclosed');
			throw new Error('should have thrown');
		} catch (error) {
			expect((error as GisError).code).toBe('PARSE_FAILED');
		}
	});
});

describe('parseKml', () => {
	it('parses KML placemarks into line features', () => {
		const result = parseKml(KML_FIXTURE);
		expect(result.format).toBe('kml');
		const lineFeature = result.featureCollection.features.find((f) => f.geometry?.type === 'LineString');
		expect(lineFeature).toBeDefined();
	});
});

describe('parseKmz', () => {
	it('parses a KMZ archive containing doc.kml', async () => {
		const zip = new JSZip();
		zip.file('doc.kml', KML_FIXTURE);
		const buffer = await zip.generateAsync({ type: 'nodebuffer' });

		const result = await parseKmz(buffer);
		expect(result.format).toBe('kmz');
		const lineFeature = result.featureCollection.features.find((f) => f.geometry?.type === 'LineString');
		expect(lineFeature).toBeDefined();
	});

	it('falls back to any .kml entry', async () => {
		const zip = new JSZip();
		zip.file('some-folder/trail.kml', KML_FIXTURE);
		const buffer = await zip.generateAsync({ type: 'nodebuffer' });

		const result = await parseKmz(buffer);
		expect(result.featureCollection.features.length).toBeGreaterThan(0);
	});

	it('rejects archives without KML', async () => {
		const zip = new JSZip();
		zip.file('readme.txt', 'hello');
		const buffer = await zip.generateAsync({ type: 'nodebuffer' });

		const error = await parseKmz(buffer).catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PARSE_FAILED');
	});

	it('rejects non-zip input', async () => {
		const error = await parseKmz(Buffer.from('plain text')).catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PARSE_FAILED');
	});
});

describe('detectAndParse', () => {
	it('routes by file extension', async () => {
		const geojson = JSON.stringify({ type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] });
		expect((await detectAndParse('trail.geojson', Buffer.from(geojson))).format).toBe('geojson');
		expect((await detectAndParse('trail.json', Buffer.from(geojson))).format).toBe('geojson');
		expect((await detectAndParse('trail.gpx', Buffer.from(GPX_FIXTURE))).format).toBe('gpx');
		expect((await detectAndParse('trail.KML', Buffer.from(KML_FIXTURE))).format).toBe('kml');
	});

	it('rejects unsupported extensions', async () => {
		const error = await detectAndParse('trail.pdf', Buffer.from('x')).catch((e) => e);
		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('UNSUPPORTED_FORMAT');
		expect(error.status).toBe(400);
	});
});

describe('extractLineGeometry', () => {
	it('merges LineString and MultiLineString features into one MultiLineString', () => {
		const featureCollection: FeatureCollection = {
			type: 'FeatureCollection',
			features: [
				{ type: 'Feature', geometry: { type: 'Point', coordinates: [-75, 39] }, properties: {} },
				{ type: 'Feature', geometry: { type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] }, properties: {} },
				{
					type: 'Feature',
					geometry: { type: 'MultiLineString', coordinates: [[[-75.2, 39.8], [-75.201, 39.801]], [[-75.3, 39.7], [-75.301, 39.701]]] },
					properties: {}
				}
			]
		};

		const geometry = extractLineGeometry(featureCollection);
		expect(geometry.type).toBe('MultiLineString');
		expect(geometry.coordinates).toHaveLength(3);
		expect(countPoints(geometry)).toBe(6);
	});

	it('strips elevation to produce 2D coordinates', () => {
		const parsed = parseGpx(GPX_FIXTURE);
		const geometry = extractLineGeometry(parsed.featureCollection);

		expect(geometry.coordinates[0].every((position) => position.length === 2)).toBe(true);
		expect(geometry.coordinates[0][0]).toEqual([-75.1, 39.9]);
	});

	it('collects lines nested in GeometryCollections', () => {
		const featureCollection: FeatureCollection = {
			type: 'FeatureCollection',
			features: [
				{
					type: 'Feature',
					geometry: {
						type: 'GeometryCollection',
						geometries: [{ type: 'LineString', coordinates: [[-75.1, 39.9], [-75.101, 39.901]] }]
					},
					properties: {}
				}
			]
		};

		const geometry = extractLineGeometry(featureCollection);
		expect(geometry.coordinates).toHaveLength(1);
	});

	it('throws NO_LINE_GEOMETRY when only points exist', () => {
		const featureCollection: FeatureCollection = {
			type: 'FeatureCollection',
			features: [{ type: 'Feature', geometry: { type: 'Point', coordinates: [-75, 39] }, properties: {} }]
		};

		try {
			extractLineGeometry(featureCollection);
			throw new Error('should have thrown');
		} catch (error) {
			expect((error as GisError).code).toBe('NO_LINE_GEOMETRY');
			expect((error as GisError).status).toBe(400);
		}
	});
});
