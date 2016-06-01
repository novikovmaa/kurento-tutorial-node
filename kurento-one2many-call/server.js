/*
 * (C) Copyright 2014-2015 Kurento (http://kurento.org/)
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 */

var path = require('path');
var url = require('url');
var express = require('express');
var minimist = require('minimist');
var ws = require('ws');
var kurento = require('kurento-client');
var fs    = require('fs');
var https = require('https');

var argv = minimist(process.argv.slice(2), {
    default: {
        as_uri: 'https://localhost:8443/',
        ws_uri: 'ws://localhost:8888/kurento'
    }
});

var options =
{
  key:  fs.readFileSync('keys/server.key'),
  cert: fs.readFileSync('keys/server.crt')
};

var app = express();

/*
 * Definition of global variables.
 */
var idCounter = 0;
var candidatesQueue = {};
var kurentoClient = null;
// array addressed by sessionId
var presenter = [];
var viewers = [];
var lastPresenter = 1;
var noPresenterMessage = 'No active presenter. Try again later...';

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console.log('Kurento Tutorial started');
    console.log('Open ' + url.format(asUrl) + ' with a WebRTC capable browser');
});

var wss = new ws.Server({
    server : server,
    path : '/one2many'
});

function nextUniqueId() {
	idCounter++;
	return idCounter.toString();
}

/*
 * Management of WebSocket messages
 */
wss.on('connection', function(ws) {

	var sessionId = nextUniqueId();
	console.log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console.log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console.log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        console.log('Connection ' + sessionId + ' received message ', message);

        switch (message.id) {
        case 'presenter':
			startPresenter(sessionId, ws, message.sdpOffer, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'presenterResponse',
						response : 'rejected',
						message : error
					}));
				}
				ws.send(JSON.stringify({
					id : 'presenterResponse',
					response : 'accepted',
					presenterId : sessionId,
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'viewer':
			// message has to contain presenterId
			console.log("start viewer, presenterId: "+message.presenterId+", sessionId"+sessionId);
			startViewer(sessionId, ws, message.sdpOffer, message.presenterId, function(error, sdpAnswer) {
				if (error) {
					return ws.send(JSON.stringify({
						id : 'viewerResponse',
						response : 'rejected',
						message : error
					}));
				}

				ws.send(JSON.stringify({
					id : 'viewerResponse',
					response : 'accepted',
					sdpAnswer : sdpAnswer
				}));
			});
			break;

        case 'stop':
            stop(sessionId);
            break;

        case 'onIceCandidate':
            onIceCandidate(sessionId, message.candidate);
            break;

        default:
            ws.send(JSON.stringify({
                id : 'error',
                message : 'Invalid message ' + message
            }));
            break;
        }
    });
});

/*
 * Definition of functions
 */

// no fix needed
// Recover kurentoClient for the first time.
function getKurentoClient(callback) {
    if (kurentoClient !== null) {
        return callback(null, kurentoClient);
    }

    kurento(argv.ws_uri, function(error, _kurentoClient) {
        if (error) {
            console.log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

// fixed
function startPresenter(sessionId, ws, sdpOffer, callback) {
	clearCandidatesQueue(sessionId);

	if (typeof presenter[sessionId] !== 'undefined' && presenter[sessionId] !== null) {
		stop(sessionId);
		return callback("Another user is currently acting as presenter "+sessionId+". Try again later ...");
	}

	lastPresenter = sessionId;
	console.log("last presenter is now "+lastPresenter);

	presenter[sessionId] = {
		id : sessionId,
		pipeline : null,
		webRtcEndpoint : null
	}
	console.log("assigned presented "+sessionId+" to correct value."+presenter[sessionId].id);
	getKurentoClient(function(error, kurentoClient) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}

		if (typeof presenter[sessionId] === 'undefined' || presenter[sessionId] === null) {
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		kurentoClient.create('MediaPipeline', function(error, pipeline) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}

			if (typeof presenter[sessionId] === 'undefined' || presenter[sessionId] === null) {
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter[sessionId].pipeline = pipeline;
			pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}

				if (presenter[sessionId] === null) {
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				presenter[sessionId].webRtcEndpoint = webRtcEndpoint;

                if (candidatesQueue[sessionId]) {
                    while(candidatesQueue[sessionId].length) {
                        var candidate = candidatesQueue[sessionId].shift();
                        webRtcEndpoint.addIceCandidate(candidate);
                    }
                }

                webRtcEndpoint.on('OnIceCandidate', function(event) {
                    var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
                    ws.send(JSON.stringify({
                        id : 'iceCandidate',
                        candidate : candidate
                    }));
                });

				webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
					if (error) {
						stop(sessionId);
						return callback(error);
					}

					if (typeof presenter[sessionId] === 'undefined' || presenter[sessionId] === null) {
						stop(sessionId);
						return callback(noPresenterMessage);
					}

					callback(null, sdpAnswer);
				});

                webRtcEndpoint.gatherCandidates(function(error) {
                    if (error) {
                        stop(sessionId);
                        return callback(error);
                    }
                });
            });
        });
	});
}

