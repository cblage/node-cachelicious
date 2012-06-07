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
	module.exports = {http: CacheliciousHttp, fs: CacheliciousFs};
}


var http = require('http');
var fs = require('fs');
var path = require('path');
var LRU = require("lru-cache");
var util = require("util");
var events = require("events");
var stream = require("stream");

function isNumber(n) 
{
  return !isNaN(parseFloat(n)) && isFinite(n);
}


var debugMode = false;

if (debugMode) {
	var reqId = 0;	
}


function CacheStreamConsumer(cacheStream, options) {
	if (debugMode) {
		this.reqId = reqId++; //for debugging purposes
	}
	
	stream.Stream.call(this);

	this.cacheStream = cacheStream;
	this.readable    = false;	
	this.paused      = false;
	this.tickAttempt = 0;
	this.options     = options;	
	this.startOffset = undefined;
	this.endOffset   = undefined;
	this.totalSize   = undefined;
	this.size        = undefined; 
	this.error       = undefined;
	this.ended       = false;
	
	var self = this;
	process.nextTick(function () {
		self._init();	
	});
}


util.inherits(CacheStreamConsumer, stream.Stream);

CacheStreamConsumer.prototype._init = function () 
{
	//console.log('_init!');
	var self = this;
	
	if (this.cacheStream.error !== undefined) {
		this._setError(this.cacheStream.error);
	} else if (this.cacheStream.readable) {
		this._markReadable();
	} else {
		//console.log('attaching to cacheStream');
		this.cacheStream.on('readable', function () {
			self._markReadable();
		}).on('error', function (error) {
			self._setError(error);
		});
	}
};

CacheStreamConsumer.prototype._markReadable = function () 
{
	//console.log('_markReadable');
	if (this.error !== undefined) {
		if (debugMode) {
			console.log(this.reqId + ':MARK READABLE AFTER ERROR, ABORTING');
		}
		return;
	}
	
	this.startOffset = 0;
	this.totalSize   = this.cacheStream.size;
	this.size        = this.totalSize;
	this.endOffset   = this.size - 1;
	
	
	if (this.options !== undefined) {
		if (this.options.end !== undefined)	{
			if (!isNumber(this.options.end) || this.options.end <= 0 || this.options.end >= this.size) {
				this._setError({type: 'invalid_range_end'});
				return;
			}
			
			this.options.end = parseInt(this.options.end, 10);
			
			this.endOffset = this.options.end;
		}


		if (this.options.start !== undefined)	{
			if (!isNumber(this.options.start) || this.options.start < 0 || this.options.start >= this.end) {
				this._setError({type: 'invalid_range_start'});
				return;
			}
			this.options.start = parseInt(this.options.start, 10);
			
			this.startOffset = this.options.start;
		}		
	}
	
	this.readOffset     = this.startOffset;
	this.size           = this.endOffset - this.startOffset + 1;
	this.idealChunkSize = 0.1 * this.size; //10% of request size per chunk

	this.readable = true;
	this.emit('readable', this);
};

CacheStreamConsumer.prototype._setError = function (error) 
{
	//console.log('_setError');
	this.error = error;
	this.emit('error', this.error);
};


CacheStreamConsumer.prototype.pipe = function (destination)
{
	var self = this;	

	if (this.error !== undefined) {
		process.nextTick(function () {
			self.emit('error', self.error);
		});
	} else if (this.readable) {
		process.nextTick(function () {
			self.tick();
		});
	} else {
		this.on('readable', function () {
			self.tick();
		});
	}
	
	stream.Stream.prototype.pipe.call(this, destination);	
	
	return destination;
};


