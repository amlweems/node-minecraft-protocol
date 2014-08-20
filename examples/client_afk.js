var mc = require('../')
  , states = mc.protocol.states

function spawn(name) {
  var client = mc.createClient({
    host: "trebuchet.me",
    port: 25565,
    username: name,
    keepAlive: true,
  });

  client.on('connect', function() {
    console.info('connected: ' + name);
  });

  client.on('end', function() {
    console.info('disconnected: ' + name);
		setTimeout(function() {
			spawn(name);
		}, 7500);
  });
}

process.argv.forEach(function(val, index, array) {
  if (index <= 1) {
    return;
  }
	spawn(val);
});
