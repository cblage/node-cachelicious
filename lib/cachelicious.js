/*jshint debug:true, forin:true, noarg:true, noempty:true, eqeqeq:true, bitwise:true, strict:true, undef:true, curly:true, devel:true, node:true, maxerr:50, globalstrict:true, newcap:true */

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

"use strict";

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

//var reqId = 0;

function CacheStreamConsumer(cacheStream, response, startOffset, endOffset, idealChunkSize) {
	//this.reqId = reqId++; //for debugging purposes
	
	stream.Stream.call(this);
	
	this.response = response;
	this.readable = true;	
	this.paused = false;
	this.cacheStream    = cacheStream;
	this.readOffset     = undefined === startOffset ? 0 : startOffset;
	this.maxOffset      = undefined === endOffset ||  endOffset >= this.cacheStream.size ? this.cacheStream.size-1 : endOffset; //we use C style max offsets (0 .. length-1)
	this.idealChunkSize = undefined === idealChunkSize ? 0.1 * (this.maxOffset - this.readOffset + 1) : idealChunkSize; //default = 10% of total request per chunk
	this.tickAttempt    = 0;
}
util.inherits(CacheStreamConsumer, stream.Stream);

CacheStreamConsumer.prototype.asyncStart = function (timeout)
{
	var self = this;
	if (undefined === timeout) {
		timeout = 6;
	}
	
	//console.log(timeout);
	this.pipe(this.response);
	
	setTimeout(function () {
		self.tick();	
	}, timeout);
	//the timeout value should probably be calculated based on file size and number of global pending requests
	
	return this; //provides a fluent interface
};

CacheStreamConsumer.prototype.tick = function () 
{
	if (this.paused) {
		//console.log(this.reqId + ': Skipped tick.');
		return;
	}
	
	//console.log(this.reqId + ': readoffset, maxoffset, writeoffset [' + this.readOffset + ', ' + this.maxOffset + ', '+ this.cacheStream.writeOffset + ']');

	if (this.readOffset === this.maxOffset + 1) {
		//console.log(this.reqId + ': finito!');
		this.emit('end');
		return;
	}

	this.tickAttempt++;
	
	var 
	outputMaxOffset = Math.min(this.maxOffset, this.cacheStream.writeOffset - 1), //can only read up to writeOffset - 1 or we'll read junk data
	servedChunkSize = outputMaxOffset - this.readOffset,
	canServe        = false;
	
	if (servedChunkSize > 0) {
		if (this.maxOffset === outputMaxOffset) {  //last chunk, serve asap
			canServe = true;			
		} else if (this.tickAttempt >= 10) { //dont starve a request for too long
			canServe = true;
		} else if (servedChunkSize >= (this.idealChunkSize * (1 - this.tickAttempt/10))) {  //try to serve at least the ideal chunk size, reducing the ideal for each failed attempt
			canServe = true;
		} else if (!this.cacheStream.writable) { //no point in waiting for more data
			canServe = true;
		}
	}
	
	if (canServe) {				
		this.tickAttempt = 0; //reset attempt count

		var data = this.cacheStream.buffer.slice(this.readOffset, outputMaxOffset + 1);
		//outputMaxOffset+1 is due to retarded slice / copy API: http://stackoverflow.com/questions/8804809/node-js-buffer-copy-api-looks-very-strange-and-not-similar-to-memcpy-in-c
		
		//console.log(this.reqId + ': emitting chunk with size['+servedChunkSize+'] [' + this.readOffset + ', ' + outputMaxOffset + '] - total size: ' + this.cacheStream.size + ' - max offset: ' + this.maxOffset);
		//console.log('data.length', data.length);
		//console.log('servedChunkSize', servedChunkSize);
					
		this.readOffset += data.length;

		this.emit('data', data);
	}
	
	//if we reached here it means we drained the file buffer from disk
	var self = this;
	if (this.cacheStream.writable) {
		//console.log(this.reqId + ': waiting for more data');
		this.cacheStream.once('data', function () {
			//console.log(self.reqId + ': moar data!');
			self.tick();
		});		
	}
	
	//!this.cacheStream.writable <-> the whole file has been read from disk, no need to retry tick() again via "nextTick", as it will be triggered by the response drain event when needed
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
};

CacheStream.prototype.end = function (data) 
{
	//console.log("ended!");
	this.writable = false;
	if (undefined !== data) {
		this.write(data);
	}
	this.emit('end');
};

function defaultRequestHandler (request)
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
		case '.png':
			return 'image/png';
	}
	return 'text/html';
}


function Cachelicious (requestHandler, contentTypeFinder, port, maxCacheSize)
{
	events.EventEmitter.call(this);
	this.setMaxListeners(0);
	this.init(requestHandler, contentTypeFinder, port, maxCacheSize);
}

