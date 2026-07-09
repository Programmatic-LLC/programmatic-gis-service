import { GeocodingModule } from './geocoding';
import { RoutingModule } from './routing';
import { GeolocationModule } from './geolocation';
import { EsriModule } from './esri';
import { files, FilesModule } from './files';
import { GisServiceConfig } from './types';

export class GisService {
	geocoding: GeocodingModule;
	routing: RoutingModule;
	geolocation: GeolocationModule;
	esri: EsriModule;
	files: FilesModule;

	constructor(config: GisServiceConfig = {}) {
		this.geocoding = new GeocodingModule(config);
		this.routing = new RoutingModule(config);
		this.geolocation = new GeolocationModule(config);
		this.esri = new EsriModule(config);
		this.files = files;
	}
}

export { GeocodingModule } from './geocoding';
export {
	RoutingModule,
	haversineMeters,
	resolveLegMode,
	DEFAULT_WALK_THRESHOLD_METERS,
	DEFAULT_DRIVE_SHORT_THRESHOLD_METERS
} from './routing';
export { GeolocationModule, isPrivateIp } from './geolocation';
export { EsriModule, normalizeLayerUrl } from './esri';
export {
	files,
	parseGeoJson,
	parseGpx,
	parseKml,
	parseKmz,
	parseShapefile,
	detectAndParse,
	extractLineGeometry,
	countPoints
} from './files';
export type { FilesModule } from './files';
export { GisError } from './errors';
export type { GisErrorCode } from './errors';
export * from './types';