CacheStreamConsumer.prototype.tick = function () 
{
	if (!this.readable) {
		if (debugMode) {
			console.log(this.reqId + ': UNREADABLE TICK! ABORT!');
		}
		return;
	}
	
	if (this.paused || this.ended) {
		//console.log(this.reqId + ': Skipped tick.');
		return;
	}
	
	if (this.readOffset === this.endOffset + 1) {
		if (debugMode) {
			console.log(this.reqId + ': finito!');
		}
		
		this.emit('end');
		this.ended = true;
		return;
	}

	this.tickAttempt++;
	
	var 
	outputMaxOffset = Math.min(this.endOffset, this.cacheStream.writeOffset - 1), //can only read up to writeOffset - 1 or we'll read junk data
	servedChunkSize = outputMaxOffset - this.readOffset + 1,
	canServe        = false;
	
	if (servedChunkSize > 0) {
		if (this.endOffset === outputMaxOffset) {  //last chunk, serve asap
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
		
		if (debugMode) {
			console.log(this.reqId + ': be readoffset, endoffset, writeoffset [' + this.readOffset + ', ' + this.endOffset + ', '+ this.cacheStream.writeOffset + ']');		
		}
		
		var data = this.cacheStream.buffer.slice(this.readOffset, outputMaxOffset + 1);
		//outputMaxOffset+1 is due to retarded slice / copy API: http://stackoverflow.com/questions/8804809/node-js-buffer-copy-api-looks-very-strange-and-not-similar-to-memcpy-in-c
		
		if (debugMode) {
			console.log(this.reqId + ': emitting chunk with size['+servedChunkSize+', ' + data.length + '] outputMaxOffset: ' + outputMaxOffset);
		}
			
		//console.log('data.length', data.length);
		//console.log('servedChunkSize', servedChunkSize);
					
		this.readOffset += data.length; 

		if (debugMode) {
			console.log(this.reqId + ': ae readoffset, endoffset, writeoffset [' + this.readOffset + ', ' + this.endOffset + ', '+ this.cacheStream.writeOffset + ']');
		}

		this.emit('data', data);
	}
	
	var self = this;
	if (this.cacheStream.writable) {
		//console.log(this.reqId + ': waiting for more data');
		this.cacheStream.once('data', function () {
			//console.log(self.reqId + ': moar data!');
			self.tick();
		});		
	} else {
		process.nextTick(function () {
			self.tick();
		});
	}
};

CacheStreamConsumer.prototype.pause = function () 
{
	if (!this.readable) {
		if (debugMode) {
			console.log(this.reqId + ': IGNORING UNREADABLE PAUSE');
		}
		return;
	}
	
	if (debugMode) {
		console.log(this.reqId + ': paused!');
	}
	
	this.paused = true;
};

CacheStreamConsumer.prototype.resume = function () 
{
	if (!this.readable) {
		if (debugMode) {
			console.log(this.reqId + ':IGNORING UNREADABLE RESUME');
		}
		return;
	}
	
	if (debugMode) {
		console.log(this.reqId + ': resumed!');
	}
	
	this.paused = false;
	//if the response asked to be resumed, lets prioritize it in this tick
	this.tick();
};



function CacheStream(filepath) {
	stream.Stream.call(this);
	
	this.error = undefined;
	this.stat  = undefined;
	this.size  = undefined;
	this.writeOffset = 0;
	this.writable = false;
	this.readable = false;
	this.filepath = filepath;
	this.fileCheck();
	this.setMaxListeners(0);
}

util.inherits(CacheStream, stream.Stream);


CacheStream.prototype.fileCheck = function () 
{
	var self = this; 

	//console.log('running fs.stat on ' + this.filepath);
	
	fs.stat(this.filepath, function (error, stat) {
		//self.emit('stat', error, stat);

		if (null !== error) {
			self.error = {type: 'stat', detail: error};
		} else if (undefined === stat) {
			self.error = {type: 'no_stat'};
		} else if (!stat.isFile()) {
			self.error = {type: 'not_file'};
		}			
		
		if (undefined !== self.error) {
			self.emit('error', self.error);
			return;
		}
		
		self.stat = stat;
		
		//success!
		self.size     = self.stat.size;
		self.emit('size', self);
		
		self.buffer   = new Buffer(self.stat.size);
		self.writable = true;
		self.readable = true;
		fs.createReadStream(self.filepath).pipe(self);
		
		self.emit('readable', self);
		//console.log('cachestream emitting readable');
	});				
};

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




function CacheliciousFs(maxCacheSize) 
{
	this.cache = LRU(maxCacheSize, function (cacheStream) {
		return undefined === cacheStream.size ? 1 : cacheStream.size;
	});		
}

CacheliciousFs.prototype.createReadStream = function (filepath, options) 
{
	var	cacheStream = this.cache.get(filepath), self = this;

	if (undefined === cacheStream) {
		cacheStream = new CacheStream(filepath);
		this.cache.set(filepath, cacheStream);
		
		//needed to update the cache size properly on the LRU
		cacheStream.on('size', function () {
			self.cache.del(filepath);
			self.cache.set(filepath, cacheStream); //recalculate size
		});
	}
		
	return new CacheStreamConsumer(cacheStream, options);
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
		case '.avi':
			return 'video/avi';
		case '.mp4':
			return 'video/mp4';
		case '.mov':
			return 'video/quicktime';
		case '.m4v':
			return 'video/x-m4v';
	}
	return 'text/html';
}

