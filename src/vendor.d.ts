declare module 'shapefile' {
	export function read(
		shp: ArrayBuffer | Uint8Array,
		dbf?: ArrayBuffer | Uint8Array,
		options?: Record<string, unknown>
	): Promise<{ type: 'FeatureCollection'; features: unknown[]; bbox?: number[] }>;
}
