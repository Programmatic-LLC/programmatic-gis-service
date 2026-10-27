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
	ParsedPlacemarks,
	ParsedSpatialFile,
	ParsePlacemarksOptions,
	Placemark,
	PlacemarkGeometryType,
	PlacemarkImage,
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

interface KmzArchive {
	zip: JSZip;
	kmlEntry: string;
	entryNames: string[];
}

const readKmzArchive = async (input: Buffer | Uint8Array): Promise<KmzArchive> => {
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

	return { zip, kmlEntry, entryNames };
};

export const parseKmz = async (input: Buffer | Uint8Array): Promise<ParsedSpatialFile> => {
	const { zip, kmlEntry } = await readKmzArchive(input);
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

const IMAGE_CONTENT_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp'
};

const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMG_SRC_PATTERN = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
const WEB_URL_PATTERN = /^https?:\/\//i;

interface FolderNode {
	type: 'folder';
	meta: Record<string, unknown>;
	children: TreeNode[];
}

type TreeNode = FolderNode | GeoJsonFeature;

interface FoundPlacemark {
	feature: GeoJsonFeature;
	folder: string[];
}

const textOf = (value: unknown): string | null => {
	if (value && typeof value === 'object' && 'value' in value) {
		return textOf((value as { value: unknown }).value);
	}
	if (value === null || value === undefined) {
		return null;
	}
	const text = String(value).trim();
	return text === '' ? null : text;
};

const collectPlacemarks = (children: TreeNode[], folder: string[], found: FoundPlacemark[]): void => {
	for (const child of children) {
		if (child.type === 'folder') {
			const folderNode = child as FolderNode;
			const name = textOf(folderNode.meta?.name);
			collectPlacemarks(folderNode.children, name ? [...folder, name] : folder, found);
			continue;
		}
		const feature = child as GeoJsonFeature;
		if (feature.properties?.['@geometry-type'] === 'groundoverlay') {
			continue;
		}
		found.push({ feature, folder });
	}
};

const toPosition = (position: unknown): Position | null => {
	if (!Array.isArray(position)) {
		return null;
	}
	const lon = Number(position[0]);
	const lat = Number(position[1]);
	if (!Number.isFinite(lon) || !Number.isFinite(lat) || Math.abs(lon) > 180 || Math.abs(lat) > 90) {
		return null;
	}
	return [lon, lat];
};

const ringCentroid = (ring: unknown): Position | null => {
	if (!Array.isArray(ring)) {
		return null;
	}
	const positions = ring.map(toPosition).filter((position): position is Position => position !== null);
	const last = positions[positions.length - 1];
	if (positions.length > 1 && last[0] === positions[0][0] && last[1] === positions[0][1]) {
		positions.pop();
	}
	if (positions.length === 0) {
		return null;
	}
	const lon = positions.reduce((sum, position) => sum + position[0], 0) / positions.length;
	const lat = positions.reduce((sum, position) => sum + position[1], 0) / positions.length;
	return [lon, lat];
};

const validLines = (geometry: GeoJsonGeometry): MultiLineStringGeometry | null => {
	const lines: Position[][] = [];
	collectLines(geometry, lines);
	const kept = lines
		.map((line) => line.map(toPosition).filter((position): position is Position => position !== null))
		.filter((line) => line.length >= 2);
	return kept.length > 0 ? { type: 'MultiLineString', coordinates: kept } : null;
};

const firstPoint = (geometry: GeoJsonGeometry): Position | null => {
	if (geometry.type === 'Point') {
		return toPosition(geometry.coordinates);
	}
	if (geometry.type === 'MultiPoint' && Array.isArray(geometry.coordinates)) {
		return toPosition(geometry.coordinates[0]);
	}
	if (geometry.type === 'GeometryCollection') {
		for (const nested of geometry.geometries ?? []) {
			const position = firstPoint(nested);
			if (position) {
				return position;
			}
		}
	}
	return null;
};

const polygonCentroid = (geometry: GeoJsonGeometry): Position | null => {
	if (geometry.type === 'Polygon' && Array.isArray(geometry.coordinates)) {
		return ringCentroid(geometry.coordinates[0]);
	}
	if (geometry.type === 'MultiPolygon' && Array.isArray(geometry.coordinates)) {
		const [firstPolygon] = geometry.coordinates as unknown[][];
		return Array.isArray(firstPolygon) ? ringCentroid(firstPolygon[0]) : null;
	}
	if (geometry.type === 'GeometryCollection') {
		for (const nested of geometry.geometries ?? []) {
			const position = polygonCentroid(nested);
			if (position) {
				return position;
			}
		}
	}
	return null;
};

const classifyGeometry = (
	geometry: GeoJsonGeometry | null
): { geometryType: PlacemarkGeometryType; position: Position | null; lines: MultiLineStringGeometry | null } | null => {
	if (!geometry) {
		return null;
	}
	const lines = validLines(geometry);
	if (lines) {
		return { geometryType: 'line', position: null, lines };
	}
	const point = firstPoint(geometry);
	if (point) {
		return { geometryType: 'point', position: point, lines: null };
	}
	const centroid = polygonCentroid(geometry);
	if (centroid) {
		return { geometryType: 'polygon', position: centroid, lines: null };
	}
	return null;
};

