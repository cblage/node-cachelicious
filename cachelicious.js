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
	//console.log('initialized buffer with size:' + this.size);
}

util.inherits(CacheStream, events.EventEmitter);

CacheStream.prototype.register = function (requestId, readOffset) 
{
	this.activeRequests[requestId] = {
		paused: false,
		readOffset: (undefined === readOffset ? 0 : readOffset),
	};
	//console.log("registering requestId:" + requestId);
	
	if (0 === this.activeRequestCount++) {
		this.startServingRequests();
	}

}

CacheStream.prototype.unregister = function (requestId) 
{
	this.activeRequestCount--;
	delete this.activeRequests[requestId];
}

CacheStream.prototype.startServingRequests = function () 
{
	var self = this;
	this.requestServer = setInterval(function () {
		if (0 ===	self.activeRequestCount) {
			clearInterval(self.requestServer);
			return;
		}
		
		for (var requestId in self.activeRequests) {
			if (self.activeRequests.hasOwnProperty(requestId)) {
				self.emitRequestData(requestId);
			}
		}
	}, 0);
	
}

CacheStream.prototype.emitRequestData = function (requestId) 
{
	if (this.activeRequests[requestId].paused || this.activeRequests[requestId].readOffset === this.writeOffset) {
		return;
	}
	//console.log("emitting data for requestId:" + requestId);
	var self = this;
	setTimeout(function () {		
		if (undefined === self.activeRequests[requestId]) {
			//console.log("abandoning streaming for req that ended before this setimeout:" + requestId);
			return;
		}
		self.emit(
			requestId+"data", 
			self.buffer.slice(self.activeRequests[requestId].readOffset, self.writeOffset)
		);
		
		self.activeRequests[requestId].readOffset = self.writeOffset;
		if (self.activeRequests[requestId].readOffset === self.size) {
			//console.log("ending streaming for req:" + requestId);
			self.emit(requestId+"end");
			self.unregister(requestId);
		}
	}, 0);	
}

CacheStream.prototype.pause = function (requestId) 
{
	this.activeRequests[requestId].paused = true;
}

CacheStream.prototype.resume = function (requestId) 
{
	this.activeRequests[requestId].paused = false;
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
		setTimeout(function () {
			self.serveCachedStream(cachedStream, contentType, requestId, response);
		}, 0);
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
			//console.log(requestId + ":Streaming data back to client")

			// Pause the read stream when the write stream gets saturated
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