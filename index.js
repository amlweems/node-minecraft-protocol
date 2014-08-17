var EventEmitter = require('events').EventEmitter
        , util = require('util')
        , assert = require('assert')
        , crypto = require('crypto')
        , bufferEqual = require('buffer-equal')
        , superagent = require('superagent')
        , protocol = require('./lib/protocol')
        , Client = require('./lib/client')
        , Server = require('./lib/server')
        , Yggdrasil = require('./lib/yggdrasil.js')
        , getSession = Yggdrasil.getSession
        , validateSession = Yggdrasil.validateSession
        , joinServer = Yggdrasil.joinServer
        , states = protocol.states
        , debug = protocol.debug
        ;

module.exports = {
  createClient: createClient,
  createServer: createServer,
  Client: Client,
  Server: Server,
  ping: require('./lib/ping'),
  protocol: protocol,
  yggdrasil: Yggdrasil,
};

function createServer(options) {
  options = options || {};
  var port = options.port != null ?
          options.port :
          options['server-port'] != null ?
          options['server-port'] :
          25565;
  var host = options.host || '0.0.0.0';
  var kickTimeout = options.kickTimeout || 10 * 1000;
  var checkTimeoutInterval = options.checkTimeoutInterval || 4 * 1000;
  var onlineMode = options['online-mode'] == null ? true : options['online-mode'];

  var server = new Server(options);
  server.motd = options.motd || "A Minecraft server";
  server.maxPlayers = options['max-players'] || 20;
  server.playerCount = 0;
  server.onlineModeExceptions = {};
  server.on("connection", function(client) {
    client.once([states.HANDSHAKING, 0x00], onHandshake);
    client.once([states.LOGIN, 0x00], onLogin);
    client.once([states.STATUS, 0x00], onPing);
    client.on('end', onEnd);

    var keepAlive = false;
    var loggedIn = false;
    var lastKeepAlive = null;

    var keepAliveTimer = null;
    var loginKickTimer = setTimeout(kickForNotLoggingIn, kickTimeout);

    var hash;

    function kickForNotLoggingIn() {
      client.end('LoginTimeout');
    }

    function keepAliveLoop() {
      if (!keepAlive)
        return;

      // check if the last keepAlive was too long ago (kickTimeout)
      var elapsed = new Date() - lastKeepAlive;
      if (elapsed > kickTimeout) {
        client.end('KeepAliveTimeout');
        return;
      }
      client.write(0x00, {
        keepAliveId: Math.floor(Math.random() * 2147483648)
      });
    }

    function onKeepAlive(packet) {
      lastKeepAlive = new Date();
    }

    function startKeepAlive() {
      keepAlive = true;
      lastKeepAlive = new Date();
      keepAliveTimer = setInterval(keepAliveLoop, checkTimeoutInterval);
      client.on(0x00, onKeepAlive);
    }

    function onEnd() {
      clearInterval(keepAliveTimer);
      clearTimeout(loginKickTimer);
    }

    function onPing(packet) {
      var response = {
        "version": {
          "name": protocol.minecraftVersion,
          "protocol": protocol.version
        },
        "players": {
          "max": server.maxPlayers,
          "online": server.playerCount,
          "sample": []
        },
        "description": {"text": server.motd},
        "favicon": server.favicon
      };

      client.once([states.STATUS, 0x01], function(packet) {
        client.write(0x01, { time: packet.time });
        client.end();
      });
      client.write(0x00, {response: JSON.stringify(response)});
    }

    function onLogin(packet) {
      client.username = packet.username;
      loginClient();
    }

    function onHandshake(packet) {
      if (packet.nextState == 1) {
        client.state = states.STATUS;
      } else if (packet.nextState == 2) {
        client.state = states.LOGIN;
      }
    }

    function loginClient() {
      client.write(0x02, {uuid: (client.uuid | 0).toString(10), username: client.username});
      client.state = states.PLAY;
      loggedIn = true;
      startKeepAlive();

      clearTimeout(loginKickTimer);
      loginKickTimer = null;

      server.playerCount += 1;
      client.once('end', function() {
        server.playerCount -= 1;
      });
      server.emit('login', client);
    }
  });
  server.listen(port, host);
  return server;
}

function createClient(options) {
  assert.ok(options, "options is required");
  var port = options.port || 25565;
  var host = options.host || 'localhost';
  var clientToken = options.clientToken || Yggdrasil.generateUUID();
  var accessToken = options.accessToken || null;

  assert.ok(options.username, "username is required");
  var haveCredentials = options.password != null || (clientToken != null && accessToken != null);
  var keepAlive = options.keepAlive == null ? true : options.keepAlive;


  var client = new Client(false);
  client.on('connect', onConnect);
  if (keepAlive) client.on([states.PLAY, 0x00], onKeepAlive);
  client.once([states.LOGIN, 0x02], onLogin);
  client.once([states.LOGIN, 0x03], onSetCompression);
  
  if (haveCredentials) {
    // make a request to get the case-correct username before connecting.
    var cb = function(err, session) {
      if (err) {
        client.emit('error', err);
      } else {
        client.session = session;
        client.username = session.username;
        accessToken = session.accessToken;
        client.emit('session');
        client.connect(port, host);
      }
    };
    
    if (accessToken != null) getSession(options.username, accessToken, options.clientToken, true, cb);
    else getSession(options.username, options.password, options.clientToken, false, cb);
  } else {
    // assume the server is in offline mode and just go for it.
    client.username = options.username;
    client.connect(port, host);
  }

  return client;

  function onConnect() {
    client.write(0x00, {
      protocolVersion: protocol.version,
      serverHost: host,
      serverPort: port,
      nextState: 2
    });

    client.state = states.LOGIN;
    client.write(0x00, {
      username: client.username
    });
  }

  function onKeepAlive(packet) {
    client.writeRaw(new Buffer([0x03, 0x00, 0x03, 0x01]));
  }

  function onSetCompression(packet) {
    client.compression.enabled = true;
    client.compression.threshold = packet.threshold;
  }
  
  function onLogin(packet) {
    client.state = states.PLAY;
    client.uuid = packet.uuid;
    client.username = packet.username;
  }
}


function mcHexDigest(hash) {
  var buffer = new Buffer(hash.digest(), 'binary');
  // check for negative hashes
  var negative = buffer.readInt8(0) < 0;
  if (negative)
    performTwosCompliment(buffer);
  var digest = buffer.toString('hex');
  // trim leading zeroes
  digest = digest.replace(/^0+/g, '');
  if (negative)
    digest = '-' + digest;
  return digest;

  function performTwosCompliment(buffer) {
    var carry = true;
    var i, newByte, value;
    for (i = buffer.length - 1; i >= 0; --i) {
      value = buffer.readUInt8(i);
      newByte = ~value & 0xff;
      if (carry) {
        carry = newByte === 0xff;
        buffer.writeUInt8((newByte + 1) & 0xff, i);
      } else {
        buffer.writeUInt8(newByte, i);
      }
    }
  }
}
