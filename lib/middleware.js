'use strict';

const path = require('path');

const mime = require('mime');

const DevMiddlewareError = require('./DevMiddlewareError');
const { getFilenameFromUrl, handleRangeHeaders, ready } = require('./utils');

// Do not add a charset to the Content-Type header of these file types
// otherwise the client will fail to render them correctly.
const NonCharsetFileTypes = /\.(wasm|usdz)$/;

const HASH_REGEXP = /[0-9a-f]{10,}/;

module.exports = function wrapper(context) {
  return function middleware(req, res, next) {
    // fixes #282. credit @cexoso. in certain edge situations res.locals is
    // undefined.
    // eslint-disable-next-line no-param-reassign
    res.locals = res.locals || {};

    function goNext() {
      if (!context.options.serverSideRender) {
        return next();
      }

      return new Promise((resolve) => {
        ready(
          context,
          () => {
            // eslint-disable-next-line no-param-reassign
            res.locals.webpackStats = context.webpackStats;
            // eslint-disable-next-line no-param-reassign
            res.locals.fs = context.fs;

            resolve(next());
          },
          req
        );
      });
    }

    const acceptedMethods = context.options.methods || ['GET', 'HEAD'];

    if (acceptedMethods.indexOf(req.method) === -1) {
      return goNext();
    }

    let filename = getFilenameFromUrl(
      context.options.publicPath,
      context.compiler,
      req.url
    );

    if (filename === false) {
      return goNext();
    }
    
    function normalPath(filePath) {
      return filePath.replace(/[/]/g, path.sep).replace(/[\\]/g, path.sep);
    }

    function fileExists(filePath, fs) {
      try {
        return fs.statSync(filePath).isFile();
      } catch (err) {
        return false;
      }
    }

    filename = normalPath(filename);

    if (!path.extname(filename)) {
      filename = path.resolve(filename, 'index.html');
    }

    if (!fileExists(filename, context.fs)) {
      const basename = path.basename(filename, '.html').toLowerCase();
      if (basename === 'index') {
        const fs = require('fs');
        const MultiEntryPlugin = require('webpack/lib/MultiEntryPlugin');
        const HtmlWebpackPlugin = require('html-webpack-plugin');
        const webpack = require('webpack');

        const compiler = context.compiler;
        const options = compiler.options;

        const distPath = normalPath(options.output.path);
        const rootPath = path.dirname(distPath);

        const srcPath = normalPath(path.resolve(rootPath, 'src'));
        const srcFileName = normalPath(`${srcPath}${filename.substr(distPath.length)}`);

        let dirname = path.dirname(srcFileName);
        let tsFile = normalPath(`${dirname}/p.ts`);

        if (fileExists(tsFile, fs)) {
          let title = dirname.substr(dirname.lastIndexOf(path.sep) + 1);

          let relativePath = path.relative(srcPath, dirname);
          let chunkName = path.join(relativePath, basename).replace(/\\/g, '/');

          options.entry = {};
          options.plugins = options.plugins.filter(p => !(p instanceof HtmlWebpackPlugin));

          const entry = options.entry;

          entry[chunkName] = [`.${path.sep}${path.relative(rootPath, tsFile)}`];

          let headFileName = path.resolve(dirname, 'h.html');
          if (fileExists(headFileName, fs)) {
            entry[chunkName].push(`.${path.sep}${path.relative(rootPath, headFileName)}`);
          }

          let bodyFileName = path.resolve(dirname, 'p.html');
          if (fileExists(bodyFileName, fs)) {
            entry[chunkName].push(`.${path.sep}${path.relative(rootPath, bodyFileName)}`);
          }

          let styleFileName = path.resolve(dirname, 'p.less');
          if (fileExists(styleFileName, fs)) {
            entry[chunkName].push(`.${path.sep}${path.relative(rootPath, styleFileName)}`);
          }

          new MultiEntryPlugin(options.context, entry[chunkName], chunkName).apply(compiler);
          new HtmlWebpackPlugin({
            title: title,
            pagePath: dirname,
            filename: `${chunkName}.html`,
            template: path.resolve(rootPath, 'template.ejs'),
            chunks: [chunkName],
            hash: true
          }).apply(compiler);
          new webpack.NoEmitOnErrorsPlugin().apply(compiler);
          new webpack.HotModuleReplacementPlugin().apply(compiler);

          context.watching.invalidate();
        }
      }
    }

    return new Promise((resolve) => {
      // eslint-disable-next-line consistent-return
      function processRequest() {
        try {
          let stat = context.fs.statSync(filename);

          if (!stat.isFile()) {
            if (stat.isDirectory()) {
              let { index } = context.options;

              // eslint-disable-next-line no-undefined
              if (index === undefined || index === true) {
                index = 'index.html';
              } else if (!index) {
                throw new DevMiddlewareError('next');
              }

              filename = path.posix.join(filename, index);
              stat = context.fs.statSync(filename);

              if (!stat.isFile()) {
                throw new DevMiddlewareError('next');
              }
            } else {
              throw new DevMiddlewareError('next');
            }
          }
        } catch (e) {
          return resolve(goNext());
        }

        // server content
        let content = context.fs.readFileSync(filename);

        content = handleRangeHeaders(content, req, res);

        let contentType = mime.getType(filename) || '';

        if (!NonCharsetFileTypes.test(filename)) {
          contentType += '; charset=UTF-8';
        }

        if (!res.getHeader || !res.getHeader('Content-Type')) {
          res.setHeader('Content-Type', contentType);
        }

        res.setHeader('Content-Length', content.length);

        const { headers } = context.options;

        if (headers) {
          for (const name in headers) {
            if ({}.hasOwnProperty.call(headers, name)) {
              res.setHeader(name, context.options.headers[name]);
            }
          }
        }

        // Express automatically sets the statusCode to 200, but not all servers do (Koa).
        // eslint-disable-next-line no-param-reassign
        res.statusCode = res.statusCode || 200;

        if (res.send) {
          res.send(content);
        } else {
          res.end(content);
        }

        resolve();
      }

      if (
        context.options.lazy &&
        (!context.options.filename || context.options.filename.test(filename))
      ) {
        context.rebuild();
      }

      if (HASH_REGEXP.test(filename)) {
        try {
          if (context.fs.statSync(filename).isFile()) {
            processRequest();

            return;
          }
        } catch (_error) {
          // Ignore error
        }
      }

      ready(context, processRequest, req);
    });
  };
};
