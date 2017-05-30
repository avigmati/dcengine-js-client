'use strict';

const path = require('path');
const webpack = require('webpack');
const UglifyEsPlugin = require('uglify-es-webpack-plugin');


module.exports = {
    entry: './src/index.js',
    output: {
        path: path.resolve(__dirname, 'dist'),
        filename: 'dcengine.js',
        library: 'dcengine',
        libraryTarget: 'umd'
    },
    plugins: [
        new UglifyEsPlugin()
    ]
};
