export type GisErrorCode =
	| 'INVALID_INPUT'
	| 'MISSING_API_KEY'
	| 'PROVIDER_ERROR'
	| 'NO_RESULTS'
	| 'ROUTE_TOO_LONG'
	| 'UNSUPPORTED_FORMAT'
	| 'PARSE_FAILED'
	| 'NO_LINE_GEOMETRY'
	| 'INVALID_ESRI_URL';

export class GisError extends Error {
	code: GisErrorCode;
	status: number;
	details: unknown;

	constructor(code: GisErrorCode, message: string, status = 500, details: unknown = null) {
		super(message);
		this.name = 'GisError';
		this.code = code;
		this.status = status;
		this.details = details;
	}
}
