const path = require('node:path');

module.exports = {
  mode: 'production',
  entry: path.resolve(__dirname, 'src/entry.ts'),
  target: ['web', 'es2022'],
  experiments: {
    outputModule: true,
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'index.js',
    module: true,
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: {
          loader: 'ts-loader',
          options: {
            transpileOnly: true,
            compilerOptions: {
              noEmit: false,
              allowImportingTsExtensions: false,
              module: 'ESNext',
              moduleResolution: 'Bundler',
            },
          },
        },
      },
      {
        resourceQuery: /raw/,
        type: 'asset/source',
      },
    ],
  },
  optimization: {
    minimize: true,
  },
};
