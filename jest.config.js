module.exports = {
	testEnvironment: 'node',
	transform: {
		'^.+\\.ts$': ['ts-jest', { tsconfig: { rootDir: '.', types: ['node', 'jest'] } }]
	},
	testMatch: ['**/tests/**/*.test.ts'],
	clearMocks: true
};
