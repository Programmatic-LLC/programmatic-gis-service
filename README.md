# programmatic-gis-service

Spatial processing library for Programmatic services. Wraps all provider-facing GIS work — geocoding, routing, IP geolocation, spatial file parsing, and Esri REST feature service ingestion — behind normalized, GeoJSON-first types so any consuming service can create and process the same shapes.

No hosted service required: install it straight from GitHub as an npm dependency. TypeScript source compiles to CommonJS with type declarations, so it works unchanged in plain-JS CommonJS projects (Node 18+; uses global `fetch`).

## Install

```bash
npm install git+ssh://git@github.com/Programmatic-LLC/programmatic-gis-service.git#v1.0.0
```

Pin to a tag for reproducible builds. Installing from git runs the `prepare` script, which compiles `dist/` automatically.

In `package.json`:

```json
{
  "dependencies": {
    "programmatic-gis-service": "git+ssh://git@github.com/Programmatic-LLC/programmatic-gis-service.git#v1.0.0"
  }
}
```

> CI/deploy environments (e.g. Render) need read access to this repository — an SSH deploy key or a machine-user token — for `npm install` to succeed while the repo is private.

## Configuration

The library never reads environment variables. Pass configuration explicitly:

```js
const { GisService } = require('programmatic-gis-service');

const gis = new GisService({
  geoapifyApiKey: process.env.GEOAPIFY_API_KEY,
  mapboxApiKey: process.env.MAPBOX_API_KEY,
  logger,
  autocompleteLimit: 5,
  routing: {
    walkThresholdMeters: 800,
    driveShortThresholdMeters: 200
  }
});
```

| Option | Default | Used by |
| --- | --- | --- |
| `geoapifyApiKey` | — | `geocoding.autocomplete`, `routing`, `geolocation` |
| `mapboxApiKey` | — | `geocoding.geocodePermanent` |
| `logger` | no-op | all modules; any object with `info(obj)` / `warn(obj)` (pino-compatible) |
| `autocompleteLimit` | `5` | `geocoding.autocomplete` |
| `routing.walkThresholdMeters` | `800` | leg-mode auto-suggestion in `buildMixedModeRoute` |
| `routing.driveShortThresholdMeters` | `200` | leg-mode auto-suggestion in `buildMixedModeRoute` |

Modules that need no keys (`files`, `esri`) also work standalone via named exports:

```js
const { detectAndParse, extractLineGeometry, EsriModule } = require('programmatic-gis-service');
```

## Errors

Every failure throws a `GisError` with a machine-readable `code`, a suggested HTTP `status`, and optional `details`:

```js
const { GisError } = require('programmatic-gis-service');

try {
  await gis.routing.route(waypoints, 'walk');
} catch (err) {
  if (err instanceof GisError && err.code === 'ROUTE_TOO_LONG') {
    // err.status === 400, err.message === 'Destinations are too far apart.'
  }
}
```

Codes: `INVALID_INPUT`, `MISSING_API_KEY`, `PROVIDER_ERROR`, `NO_RESULTS`, `ROUTE_TOO_LONG`, `UNSUPPORTED_FORMAT`, `PARSE_FAILED`, `NO_LINE_GEOMETRY`, `INVALID_ESRI_URL`.

## Modules

### `gis.geocoding`

Two-stage geocoding: temporary (display-only) suggestions from Geoapify, then a permanent Mapbox geocode of the user's selection. Only the permanent result may be stored — Mapbox's `permanent=true` parameter is what licenses coordinate storage.

```js
const suggestions = await gis.geocoding.autocomplete('123 Main St');
// -> raw Geoapify response: { results: AddressSuggestion[] } — never persist these

const address = await gis.geocoding.geocodePermanent(suggestions.results[0]);
// -> GeocodedAddress:
// {
//   attribution, mapboxId, name,
//   addressLine1, addressLine2,
//   city, state, postalCode, country,
//   latitude, longitude
// }
```

`geocodePermanent` requests entrance points (`entrances=true`) and prefers the `entrance` routable point, then `default`, over the raw rooftop coordinate — the returned lat/lon is the best routable location.

### `gis.routing`

Geoapify routing with imperial units, plus the mixed-mode tour route builder.

```js
const route = await gis.routing.route([{ lat, lon }, { lat, lon }], 'walk');
// -> { distanceMiles, durationSeconds, geometry, legs, raw, mode }
// modes: 'walk' | 'drive' | 'bicycle'
// pass rawOutput=true as the third argument for the untouched provider payload

const tourRoute = await gis.routing.buildMixedModeRoute({
  orderedWaypoints,
  legOverrides,
  baseMode: 'walk',
  onWrapError: (err) => {}
});
// -> TourRouteResult: { mode, distanceMiles, durationSeconds, waypoints, legs, geom }
```

