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


var http   = require('http'),
    fs     = require('fs'),
    path   = require('path'),
    LRU    = require("lru-cache"),
    util   = require("util"),
    events = require("events"),
    stream = require("stream"),
    mime   = require("mime");

var cacheliciousVersion = '0.0.3';

if (module) {
	module.exports.mime = mime; //to allow extensibility of the mime types
}


try {
	var connect = require('connect');
	if (module) {
		module.exports.connect = CacheliciousConnect;
	}
} catch (e) {}


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
	this.decoder     = undefined;
	this.stat        = undefined;
	
	if ('object' === typeof this.options && undefined !== this.options.encoding) {
		this.setEncoding(this.options.encoding);
	}
	
	
	var self = this;
	process.nextTick(function () {
		self._init();	
	});
}


util.inherits(CacheStreamConsumer, stream.Stream);

//encoding as seen in https://github.com/joyent/node/blob/master/lib/fs.js
CacheStreamConsumer.prototype.setEncoding = function (encoding) {
	var StringDecoder = require('string_decoder').StringDecoder; // lazy load
	this.decoder = new StringDecoder(encoding);
	this.encoding = encoding;
};

CacheStreamConsumer.prototype._emitData = function (data) {
	if (undefined !== this.decoder) {
		var string = this.decoder.write(data);
		if (string.length > 0) {
			this.emit('data', string); 
		}
	} else {
		this.emit('data', data);
	}
};


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
	this.stat        = this.cacheStream.stat;
	this.totalSize   = this.cacheStream.size;
	this.size        = this.totalSize;
	this.endOffset   = this.size - 1;
	
	
	if (this.options !== undefined) {
		if (this.options.end !== undefined)	{
			if ('number' !== typeof this.options.end) {
				this.options.end = parseInt(this.options.end, 10);
			}
			
			if (isNaN(this.options.end) || this.options.end <= 0 || this.options.end >= this.size) {
				this._setError({type: 'invalid_range', detail: 'invalid_range_end'});
				return;
			}
			
			this.endOffset = this.options.end;
		}


		if (this.options.start !== undefined)	{
			if ('number' !== typeof this.options.start) {
				this.options.start = parseInt(this.options.start, 10);
			}

			if (isNaN(this.options.start) || this.options.start < 0 || this.options.start >= this.end) {
				this._setError({type: 'invalid_range', detail: 'invalid_range_start'});
				return;
			}
			
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


CacheStreamConsumer.prototype.pipe = function (destination, options)
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
	
	return stream.Stream.prototype.pipe.call(this, destination, options);	
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

		this._emitData(data);
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
		} else if (stat.isDirectory()) {
			self.error = {type: 'directory'};
		}	else if (!stat.isFile()) {
			self.error = {type: 'not_file'};
		}			
		
		if (undefined !== self.error) {
			self.emit('error', self.error);
			return;
		}
		
		self.stat = stat;
		
		//success!
		self.size = self.stat.size;
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
	var cacheStream = this.cache.get(filepath), self = this;

	if (undefined === cacheStream) {
		cacheStream = new CacheStream(filepath);
		this.cache.set(filepath, cacheStream);
		
		//needed to update the cache item size to assure the LRU cache respects its memory limit
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

function defaultErrorHandler (error, request, response) 
{
	var code = 500;
	
	if ('number' === typeof error) {
		code = error;
	} else if (error !== undefined && error.type !== undefined) {
		if ('stat' === error.type) {
			code = 404;					
		} else if ('not_file' === error.type || 'directory' === error.type) {
			code = 401;					
		} else if  ('invalid_range' === error.type) {
			code = 416;
		}
	}

	
	
	if (undefined === http.STATUS_CODES[code]) {
		console.log('replacing invalid status code['+code+'] with 500');
		code = 500;
	}
		
	//console.log('status code for url['+request.url+']: ' + code + ' - ' + http.STATUS_CODES[code]);
	
	response.writeHead(code, {
		'Content-Type': 'text/plain',
		'Server':       'Cachelicious/' + cacheliciousVersion
	});
	
	if ('HEAD' !== request.method) {
		response.end(code + ' - ' + http.STATUS_CODES[code], 'utf-8');		
	} else {
		response.end();
	}
}

function defaultContentTypeFinder (filepath)
{
	return mime.lookup(filepath);
}



function CacheliciousHttp (maxCacheSize, requestHandler, errorHandler, contentTypeFinder)
{
	if (undefined === requestHandler) {
		requestHandler = defaultRequestHandler;
	}

	if (undefined === errorHandler) {
		errorHandler = defaultErrorHandler;
	}		
	
	if (undefined ===  maxCacheSize) {
		maxCacheSize = 20971520; //20mb
	}

	if (undefined === contentTypeFinder) {
		contentTypeFinder = defaultContentTypeFinder;
	}		
	
	this.cacheliciousFs    = new CacheliciousFs(maxCacheSize);
	this.requestHandler    = requestHandler;
	this.contentTypeFinder = contentTypeFinder;
	this.errorHandler      = errorHandler;
	this.pendingRequests   = 0;
	this.server            = undefined;
}
	
CacheliciousHttp.prototype.listen = function (port)
{
	if (undefined === this.server) {
		var self = this;
		this.server = http.createServer(function (request, response) {
			self.dispatch(request, response);
		});				
	}
	this.server.listen(port);
	console.log('Server running at http://127.0.0.1:' + port);	
};
	
CacheliciousHttp.prototype.close = function () 
{
	if (undefined !== this.server) {
		this.server.close();		
		console.log('Server shut down');
	}
};
	
CacheliciousHttp.prototype.dispatch = function (request, response, errorHandler) 
{
	if (debugMode) {
		console.log(request.method + ' ' + request.url);
		console.log(request.headers);
	}
	
	var 
	self = this,
	requestHandlerResult = this.requestHandler(request, response, function (requestHandlerResult) {
		self.serveRequest(requestHandlerResult, request, response, errorHandler);
	});
	
	if (undefined === requestHandlerResult) {
		return; //handled somewhere else
	}
	
	this.serveRequest(requestHandlerResult, request, response, errorHandler);
};

CacheliciousHttp.prototype.serveRequest = function (requestHandlerResult, request, response, errorHandler) 
{
	if (undefined === errorHandler) {
		errorHandler = this.errorHandler;
	}
	
	if ('number' === typeof requestHandlerResult) {
		errorHandler(requestHandlerResult, request, response);
		return;
	}	
	
	var 
		contentType = this.contentTypeFinder(requestHandlerResult),
		options     = {},
		self        = this,
		parsedRange;	

	if ('string' === typeof request.headers.range) {
		parsedRange = request.headers.range.match(/bytes=([0-9]+)-([0-9]+)?/);
		if (null === parsedRange) {
			errorHandler({type: 'invalid_range', detail: 'invalid_header'}, request, response);
			return;
		}
		
		//ranged requests without a start are invalid
		if (undefined !== parsedRange[1]) {
			options.start = parsedRange[1];
		} else {
			errorHandler({type: 'invalid_range', detail: 'no_start'}, request, response);
			return;
		}
		
		//will either be undefined (requesting all the bytes starting in parsedRange[1]) or a number to be validated by the CacheStream
		options.end = parsedRange[2];
	} 
	
	this.cacheliciousFs.createReadStream(requestHandlerResult, options)
		.on('error', function (error) {
			errorHandler(error, request, response);
		}).on('readable', function (fileReader) {
			var
				headers = {
					'Accept-Ranges' : 'bytes',
					'Content-Length': fileReader.size,
					'Server'        : 'Cachelicious/' + cacheliciousVersion
				}, 
				code     = 200, 
				sendBody = ('HEAD' !== request.method);
			
			if (undefined !== parsedRange) {
				code = 206;
				headers['Content-Range'] = 'bytes ' + fileReader.startOffset + "-" + fileReader.endOffset + "/" + fileReader.totalSize;
			}
			
			if (!response.getHeader('Date')) {
				headers.Date = (new Date()).toUTCString();
			}
			
			if (!response.getHeader('Last-Modified')) {
				headers['Last-Modified'] = fileReader.stat.mtime.toUTCString();
			} 
			
			if (!response.getHeader('Content-Type')) {
				var charset = mime.charsets.lookup(contentType);
				headers['Content-Type'] = contentType + (charset ? '; charset=' + charset : '');
			} 

			if (request.headers['if-modified-since'] !== undefined) {
				var ifModDate = Date.parse(request.headers['if-modified-since']);
				if (!isNaN(ifModDate) && fileReader.stat.mtime.getTime() <= ifModDate) {
					sendBody = false;
					code     = 304;	
				}
			}
			
			response.writeHead(code, headers);


			if (debugMode) {	
				console.log('response:');
				console.log(response._header);
			}

			if (!sendBody) {
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


function CacheliciousConnect (root, options) 
{
	if (!root) {
		throw new Error('CacheliciousConnect() root path required');		
	} 
	
	if (undefined === options) {
		options = {};		
	}
	
	var redirect = false === options.redirect ? false : true,
	    getOnly  = false === options.getOnly  ? false : true;
	
	var cacheliciousHttp = new CacheliciousHttp(options.maxCacheSize, function (request) {
		var filepath = path.normalize(root);
		if ('/' === request.url.substr(-1)) {
			filepath += request.url + 'index.html';
		} else {
			filepath += request.url;
		}
		return filepath;	
	});	
	
	return function (request, response, next)
	{
		if (getOnly && 'HEAD' !== request.method && 'GET' !== request.method) {
			next();
			return;
		}
		
		cacheliciousHttp.dispatch(request, response, function (error) {
			var code = 500;
			
			if ('number' === typeof error) {
				code = error;
			} else if (error !== undefined && error.type !== undefined) {
				if ('directory' === error.type) { //directory
					if (!redirect) {
						next();
						return;					
					}

					response.writeHead(301, {
						'Location' : request.url + '/',
						'Server'   : 'Cachelicious/' + cacheliciousVersion
					});
					response.end();
					return;					
				}					
				
				if ('stat' === error.type) {
					//mimic static.js behaviour
					if ('ENOENT' === error.detail.code || 'ENAMETOOLONG' === error.detail.code || 'ENOTDIR' === error.detail.code) {
						next();							
					} else {
						next(error.detail);
					}
					return;					
				} else if ('not_file' === error.type) {
					code = 401;					
				} else if  ('invalid_range' === error.type) {
					code = 416;
				}
			}

			next(connect.utils.error(code));
		});
	};
}