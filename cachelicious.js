var http = require('http');
var fs = require('fs');
var path = require('path');
var strean = require('stream');

Cachelicious = function (basepath, port)
{
	this.init(basepath, port)
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
		
		this.port = port;
		this.basepath = basepath;
		
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
		console.log('request starting...');
		var filepath = this.basepath,
		    self = this;
		
		if ('/' === request.url) {
			filepath += '/index.html';
		} else {
			filepath += request.url;
		}
				
		console.log('filepath:' + filepath)
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
		this.streamPath(filepath, response);		
	},
	
	streamPath: function (filepath, response)
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
	
	serveError: function (code, response) 
	{
		console.log('error:' + code);
		response.writeHead(code, { 'Content-Type': 'text/html' });
		response.end(""+code, 'utf-8');;		
	}


};

(new Cachelicious()).start();	