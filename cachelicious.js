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
    * The name of the author may not be used to endorse or promote products
      derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER BE LIABLE FOR ANY
DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
(INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

if (module) {
	module.exports = Cachelicious;
}


var http = require('http');
var fs = require('fs');
var path = require('path');
var LRU = require("lru-cache");
var util = require("util");
var events = require("events");
var stream = require("stream");


function CacheStreamConsumer(id, response, readOffset) {
	this.id = id;
	this.paused = false;
	this.readOffset = undefined === readOffset ? 0 : readOffset;
	this.response = response;
	var self = this;
	this.backoff = 1;

	this.response.on('drain', function() {
		// Resume the read stream when the write stream gets hungry 
		self.resume();
	});
}

CacheStreamConsumer.prototype.setCacheStream = function (stream) 
{
	this.cacheStream = stream;
	this.maxOffset = stream.size;
	//when adding new consumers, set a 5ms timeout per each consumer in queue, plus a 5ms baseline, to prevent them from starving previously existing consumers
	var self = this;
	setTimeout(function () {
		self.tick();	
	}, 6);
	//right now, hardcoding a number, but should use a formula based on the file size plus the number of consumers in queue
	//something like this this.cacheStream.consumerCount * Math.max(4, Math.ceil(this.maxOffset/(1024*650)))
}

CacheStreamConsumer.prototype.tick = function () 
{
	if (this.paused) {
		return;
	}

	if (this.readOffset < this.cacheStream.writeOffset) {
		this.backoff = 1; //reset the backoff factor
		//console.log("emitting data for requestId:" + this.id);
				
		var data = this.cacheStream.buffer.slice(this.readOffset, this.cacheStream.writeOffset);
		this.readOffset = this.cacheStream.writeOffset;

		if (this.readOffset === this.maxOffset) {
			//console.log(this.id + ": ended streaming");
			this.end(data);
			return;
		}	

		if (false === this.response.write(data)) {
			//console.log(requestId + ": Pausing stream...")
			this.pause();	
			return;
		}
		
		//this.emit('data', data);	

		if (this.paused) {
			return;
		}		
	}
	
	//we drained the buffer, let's give it some time to breathe
	//console.log(this.backoff);
	var self = this;
	setTimeout(function () {
		self.tick();	
	}, 15*this.backoff);

	++this.backoff; //lets backoff the buffer drainers so they give the buffer sometime to increase
}

CacheStreamConsumer.prototype.end = function (data) 
{
	this.response.end(data);		
	this.cacheStream.removeConsumer(this);
}


CacheStreamConsumer.prototype.pause = function () 
{
	this.paused = true;
}

CacheStreamConsumer.prototype.resume = function () 
{
	this.paused = false;
	//if the response asked to be resumed, lets prioritize it in this tick
	this.tick();
}


function CacheStream(size) {
	events.EventEmitter.call(this);
	this.buffer = new Buffer(size);
	this.size = size;
	this.writeOffset = 0;
	this.consumers = {};
	this.consumerCount = 0;
	this.writable = true;
}

util.inherits(CacheStream, stream.Stream);

CacheStream.prototype.addConsumer = function (consumer) 
{
	consumer.setCacheStream(this);
	this.consumers[consumer.id] = consumer;
	this.consumerCount++;
}


CacheStream.prototype.removeConsumer = function (consumer) 
{
	this.consumerCount--;
	delete this.consumers[consumer.id];
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

	//this.emit('data', data);
	//console.log("wrote " + writtenBytes + " bytes into buffer");
	//console.log("new offset" + this.writeOffset);			
}

CacheStream.prototype.end = function() 
{
	//console.log("ended!");
	this.writable = false;
	//this.emit('end');
}

function defaultPathFinder (request)
{
	var filepath = './test-assets';
	if ('/' === request.url) {
		filepath += '/index.html';
	} else {
		filepath += request.url;
	}
	return filepath;
}

function defaultContentTypeFinder (filepath)
{
	var extname = path.extname(filepath).toLowerCase();
	switch (extname) {
		case '.js':
			return 'text/javascript';
		case '.css':
			return 'text/css';
		case '.jpeg':
		case '.jpg':
			return 'image/jpeg';
	}
	return 'text/html';
}


function Cachelicious (pathFinder, contentTypeFinder, port, maxCacheSize)
{
	this.init(pathFinder, contentTypeFinder, port, maxCacheSize)
}

Cachelicious.prototype = {
	init: function (pathFinder, contentTypeFinder, port, maxCacheSize) 
	{
		var self = this;
		if (typeof pathFinder === 'undefined') {
			pathFinder = defaultPathFinder;
		
		if (typeof contentTypeFinder === 'undefined') {
			contentTypeFinder = defaultContentTypeFinder;
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
		this.requestStreamId = 0;
		this.locked = {};
		this.pathFinder = pathFinder;
		this.contentTypeFinder = contentTypeFinder;
		
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
		var filepath = this.pathFinder(request), contentType;
		
		if (null === filepath) {
			this.serveError(404, request.method, response);
			return;
		}
		
		contentType = this.contentTypeFinder(filepath);

		this.streamPath(filepath, contentType, request.method, response);
	},
	
	fileCheck: function (filepath, method, response, successCb, errorCb) 
	{
		//console.log('running stat on:' + filepath)
		var self = this;
		fs.stat(filepath, function (error, stat) {
			if (null !== error) {
				self.serveError(404, method, response);
				if (errorCb) {
					errorCb();
				}
				return;
			}

			if (undefined === stat) {
				self.serveError(500, method, response);
				if (errorCb) {
					errorCb();
				}
				return;				
			}

			if (!stat.isFile()) {
				self.serveError(401, method, response);
				if (errorCb) {
					errorCb();
				}				
				return;				
			}			
			successCb(stat);
		});				
	},
	
	streamPath: function (filepath, contentType, method, response)
	{
		if (false === this.cache) {
			this.asyncServeUncachedStream(filepath, contentType, method, response);
			return;
		}

		this.requestStreamId++;
		
		var
			requestId = "r-" + this.requestStreamId, 
			cachedStream = this.getCached(filepath),
			self = this;

		if (undefined !== cachedStream) {
			self.asyncServeCachedStream(cachedStream, contentType, method, requestId, response);
			return;
		}
		
		//TODO: refactor this into using events
		if (this.locked[filepath]) {
			var lockCheck = setInterval(function () {
				var cachedStream = self.getCached(filepath);
				//console.log("lock checker for: " + requestId);
				if (undefined !== cachedStream) {
					//console.log("stopped checker for: " + requestId);
					clearInterval(lockCheck);
					self.asyncServeCachedStream(cachedStream, contentType, method, requestId, response);						
				}
			}, 5);
			return;
		}
		
		this.locked[filepath] = true;
		this.fileCheck(filepath, method, response, 
			function (stat) {
				var newStream = new CacheStream(stat.size);
				self.setCached(filepath, newStream);
				fs.createReadStream(filepath).pipe(newStream);
				delete self.locked[filepath];
				self.asyncServeCachedStream(newStream, contentType, method, requestId, response);	
			}, 
			function () {
				delete self.locked[filepath];
			});
	},
	
	asyncServeUncachedStream: function (filepath, contentType, method, response)
	{
		this.fileCheck(filepath, method, response, function (stat) {
			response.writeHead(200, {
				'Content-Type':   contentType,
				'Content-Length': stat.size
			});
			
			if ('HEAD' !== method) {
				fs.createReadStream(filepath).pipe(response);
			} else {
				response.end();
			}
		});
	},
	
	
	asyncServeCachedStream: function (cachedStream, contentType, method, requestId, response)  
	{
		var self = this;
		process.nextTick(function () {
			self.serveCachedStream(cachedStream, contentType, method, requestId, response);
		});
	},
	
	serveCachedStream: function (cachedStream, contentType, method, requestId, response) 
	{
		response.writeHead(200, {
			'Content-Type':   contentType,
			'Content-Length': cachedStream.size,
			'X-Req-Id':       requestId
		});
			
		if ('HEAD' !== method) {
			cachedStream.addConsumer(new CacheStreamConsumer(requestId, response));
		} else {
			response.end();
		}
	},
	
	serveError: function (code, method, response) 
	{
		console.log('error:' + code);
		response.writeHead(code, { 'Content-Type': 'text/html' });
		if ('HEAD' !== method) {
			response.end(""+code, 'utf-8');		
		} else {
			response.end();
		}
		

	},
	
	getCached: function (filepath) 
	{
		return this.cache.get(filepath);
	},
	
	setCached: function (filepath, cacheStream) 
	{
		this.cache.set(filepath, cacheStream);
		console.log('Current cache size: ' + Math.round(this.cache.length/(1024*1024)) + 'MB');
	},
	



};

(new Cachelicious()).start();	
