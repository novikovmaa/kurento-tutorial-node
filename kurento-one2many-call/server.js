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
var presenterIds = {};

function console_log(s) {
        console.log(new Date().toString()+" "+s);
}

/*
 * Server startup
 */
var asUrl = url.parse(argv.as_uri);
var port = asUrl.port;
var server = https.createServer(options, app).listen(port, function() {
    console_log('Demio');
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
        console_log('Connection received with sessionId ' + sessionId);

    ws.on('error', function(error) {
        console_log('Connection ' + sessionId + ' error');
        stop(sessionId);
    });

    ws.on('close', function() {
        console_log('Connection ' + sessionId + ' closed');
        stop(sessionId);
    });

    ws.on('message', function(_message) {
        var message = JSON.parse(_message);
        if (message.id !== 'onIceCandidate') {
               console_log('Connection ' + sessionId + ' received message ', message);
        } else {
                console_log('TL;DR: onIceCandidate');
        }

        switch (message.id) {
        case 'presenter':
                        startPresenter(sessionId, ws, message.sdpOffer, message.presenterName, function(error, sdpAnswer) {
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
                        console_log("start viewer, presenterName: >"+message.presenterName+"<, sessionId"+sessionId);
                        startViewer(sessionId, ws, message.sdpOffer, message.presenterName, function(error, sdpAnswer) {
                                if (error) {
                                        return ws.send(JSON.stringify({
                                                id : 'viewerResponse',
                                                response : 'rejected',
                                                message : error
                                        }));
                                }
                                console_log("send a valid SDP answer to viewer "+sessionId+", its presenter is now "+viewers[sessionId].presenterId);
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
            console_log("Could not find media server at address " + argv.ws_uri);
            return callback("Could not find media server at address" + argv.ws_uri
                    + ". Exiting with error " + error);
        }

        kurentoClient = _kurentoClient;
        callback(null, kurentoClient);
    });
}

// fixed
function startPresenter(sessionId, ws, sdpOffer, presenterName, callback) {
        clearCandidatesQueue(sessionId);

        if (typeof presenter[sessionId] !== 'undefined' && presenter[sessionId] !== null) {
                stop(sessionId);
                return callback("Another user is currently acting as presenter "+sessionId+". Try again later ...");
        }

        lastPresenter = sessionId;
        presenterIds[presenterName] = sessionId;
        console_log("presenterName for presenter "+sessionId+" is >"+presenterName+"<");
        console_log("last presenter is now "+lastPresenter);

        presenter[sessionId] = {
                id : sessionId,
                pipeline : null,
                webRtcEndpoint : null,
                recorderEndpoint : null,
                ready : 0
        }
        console_log("assigned presented "+sessionId+" with value "+presenter[sessionId].id);
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
                                console_log("creation of MediaPipeline failed for presenter "+sessionId);
                                stop(sessionId);
                                return callback(error);
                        }

                        if (typeof presenter[sessionId] === 'undefined' || presenter[sessionId] === null) {
                                stop(sessionId);
                                return callback(noPresenterMessage);
                        }

                        presenter[sessionId].pipeline = pipeline;
                        console_log("created a media pipline and assigned it to presenter "+sessionId);

                        recordParams = {
                                uri : "file:///tmp/demio_rec_"+sessionId+"_"+Math.floor(Math.random()*1000000000)+".webm" //The media server user must have wirte permissions for creating this file
                        };
                        pipeline.create('RecorderEndpoint', recordParams, function(error, recorderEndpoint) {
                                if (error) {
                                        console_log("Recorder problem");
                                        return callback(error);
                                }
                                console_log("created recorder endpoint");
                                recorderEndpoint.on('Recording', function(event) {
                                        console_log("Recording");
                                });
                                recorderEndpoint.on('Paused', function(event) {
                                        console_log("Paused");
                                });
                                recorderEndpoint.on('Stopped', function(event) {
                                        console_log("Stopped");
                                });

                                pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
                                        if (error) {
                                                console_log("creation of a presenter WebRtcEndPoint for session "+sessionId+" failed!");
                                                stop(sessionId);
                                                return callback(error);
                                        }

                                        if (presenter[sessionId] === null) {
                                                console_log("presenters WebRtcEndPoint created for "+sessionId+
                                                " but presenter with that id is mystically lacking so it will be left stale!");
                                                stop(sessionId);
                                                return callback(noPresenterMessage);
                                        }

                                        presenter[sessionId].webRtcEndpoint = webRtcEndpoint;
                                        presenter[sessionId].recorderEndpoint = recorderEndpoint;
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

                                                webRtcEndpoint.connect(recorderEndpoint, function(error) {
                                                        if (error !== null) {
                                                                console_log("recording fails: "+error);
                                                        }
                                                });

                                                webRtcEndpoint.on('MediaStateChanged', function(event) {
                                                        console_log("state changed");
                                                        if ((event.oldState !== event.newState) && (event.newState === 'CONNECTED')) {
                                                                console_log("starting recording");
                                                                recorderEndpoint.record();
                                                        }
                                                });
                                                console_log("Presenter "+sessionId+" ready.");
                                                presenter[sessionId].ready=1;
                                                callback(null, sdpAnswer);
                                        });
                                         console_log("invoking gatherCandidates");
                                        webRtcEndpoint.gatherCandidates(function(error) {
                                            if (error) {
                                                stop(sessionId);
                                                return callback(error);
                                            }
                                        });
                                });
                        });
                });
        });
}

