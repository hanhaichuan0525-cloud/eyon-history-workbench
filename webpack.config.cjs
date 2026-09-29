const path = require('node:path');

module.exports = {
  mode: 'production',
  entry: {
    index: path.resolve(__dirname, 'src/entry.ts'),
    genealogy: path.resolve(__dirname, 'src/ui/genealogyPage.ts'),
    ruin: path.resolve(__dirname, 'src/ui/ruinPage.ts'),
    biography: path.resolve(__dirname, 'src/ui/biographyPage.ts'),
    timeline: path.resolve(__dirname, 'src/ui/timelinePage.ts'),
    workbench: path.resolve(__dirname, 'src/ui/workbenchPage.ts'),
  },
  target: ['web', 'es2022'],
  experiments: {
    outputModule: true,
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: '[name].js',
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
      {
        test: /eyon-companion-prototype-v5\.png$/,
        type: 'asset/inline',
      },
    ],
  },
  optimization: {
    minimize: true,
  },
};
