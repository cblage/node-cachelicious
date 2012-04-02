/*
Copyright (c) 2012, Carlos Brito Lage
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
    * Redistributions of source code must retain the above copyright
      notice, this list of conditions and the following disclaimer.
    * Redistributions in binary form must reproduce the above copyright
      notice, this list of conditions and the following disclaimer in the
      documentation and/or other materials provided with the distribution.
    * Neither the name of the <organization> nor the
      names of its contributors may be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL <COPYRIGHT HOLDER> BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

var http = require('http');
var fs = require('fs');
var path = require('path');
var strean = require('stream');
var LRU = require("./vendor/node-lru-cache");
var util = require("util");
var events = require("events");

function CacheStream(size) {
	events.EventEmitter.call(this);
	this.buffer = new Buffer(size);
	this.size = size;
	this.writeOffset = 0;
	this.activeRequests = {};
	this.activeRequestCount = 0;
	this.requestServer = null;
	this.writable = true;
	this.chunkSize = 1024 * 1024; //2MB
	//console.log('initialized buffer with size:' + this.size);
}

util.inherits(CacheStream, events.EventEmitter);

CacheStream.prototype.register = function (requestId, readOffset) 
{
	var self = this;
	this.activeRequests[requestId] = {
		paused: false,
		readOffset: (undefined === readOffset ? 0 : readOffset)		
	};
	
	process.nextTick(function () {
		self.emitRequestData(requestId);
	})
	
	this.activeRequestCount++;
}

CacheStream.prototype.unregister = function (requestId) 
{
	this.activeRequestCount--;
	delete this.activeRequests[requestId];
}

CacheStream.prototype.emitRequestData = function (requestId) 
{
	if (undefined === this.activeRequests[requestId] || this.activeRequests[requestId].paused) {
		return;
	}

	//console.log("emitting data for requestId:" + requestId);
	if (this.activeRequests[requestId].readOffset < this.writeOffset) {
		var outputMaxByte = Math.min(this.activeRequests[requestId].readOffset + this.chunkSize, this.writeOffset);
		//console.log('writeOffset: ' + this.writeOffset);
		//console.log('outputMaxbyte:' + outputMaxByte);
		this.emit(
			requestId+"data", 
			this.buffer.slice(this.activeRequests[requestId].readOffset, outputMaxByte)
		);
		this.activeRequests[requestId].readOffset = outputMaxByte;
	}
	
	if (this.activeRequests[requestId].readOffset === this.size) {
		//console.log(requestId + ": ended streaming");
		this.emit(requestId+"end");
		this.unregister(requestId);
	}
	var self = this;
	process.nextTick(function () {
		self.emitRequestData(requestId);
	})
}

CacheStream.prototype.pause = function (requestId) 
{
	if (undefined !== this.activeRequests[requestId]) {
		this.activeRequests[requestId].paused = true;	
	}
}

CacheStream.prototype.resume = function (requestId) 
{
	if (undefined !== this.activeRequests[requestId]) {
		this.activeRequests[requestId].paused = false;
		var self = this;
		process.nextTick(function () {
			self.emitRequestData(requestId);
		})		
	}
}

CacheStream.prototype.write = function(data) 
{
	if (!this.writable) {
		//console.log("rejecting write because we ended already")
		return;
	}
	
	var writtenBytes;
	if (Buffer.isBuffer(data)) {
		//console.log("writing buffer data " + data.length + " bytes to offset: " + this.writeOffset);
		data.copy(this.buffer, this.writeOffset);
		writtenBytes = data.length;
	} else {
		//console.log("writing " + Buffer.byteLength(data) + " bytes to offset: " + this.writeOffset);
		writtenBytes = this.buffer.write(data, this.writeOffset);
	}
	this.writeOffset+= writtenBytes;
	//console.log("wrote " + writtenBytes + " bytes into buffer");
	//console.log("new offset" + this.writeOffset);			
}

CacheStream.prototype.end = function() 
{
	//console.log("ended!");
	this.writable = false;
}


Cachelicious = function (basepath, port, maxCacheSize)
{
	this.init(basepath, port, maxCacheSize)
};

Cachelicious.prototype = {
	init: function (basepath, port) 
	{
		var self = this;
		if (typeof basepath === 'undefined') {
			basepath = './test-assets';
		}
		
		if (typeof port === 'undefined') {
			port = 9876;
		}
		
		if (typeof maxCacheSize === 'undefined') {
			maxCacheSize = 20971520; //20mb
		}
		
		if (maxCacheSize !== false) {
			this.cache = LRU(maxCacheSize, function (cacheStream) {
				return cacheStream.size;
			});			
		} else {
			this.cache = false;
		}
		
		this.port = port;
		this.basepath = basepath;
		this.requestStreamId = 0;
		this.locked = {};
		
		this.server = http.createServer(function (request, response) {
			self.dispatch(request, response);
		});				
	},
	
	start: function ()
	{
		this.server.listen(this.port);
		console.log('Server running at http://127.0.0.1:' + this.port);
	},
	
	stop: function () 
	{
		this.server.close();		
		console.log('Server shut down');
	},
	
	dispatch: function (request, response) 
	{
		//console.log('request starting...');
		var filepath = this.basepath,
		    self = this;
		
		if ('/' === request.url) {
			filepath += '/index.html';
		} else {
			filepath += request.url;
		}
		
		self.servePath(filepath, response);		
	},
	
	servePath: function (filepath, response)
	{
		var extname = path.extname(filepath).toLowerCase(), self = this;
		var contentType;
		
		switch (extname) {
			case '.js':
				contentType = 'text/javascript';
				break;
			case '.css':
				contentType = 'text/css';
				break;
			case '.jpeg':
			case '.jpg':
				contentType = 'image/jpeg';
				break;				
			default:
				contentType = 'text/html';
				break;
		}

		this.streamPath(filepath, contentType, response);
	},
	
	fileCheck: function (filepath, callback) 
	{
		console.log('running stat on:' + filepath)
		fs.stat(filepath, function (error, stat) {
			if (null !== error) {
				self.serveError(404, response);
				return;
			}

			if (undefined === stat) {
				self.serveError(500, response);
				return;				
			}

			if (!stat.isFile()) {
				self.serveError(401, response);
				return;				
			}			
			callback(stat);
		});				
	},
	
	uncachedStream: function (filepath, contentType, response)
	{
		this.fileCheck(filepath, function (stat) {
			response.writeHead(200, {
				'Content-Type':   contentType,
				'Content-Length': stat.size
			});

			fs.createReadStream(filepath).pipe(response);						
		});
	},
	
	streamPath: function (filepath, contentType, response)
	{
		if (false === this.cache) {
			this.serveUncachedStream(filepath, contentType, response);
			return;
		}

		this.requestStreamId++;
		
		var
			requestId = "r-" + this.requestStreamId, 
			cachedStream = this.getCached(filepath),
			self = this;

		if (undefined !== cachedStream) {
			self.asyncServeCachedStream(cachedStream, contentType, requestId, response);
			return;
		}
		
		if (this.locked[filepath]) {
			var lockCheck = setInterval(function () {
				var cachedStream = self.getCached(filepath);
				//console.log("lock checker for: " + requestId);
				if (undefined !== cachedStream) {
					//console.log("stopped checker for: " + requestId);
					clearInterval(lockCheck);
					self.asyncServeCachedStream(cachedStream, contentType, requestId, response);						
				}
			}, 5);
			return;
		}
		
		this.locked[filepath] = true;
		this.fileCheck(filepath, function (stat) {
			var newStream = new CacheStream(stat.size);
			self.setCached(filepath, newStream);
			fs.createReadStream(filepath).pipe(newStream);
			delete self.locked[filepath];
			self.asyncServeCachedStream(newStream, contentType, requestId, response);	
		});
	},
	
	asyncServeCachedStream: function (cachedStream, contentType, requestId, response)  
	{
		var self = this;
		process.nextTick(function () {
			self.serveCachedStream(cachedStream, contentType, requestId, response);
		});
	},
	
	serveCachedStream: function (cachedStream, contentType, requestId, response) 
	{
		response.writeHead(200, {
			'Content-Type':   contentType,
			'Content-Length': cachedStream.size,
			'X-Req-Id':       requestId
		});

		cachedStream.register(requestId);

		cachedStream.on(requestId+'data', function(data) {
			// Pause the read stream when the write stream gets saturated
			//console.log(requestId + ":Streaming data back to client")
			if(false === response.write(data)) {
				//console.log(requestId + ": Pausing stream...")
				cachedStream.pause(requestId);	
			}
		});

		response.on('drain', function() {
			//console.log(requestId + ': response drained');
			// Resume the read stream when the write stream gets hungry 
			cachedStream.resume(requestId);
		});

		cachedStream.on(requestId+'end', function() {
			response.end();
			//console.log(requestId + ': response ended');
		});		
	},
	
	serveError: function (code, response) 
	{
		console.log('error:' + code);
		response.writeHead(code, { 'Content-Type': 'text/html' });
		response.end(""+code, 'utf-8');		
	},
	
	getCached: function (filepath) 
	{
		var cacheStream = this.cache.get(filepath);
		/*if (undefined === cacheStream) {
			//console.log("MISS!");
		} else {
			//console.log("HIT!");
		}*/
		return cacheStream;
	},
	
	setCached: function (filepath, cacheStream) 
	{
		this.cache.set(filepath, cacheStream);
		//console.log('current cache size:' + this.cache.length);
	},
	



};

(new Cachelicious()).start();	