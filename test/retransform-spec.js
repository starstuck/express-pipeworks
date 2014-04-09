/*global describe, it, beforeEach, afterEach, process*/

var stream = require('stream'),
    util = require('util'),
    chai = require('chai'),
    sinon = require('sinon'),
    ReTransform = require('../lib/retransform.js'),
    expect = chai.expect;

chai.use(require('sinon-chai'));
chai.Assertion.includeStack = true;


// Dummy writable buffer stream which can be used to transformed output
function WritableBuffer() {
    stream.Writable.call(this, {
        decodeStrings: false
    });
    this.buffer = '';
};
util.inherits(WritableBuffer, stream.Writable);
WritableBuffer.prototype._write = function(chunk, encoding, cb) {
    this.buffer += chunk.toString();
    cb();
};


describe('ReTransform', function() {
    var output;

    beforeEach(function() {
        output = new WritableBuffer(); //.on('finish', function(){ finished = true; });
        sinon.spy(output, 'end');
    });

    afterEach(function() {
        delete output;
    });

    it('should allow simple string replacement', function(done) {
        var stream = new ReTransform(/<\/body>/, '<foot>, by pipeworks</foot>');
        stream.pipe(output);
        stream.end('<html><body><p>Hello world!</p></body></html>');

        setTimeout(function() {
            expect(output.end).to.have.been.calledOnce;
            expect(output.buffer).to.equal('<html><body><p>Hello world!</p><foot>, by pipeworks</foot></html>');
            done();
        }, 0);
    });

    it('should allow function feeding stream data', function(done) {
        
        var filter = sinon.spy(function(match, out){
                sendReplacement = function(){
                    out.end('<foot>, by awesome pipeworks</foot>');
                    setTimeout(afterSendingReplacement, 0);
                };
            }),
            stream = new ReTransform(/<\/body>/, filter),
            sendReplacement;

        stream.pipe(output);
        stream.end('<html><body><p>Hello world!</p></body></html>');

        function beforeSendingReplacement() {
            expect(filter).to.have.been.calledWith(["</body>"]);
            expect(output.end).to.have.been.not.called;
            expect(output.buffer).to.be.equal('<html><body><p>Hello world!</p>');
            process.nextTick(sendReplacement);
        }
        
        function afterSendingReplacement() {
            expect(output.end).to.have.been.calledOnce;
            expect(output.buffer).to.equal('<html><body><p>Hello world!</p><foot>, by awesome pipeworks</foot></html>');
            done();
        }

        process.nextTick(beforeSendingReplacement);
    });

    it.skip('should call filter function for all matches of global regular expression, even data passed in multiple chunks');
    it.skip('should call filter function for only first match of single regular expression');
    it.skip('should call filter function even if matching string is across chunks');
    it.skip('should optimize buffering when single line expression is being used');
});
