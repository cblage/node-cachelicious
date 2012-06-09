Cachelicious
=============

Who said caching and serving cached files should be a chore? 

With Cachelicious it's easier than baking a pie, and almost as delicious as eating it. Mmmmm, pie.... *drool*


Installation
-----------

    node install cachelicious


FS Cache Usage
-----

```js
var CacheliciousFs = require('cachelicious').fs;
var fsCache = new CacheliciousFs(20971520); //20MB of cache

fsCache.createReadStream(filepath, options).pipe(destination1);
fsCache.createReadStream(filepath, {start: 2, end: 100}).pipe(destination2);
//both will stream from the same cache :)

```

HTTP Server Usage
-----

```js
var CacheliciousHttp = require('cachelicious').http;

(new CacheliciousHttp(function  (request) {
	var filepath = '/var/www/foo/';
	if ('/' === request.url) {
		return filepath + 'index.html';
	} else if ('/teapot' === request.url) {
		return 418; //generate a 418
	} else {
		filepath += request.url;
	}
	return filepath;
}, 209715200)).start();	
```

Some test assets are included in the test/assets directory.

You can also try streaming video (and you should :D), like the Big Buck Bunny - http://www.bigbuckbunny.org/index.php/download/

License
-----

New BSD License


Contributing
------------

Pull requests are welcome! I'll try to merge all valuable contributions and credit the author when I do so.