const findImageRefs = (description: string | null, properties: Record<string, unknown>): string[] => {
	const refs: string[] = [];
	for (const match of (description ?? '').matchAll(IMG_SRC_PATTERN)) {
		refs.push(match[1].trim());
	}
	const mediaLinks = textOf(properties.gx_media_links);
	if (mediaLinks) {
		refs.push(...mediaLinks.split(/\s+/));
	}
	return [...new Set(refs.filter(Boolean))];
};

const archivePathFor = (ref: string, kmlEntry: string, entriesByLowerName: Map<string, string>): string | null => {
	let path = ref.split(/[?#]/)[0];
	try {
		path = decodeURIComponent(path);
	} catch {
		return null;
	}
	path = path.replace(/^\.\//, '').replace(/^\/+/, '');
	const kmlDirectory = kmlEntry.includes('/') ? kmlEntry.slice(0, kmlEntry.lastIndexOf('/') + 1) : '';
	return (
		entriesByLowerName.get(`${kmlDirectory}${path}`.toLowerCase()) ??
		entriesByLowerName.get(path.toLowerCase()) ??
		null
	);
};

const uncompressedSize = (file: JSZip.JSZipObject): number | null => {
	const size = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize;
	return typeof size === 'number' ? size : null;
};

const extractImage = async (
	zip: JSZip,
	path: string,
	maxImageBytes: number,
	warnings: string[]
): Promise<PlacemarkImage | null> => {
	const contentType = IMAGE_CONTENT_TYPES[path.toLowerCase().split('.').pop() ?? ''];
	if (!contentType) {
		return null;
	}
	const file = zip.files[path];
	const declaredSize = uncompressedSize(file);
	if (declaredSize !== null && declaredSize > maxImageBytes) {
		warnings.push(`Skipped image "${path}" because it is larger than ${maxImageBytes} bytes`);
		return null;
	}
	const data = await file.async('nodebuffer');
	if (data.length > maxImageBytes) {
		warnings.push(`Skipped image "${path}" because it is larger than ${maxImageBytes} bytes`);
		return null;
	}
	return { path, contentType, data };
};

const buildPlacemarks = async (
	format: 'kml' | 'kmz',
	doc: Document,
	archive: KmzArchive | null,
	options: ParsePlacemarksOptions
): Promise<ParsedPlacemarks> => {
	const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES;
	const warnings: string[] = [];
	const found: FoundPlacemark[] = [];
	collectPlacemarks(togeojson.kmlWithFolders(doc).children as TreeNode[], [], found);

	const entriesByLowerName = new Map((archive?.entryNames ?? []).map((name) => [name.toLowerCase(), name]));
	const images = new Map<string, PlacemarkImage | null>();
	const placemarks: Placemark[] = [];
	let skipped = 0;
	let unresolvedImages = 0;

	for (const { feature, folder } of found) {
		const geometry = classifyGeometry(feature.geometry);
		if (!geometry) {
			skipped++;
			continue;
		}

		const properties = feature.properties ?? {};
		const description = textOf(properties.description);
		const imageRefs: string[] = [];

		for (const ref of findImageRefs(description, properties)) {
			if (WEB_URL_PATTERN.test(ref)) {
				imageRefs.push(ref);
				continue;
			}
			const path = archive ? archivePathFor(ref, archive.kmlEntry, entriesByLowerName) : null;
			if (!archive || !path) {
				unresolvedImages++;
				continue;
			}
			if (!images.has(path)) {
				images.set(path, await extractImage(archive.zip, path, maxImageBytes, warnings));
			}
			if (images.get(path)) {
				imageRefs.push(path);
			}
		}

		placemarks.push({
			id: feature.id === undefined || feature.id === null ? null : String(feature.id),
			name: textOf(properties.name),
			description,
			folder,
			...geometry,
			imageRefs: [...new Set(imageRefs)],
			properties
		});
	}

	if (unresolvedImages > 0) {
		warnings.push(`${unresolvedImages} image reference(s) pointed at files that are not in the upload`);
	}

	return {
		format,
		placemarks,
		images: [...images.values()].filter((image): image is PlacemarkImage => image !== null),
		skipped,
		warnings
	};
};

export const parsePlacemarks = async (
	fileName: string,
	input: Buffer | Uint8Array,
	options: ParsePlacemarksOptions = {}
): Promise<ParsedPlacemarks> => {
	const extension = (fileName ?? '').toLowerCase().split('.').pop() ?? '';

	if (extension === 'kml') {
		return buildPlacemarks('kml', parseXmlDocument(toBuffer(input), 'KML'), null, options);
	}

	if (extension === 'kmz') {
		const archive = await readKmzArchive(input);
		const kmlText = await archive.zip.files[archive.kmlEntry].async('string');
		return buildPlacemarks('kmz', parseXmlDocument(kmlText, 'KML'), archive, options);
	}

	throw new GisError('UNSUPPORTED_FORMAT', `Unsupported file type: .${extension} (expected .kml or .kmz)`, 400);
};

export const files = {
	parseGeoJson,
	parseGpx,
	parseKml,
	parseKmz,
	parseShapefile,
	detectAndParse,
	parsePlacemarks,
	extractLineGeometry,
	countPoints
};

export type FilesModule = typeof files;
