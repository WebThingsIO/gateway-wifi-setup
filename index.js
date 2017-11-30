console.log('starting the wifi server');

var Express = require('express');
var Handlebars = require('handlebars');
var bodyParser = require('body-parser');
var fs = require('fs');
var run = require('./run.js');
var platform = require('./platform.js');
var wifi = require('./wifi.js');
var wait = require('./wait.js');

// The Edison device can't scan for wifi networks while in AP mode, so
// we've got to scan before we enter AP mode and save the results
var preliminaryScanResults;

// Wait until we have a working wifi connection. Retry every 3 seconds up
// to 10 times. If we are connected, then start the Vaani client.
// If we never get a wifi connection, go into AP mode.
// Before we start, though, let the user know that something is happening
waitForWifi(20, 3000)
  .then(() => {
    console.log('start the gateway');
    startVaani();
    console.log('stop wifi setup');
    stopWifiService();
  })
  .catch((err) => {
	console.log('error starting wifi:', err);
	startAP();
	}
   );

// Meanwhile, start running the server.
startServer();


// Return a promise, then check every interval ms for a wifi connection.
// Resolve the promise when we're connected. Or, if we aren't connected
// after maxAttempts attempts, then reject the promise
function waitForWifi(maxAttempts, interval) {
  return new Promise(function(resolve, reject) {
    var attempts = 0;
    check();

    function check() {
      attempts++;
      console.log('check', attempts);
      wifi.getStatus()
        .then(status => {
          console.log(status);
          if (status === 'COMPLETED') {
            console.log('Wifi connection found. resolving');
            resolve();
	    console.log('resolved'); 
          }
          else {
            console.log('No wifi connection on attempt', attempts);
            retryOrGiveUp()
          }
        })
        .catch(err => {
          console.error('Error checking wifi on attempt', attempts, ':', err);
          retryOrGiveUp();
        });
    }

    function retryOrGiveUp() {
      if (attempts >= maxAttempts) {
        console.error('Giving up. No wifi available.');
        reject();
      }
      else {
        setTimeout(check, interval);
      }
    }
  });
}

function startAP() {
  console.log("startAP");

  // Scan for wifi networks now because we can't always scan once
  // the AP is being broadcast
  wifi.scan(10)   // retry up to 10 times
    .then(ssids => preliminaryScanResults = ssids) // remember the networks
    .then(() => wifi.startAP())                    // start AP mode
    .then(() => {
      console.log('No wifi found; entering AP mode')
      talkOnFirstPage = true; // continue talking to the user when they connect
    });
}

function startServer(wifiStatus) {

   // The express server
   var server = Express();

  // When we get POSTs, handle the body like this
  server.use(bodyParser.urlencoded({extended:false}));

  // Define the handler methods for the various URLs we handle
  server.get('/*', handleCaptive);
  server.get('/', handleRoot);
  server.get('/wifiSetup', handleWifiSetup);
  server.post('/connecting', handleConnecting);
  server.get('/status', handleStatus);

  // And start listening for connections
  // XXX: note that we are HTTP only... is this a security issue?
  // XXX: for first-time this is on an open access point.
  server.listen(8080);
  console.log('HTTP server listening');
}

function getTemplate(filename) {
  return Handlebars.compile(fs.readFileSync(filename, 'utf8'));
}

var wifiSetupTemplate = getTemplate('./templates/wifiSetup.hbs');
var oauthSetupTemplate = getTemplate('./templates/oauthSetup.hbs');
var connectingTemplate = getTemplate('./templates/connecting.hbs');
var statusTemplate = getTemplate('./templates/status.hbs');
var hotspotTemplate = getTemplate('./templates/hotspot.hbs');

// When the client issues a GET request for the list of wifi networks
// scan and return them

