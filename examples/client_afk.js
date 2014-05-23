var mc = require('../')
  , states = mc.protocol.states

process.argv.forEach(function(val, index, array) {
  if (index == 0) {
    return;
  }
  mc.createClient({
    host: "trebuchet.me",
    port: 25565,
    username: val,
  });
});
