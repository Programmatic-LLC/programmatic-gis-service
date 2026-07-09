import { DOMParser } from '@xmldom/xmldom';
import * as togeojson from '@tmcw/togeojson';
import JSZip from 'jszip';
import * as shapefileLib from 'shapefile';
import proj4 from 'proj4';
import { GisError } from './errors';
import {
	FeatureCollection,
	GeoJsonFeature,
	GeoJsonGeometry,
	MultiLineStringGeometry,
	ParsedSpatialFile,
	Position
} from './types';

const toText = (input: string | Buffer | Uint8Array): string =>
	typeof input === 'string' ? input : Buffer.from(input).toString('utf8');

const toBuffer = (input: string | Buffer | Uint8Array): Buffer =>
	typeof input === 'string' ? Buffer.from(input) : Buffer.from(input);

const GEOMETRY_TYPES = new Set([
	'Point',
	'MultiPoint',
	'LineString',
	'MultiLineString',
	'Polygon',
	'MultiPolygon',
	'GeometryCollection'
]);

const normalizeToFeatureCollection = (data: unknown): FeatureCollection | null => {
	if (!data || typeof data !== 'object') {
		return null;
	}

	const candidate = data as Record<string, unknown>;

	if (candidate.type === 'FeatureCollection' && Array.isArray(candidate.features)) {
		return candidate as unknown as FeatureCollection;
	}

	if (candidate.type === 'Feature' && 'geometry' in candidate) {
		return { type: 'FeatureCollection', features: [candidate as unknown as GeoJsonFeature] };
	}

	if (typeof candidate.type === 'string' && GEOMETRY_TYPES.has(candidate.type)) {
		return {
			type: 'FeatureCollection',
			features: [{ type: 'Feature', geometry: candidate as unknown as GeoJsonGeometry, properties: {} }]
		};
	}

	return null;
};

export const parseGeoJson = (input: string | Buffer): ParsedSpatialFile => {
	let data: unknown;
	try {
		data = JSON.parse(toText(input));
	} catch {
		throw new GisError('PARSE_FAILED', 'File is not valid JSON', 400);
	}

	const featureCollection = normalizeToFeatureCollection(data);
	if (!featureCollection) {
		throw new GisError('PARSE_FAILED', 'File is not valid GeoJSON (expected a FeatureCollection, Feature, or geometry)', 400);
	}

	return { format: 'geojson', featureCollection, warnings: [] };
};

const parseXmlDocument = (input: string | Buffer, formatLabel: string): Document => {
	let doc: unknown;
	try {
		doc = new DOMParser({
			onError: (level, message) => {
				if (level === 'fatalError') {
					throw new Error(message);
				}
			}
		}).parseFromString(toText(input), 'text/xml');
	} catch {
		throw new GisError('PARSE_FAILED', `File is not valid ${formatLabel} (XML parsing failed)`, 400);
	}

	const parsed = doc as { documentElement?: unknown };
	if (!parsed || !parsed.documentElement) {
		throw new GisError('PARSE_FAILED', `File is not valid ${formatLabel} (XML parsing failed)`, 400);
	}

	return doc as Document;
};

export const parseGpx = (input: string | Buffer): ParsedSpatialFile => {
	const doc = parseXmlDocument(input, 'GPX');
	const featureCollection = togeojson.gpx(doc) as unknown as FeatureCollection;
	return { format: 'gpx', featureCollection, warnings: [] };
};

export const parseKml = (input: string | Buffer): ParsedSpatialFile => {
	const doc = parseXmlDocument(input, 'KML');
	const featureCollection = togeojson.kml(doc) as unknown as FeatureCollection;
	return { format: 'kml', featureCollection, warnings: [] };
};

export const parseKmz = async (input: Buffer | Uint8Array): Promise<ParsedSpatialFile> => {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(toBuffer(input));
	} catch {
		throw new GisError('PARSE_FAILED', 'File is not a valid KMZ archive', 400);
	}

	const entryNames = Object.keys(zip.files).filter(
		(name) => !zip.files[name].dir && !name.startsWith('__MACOSX/')
	);
	const kmlEntry =
		entryNames.find((name) => name.toLowerCase() === 'doc.kml') ??
		entryNames.find((name) => name.toLowerCase().endsWith('.kml'));

	if (!kmlEntry) {
		throw new GisError('PARSE_FAILED', 'KMZ archive does not contain a .kml file', 400);
	}

	const kmlText = await zip.files[kmlEntry].async('string');
	const parsed = parseKml(kmlText);
	return { ...parsed, format: 'kmz' };
};

const isGeographicPrj = (prjWkt: string): boolean => /^\s*GEOGCS/i.test(prjWkt);

const transformPositions = (coordinates: unknown, transform: (position: Position) => Position): unknown => {
	if (!Array.isArray(coordinates)) {
		return coordinates;
	}
	if (typeof coordinates[0] === 'number') {
		return transform(coordinates as Position);
	}
	return coordinates.map((nested) => transformPositions(nested, transform));
};

