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
        this.on('drain', res.emit.bind(res, 'drain'));
        this.on('finish', function() {
            parentResponseProto.end.call(res);
        });
        // When request is piped, re-pipe source to inlet straight away
        // ommiting request write and end methods
        res.on('pipe', function(source) {
            source.unpipe(res);
            source.pipe(res.inlet);
        });
    }
    util.inherits(ResponseInlet, stream.Writable);

    ResponseInlet.prototype._write = function(chunk, encoding, callback) {
        if (parentResponseProto.write.call(this.res, chunk, encoding)) {
            setImmediate(callback);
        } else {
            this.res.once('drain', callback);
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

    // Headers are not piped through inlet, but we want an event to mangle them
    // before they are actually written
    response.writeHead = function writeHead() {
        this.emit('beforehead');
        return parentResponseProto.writeHead.apply(this, arguments);
    };

    response.write = function write(chunk, encoding, callback) {
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

        // Discard headers, which should not be there in chunked encoding, but are set by sendfile or proxy
        // TODO: write patch for express.js to set those headers only when chunked encoding is not used. 
        res.once('beforehead', function() {
            res.removeHeader('Content-Length');
            res.removeHeader('ETag');
            res.removeHeader('Last-Modified');
        });

        next();
    };
}


function ProcessError(error) {
    this.type = 'ProcessError';
    this.message = "Macro evaluation error: " +  error.toString();
}

ProcessError.prototype = Object.create(Error);

/*
 * Middleware providing macro expansion functionality.
 *
 * Everything you put between <%= and %> tags will be evaluated. You can provide optional
 * object with properties which will become variables available to evaluated script. Beside
 * Those variables, you have access to pipeworks object
 * 
 * If expression yields function, ehn the function will be called with outpus stream as 
 * second argument. This way you can use pipeworks content producers which do not require
 * request object.
 * 
 * For example having in your html:
 *
 * @example
 * <head>
 *     <%= pipeworks.printscripts("/src") %>
 * </head>
 *
 * , with replace function like:
 *
 * @example
 * app.get("/index.html", pipeworks.replace(/<%= ([a-z]+)([^)]*)/g, function(match, res) {
 * });
 *
 * You can get output:
 *
 * @example
 * <head>
 *     <script src="/src/main.js"></script>
 *     <script src="/src/main.js"></script>
 * </head>
 */
function process(context) {
    var argNames = ['pipeworks'],
        argValues = [exports],
        key;

    Object.getOwnPropertyNames(context).forEach(function extractArgs(key) {
        argNames.push(key);
        argValues.push(context[key]);
    });

    // TODO: ot would be really nice to have file path and line number
    return replace(/<%= ([^%]*) %>/g, function(match, out) {
        var expression = match[1],
            fn, result;
        if (expression) {
            fn = Function.call(Object.create(Function), argNames, 'return '+ expression);
            try {
                result = fn.apply(null, argValues);
            } catch (err) {
                throw new ProcessError(err); 
            }
            if (typeof result == 'function') {
                result(null, out);
            } else {
                out.end(result);
            }
            //throw 'exit';
        };
    });
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

/**
 * List files
 *
 * @param {String} path Folder which will be walked to get files
 */
function listfiles(path, regexp, replacement, deps) {

    return function(req, res) {
        pathutil.walk(path, regexp, function(path) {
            var path = arguments[arguments.length - 1];
            res.write(
                typeof replacement == 'function' ?
                    replacement(match, path) :
                    replacement.replace('$0', path));
        }, function done() {
            res.end();
        }, deps);
    };
}


// Import all scripts inside folder and nested folders
function printscripts(path, deps) {
    return listfiles(path, /\.js$/, '<script src="$0"></script>\n', deps);

    return function(req, res, next) {
        pathutil.walk
        function include(path) {
            if (!included[path]) {
                res.write('<script src="' + path + '"></script>\n');
                included[path] = 1;
            }
        }

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
exports.process = process;
exports.concat = concat;
exports.print = print;
exports.listfiles = listfiles;
exports.printscripts = printscripts;
exports.redirect = redirect;
exports.sendfile = sendfile;
exports.importscripts = importscripts;