// fixed
function startViewer(sessionId, ws, sdpOffer, presenterId, callback) {
	clearCandidatesQueue(sessionId);

	if (typeof presenterId === 'undefined' || presenterId === null) {
		console.log("setting undefined/unset presenterId to last known presenter, which is " +
			lastPresenter);
		presenterId = lastPresenter;
	}

	if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null) {
		stop(sessionId);

		console.log("no presenter "+presenterId);
		return callback(noPresenterMessage);
	}

	presenter[presenterId].pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
		if (error) {
			stop(sessionId);
			return callback(error);
		}
		viewers[sessionId] = {
			"presenterId": presenterId,
			"webRtcEndpoint" : webRtcEndpoint,
			"ws" : ws
		}

		if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null) {
			console.log("2 no presenter "+presenterId);
			stop(sessionId);
			return callback(noPresenterMessage);
		}

		if (candidatesQueue[sessionId]) {
			while(candidatesQueue[sessionId].length) {
				var candidate = candidatesQueue[sessionId].shift();
				webRtcEndpoint.addIceCandidate(candidate);
			}
		}

        webRtcEndpoint.on('OnIceCandidate', function(event) {
            var candidate = kurento.register.complexTypes.IceCandidate(event.candidate);
            ws.send(JSON.stringify({
                id : 'iceCandidate',
                candidate : candidate
            }));
        });

		webRtcEndpoint.processOffer(sdpOffer, function(error, sdpAnswer) {
			if (error) {
				stop(sessionId);
				return callback(error);
			}
			if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null) {
				console.log("3 no presenter "+presenterId);
				stop(sessionId);
				return callback(noPresenterMessage);
			}

			presenter[presenterId].webRtcEndpoint.connect(webRtcEndpoint, function(error) {
				if (error) {
					stop(sessionId);
					return callback(error);
				}
				if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null) {
					console.log("4 no presenter "+presenterId);
					stop(sessionId);
					return callback(noPresenterMessage);
				}

				callback(null, sdpAnswer);
		        webRtcEndpoint.gatherCandidates(function(error) {
		            if (error) {
			            stop(sessionId);
			            return callback(error);
		            }
		        });
		    });
	    });
	});
}

function clearCandidatesQueue(sessionId) {
	if (candidatesQueue[sessionId]) {
		delete candidatesQueue[sessionId];
	}
}

// fixed
function stop(sessionId) {
	if (typeof presenter[sessionId] !== 'undefined' && presenter[sessionId] !== null && presenter[sessionId].id == sessionId) {
		for (var i in viewers) {
			var viewer = viewers[i];
			// this viewer is a viewer of this presenter
			if (viewer != null && viewer.ws && viewer.presenterId == sessionId) {
				viewer.ws.send(JSON.stringify({
					id : 'stopCommunication'
				}));
				viewers[i] = null;
			}
		}
		presenter[sessionId].pipeline.release();
		presenter[sessionId] = null;
		//viewers = [];
	} else if (viewers[sessionId]) {
		viewers[sessionId].webRtcEndpoint.release();
		delete viewers[sessionId];
	}

	clearCandidatesQueue(sessionId);
}

// fixed
function onIceCandidate(sessionId, _candidate) {
    var candidate = kurento.register.complexTypes.IceCandidate(_candidate);

    if (presenter[sessionId] && presenter.id === sessionId && presenter.webRtcEndpoint) {
        console.info('Sending presenter candidate');
        presenter[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
        console.info('Sending viewer candidate');
        viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console.info('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
