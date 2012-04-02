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
	this.endendWriting = false;
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
	if (this.endendWriting) {
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
	this.endendWriting = true;
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
				
		//console.log('filepath:' + filepath)
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
			
			//console.log(stat);
			
			self.servePath(filepath, stat.size, response);
		});
	}, 
	
	servePath: function (filepath, size, response)
	{
		var extname = path.extname(filepath).toLowerCase();
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

		response.writeHead(200, {
			'Content-Type':   contentType,
			'Content-Length': size
		});
		this.streamPath(filepath, size, response);
	},
	
	uncachedStream: function (filepath, response)
	{
		var readStream = fs.createReadStream(filepath);
		readStream.on('data', function(data) {
			var flushed = response.write(data);
			// Pause the read stream when the write stream gets saturated
			if(!flushed) {
				readStream.pause();	
			}
		});

		response.on('drain', function() {
			// Resume the read stream when the write stream gets hungry 
			readStream.resume();
		});

		readStream.on('end', function() {
			response.end();
		});		
	},
	
	streamPath: function (filepath, size, response)
	{
		if (false === this.cache) {
			this.uncachedStream(filepath, response);
			return;
		}
		
		this.requestStreamId++;
		
		var readStream = this.getCachedReadStream(filepath, size), requestId = "r-" + this.requestStreamId;


		readStream.register(requestId);
		
		readStream.on(requestId+'data', function(data) {
			//console.log(requestId + "Streaming data back to client")
			
			var flushed = response.write(data);
			// Pause the read stream when the write stream gets saturated
			if(!flushed) {
				readStream.pause(requestId);	
			}
		});

		response.on('drain', function() {
			// Resume the read stream when the write stream gets hungry 
			readStream.resume(requestId);
		});

		readStream.on(requestId+'end', function() {
			response.end();
		});
	},
	
	serveError: function (code, response) 
	{
		console.log('error:' + code);
		response.writeHead(code, { 'Content-Type': 'text/html' });
		response.end(""+code, 'utf-8');		
	},
	
	getCachedReadStream: function (filepath, size) 
	{
		var cacheStream = this.getCached(filepath), self = this;
		if (false === cacheStream || undefined === cacheStream) {
			cacheStream = new CacheStream(size);
			this.setCached(filepath, cacheStream);
			
			var fileReadSteam = fs.createReadStream(filepath);

			fileReadSteam.on('data', function (data) {
				cacheStream.write(data);
			});
			
			fileReadSteam.on('end', function() {
				cacheStream.end();
			});
			
		}
		
		return cacheStream;
	},
	
	getCached: function (filepath) 
	{
		var cacheStream = this.cache.get(filepath);
		if (undefined === cacheStream) {
			//console.log("MISS!");
		} else {
			//console.log("HIT!");
		}
		return cacheStream;
	},
	
	setCached: function (filepath, cacheStream) 
	{
		this.cache.set(filepath, cacheStream);
		//console.log('current cache size:' + this.cache.length);
	},
	



};

(new Cachelicious()).start();	