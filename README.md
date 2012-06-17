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

Apache Bench results serving the 641KB file in the test assets, running on a laptop (initial status - cold cache):
```
Server Software:        Cachelicious/0.0.2
Server Hostname:        127.0.0.1
Server Port:            9876

Document Path:          /medium.jpg
Document Length:        656882 bytes

Concurrency Level:      100
Time taken for tests:   0.737 seconds
Complete requests:      1000
Failed requests:        0
Write errors:           0
Total transferred:      657020000 bytes
HTML transferred:       656882000 bytes
Requests per second:    1356.47 [#/sec] (mean)
Time per request:       73.721 [ms] (mean)
Time per request:       0.737 [ms] (mean, across all concurrent requests)
Transfer rate:          870340.48 [Kbytes/sec] received

Connection Times (ms)
              min  mean[+/-sd] median   max
Connect:        0    2   1.8      2      10
Processing:    26   70  17.3     67     117
Waiting:        9   21   6.4     21      42
Total:         29   72  17.3     69     120
```

License
-----

New BSD License


Contributing
------------

Pull requests are welcome! I'll try to merge all valuable contributions and credit the author when I do so.