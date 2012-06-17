Cachelicious
=============

Who said caching and serving cached files should be a chore? 

With Cachelicious it's easier than baking a pie, and almost as delicious as eating it. Mmmmm, pie.... *drool*


Installation
-----------

    npm install cachelicious


FS Cache Usage
-----

```js
var CacheliciousFs = require('cachelicious').fs;
var fsCache = new CacheliciousFs(20971520); //20MB of cache

fsCache.createReadStream(filepath, options).pipe(destination1);
fsCache.createReadStream(filepath, {start: 2, end: 100}).pipe(destination2);
//both will stream from the same cache :)

```

Standalone HTTP Server Usage
-----

```js
var CacheliciousHttp = require('cachelicious').http;

//create an HTTP cache server with 20MB to serve files from the assets directory
(new CacheliciousHttp(20971520, __dirname + '/assets')).listen(9876);	
```

Connect Middleware Usage
-----

```js
var connect = require('connect'),
    cacheliciousConnect = require('cachelicious').connect,
    http = require('http');

var app = connect()
	.use(cacheliciousConnect(__dirname + '/assets',  {maxCacheSize: 20971520}))
	.listen(3210);
```


Some test assets are included in the test/assets directory.

You can also try streaming video (and you should :D), like the Big Buck Bunny - http://www.bigbuckbunny.org/index.php/download/

Ranged HTTP requests are fully supported :)

Fast
-----

[APIB](http://code.google.com/p/apib/) results serving the 641KB file in the test assets, running on a 2011 MacBook Air i7 1.8GHz (initial status - cold cache):

**Standlone HTTP server** *test/http.js*

	apib -d 30 -c 200 -K 2  http://127.0.0.1:9876/medium.jpg

```
Duration:             30.004 seconds
Attempted requests:   53845
Successful requests:  53845
Non-200 results:      0
Connections opened:   200
Socket errors:        0

Throughput:           1794.583 requests/second
Average latency:      111.210 milliseconds
Minimum latency:      39.997 milliseconds
Maximum latency:      243.020 milliseconds
Latency std. dev:     12.224 milliseconds
50% latency:          109.000 milliseconds
90% latency:          124.159 milliseconds
98% latency:          142.353 milliseconds
99% latency:          148.804 milliseconds

Client CPU average:    0%
Client CPU max:        0%
Client memory usage:    0%

Total bytes sent:      3.71 megabytes
Total bytes received:  33792.17 megabytes
Send bandwidth:        0.99 megabits / second
Receive bandwidth:     9009.99 megabits / second
```

**Cachelicious Connect Middleware** *test/connect.js*
	
	apib -d 30 -c 200 -K 2  http://127.0.0.1:3210/medium.jpg

```
Duration:             30.004 seconds
Attempted requests:   49598
Successful requests:  49598
Non-200 results:      0
Connections opened:   200
Socket errors:        0

Throughput:           1653.028 requests/second
Average latency:      120.535 milliseconds
Minimum latency:      46.361 milliseconds
Maximum latency:      572.141 milliseconds
Latency std. dev:     31.452 milliseconds
50% latency:          115.357 milliseconds
90% latency:          137.229 milliseconds
98% latency:          161.885 milliseconds
99% latency:          194.394 milliseconds

Client CPU average:    0%
Client CPU max:        0%
Client memory usage:    0%

Total bytes sent:      3.42 megabytes
Total bytes received:  31150.77 megabytes
Send bandwidth:        0.91 megabits / second
Receive bandwidth:     8305.67 megabits / second
```

**Static + Static Cache Connect Middleware** *test/connectStatic.js*

	apib -d 30 -c 200 -K 2  http://127.0.0.1:4321/medium.jpg

```
Duration:             30.004 seconds
Attempted requests:   15000
Successful requests:  15000
Non-200 results:      0
Connections opened:   200
Socket errors:        0

Throughput:           499.940 requests/second
Average latency:      398.803 milliseconds
Minimum latency:      371.709 milliseconds
Maximum latency:      525.252 milliseconds
Latency std. dev:     24.629 milliseconds
50% latency:          390.023 milliseconds
90% latency:          431.956 milliseconds
98% latency:          475.991 milliseconds
99% latency:          505.020 milliseconds

Client CPU average:    0%
Client CPU max:        0%
Client memory usage:    0%

Total bytes sent:      1.04 megabytes
Total bytes received:  9410.90 megabytes
Send bandwidth:        0.28 megabits / second
Receive bandwidth:     2509.27 megabits / second
```


License
-----

[New BSD License](https://github.com/cblage/node-cachelicious/blob/master/LICENSE) 


Contributing
------------

Pull requests are welcome! I'll try to merge all valuable contributions and credit the author when I do so.