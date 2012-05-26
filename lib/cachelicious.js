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


function CacheStreamConsumer(cacheStream, response, startOffset, endOffset) {
	this.paused = false;

	this.cacheStream = cacheStream;
	this.readOffset  = undefined === startOffset ? 0 : startOffset;
	this.maxOffset   = undefined === endOffset ||  endOffset > this.cacheStream.size ? this.cacheStream.size : endOffset;

	this.response = response;

	var self = this;
	this.response.on('drain', function () {
		// Resume the read stream when the write stream gets hungry 
		self.resume();
	});
}

CacheStreamConsumer.prototype.asyncStart = function ()
{
	var self = this;
	setTimeout(function () {
		self.tick();	
	}, 6);
	//the timeout value should probably be calculated based on file size and number of global pending requests
};

CacheStreamConsumer.prototype.tick = function () 
{
	if (this.paused) {
		return;
	}

	if (this.readOffset < this.cacheStream.writeOffset) {				
		var data = this.cacheStream.buffer.slice(this.readOffset, this.cacheStream.writeOffset);
		this.readOffset = this.cacheStream.writeOffset;

		if (this.readOffset === this.maxOffset) {
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
	
	//we drained the buffer, wait on more data
	var self = this;
	this.cacheStream.once('data', function () {
		self.tick();
	});
};

CacheStreamConsumer.prototype.end = function (data) 
{
	this.response.end(data);		
};

CacheStreamConsumer.prototype.pause = function () 
{
	this.paused = true;
};

CacheStreamConsumer.prototype.resume = function () 
{
	this.paused = false;
	//if the response asked to be resumed, lets prioritize it in this tick
	this.tick();
};


function CacheStream(size) {
	stream.Stream.call(this);
	this.buffer = new Buffer(size);
	this.size = size;
	this.writeOffset = 0;
	this.consumerCount = 0;
	this.writable = true;
	this.setMaxListeners(0);
}

util.inherits(CacheStream, stream.Stream);

CacheStream.prototype.write = function (data) 
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

	this.emit('data', data);
	//console.log("wrote " + writtenBytes + " bytes into buffer");
	//console.log("new offset" + this.writeOffset);			
};

CacheStream.prototype.end = function () 
{
	//console.log("ended!");
	this.writable = false;
	this.emit('end');
};

function defaultPathFinder (request)
{
	var filepath = '.';
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
	events.EventEmitter.call(this);
	this.setMaxListeners(0);
	this.init(pathFinder, contentTypeFinder, port, maxCacheSize)
}

util.inherits(Cachelicious, events.EventEmitter);

Cachelicious.prototype.init = function (pathFinder, contentTypeFinder, port, maxCacheSize) 
{
	var self = this;
	
	if (typeof pathFinder === 'undefined') {
		pathFinder = defaultPathFinder;
	}
	
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
	this.pathFinder = pathFinder;
	this.contentTypeFinder = contentTypeFinder;
	
	this.server = http.createServer(function (request, response) {
		self.dispatch(request, response);
	});				
};
	
Cachelicious.prototype.start = function ()
{
	this.server.listen(this.port);
	console.log('Server running at http://127.0.0.1:' + this.port);
};
	
Cachelicious.prototype.stop = function () 
{
	this.server.close();		
	console.log('Server shut down');
};
	
Cachelicious.prototype.dispatch = function (request, response) 
{
	var filepath = this.pathFinder(request), contentType;
	
	if (null === filepath) {
		this.serveError(request.method, response, 404);
		return;
	}
	
	contentType = this.contentTypeFinder(filepath);

	this.streamPath(filepath, contentType, request.method, response);
};
	
Cachelicious.prototype.fileCheck = function (filepath, successCb, errorCb) 
{
	//console.log('running stat on:' + filepath)
	var self = this;
	fs.stat(filepath, function (error, stat) {
		if (null !== error) {
			if (errorCb) {
				errorCb(404);
			}
			return false;
		}

		if (undefined === stat) {
			if (errorCb) {
				errorCb(500);
			}
			return false;				
		}

		if (!stat.isFile()) {
			if (errorCb) {
				errorCb(401);
			}				
			return false;				
		}			
		successCb(stat);
		return true;
	});				
};
	
Cachelicious.prototype.streamPath = function (filepath, contentType, method, response)
{
	if (false === this.cache) {
		this.asyncServeUncachedStream(filepath, contentType, method, response);
		return;
	}
	
	var
		cachedStream = this.getCached(filepath),
		self = this;

	if (undefined !== cachedStream) {
		self.asyncServeCachedStream(cachedStream, contentType, method, response);
		return;
	}
	

	this.once('fileCheckSuccess-' + filepath, function (cachedStream) {
		self.asyncServeCachedStream(cachedStream, contentType, method, response);						
	});
	
	this.once('fileCheckError-' + filepath, function (error) {
		self.serveError(method, response, error);
	});		

	
	this.fileCheck(filepath,
		function (stat) 
		{
			var newStream = new CacheStream(stat.size);
			self.setCached(filepath, newStream);
			fs.createReadStream(filepath).pipe(newStream);
			
			//console.log('emitting: fileCheckSuccess-' + filepath);
			self.emit('fileCheckSuccess-' + filepath, newStream);
			self.removeAllListeners('fileCheckError-' + filepath);
		}, 
		function (error) 
		{
			//console.log('emitting: fileCheckError-' + filepath);
			self.emit('fileCheckError-' + filepath, error);
			self.removeAllListeners('fileCheckSuccess-' + filepath);
		}
	);
};
	
Cachelicious.prototype.asyncServeUncachedStream = function (filepath, contentType, method, response)
{
	var self = this;
	this.fileCheck(filepath, 
		function (stat) {
			response.writeHead(200, {
				'Content-Type':   contentType,
				'Content-Length': stat.size
			});
			
			if ('HEAD' !== method) {
				fs.createReadStream(filepath).pipe(response);
			} else {
				response.end();
			}
		}, 
		function (error) {
			self.serveError(method, response, error);
		}
	);
};
	
	
Cachelicious.prototype.asyncServeCachedStream = function (cachedStream, contentType, method, response)  
{
	var self = this;
	process.nextTick(function () {
		self.serveCachedStream(cachedStream, contentType, method, response);
	});
};
	
Cachelicious.prototype.serveCachedStream = function (cachedStream, contentType, method, response) 
{
	response.writeHead(200, {
		'Content-Type':   contentType,
		'Content-Length': cachedStream.size
	});
		
	if ('HEAD' !== method) {
		(new CacheStreamConsumer(cachedStream, response)).asyncStart();
	} else {
		response.end();
	}
};

Cachelicious.prototype.serveError = function (method, response, code) 
{
	console.log('error: ' + code);
	response.writeHead(code, {'Content-Type': 'text/html'});
	if ('HEAD' !== method) {
		response.end(""+code, 'utf-8');		
	} else {
		response.end();
	}
};

Cachelicious.prototype.getCached = function (filepath) 
{
	return this.cache.get(filepath);
};
	
Cachelicious.prototype.setCached = function (filepath, cacheStream) 
{
	this.cache.set(filepath, cacheStream);
	//console.log('Current cache size: ' + Math.round(this.cache.length/(1024*1024)) + 'MB');
};

