import JSZip from 'jszip';
import proj4 from 'proj4';
import { parseShapefile, extractLineGeometry } from '../src/files';
import { GisError } from '../src/errors';
import { buildPolylineShp } from './helpers';

const UTM_18N_PRJ =
	'PROJCS["WGS_1984_UTM_Zone_18N",GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-75.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';

const WGS84_PRJ =
	'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

const LON_LAT_LINE: [number, number][] = [
	[-75.1, 39.9],
	[-75.101, 39.901],
	[-75.102, 39.902]
];

const zipEntries = async (entries: Record<string, Buffer | string>): Promise<Buffer> => {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(entries)) {
		zip.file(name, content);
	}
	return zip.generateAsync({ type: 'nodebuffer' });
};

describe('parseShapefile', () => {
	it('parses a WGS84 polyline shapefile', async () => {
		const shp = buildPolylineShp([LON_LAT_LINE]);
		const buffer = await zipEntries({ 'trail.shp': shp, 'trail.prj': WGS84_PRJ });

		const result = await parseShapefile(buffer);
		expect(result.format).toBe('shapefile');

		const geometry = extractLineGeometry(result.featureCollection);
		expect(geometry.coordinates[0][0][0]).toBeCloseTo(-75.1, 6);
		expect(geometry.coordinates[0][0][1]).toBeCloseTo(39.9, 6);
	});

	it('reprojects projected coordinates to WGS84 using the .prj', async () => {
		const converter = proj4(UTM_18N_PRJ, 'EPSG:4326');
		const projectedLine = LON_LAT_LINE.map(([lon, lat]) => converter.inverse([lon, lat]) as [number, number]);
		const shp = buildPolylineShp([projectedLine]);
		const buffer = await zipEntries({ 'trail.shp': shp, 'trail.prj': UTM_18N_PRJ });

		const result = await parseShapefile(buffer);
		const geometry = extractLineGeometry(result.featureCollection);

		expect(geometry.coordinates[0][0][0]).toBeCloseTo(-75.1, 5);
		expect(geometry.coordinates[0][0][1]).toBeCloseTo(39.9, 5);
		expect(geometry.coordinates[0][2][0]).toBeCloseTo(-75.102, 5);
		expect(geometry.coordinates[0][2][1]).toBeCloseTo(39.902, 5);
	});

	it('warns when no .prj is present and assumes WGS84', async () => {
		const shp = buildPolylineShp([LON_LAT_LINE]);
		const buffer = await zipEntries({ 'trail.shp': shp });

		const result = await parseShapefile(buffer);
		expect(result.warnings.some((warning) => warning.includes('No .prj'))).toBe(true);

		const geometry = extractLineGeometry(result.featureCollection);
		expect(geometry.coordinates[0][0][0]).toBeCloseTo(-75.1, 6);
	});

	it('prefers the line-bearing layer and warns when multiple layers exist', async () => {
		const lineShp = buildPolylineShp([LON_LAT_LINE]);
		const otherShp = buildPolylineShp([[[-1, 1], [-2, 2]]]);
		const buffer = await zipEntries({
			'a-first.shp': otherShp,
			'b-lines.shp': lineShp,
			'b-lines.prj': WGS84_PRJ
		});

		const result = await parseShapefile(buffer);
		expect(result.warnings.some((warning) => warning.includes('2 shapefile layers'))).toBe(true);
	});

	it('rejects archives without a .shp', async () => {
		const buffer = await zipEntries({ 'readme.txt': 'hello' });
		const error = await parseShapefile(buffer).catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PARSE_FAILED');
		expect(error.message).toContain('.shp');
	});
});