util.inherits(Cachelicious, events.EventEmitter);

Cachelicious.prototype.init = function (requestHandler, contentTypeFinder, port, maxCacheSize) 
{
	var self = this;
	
	if (typeof requestHandler === 'undefined') {
		requestHandler = defaultRequestHandler;
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
	this.requestHandler = requestHandler;
	this.contentTypeFinder = contentTypeFinder;
	this.pendingRequests = 0;
	this.checkingFilepath = {};
	
	
	this.server = http.createServer(function (request, response) {
		self.dispatch(request, response);
	});				
};
	
Cachelicious.prototype.start = function ()
{
	this.server.listen(this.port);
	console.log('Server running at http://127.0.0.1:' + this.port);
	if (false !== this.cache) {
		console.log('caching is on');		
	} else {
		console.log('caching is off');				
	}
};
	
Cachelicious.prototype.stop = function () 
{
	this.server.close();		
	console.log('Server shut down');
};
	
Cachelicious.prototype.dispatch = function (request, response) 
{
	var result = this.requestHandler(request), contentType;	
	
	if (false === result) {
		return; //handled somewhere else
	}
	
	if ('number' === typeof result) {
		this.serveStatusCode(request, response, result);
		return;
	}	
	
	contentType = this.contentTypeFinder(result);

	this.streamPath(result, contentType, request, response);
};

Cachelicious.prototype.calculateNextConsumerTimeout = function () 
{
	//var result = Math.min(Math.round(this.pendingRequests/10), 10);
	//console.log(result);
	//return result;
	return Math.min(Math.round(this.pendingRequests/10), 10);
};
	
Cachelicious.prototype.fileCheck = function (filepath, successCb, errorCb) 
{
	//console.log('running stat on:' + filepath)
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
	
Cachelicious.prototype.streamPath = function (filepath, contentType, request, response)
{
	if (false === this.cache) {
		this.asyncServeUncachedStream(filepath, contentType, request, response);
		return;
	}
	
	var
		cachedStream = this.getCached(filepath),
		self = this;

	if (undefined !== cachedStream) {
		self.asyncServeCachedStream(cachedStream, contentType, request, response);
		return;
	}
	

	this.once('fileCheckSuccess-' + filepath, function (cachedStream) {
		self.asyncServeCachedStream(cachedStream, contentType, request, response);						
	});
	
	this.once('fileCheckError-' + filepath, function (error) {
		self.serveStatusCode(request, response, error);
	});		
	
	if (this.checkingFilepath[filepath]) {
		return;
	}
	
	this.checkingFilepath[filepath] = true;
	
	this.fileCheck(filepath,
		function (stat) 
		{
			delete self.checkingFilepath[filepath];
			var cacheStream = new CacheStream(stat.size);
			self.setCached(filepath, cacheStream);
			fs.createReadStream(filepath).pipe(cacheStream);
			
			//console.log('emitting: fileCheckSuccess-' + filepath);
			self.emit('fileCheckSuccess-' + filepath, cacheStream);
			self.removeAllListeners('fileCheckError-' + filepath);
		}, 
		function (error) 
		{
			delete self.checkingFilepath[filepath];
			//console.log('emitting: fileCheckError-' + filepath);
			self.emit('fileCheckError-' + filepath, error);
			self.removeAllListeners('fileCheckSuccess-' + filepath);
		}
	);
};
	
Cachelicious.prototype.asyncServeUncachedStream = function (filepath, contentType, request, response)
{
	var self = this;
	this.fileCheck(filepath, 
		function (stat) {
			response.writeHead(200, {
				'Content-Type':   contentType,
				'Content-Length': stat.size
			});
			
			if ('HEAD' !== request.method) {
				fs.createReadStream(filepath).pipe(response);
			} else {
				response.end();
			}
		}, 
		function (error) {
			self.serveStatusCode(request, response, error);
		}
	);
};
	
	
Cachelicious.prototype.asyncServeCachedStream = function (cachedStream, contentType, request, response)  
{
	var self = this;
	process.nextTick(function () {
		self.serveCachedStream(cachedStream, contentType, request, response);
	});
};
	
//range parsing inspired by https://github.com/meloncholy/vid-streamer/blob/master/index.js
function isNumber(n) 
{
  return !isNaN(parseFloat(n)) && isFinite(n);
}
	
Cachelicious.prototype.serveCachedStream = function (cachedStream, contentType, request, response) 
{
	var startOffset = 0, endOffset = cachedStream.size - 1;
	
	if ('string' === typeof request.headers.range) {
		var parsedRange = request.headers.range.match(/bytes=(.+)-(.+)?/);
		if (null === parsedRange) {
			this.serveStatusCode(request, response, 416);
			return;
		}
		
		if (isNumber(parsedRange[1]) && parsedRange[1] >= 0 && parsedRange[1] < cachedStream.size) {
			startOffset = parsedRange[1];
		} else {
			this.serveStatusCode(request, response, 416);
			return;
		}
		
		if (isNumber(parsedRange[2]) && parsedRange[2] > startOffset && parsedRange[2] < cachedStream.size) {
			endOffset = parsedRange[2];
		} else {
			this.serveStatusCode(request, response, 416);
			return;
		}		

		response.writeHead(206, {
			'Content-Type':   contentType,
			'Status':         '206 Partial Content',
			'Accept-Ranges':  'bytes',
			'Content-Range':  'bytes ' + startOffset + "-" + endOffset + "/" + cachedStream.size,
			'Content-Length': endOffset - startOffset + 1
		});
	} else {
		response.writeHead(200, {
			'Content-Type':   contentType,
			'Content-Length': cachedStream.size
		});
	}
		
	if ('HEAD' !== request.method) {
		++this.pendingRequests;
	
		var self = this;
		(new CacheStreamConsumer(cachedStream, response, startOffset, endOffset))
			.on('end', function () { --self.pendingRequests; })
			.asyncStart(this.calculateNextConsumerTimeout());
	} else {
		response.end();
	}
};

//Found in http://blog.amnuts.com/2007/03/20/http-status-codes/ (thanks)
Cachelicious.prototype.httpStatusCodes = {
	/*code: [majorHttpVersion, minorHttpVersion, message] */	
	100: [1, 1, 'Continue'],
	101: [1, 1, 'Switching Protocols'],
	200: [1, 0, 'OK'],
	201: [1, 0, 'Created'],
	202: [1, 0, 'Accepted'],
	203: [1, 0, 'Non-Authoritative Information'],
	204: [1, 0, 'No Content'],
	205: [1, 0, 'Reset Content'],
	206: [1, 0, 'Partial Content'],
	300: [1, 0, 'Multiple Choices'],
	301: [1, 0, 'Moved Permanently'],
	302: [1, 1, 'Found'],
	303: [1, 1, 'See Other'],
	304: [1, 0, 'Not Modified'],
	305: [1, 0, 'Use Proxy'],
	306: [1, 0, 'Switch Proxy'], // No longer used, but reserved
	307: [1, 0, 'Temporary Redirect'],
	400: [1, 0, 'Bad Request'],
	401: [1, 0, 'Authorization Required'],
	402: [1, 0, 'Payment Required'],
	403: [1, 0, 'Forbidden'],
	404: [1, 0, 'Not Found'],
	405: [1, 0, 'Method Not Allowed'],
	406: [1, 0, 'Not Acceptable'],
	407: [1, 0, 'Proxy Authentication Required'],
	408: [1, 0, 'Request Timeout'],
	409: [1, 0, 'Conflict'],
	410: [1, 0, 'Gone'],
	411: [1, 0, 'Length Required'],
	412: [1, 0, 'Precondition Failed'],
	413: [1, 0, 'Request Entity Too Large'],
	414: [1, 0, 'Request-URI Too Long'],
	415: [1, 0, 'Unsupported Media Type'],
	416: [1, 0, 'Requested Range Not Satisfiable'],
	417: [1, 0, 'Expectation Failed'],
	418: [1, 1, 'I\'m a teapot'], //as per RFC2324 - http://tools.ietf.org/html/rfc2324
	449: [1, 0, 'Retry With'], // Microsoft extension
	500: [1, 0, 'Internal Server Error'],
	501: [1, 0, 'Not Implemented'],
	502: [1, 0, 'Bad Gateway'],
	503: [1, 0, 'Service Unavailable'],
	504: [1, 0, 'Gateway Timeout'],
	505: [1, 0, 'HTTP Version Not Supported'],
	509: [1, 0, 'Bandwidth Limit Exceeded'] // not an official HTTP status code	
};

Cachelicious.prototype.serveStatusCode = function (request, response, code) 
{
	if (typeof this.httpStatusCodes[code] === 'undefined') {
		console.log('replacing invalid status code['+code+'] with 500');
		code = 500;
	}

	if (this.httpStatusCodes[code][0] > request.httpVersionMajor || this.httpStatusCodes[code][1] > request.httpVersionMinor) {
		console.log(
			'replacing incompatible HTTP versions status code['+code+']['+this.httpStatusCodes[code][0]+'.'+this.httpStatusCodes[code][1] + ']' + 
			' with 500 for request with version ['+request.httpVersion+']'
		);
		code = 500;
	}
	
	//console.log('status code for url['+request.url+']: ' + code + ' - ' + this.httpStatusCodes[code][2]);
	
	response.writeHead(code, {'Content-Type': 'text/plain'});
	if ('HEAD' !== request.method) {
		response.end(code + ' - ' + this.httpStatusCodes[code][2], 'utf-8');		
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