const reprojectFeatureCollection = (
	featureCollection: FeatureCollection,
	prjWkt: string,
	warnings: string[]
): FeatureCollection => {
	if (isGeographicPrj(prjWkt)) {
		return featureCollection;
	}

	let converter: proj4.Converter;
	try {
		converter = proj4(prjWkt, 'EPSG:4326');
	} catch {
		warnings.push('Could not interpret the .prj projection; coordinates were assumed to be WGS84');
		return featureCollection;
	}

	const transform = (position: Position): Position => {
		const [x, y] = position;
		const [lon, lat] = converter.forward([x, y]);
		return [lon, lat];
	};

	const features = featureCollection.features.map((feature) => {
		if (!feature.geometry || feature.geometry.coordinates === undefined) {
			return feature;
		}
		return {
			...feature,
			geometry: {
				...feature.geometry,
				coordinates: transformPositions(feature.geometry.coordinates, transform)
			}
		};
	});

	return { ...featureCollection, features };
};

const hasLineFeatures = (featureCollection: FeatureCollection): boolean =>
	featureCollection.features.some(
		(feature) => feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString'
	);

export const parseShapefile = async (input: Buffer | Uint8Array): Promise<ParsedSpatialFile> => {
	let zip: JSZip;
	try {
		zip = await JSZip.loadAsync(toBuffer(input));
	} catch {
		throw new GisError('PARSE_FAILED', 'File is not a valid zip archive', 400);
	}

	const entryNames = Object.keys(zip.files).filter(
		(name) => !zip.files[name].dir && !name.startsWith('__MACOSX/') && !name.split('/').pop()?.startsWith('.')
	);
	const shpNames = entryNames.filter((name) => name.toLowerCase().endsWith('.shp'));

	if (shpNames.length === 0) {
		throw new GisError('PARSE_FAILED', 'Zip archive does not contain a .shp file', 400);
	}

	const warnings: string[] = [];
	const layers: { name: string; featureCollection: FeatureCollection }[] = [];

	for (const shpName of shpNames) {
		const baseName = shpName.slice(0, -4);
		const findSibling = (extension: string) =>
			entryNames.find((name) => name.toLowerCase() === `${baseName.toLowerCase()}${extension}`);

		const shpBuffer = await zip.files[shpName].async('uint8array');
		const dbfName = findSibling('.dbf');
		const dbfBuffer = dbfName ? await zip.files[dbfName].async('uint8array') : undefined;
		const prjName = findSibling('.prj');
		const prjWkt = prjName ? await zip.files[prjName].async('string') : null;

		let featureCollection: FeatureCollection;
		try {
			featureCollection = (await shapefileLib.read(shpBuffer, dbfBuffer)) as unknown as FeatureCollection;
		} catch {
			throw new GisError('PARSE_FAILED', `Could not read shapefile layer "${shpName}"`, 400);
		}

		if (prjWkt) {
			featureCollection = reprojectFeatureCollection(featureCollection, prjWkt, warnings);
		} else {
			warnings.push(`No .prj found for "${shpName}"; coordinates were assumed to be WGS84`);
		}

		layers.push({ name: shpName, featureCollection });
	}

	const selected = layers.find((layer) => hasLineFeatures(layer.featureCollection)) ?? layers[0];
	if (layers.length > 1) {
		warnings.push(`Zip archive contains ${layers.length} shapefile layers; using "${selected.name}"`);
	}

	return { format: 'shapefile', featureCollection: selected.featureCollection, warnings };
};

export const detectAndParse = async (fileName: string, input: Buffer | Uint8Array): Promise<ParsedSpatialFile> => {
	const extension = (fileName ?? '').toLowerCase().split('.').pop() ?? '';

	switch (extension) {
		case 'geojson':
		case 'json':
			return parseGeoJson(toBuffer(input));
		case 'gpx':
			return parseGpx(toBuffer(input));
		case 'kml':
			return parseKml(toBuffer(input));
		case 'kmz':
			return parseKmz(input);
		case 'zip':
			return parseShapefile(input);
		default:
			throw new GisError('UNSUPPORTED_FORMAT', `Unsupported file type: .${extension}`, 400);
	}
};

const collectLines = (geometry: GeoJsonGeometry | null | undefined, lines: Position[][]): void => {
	if (!geometry) {
		return;
	}

	if (geometry.type === 'LineString' && Array.isArray(geometry.coordinates)) {
		lines.push((geometry.coordinates as Position[]).map((position) => [Number(position[0]), Number(position[1])]));
		return;
	}

	if (geometry.type === 'MultiLineString' && Array.isArray(geometry.coordinates)) {
		for (const line of geometry.coordinates as Position[][]) {
			lines.push(line.map((position) => [Number(position[0]), Number(position[1])]));
		}
		return;
	}

	if (geometry.type === 'GeometryCollection' && Array.isArray(geometry.geometries)) {
		for (const nested of geometry.geometries) {
			collectLines(nested, lines);
		}
	}
};

export const extractLineGeometry = (featureCollection: FeatureCollection): MultiLineStringGeometry => {
	const lines: Position[][] = [];

	for (const feature of featureCollection.features ?? []) {
		collectLines(feature.geometry, lines);
	}

	if (lines.length === 0) {
		throw new GisError('NO_LINE_GEOMETRY', 'No line geometry (LineString or MultiLineString) was found', 400);
	}

	return { type: 'MultiLineString', coordinates: lines };
};

export const countPoints = (geometry: MultiLineStringGeometry): number =>
	geometry.coordinates.reduce((sum, line) => sum + line.length, 0);

export const files = {
	parseGeoJson,
	parseGpx,
	parseKml,
	parseKmz,
	parseShapefile,
	detectAndParse,
	extractLineGeometry,
	countPoints
};

export type FilesModule = typeof files;
