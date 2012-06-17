var connect = require('connect'),
    cachelicious = require('../lib/cachelicious'),
    http = require('http');

var app = connect()
	//.use(connect.staticCache())
	//.use(connect.static(__dirname + '/assets'))
	.use(cachelicious.connect(__dirname + '/assets'))
	.listen(3210);