// this function handles requests for captive portals
function handleCaptive(request, response, next) {
  console.log('handleCaptive', request.path);
  if (request.path === '/hotspot.html') {
	console.log('sending hotspot');
	response.send(hotspotTemplate());
  } else if (request.path === '/hotspot-detect.html' || 
	    request.path === '/connecttest.txt') {
	console.log('CAPTIVE PORTAL REQUEST BY IOS OR MAC', request.path);
	if (request.get('User-Agent').includes('CaptiveNetworkSupport') || 
	  request.get('User-Agent').includes('Microsoft NCSI')) {
		console.log('redirect to hotspot.html');
		response.redirect(302, 'http://10.0.0.1/hotspot.html');
	} else {
		response.redirect(302, 'http://10.0.0.1/wifiSetup');
	}
  } else if (request.path === '/generate_204' || request.path === '/fwlink/') {
	console.log('no handle captive mas nao tem o header do captive network support. deve ser google');
        response.redirect(302, 'http://10.0.0.1/wifiSetup');
  } else {
	console.log('no handle captive mas nao caiu em condicao nenhuma. passando');
   	next();
  }
}

// This function handles requests for the root URL '/'.
// We display a different page depending on what stage of setup we're at
function handleRoot(request, response) {
  wifi.getStatus().then(status => {
    // If we don't have a wifi connection yet, display the wifi setup page
    if (status !== 'COMPLETED') {
      console.log("no wifi connection; redirecting to wifiSetup");
      response.redirect('/wifiSetup');
    }
    else {
      // Otherwise, look to see if we have an oauth token yet
      console.log("wifi setup complete; redirecting /status");
      response.redirect('/status');
    }
  })
  .catch(e => {
    console.error(e);
  });
}

function handleWifiSetup(request, response) {

  wifi.scan().then(results => {
    // On Edison, scanning will fail since we're in AP mode at this point
    // So we'll use the preliminary scan instead
    if (results.length === 0) {
      results = preliminaryScanResults;
    }

    // XXX
    // To handle the case where the user entered a bad password and we are
    // not connected, we should show the networks we know about, and modify
    // the template to explain that if the user is seeing it, it means
    // that the network is down or password is bad. This allows the user
    // to re-enter a network.  Hopefully wpa_supplicant is smart enough
    // to do the right thing if there are two entries for the same ssid.
    // If not, we could modify wifi.defineNetwork() to overwrite rather than
    // just adding.

    response.send(wifiSetupTemplate({ networks: results }));
  });
}

function handleConnecting(request, response) {
  var ssid = request.body.ssid.trim();
  var password = request.body.password.trim();

  // XXX
  // We can come back here from the status page if the user defines
  // more than one network. We always need to call defineNetwork(), but
  // only need to call stopAP() if we're actually in ap mode.
  //
  // Also, if we're not in AP mode, then we should just redirect to
  // /status instead of sending the connecting template.
  //

  response.send(connectingTemplate({ssid: ssid}));

  // Wait before switching networks to make sure the response gets through.
  // And also wait to be sure that the access point is fully down before
  // defining the new network. If I only wait two seconds here, it seems
  // like the Edison takes a really long time to bring up the new network
  // but a 5 second wait seems to work better.
  wait(2000)
    .then(() => wifi.stopAP())
    .then(() => wait(5000))
    .then(() => wifi.defineNetwork(ssid, password))
    .then(() => waitForWifi(20, 3000))
    .then(() => {
    	console.log('start the gateway');
    	startVaani();
    	console.log('stop wifi setup');
    	stopWifiService();
     })
    .catch((error) => {
	console.log('General Error:', error);
    });
}

function handleStatus(request, response) {
  wifi.getConnectedNetwork().then(ssid => {
    var until = '';
    response.send(statusTemplate({
      ssid: ssid,
      until: until
    }));
  });
}

function startVaani() {
  return run(platform.startVaani)
    .then((out) => console.log('Gateway started', out))
    .catch((err) => console.error('Error starting Gateway:', err));
}

function stopVaani() {
  return run(platform.stopVaani)
    .then((out) => console.log('Gateway stopped', out))
    .catch((err) => console.error('Error stopping Gateway:', err));
}

function restartVaani() {
  return run(platform.restartVaani)
    .then((out) => console.log('Gateway restarted', out))
    .catch((err) => console.error('Error restarting Gateway:', err));
}

function stopWifiService() {
  return run(platform.stopWifiService)
    .then((out) => console.log('VWifi service stopped', out))
    .catch((err) => console.error('Error stopping wifi service:', err));
}
