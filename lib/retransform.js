var util = require('util'),
    stream = require('stream');


function callIt(fn) {
    fn();
}


/**
 * Stream sending all data through function.
 * The function is expected to be asynchronous and provide promise protocol to negotiate when processing is done
 */
function FuncStream(fn) {
    this._fn = fn;
    stream.Writable.call(this);
}
util.inherits(FuncStream, stream.Writable);

FuncStream.prototype._write = function(chunk, enc, cb) {
    this._fn(chunk, enc).than(cb);
};


/**
 * Need to document how much of data will be buffered ins cas of multiline regexps 
 */
function ReTransform(re, replacement) {
    this.re = re;
    this._replacement = replacement;
    this._buffer = '';
    this._waiting = false; // Set to true when waiting for handler to process regexp
    this._finished = false; // Set to true when handler is finished and there will be no more stuff to process
    stream.Transform.call(this);
}

util.inherits(ReTransform, stream.Transform);

// Flush remaining content in buffer and reset internal state
ReTransform.prototype._cleanup = function() {
    if (this._buffer) this.push(this._buffer);
    this._buffer = '';
};

// Called when whole input has been sent through _transform. If we are not waiting for
// any match handlers to finish, we can just go straight to cleanup. Otherwise we need
// to save callback until all matching blocks are resolved
ReTransform.prototype._flush = function(cb) {
    if (this._waiting) {
        this._finishCb = cb;
    } else {
        this._cleanup();
        cb();
    }
};

ReTransform.prototype._promisePush = function(chunk, enc) {
    var queue = [],
        promise = {_queue: queue},
        finish = Array.prototype.forEach.bind(queue, callIt);

    // TODO: consider refactoring to proper promise implementation
    promise.than = function(cb) {
        this._queue.push(cb);
    };

    if (this.push(chunk, enc)) {
        setImmediate(finish);
    } else {
        this.once('drain', finish);
    }
    return promise;
};

// Is supposed to be called by handler when match result processing is done
ReTransform.prototype._completeMatch = function(chunk) {
    this._waiting = false;
    if (chunk) this.push(chunk);
    this._matchNext();
};

ReTransform.prototype._handleMatch = function(match, chunk) {
    var repl = this._replacement,
        output;

    // Advance buffer and mark as finished if not global regexp
    this._buffer = chunk.slice(match.index + match[0].length);
    if (this.re.global) {
        this.re.lastIndex = 0;
    } else {
        this._finished = true;
    }

    // If replacement is string, just add it immediately and carry on
    if (typeof repl == 'string') {
        this.push(chunk.slice(0, match.index) + repl);
        this._matchNext();
        return;
    }

    this.push(chunk.slice(0, match.index));
    output = new FuncStream(this._promisePush.bind(this));
    output.once('finish', this._completeMatch.bind(this));
    /**
     * Replacement producer function will be called with 2 arguments:
     *  * regular expression match outcome
     *  * output stream, which should be fed with data and which end method should be called when streaming is complete
     */
    repl(match, output);
    this._waiting = true;
};

ReTransform.prototype._advanceToLastLine = function() {
    var buffer = this._buffer,
        index = buffer.lastIndexOf('\n') + 1;
    this.push(buffer.slice(0, index));
    this._buffer = buffer.slice(index);
};

// Find next match in buffer, unless match is done
ReTransform.prototype._matchNext = function() {

    var buffer = this._buffer,
        re = this.re,
        match = buffer && (! this._finished) ?  re.exec(buffer) : false;

    if (match) {
        this._handleMatch(match, buffer);

    // If finishCb is set, it means that all data has been streamed and as all
    // matching is done, we can just terminate
    } else if (this._finishCb) {
        this._cleanup();
        this._finishCb();
        delete this._finishCb;

    // If matching is finished, switch to forwarding mode, just forward whatever we got
    } else if (this._finished) {
        this.push(this._buffer);
        this._buffer = '';

    // even if match failed, but regexp is not multiline we can advance buffer
    // to last line. On multi-line regular expression we canno tflush buffer early,
    // so you can end up having whole response in memory
    } else if (! re.multiline) {
        this._advanceToLastLine();
    }
};

ReTransform.prototype._transform = function(chunk, encoding, cb) {
    this._buffer += chunk.toString();
    if (! this._waiting) this._matchNext();
    cb();
};

module.exports = ReTransform;
