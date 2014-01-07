var fs = require('fs'),
    util = require('util'),
    stream = require('stream'),

    pathutil = require('./pathutil'),
    ReTransform = require('./retransform');


// Patch application response prototype write and end methods, to send them through
// filtering pipes
function init(app) {
    var parentResponseProto = app.response,
        PipedResponse = function () {}, // To have reasonable constructor.name
        response = PipedResponse.prototype = {
            __proto__: parentResponseProto
        };

    app.response = response;

    function ResponseInlet(res) {
        this.res = res;
        stream.Writable.call(this);
        this.on('finish', function() {
            parentResponseProto.end.call(res);
        });
    }
    util.inherits(ResponseInlet, stream.Writable);

    ResponseInlet.prototype._write = function(chunk, encoding, callback) {
        // TODO: make sure it will guarantee smooth flow of chunks through multiple filters
        if (parentResponseProto.write.call(this.res, chunk)) {
            setImmediate(callback);
        } else {
            this.res.once('drain', function() {
                callback();
            });
        }
    };

    Object.defineProperty(response, "inlet", {
        get: function () {
            return this._inlet || (this._inlet = new ResponseInlet(this));
        },
        set: function (stream) {
            this._inlet = stream;
        }
    });

    response.write = function write(chunk, encoding, callback) {
        if (! this._beforedataEmited) {
            this._beforedataEmited = true;
            this.emit('beforedata');
        };
        return this.inlet.write(chunk, encoding, callback);
    };

    response.end = function end(chunk, encoding, callback) {
        return this.inlet.end(chunk, encoding, callback);
    };

    return app;
}




/**
 * Middleware providing asynchronous regexp filtering capabilities
 */
function replace(regexp, fn) {
    return function(req, res, next) {
        if (typeof res.inlet === 'undefined') {
            console.warn('Response object in your app does not seem to support piping required by filters. Have you called pipeworks.init method on app?');
            return;
        }
        var transform = new ReTransform(regexp, fn);
        transform.pipe(res.inlet);
        res.inlet = transform;

        res.setHeader('Transfer-Encoding', 'chunked');
        // Discard headers, which should not be there in chunked encoding, but are set wrongly by sendfile
        // TODO: write patch for express.js to set those headers only when chunked encoding is not used. 
        res.once('beforedata', function() {
            res.removeHeader('Content-Length');
            res.removeHeader('ETag');
            res.removeHeader('Last-Modified');
        });
        
        next();
    };
}

// TODO: move all streams to separate utility module and unit test them
function SeqentialStream(out, after) {
    this._out = out;

    if (after) {
        this._waiting = true;
        after.once('finish', this._start.bind(this));
    }
    stream.Writable.call(this);
}
util.inherits(SeqentialStream, stream.Writable);

SeqentialStream.prototype._start = function() {
    this._waiting = false;
    if (this._writeArgs) {
        this._out.write.apply(this._out, this._writeArgs);
        this._writeArgs = null;
    }
};

SeqentialStream.prototype._write = function(chunk, enc, cb) {
    if (this._waiting) {
        this._writeArgs = [chunk, enc, cb];
    } else {
        this._out.write(chunk, enc, cb);
    }
};


/**
 * Middleware for concatenating streams produced by many providers
 */
function concat() {
    var producers = Array.prototype.slice.call(arguments);
    return function(req, out) {
        var last = producers.reduce(function(prev, prod) {
            var output = new SeqentialStream(out, prev);
            prod(req, output);
            return output;
        }, null);

        last.once('finish', out.end.bind(out));
    };
}


/**
 * Middleware streaming static content
 */
function print(text) {
    return function(req, out) {
        out.end(text);
    };
}


/**
 * Middleware to provide redirect only if target path exists
 */
function redirect(path, filepath) {
    var pathtpl = pathutil.compile(path),
        filepathtpl = pathtpl;

    // TODO: share this features between others
    if (filepath) {
        filepathtpl = pathutil.compile(filepath);
    } else if (path[0] == '/') {
        filepathtpl = function(params) {
            return '.' + pathtpl(params);
        };
    }

    return function(req, res, next) {
        fs.exists(filepathtpl(req.params), function(exists) {
            if (exists) {
                res.redirect(pathtpl(req.params));
            } else {
                next();
            }
        });
    };
}


// Import all scripts inside folder and nested folders
function printscripts(path, deps) {
    return function(req, res, next) {
        var openedDirs = 0,
            included = {};

        function include(path) {
            if (!included[path]) {
                res.write('<script src="' + path + '"></script>\n');
                included[path] = 1;
            }
        }

        function includedeps(path, dep) {
            if (path.match(dep[0])) {
                include(dep[1]);
            }
        }

        function processfile(base, name) {
            var path = base + '/' + name;

            if (name.match(/\.js$/)) {
                // Hack to get crucial dependencies in order
                deps.forEach(includedeps.bind(null, path));
                include(path);
            } else {
                // Read path content if it looks only like directory (not having extensions).
                // In worst case we will just get error, but we avoid extra call to stat.
                if (!name.match(/\.[a-z]+$/)) {
                    openedDirs ++;
                    fs.readdir('.' + path, processdir.bind(null, path));
                }
            }
        }

        // TODO: move all logic related to directory traversing to pathutil module
        function processdir(path, err, files) {
            if (!err) {
                files.forEach(processfile.bind(null, path));
            }
            if ((-- openedDirs) === 0) {
                res.end();
            }
        }

        fs.readdir('.' + path, processdir.bind(null, path));
        openedDirs ++;
    };
}


function importscripts(path, deps) {
    return function(req, res) {
        res.set('Content-Type', 'application/javascript');
        concat(
            print('document.write(\''),
            printscripts(path, deps),
            print('\');')
        )(req, res);
    };
}


function sendfile(path) {
    var pathtpl = pathutil.compile(path);

    return function(req, res) {
        res.sendfile(pathtpl(req.params));
    };
}


// TODO: add utility for creating filter to replace stuff conditionally when there
// is something listening on socket, or maybe even server is answering to some requests


exports.init = init;
exports.replace = replace;
exports.concat = concat;
exports.print = print;
exports.printscripts = printscripts;
exports.redirect = redirect;
exports.sendfile = sendfile;
exports.importscripts = importscripts;
