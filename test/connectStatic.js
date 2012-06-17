var connect = require('connect'),
    http = require('http');

var app = connect()
	.use(connect.staticCache({maxLength: 20971520}))
	.use(connect.static(__dirname + '/assets'))
	.listen(4321);