// fixed
function startViewer(sessionId, ws, sdpOffer, presenterName, callback) {
        clearCandidatesQueue(sessionId);
        var presenterId = 1;

        if (typeof presenterName === 'undefined' || presenterName === null) {
                console_log("setting undefined/unset presenterId to last known presenter, which is " +
                        lastPresenter);
                presenterId = lastPresenter;
        }

        presenterId = presenterIds[presenterName];

        if (typeof presenterId === 'undefined' || presenterId === null) {
                console_log("presenter >" + presenterName+ "< not known. seting presenterId to lastPresenter, which is "+
                        lastPresenter);
                presenterId = lastPresenter;
        }

        if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null || presenter[presenterId].ready==0) {
                stop(sessionId);

                console_log("no presenter "+presenterId);
                return callback(noPresenterMessage);
        }

        presenter[presenterId].pipeline.create('WebRtcEndpoint', function(error, webRtcEndpoint) {
                if (error) {
                        console_log("presenter "+presenterId+" missing. should've been there.");
                        stop(sessionId);
                        return callback(error);
                }
                viewers[sessionId] = {
                        "presenterId": presenterId,
                        "webRtcEndpoint" : webRtcEndpoint,
                        "ws" : ws
                }

                if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null) {
                        console_log("2 no presenter "+presenterId);
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
                if (ws.readyState!=1) {
                        console_log("ws closed!\n");
                        return;
                }
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
                                console_log("3 no presenter "+presenterId);
                                stop(sessionId);
                                return callback(noPresenterMessage);
                        }
                        console_log("connecting presenter "+presenterId+" with viewer "+sessionId);
                        presenter[presenterId].webRtcEndpoint.connect(webRtcEndpoint, function(error) {
                                if (error) {
                                        console_log("some error connecting presenter "+presenterId+
                                                " with viewer "+sessionId+" : "+error);
                                        stop(sessionId);
                                        return callback(error);
                                }
                                if (typeof presenter[presenterId] === 'undefined' || presenter[presenterId] === null) {
                                        console_log("no presenter when connecting presenter " +
                                                presenterId + " to viewer "+sessionId);
                                        stop(sessionId);
                                        return callback(noPresenterMessage);
                                }

                                callback(null, sdpAnswer);
                        console_log("invoking gatherCandidates");
                        webRtcEndpoint.gatherCandidates(function(error) {
                            if (error) {
                                        console_log("gather candidates error");
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
        console_log('Sending presenter candidate');
        presenter[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else if (viewers[sessionId] && viewers[sessionId].webRtcEndpoint) {
        console_log('Sending viewer candidate');
        viewers[sessionId].webRtcEndpoint.addIceCandidate(candidate);
    }
    else {
        console_log('Queueing candidate');
        if (!candidatesQueue[sessionId]) {
            candidatesQueue[sessionId] = [];
        }
        candidatesQueue[sessionId].push(candidate);
    }
}

app.use(express.static(path.join(__dirname, 'static')));
