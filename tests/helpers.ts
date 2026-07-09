export const jsonResponse = (body: unknown, ok = true, status = 200) => ({
	ok,
	status,
	json: async () => body,
	text: async () => JSON.stringify(body)
});

export const installFetchMock = (): jest.Mock => {
	const fetchMock = jest.fn();
	(global as unknown as { fetch: unknown }).fetch = fetchMock;
	return fetchMock;
};

export const buildPolylineShp = (lines: [number, number][][]): Buffer => {
	const allPoints = lines.flat();
	const xs = allPoints.map((p) => p[0]);
	const ys = allPoints.map((p) => p[1]);
	const bbox = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

	const numParts = lines.length;
	const numPoints = allPoints.length;
	const contentBytes = 4 + 32 + 4 + 4 + 4 * numParts + 16 * numPoints;
	const totalBytes = 100 + 8 + contentBytes;

	const buffer = Buffer.alloc(totalBytes);
	buffer.writeInt32BE(9994, 0);
	buffer.writeInt32BE(totalBytes / 2, 24);
	buffer.writeInt32LE(1000, 28);
	buffer.writeInt32LE(3, 32);
	buffer.writeDoubleLE(bbox[0], 36);
	buffer.writeDoubleLE(bbox[1], 44);
	buffer.writeDoubleLE(bbox[2], 52);
	buffer.writeDoubleLE(bbox[3], 60);

	let offset = 100;
	buffer.writeInt32BE(1, offset);
	buffer.writeInt32BE(contentBytes / 2, offset + 4);
	offset += 8;

	buffer.writeInt32LE(3, offset);
	offset += 4;
	buffer.writeDoubleLE(bbox[0], offset);
	buffer.writeDoubleLE(bbox[1], offset + 8);
	buffer.writeDoubleLE(bbox[2], offset + 16);
	buffer.writeDoubleLE(bbox[3], offset + 24);
	offset += 32;
	buffer.writeInt32LE(numParts, offset);
	buffer.writeInt32LE(numPoints, offset + 4);
	offset += 8;

	let pointIndex = 0;
	for (const line of lines) {
		buffer.writeInt32LE(pointIndex, offset);
		offset += 4;
		pointIndex += line.length;
	}

	for (const [x, y] of allPoints) {
		buffer.writeDoubleLE(x, offset);
		buffer.writeDoubleLE(y, offset + 8);
		offset += 16;
	}

	return buffer;
};
