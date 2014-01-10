var fs = require('fs');

/**
 * Compile path to template
 */
function compile(path) {
    var body = 'return ',
        re = /:(\w+)/g,
        match = re.exec(path),
        lastIndex = 0,
        key;

    function extract(str, start, end) {
        return str.slice(start, end).replace('\\', '\\\\').replace('"', '\"');
    }

    while (match) {
        body += '"' + extract(path, lastIndex, match.index) + '"+p["' +  match[1] + '"]+';
        lastIndex = re.lastIndex;
        match = re.exec(path);
    }
    body += '"' + extract(path, lastIndex) + '";';
    return new Function('p', body);
}


/**
 * Walk through folder contents and list all files matching regexp
 *
 * @TODO Cover with tests
 */
function walk(path, regexp, cb, done, deps) {
    var openedDirs = 0,
        included = {},
        result = [];

    function includedeps(path, dep) {
        var match = path.match(dep[0]);
        if (match) {
            cb(dep[1]);
        }
    }

    function processfile(base, name) {
        var path = base + '/' + name;

        if (name.match(regexp)) {
            // Hack to get crucial dependencies in order
            deps.forEach(includedeps.bind(null, path));
            cb(path);
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
            done();
        }
    }

    fs.readdir('.' + path, processdir.bind(null, path));
    openedDirs ++;
}

exports.compile = compile;
exports.walk = walk;
