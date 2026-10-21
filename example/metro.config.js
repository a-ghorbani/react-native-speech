const path = require('path');
const {getDefaultConfig} = require('@react-native/metro-config');
const {withMetroConfig} = require('react-native-monorepo-config');
const pkg = require('../package.json');

const root = path.resolve(__dirname, '..');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = withMetroConfig(getDefaultConfig(__dirname), {
  root,
  dirname: __dirname,
});

// withMetroConfig prefers `source` only for exact package names; subpath
// stubs such as `engine-sdk` must also resolve to src, or the bundle gets
// a second copy of the shared modules from lib.
const {resolveRequest} = config.resolver;
config.resolver.resolveRequest = (context, moduleName, platform) =>
  resolveRequest(
    moduleName.startsWith(`${pkg.name}/`)
      ? {...context, mainFields: ['source', ...context.mainFields]}
      : context,
    moduleName,
    platform,
  );

module.exports = config;
