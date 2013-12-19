var util = require('util'),
    stream = require('stream');

/**
 *
 * Need to document how much of data will be buffered ins cas of multiline regexps 
 */
function ReTransform(re, fn) {
    this.re = re;
    this._fn = fn;
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
    }
};

// Is supposed to be called by handler when match result processing is done
ReTransform.prototype._completeMatch = function(chunk) {
    this._waiting = false;
    if (chunk) this.push(chunk);
    this._matchNext();
};

ReTransform.prototype._handleMatch = function(match, chunk) {
    /**
     * Target function will be called with 3 arguments:
     *  * regular expression match outcome
     *  * function to notify when processing is done. It accepts optional argument with remaining data
     *  * Optional function do send some data
     */
    this._fn(match, this._completeMatch.bind(this), this.push.bind(this));
    this._waiting = true;
    this.push(chunk.slice(0, match.index));
    this._buffer = chunk.slice(match.index + match[0].length);
    if (!this.re.global) {
        this._finished = true;
    }
};

ReTransform.prototype._advanceToLastLine = function() {
    var index = buffer.lastIndexOf('\n') + 1;
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
