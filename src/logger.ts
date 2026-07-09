import { GisLogger } from './types';

export const noopLogger: GisLogger = {
	info: () => undefined,
	warn: () => undefined
};
