var connect = require('connect'),
    cacheliciousConnect = require('../lib/cachelicious').connect,
    http = require('http');

var app = connect()
	.use(cacheliciousConnect(__dirname + '/assets',  {maxCacheSize: 20971520}))
	.listen(3210);