function CacheliciousHttp (requestHandler, maxCacheSize, port, contentTypeFinder)
{
	if (undefined === requestHandler) {
		requestHandler = defaultRequestHandler;
	}
	
	if (undefined === contentTypeFinder) {
		contentTypeFinder = defaultContentTypeFinder;
	}		
	
	if (undefined === port) {
		port = 9876;
	}
	
	if (undefined ===  maxCacheSize) {
		maxCacheSize = 20971520; //20mb
	}
	
	this.cacheliciousFs = new CacheliciousFs(maxCacheSize);
	this.port = port;
	this.requestHandler = requestHandler;
	this.contentTypeFinder = contentTypeFinder;
	this.pendingRequests = 0;
	
	
	var self = this;
	this.server = http.createServer(function (request, response) {
		self.dispatch(request, response);
	});				
}
	
CacheliciousHttp.prototype.start = function ()
{
	this.server.listen(this.port);
	console.log('Server running at http://127.0.0.1:' + this.port);
};
	
CacheliciousHttp.prototype.stop = function () 
{
	this.server.close();		
	console.log('Server shut down');
};
	
CacheliciousHttp.prototype.dispatch = function (request, response) 
{
	if (debugMode) {
		console.log('req:');
		console.log(request.headers);
	}
	
	var filepath = this.requestHandler(request), contentType, options = {}, self = this, parsedRange;	
	
	if (false === filepath) {
		return; //handled somewhere else
	}
	
	if ('number' === typeof filepath) {
		this.serveStatusCode(request, response, filepath);
		return;
	}	
	
	contentType = this.contentTypeFinder(filepath);
	
	if ('string' === typeof request.headers.range) {
		parsedRange = request.headers.range.match(/bytes=([0-9]+)-([0-9]+)?/);
		if (null === parsedRange) {
			this.serveStatusCode(request, response, 416);
			return;
		}
		
		if (isNumber(parsedRange[1]) && parsedRange[1] >= 0) {
			options.start = parsedRange[1];
		} else {
			this.serveStatusCode(request, response, 416);
			return;
		}
		
		if (isNumber(parsedRange[2]) && parsedRange[2] > options.start) {
			options.end = parsedRange[2];
		} else if (undefined !== parsedRange[2]) {
			this.serveStatusCode(request, response, 416);
			return;
		}		
	} 
	
	if (debugMode) {
		response.on('close', function() { console.log('response canceled!'); });
	}
	
	//range parsing inspired by https://github.com/meloncholy/vid-streamer/blob/master/index.js
	this.cacheliciousFs.createReadStream(filepath, options)
		.on('error', function (error) {
			var code = 500;
			if (error !== undefined && error.type !== undefined) {
				if ('stat' === error.type) {
					code = 404;					
				} else if ('not_file' === error.type) {
					code = 401;					
				} else if  ('invalid_range_end' === error.type || 'invalid_range_start' === error.type) {
					code = 416;
				}
			}
			self.serveStatusCode(request, response, code);
		}).on('readable', function (fileReader) {
			if (undefined !== parsedRange) {
				response.writeHead(206, {
					'Content-Type':      contentType,
					'Accept-Ranges':     'bytes',
					'Content-Range':     'bytes ' + fileReader.startOffset + "-" + fileReader.endOffset + "/" + fileReader.totalSize,
					'Content-Length':    fileReader.size,
					'Server':            'Cachelicious/alpha'
				});
			} else {
				response.writeHead(200, {
					'Content-Type':   contentType,
					'Content-Length': fileReader.size,
					'Accept-Ranges':  'bytes',
					'Server':         'Cachelicious/alpha'
					
				});
			}

			if (debugMode) {	
				console.log('response:');
				console.log(response._header);
			}

			if ('HEAD' === request.method) {
				response.end();
			} else { 
				var timeout = Math.min(Math.round(self.pendingRequests/10), 10);
				//console.log('t: ' + timeout);		
				self.pendingRequests++;
				//console.log('p:' + self.pendingRequests);
				//response.on('close', function() { fileReader.destroy(); });
				
				setTimeout(function () {
					fileReader.on('error', function () { 
						self.pendingRequests--;
						//console.log('p:' + self.pendingRequests); 
					}).on('end', function () { 
						self.pendingRequests--;
						//console.log('p:' + self.pendingRequests); 
					}).pipe(response);	
				}, timeout);
			}
		});
};


//Found in http://blog.amnuts.com/2007/03/20/http-status-codes/ (thanks)
CacheliciousHttp.prototype.httpStatusCodes = {
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

CacheliciousHttp.prototype.serveStatusCode = function (request, response, code) 
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
	
	response.writeHead(code, {
		'Content-Type': 'text/plain',
		'Server':       'Cachelicious/alpha'
	});
	if ('HEAD' !== request.method) {
		response.end(code + ' - ' + this.httpStatusCodes[code][2], 'utf-8');		
	} else {
		response.end();
	}
};
	
