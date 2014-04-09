/*global describe, it*/

var assert = require('assert'),
    pathutil = require('../lib/pathutil.js');

describe('pathutil module', function() {
    describe('compile', function() {
        it('should find named parts', function() {
            var tpl = pathutil.compile('/a/:first/c/:second/e'),
                params = {first: 'b', second: 'd'};
            assert.equal(tpl(params), '/a/b/c/d/e');
        });

        it('should find numeric parts alongside named parts', function() {
            var tpl = pathutil.compile('/a/:first/c/:0'),
                params = ['zzz'];
            params.first = 'b';
            assert.equal(tpl(params), '/a/b/c/zzz');
        });

        it('should be transparent for strings not having fields', function() {
            var tpl = pathutil.compile('/a/b/c/'),
                params = {b: 2};
            assert.equal(tpl(params), '/a/b/c/');
        });
    });
});
