import JSZip from 'jszip';
import { parsePlacemarks } from '../src/files';
import { GisError } from '../src/errors';

const kml = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
	<Document>
		<name>Downtown</name>
		${body}
	</Document>
</kml>`;

const FOLDERED_KML = kml(`
	<Folder>
		<name>Public Art</name>
		<Folder>
			<name>Murals</name>
			<Placemark id="mural-1">
				<name>River Mural</name>
				<description><![CDATA[<p>Painted in <b>2019</b>.</p><img src="https://example.org/mural.jpg" />]]></description>
				<address>12 Main St, Elyria, OH</address>
				<Point><coordinates>-82.1,41.36,0</coordinates></Point>
			</Placemark>
		</Folder>
	</Folder>
	<Folder>
		<name>Trails</name>
		<Placemark>
			<name>River Walk</name>
			<LineString><coordinates>-82.1,41.36,0 -82.11,41.37,0 -82.12,41.38,0</coordinates></LineString>
		</Placemark>
	</Folder>
	<Placemark>
		<name>Town Square</name>
		<Polygon><outerBoundaryIs><LinearRing>
			<coordinates>-82.0,41.0 -82.2,41.0 -82.2,41.2 -82.0,41.2 -82.0,41.0</coordinates>
		</LinearRing></outerBoundaryIs></Polygon>
	</Placemark>
	<Placemark>
		<name>No Geometry</name>
	</Placemark>
	<Placemark>
		<name>Bad Point</name>
		<Point><coordinates>-500,95,0</coordinates></Point>
	</Placemark>
`);

const buildKmz = async (entries: Record<string, string | Buffer>) => {
	const zip = new JSZip();
	for (const [name, content] of Object.entries(entries)) {
		zip.file(name, content);
	}
	return zip.generateAsync({ type: 'nodebuffer' });
};

describe('parsePlacemarks', () => {
	it('returns each placemark with its name, description, coordinates and folder path', async () => {
		const parsed = await parsePlacemarks('downtown.kml', Buffer.from(FOLDERED_KML));

		expect(parsed.format).toBe('kml');
		expect(parsed.skipped).toBe(2);
		expect(parsed.placemarks.map((placemark) => placemark.name)).toEqual(['River Mural', 'River Walk', 'Town Square']);

		const [mural] = parsed.placemarks;
		expect(mural).toMatchObject({
			id: 'mural-1',
			folder: ['Public Art', 'Murals'],
			geometryType: 'point',
			position: [-82.1, 41.36],
			lines: null,
			imageRefs: ['https://example.org/mural.jpg']
		});
		expect(mural.description).toContain('<b>2019</b>');
		expect(mural.properties.address).toBe('12 Main St, Elyria, OH');
	});

	it('keeps line strings as line geometry', async () => {
		const parsed = await parsePlacemarks('downtown.kml', Buffer.from(FOLDERED_KML));
		const walk = parsed.placemarks.find((placemark) => placemark.name === 'River Walk');

		expect(walk).toMatchObject({
			folder: ['Trails'],
			geometryType: 'line',
			position: null,
			lines: {
				type: 'MultiLineString',
				coordinates: [[[-82.1, 41.36], [-82.11, 41.37], [-82.12, 41.38]]]
			}
		});
	});

	it('places a polygon at the center of its outer ring', async () => {
		const parsed = await parsePlacemarks('downtown.kml', Buffer.from(FOLDERED_KML));
		const square = parsed.placemarks.find((placemark) => placemark.name === 'Town Square');

		expect(square?.geometryType).toBe('polygon');
		expect(square?.folder).toEqual([]);
		expect(square?.position?.[0]).toBeCloseTo(-82.1);
		expect(square?.position?.[1]).toBeCloseTo(41.1);
	});

	it('reads My Maps media links from extended data', async () => {
		const parsed = await parsePlacemarks('maps.kml', Buffer.from(kml(`
			<Placemark>
				<name>Library</name>
				<ExtendedData>
					<Data name="gx_media_links"><value>https://example.org/a.jpg https://example.org/b.jpg</value></Data>
				</ExtendedData>
				<Point><coordinates>-82.1,41.36</coordinates></Point>
			</Placemark>
		`)));

		expect(parsed.placemarks[0].imageRefs).toEqual(['https://example.org/a.jpg', 'https://example.org/b.jpg']);
	});

	it('extracts images a KMZ embeds and links them to their placemarks', async () => {
		const image = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
		const buffer = await buildKmz({
			'doc.kml': kml(`
				<Placemark>
					<name>Old Mill</name>
					<description><![CDATA[<img src="files/mill%20front.jpg"><img src="./files/MISSING.png">]]></description>
					<Point><coordinates>-82.1,41.36</coordinates></Point>
				</Placemark>
				<Placemark>
					<name>Mill Annex</name>
					<description><![CDATA[<img src="files/mill front.jpg">]]></description>
					<Point><coordinates>-82.2,41.36</coordinates></Point>
				</Placemark>
			`),
			'files/mill front.jpg': image
		});

		const parsed = await parsePlacemarks('mill.kmz', buffer);

		expect(parsed.format).toBe('kmz');
		expect(parsed.placemarks.map((placemark) => placemark.imageRefs)).toEqual([['files/mill front.jpg'], ['files/mill front.jpg']]);
		expect(parsed.images).toEqual([{ path: 'files/mill front.jpg', contentType: 'image/jpeg', data: image }]);
		expect(parsed.warnings).toEqual(['1 image reference(s) pointed at files that are not in the upload']);
	});

	it('skips embedded images over the size limit', async () => {
		const buffer = await buildKmz({
			'doc.kml': kml(`
				<Placemark>
					<name>Old Mill</name>
					<description><![CDATA[<img src="big.png">]]></description>
					<Point><coordinates>-82.1,41.36</coordinates></Point>
				</Placemark>
			`),
			'big.png': Buffer.alloc(2048)
		});

		const parsed = await parsePlacemarks('mill.kmz', buffer, { maxImageBytes: 1024 });

		expect(parsed.images).toEqual([]);
		expect(parsed.placemarks[0].imageRefs).toEqual([]);
		expect(parsed.warnings[0]).toContain('Skipped image "big.png"');
	});

	it('ignores ground overlays', async () => {
		const parsed = await parsePlacemarks('overlay.kml', Buffer.from(kml(`
			<GroundOverlay>
				<name>Old map</name>
				<Icon><href>map.png</href></Icon>
				<LatLonBox><north>41.4</north><south>41.3</south><east>-82.0</east><west>-82.2</west></LatLonBox>
			</GroundOverlay>
		`)));

		expect(parsed.placemarks).toEqual([]);
		expect(parsed.skipped).toBe(0);
	});

	it('rejects malformed KML', async () => {
		const error = await parsePlacemarks('broken.kml', Buffer.from('<kml><Document>')).catch((e) => e);

		expect(error).toBeInstanceOf(GisError);
		expect(error.code).toBe('PARSE_FAILED');
		expect(error.status).toBe(400);
	});

	it('rejects a KMZ without a KML document', async () => {
		const buffer = await buildKmz({ 'readme.txt': 'hello' });
		const error = await parsePlacemarks('empty.kmz', buffer).catch((e) => e);

		expect(error.code).toBe('PARSE_FAILED');
		expect(error.message).toBe('KMZ archive does not contain a .kml file');
	});

	it('rejects other file types', async () => {
		const error = await parsePlacemarks('trail.gpx', Buffer.from('<gpx />')).catch((e) => e);

		expect(error.code).toBe('UNSUPPORTED_FORMAT');
		expect(error.status).toBe(400);
	});
});
