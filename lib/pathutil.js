
// Compile path to template
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

exports.compile = compile;