`buildMixedModeRoute` behavior:
- Resolves a mode per leg: an explicit override wins; otherwise legs longer than `walkThresholdMeters` auto-suggest `drive` (unless the base mode is already drive) and drive legs shorter than `driveShortThresholdMeters` auto-suggest `walk`. Auto-suggested legs carry `autoSuggested: true`.
- Batches consecutive same-mode legs into one provider call and apportions the run's mileage across legs (`distanceMiles` per leg).
- Detects circular tours (first waypoint equals last) and marks the closing leg `isReturn: true`; for non-circular tours it appends a wrap-around return leg from the last waypoint back to the first, also marked `isReturn: true`. Wrap-around failures are swallowed (reported via `onWrapError`) so the forward path still returns.
- `distanceMiles`/`durationSeconds` totals are forward-only — the return leg is excluded.
- `geom` is a single GeoJSON `MultiLineString` combining every routed segment.

Pure helpers are exported too: `haversineMeters(a, b)`, `resolveLegMode(from, to, override, baseMode, thresholds?)`.

### `gis.geolocation`

```js
const location = await gis.geolocation.lookupIp(clientIp);
// -> { isUnitedStates, countryCode, isPrivate, raw? }
```

Private/loopback IPs (RFC1918, `127.*`, `::1`, link-local, unique-local) short-circuit to `{ isUnitedStates: true, isPrivate: true }` without a provider call. `isPrivateIp(ip)` is exported standalone.

### `gis.files`

Spatial file parsers. Every parser returns a `ParsedSpatialFile`:

```ts
{ format: 'geojson' | 'gpx' | 'kml' | 'kmz' | 'shapefile', featureCollection, warnings: string[] }
```

```js
const parsed = await gis.files.detectAndParse(fileName, buffer);
const geom = gis.files.extractLineGeometry(parsed.featureCollection);
// -> GeoJSON MultiLineString (2D, WGS84) — throws NO_LINE_GEOMETRY if no lines exist
const points = gis.files.countPoints(geom);
```

| Function | Input | Notes |
| --- | --- | --- |
| `parseGeoJson(input)` | string/Buffer | accepts FeatureCollection, single Feature, or bare geometry |
| `parseGpx(input)` | string/Buffer | tracks and routes via togeojson |
| `parseKml(input)` | string/Buffer | placemarks via togeojson |
| `parseKmz(input)` | Buffer | unzips, prefers `doc.kml`, falls back to any `.kml` entry |
| `parseShapefile(input)` | Buffer (zip) | see below |
| `detectAndParse(fileName, input)` | name + Buffer | dispatches on extension: `.geojson` `.json` `.gpx` `.kml` `.kmz` `.zip` |
| `extractLineGeometry(fc)` | FeatureCollection | merges all `LineString`/`MultiLineString` features (including inside GeometryCollections) into one 2D `MultiLineString`; strips elevation |

Shapefile expectations: a `.zip` containing `.shp` (+ optional `.dbf`, `.prj`). When the `.prj` declares a projected CRS, coordinates are reprojected to WGS84 via proj4; a missing or unparseable `.prj` assumes WGS84 and adds a warning. Archives with multiple `.shp` layers use the first line-bearing layer and add a warning.

### `gis.esri`

Snapshot ingestion from Esri REST feature services (ArcGIS FeatureServer/MapServer layers). Features are fetched as GeoJSON and returned for the caller to store — this is a copy, not a live connection.

```js
const { featureCollection, warnings } = await gis.esri.fetchFeatures(
  'https://services5.arcgis.com/xyz/arcgis/rest/services/Trails/FeatureServer/0',
  { where: '1=1', outFields: '*', maxRecords: 10000, pageSize: 1000 }
);
```

- The URL must point at a numbered layer (`.../FeatureServer/0`); a trailing `/query` is tolerated and stripped.
- Pagination follows `exceededTransferLimit` until exhausted or `maxRecords` is reached (truncation adds a warning).
- Esri error payloads returned with HTTP 200 are surfaced as `PROVIDER_ERROR`.
- The library validates URL shape only. Callers exposing this to user input should apply their own SSRF policy (https-only, block private hosts) before calling.

## Types

All exported from the package root: `GisServiceConfig`, `GisLogger`, `Waypoint`, `RouteMode`, `Route`, `TourRouteResult`, `TourRouteLeg`, `AddressSuggestion`, `AutocompleteResponse`, `GeocodedAddress`, `IpLocation`, `ParsedSpatialFile`, `SpatialFileFormat`, `EsriFetchOptions`, `EsriFetchResult`, `FeatureCollection`, `GeoJsonFeature`, `GeoJsonGeometry`, `MultiLineStringGeometry`, `PointGeometry`, `Position`, `GisError`, `GisErrorCode`.

Compatibility guarantees for consumers that persist results:
- `TourRouteResult` matches the shape destination-hub-api stores in `tour_routes` (`mode`, `distanceMiles`, `durationSeconds`, `waypoints`, `legs` with `steps[].instruction.text` / `from_index` / `isReturn`, `geom`).
- `autocomplete` returns the raw Geoapify body untouched (`results[]` with `formatted`, `lat`, `lon`, `address_line1`, …); pass a selected element straight into `geocodePermanent`.

## Development

```bash
npm install
npm test
npm run build
npm run typecheck
```

Release: bump `version` in package.json, commit, tag (`git tag v1.x.y`), push with tags. Consumers update their pinned ref.
