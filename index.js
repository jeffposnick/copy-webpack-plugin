var _ = require('lodash');
var Promise = require('bluebird');
var path = require('path');
var globAsync = Promise.promisify(require('glob'));
var fs = Promise.promisifyAll(require('fs-extra'));
var dir = Promise.promisifyAll(require('node-dir'));
var minimatch = require('minimatch');
var os = require('os');

function toLooksLikeDirectory(pattern) {
  var filename = pattern.to;
  if ((path.extname(filename) === '' || // doesn't have an extension
    _.last(filename) === path.sep ||    // ends in a path separator
    _.last(filename) === '/' ||         // ends in a slash (kept for compatibility)
    pattern.toType === 'dir') &&        // is explicitly a dir
    pattern.toType !== 'file') {        // is not explicitly a file
    return true;
  }
}

function apply(patterns, opts, compiler) {

  var baseDir = compiler.options.context;
  var fileDependencies = [];
  var contextDependencies = [];
  var lastGlobalUpdate = 0;

  if (!opts) {
    opts = {};
  }

  var ignoreList = opts.ignore;

  compiler.plugin('emit', function(compilation, cb) {
    Promise.each(patterns, function(pattern) {
      var relSrc = pattern.from;
      var absSrc = path.resolve(baseDir, relSrc);
      var relDest = pattern.to || '';
      
      // Determine if this is an absolute to
      var absDest;
      if (os.platform() === 'win32') {
        var winRootMatcher = /^[A-z]:\\\\/;
        if (winRootMatcher.test(relDest)) {
          absDest = relDest;
        }
      } else {
        if (relDest[0] === '/') {
          absDest = relDest;
        }
      }
      
      var forceWrite = !!pattern.force;

      return fs.statAsync(absSrc)
      .catch(function(err) {
        return null;
      })
      .then(function(stat) {
        if (stat && stat.isDirectory()) {
          contextDependencies.push(absSrc);
          
          if (absDest && toLooksLikeDirectory(pattern)) {
            return fs.copyAsync(absSrc, absDest);
          }
          
          return writeDirectoryToAssets({
            compilation: compilation,
            absDirSrc: absSrc,
            relDirDest: relDest,
            forceWrite: forceWrite,
            lastGlobalUpdate: lastGlobalUpdate,
            ignoreList: ignoreList
          });
        } else {

          return globAsync(relSrc, {cwd: baseDir})
          .each(function(relFileSrc) {

            // Skip if it matches any of our ignore list
            if (shouldIgnore(relFileSrc, ignoreList)) {
              return;
            }

            var absFileSrc = path.resolve(baseDir, relFileSrc);
            var relFileDest = pattern.to || '';
            var relFileDirname = path.dirname(relFileSrc);

            fileDependencies.push(absFileSrc);
            
            // If it's an absolute destination, write directly
            if (absDest) {
              var dest = absDest;
              if (toLooksLikeDirectory(pattern)) {
                dest = path.join(absDest, path.basename(absFileSrc));
              }
              return fs.copyAsync(absFileSrc, dest);
            }
            
            if (!stat && relFileDirname !== baseDir) {
              // If the file is in a subdirectory (from globbing), we should correctly map the dest folder
              relFileDest = path.join(path.relative(baseDir, relFileDirname), path.basename(relFileSrc));
            } else if (toLooksLikeDirectory(pattern)) {
              relFileDest = path.join(relFileDest, path.basename(relFileSrc));
            } else {
              relFileDest = relFileDest || path.basename(relFileSrc);
            }

            return writeFileToAssets({
              compilation: compilation,
              absFileSrc: absFileSrc,
              relFileDest: relFileDest,
              forceWrite: forceWrite,
              lastGlobalUpdate: lastGlobalUpdate
            });
          });
        }
      });
    })
    .then(function() {
      lastGlobalUpdate = _.now();
    })
    .catch(function(err) {
      compilation.errors.push(err);
    })
    .finally(cb);
  });

  compiler.plugin("after-emit", function(compilation, cb) {
    var trackedFiles = compilation.fileDependencies;
    _.each(fileDependencies, function(file) {
      if (!_.contains(trackedFiles, file)) {
        trackedFiles.push(file);
      }
    });

    var trackedDirs = compilation.contextDependencies;
    _.each(contextDependencies, function(context) {
      if (!_.contains(trackedDirs, context)) {
        trackedDirs.push(context);
      }
    });

    cb();
  });
}

function writeFileToAssets(opts) {
  var compilation = opts.compilation;
  var relFileDest = opts.relFileDest;
  var absFileSrc = opts.absFileSrc;
  var forceWrite = opts.forceWrite;
  var lastGlobalUpdate = opts.lastGlobalUpdate;

  if (compilation.assets[relFileDest] && !forceWrite) {
    return Promise.resolve();
  }

  return fs.statAsync(absFileSrc)
  .then(function(stat) {
    if (stat.mtime.getTime() > lastGlobalUpdate) {
      compilation.assets[relFileDest] = {
        size: function() {
          return stat.size;
        },
        source: function() {
          return fs.readFileSync(absFileSrc);
        }
      };
    }
  });
}

function writeDirectoryToAssets(opts) {
  var compilation = opts.compilation;
  var absDirSrc = opts.absDirSrc;
  var relDirDest = opts.relDirDest;
  var forceWrite = opts.forceWrite;
  var lastGlobalUpdate = opts.lastGlobalUpdate;
  var ignoreList = opts.ignoreList;

  return dir.filesAsync(absDirSrc)
  .each(function(absFileSrc) {
    var relFileSrc = path.relative(absDirSrc, absFileSrc);
    var relFileDest = path.join(relDirDest, relFileSrc);

    // Skip if it matches any of our ignore list
    if (shouldIgnore(relFileSrc, ignoreList)) {
      return;
    }

    // Make sure it doesn't start with the separator
    if (_.first(relFileDest) === path.sep) {
      relFileDest = relFileDest.slice(1);
    }

    return writeFileToAssets({
      compilation: compilation,
      absFileSrc: absFileSrc,
      relFileDest: relFileDest,
      forceWrite: forceWrite,
      lastGlobalUpdate: lastGlobalUpdate
    });
  });
}

function shouldIgnore(pathName, ignoreList) {
  var matched = _.find(ignoreList, function(glob) {
    return minimatch(pathName, glob, {
      matchBase: true,
      dot: true
    });
  });
  if (matched) {
    return true;
  } else {
    return false;
  }
}

module.exports = function(patterns, options) {
  if (_.isUndefined(patterns)) {
    patterns = [];
  }

  if (!_.isArray(patterns)) {
    throw new Error('CopyWebpackPlugin: patterns must be an array');
  }

  return {
    apply: apply.bind(this, patterns, options)
  };
};
