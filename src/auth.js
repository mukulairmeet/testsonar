import AgoraRTC from 'agora-rtc-sdk';
import EventEmitter from 'events';
import camelCase from 'lodash/camelCase';
import merge from 'lodash/merge';
import AuthService from 'utils/authService';
import { isChromeBrowser, isSafari } from 'utils/browserCheck';
import {
    REACT_APP_AIRMEET_PROXY_SERVER_URL,
    REACT_APP_API_BASE_URL,
} from 'utils/constants/airmeet';
import { isAutomationMode } from 'utils/constants/common';
import { Events } from 'utils/constants/containers/airmeet';
import {
    isCustomMediaStream,
    isScreenShareStream,
    SCREEN_SHARE_USER_ID_START_FROM,
} from 'utils/constants/live-airmeet';
import {
    QOELogger,
    QOEUserDropLogger,
    tableLogConstants,
    userDropCases,
} from 'utils/constants/qoeLogConstants';
import { log, logger } from '../utils/logger';

const LITE_MODE_DIMENSIONS = { width: 1280, height: 720 };

const globalLog = logger.init('global', 'blue');
const localLog = logger.init('RTCClient:', '#DBA901');
const errorLog = logger.init('error', 'red');

const mobileTranscodingLog = logger.init('Mobile Transcoding', 'blue');
const mobileTranscodingErrorLog = logger.init('Mobile Transcoding', 'red');

const INVALID_AGORA_RTC_TOKEN = 'INVALID_AGORA_RTC_TOKEN';
const INVALID_AUTH_USER = 'INVALID_AUTH_USER';

// Find all audio and video devices
let audioDevices = [];
let videoDevices = [];
let audioOutputDevices = [];
let isFirstSummonOfGetDevices = true;

export const reloadDevices = () => {
    return new Promise((resolve) => {
        AgoraRTC.getDevices(function (devices) {
            audioDevices = devices.filter(function (device) {
                return device.kind === 'audioinput';
            });
            videoDevices = devices.filter(function (device) {
                return device.kind === 'videoinput';
            });
            audioOutputDevices = devices.filter(function (device) {
                return device.kind === 'audiooutput';
            });
            if (isFirstSummonOfGetDevices) {
                isFirstSummonOfGetDevices = false;
                logger.info(
                    'Device list fetched from getDevices for the first time. VideoDevices: ',
                    videoDevices
                );
            }

            resolve({ audioDevices, audioOutputDevices, videoDevices });
        });
    });
};
reloadDevices();

export const devices = (reload = false) => {
    return {
        audioDevices,
        audioOutputDevices,
        videoDevices,
    };
};

export const checkSystemRequirement = (callback) => {
    if (!callback) {
        callback = () => {};
    }
    if (!AgoraRTC.checkSystemRequirements()) {
        return Promise.reject({
            status: false,
            info: 'Not Fullfill System Requirements',
            type: 'NOT_SUPPORTED',
            message:
                'This browser does not support to join table using camera and microphone.',
        });
    }

    return new Promise((resolve, reject) => {
        const check = (props) => {
            const { disableVideo } = props || {};
            const stream = AgoraRTC.createStream({
                audio: true,
                video: videoDevices.length > 0 && !!!disableVideo,
                screen: false,
            });
            const setTimeoutHandler = setTimeout(() => {
                const message = `Request is pending, Please grant access to camera and microphone.`;
                if (callback) {
                    return callback(message);
                }
            }, 500);
            stream.init(
                () => {
                    stream.close();
                    clearTimeout(setTimeoutHandler);
                    return resolve({ status: true, error: '', disableVideo });
                },
                (err) => {
                    stream.close();
                    clearTimeout(setTimeoutHandler);
                    const errorMessages = {
                        NotAllowedError: `You refused to grant access to camera or audio resource.`,
                        MEDIA_OPTION_INVALID: `The camera is occupied or the resolution is not supported(on browsers in early versions).`,
                        DEVICES_NOT_FOUND: `No device is found.`,
                        NOT_SUPPORTED: `The browser does not support using camera and microphone.`,
                        PERMISSION_DENIED: `The device is disabled by the browser or the user has denied permission of using the device.`,
                        CONSTRAINT_NOT_SATISFIED: `The settings are illegal(on browsers in early versions).`,
                        AbortError: `Starting video failed`,
                    };
                    let message = errorMessages[err.msg]
                        ? errorMessages[err.msg]
                        : 'Please check the browser permission.';
                    if (disableVideo) {
                        return reject({
                            status: false,
                            info: err.info,
                            type: err.msg,
                            message,
                        });
                    } else {
                        return check({ ...props, disableVideo: true });
                    }
                }
            );
        };
        check();
    });
};

export const getDevicesForStream = async (opts = {}) => {
    const {
        cameraId: requestedCameraId,
        microphoneId: requestedMicId,
        speakerId: requestedSpeakerId,
    } = opts;

    // get available device list
    const devices = await reloadDevices();
    const { audioDevices, videoDevices, audioOutputDevices } = devices;

    const firstAvailable = (type, ...id) => {
        const deviceList =
            type === 'audioIn'
                ? audioDevices
                : type === 'audioOutput'
                ? audioOutputDevices
                : videoDevices;
        const found = id
            .filter(Boolean)
            .reduce(
                (acc, curr) =>
                    acc || deviceList.find(({ deviceId }) => curr === deviceId),
                null
            );

        return found ? found : deviceList.length ? deviceList[0] : {};
    };

    return {
        microphoneId:
            firstAvailable(
                'audioIn',
                requestedMicId,
                localStorage.getItem('pref_audio_in')
            ).deviceId || '',
        speakerId:
            firstAvailable(
                'audioOutput',
                requestedSpeakerId,
                localStorage.getItem('pref_audio_out')
            ).deviceId || '',
        cameraId:
            firstAvailable(
                'video',
                requestedCameraId,
                localStorage.getItem('pref_video_in')
            ).deviceId || '',
    };
};

export const getChannelToken = (
    uid,
    channelName,
    role,
    token,
    airmeetId = null
) => {
    if (!uid && !channelName) {
        return Promise.resolve(null);
    }
    if (token) {
        return Promise.resolve(token);
    }
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };

    if (AuthService.token) {
        headers['X-AccessToken'] = AuthService.token;
    }

    const method = 'POST';
    const fullUrl = `${REACT_APP_API_BASE_URL}/events/token`;
    const body = JSON.stringify({
        agoraUserId: uid,
        sessionId: channelName,
        role,
        airmeetId,
    });
    const opts = {
        method,
        headers,
        body,
        credentials: headers['X-AccessToken'] ? 'omit' : 'include',
    };

    return fetch(fullUrl, opts)
        .then((response) => {
            if (
                response.ok &&
                response.status >= 200 &&
                response.status < 300
            ) {
                return response.json();
            } else {
                throw new Error(
                    response.status === 401 || response.status === 403
                        ? INVALID_AUTH_USER
                        : INVALID_AGORA_RTC_TOKEN,
                    response.status
                );
            }
        })
        .then((json) => {
            if (json.token) {
                return json.token;
            } else {
                throw new Error('RTC channel token not found in API response');
            }
        });
};

// In seconds
export const OPTS = {
    ACTIVE_SPEAKER_DELAY: 1,
    AUDIO_TALKING_THRESHOLD: 10,
};

window.setOpt = (optName, value) => {
    if (optName in OPTS) {
        OPTS[optName] = value;
    }
};

const AUDIO_WEIGHTED_SEGMENT_COUNT = 4;
const AUDIO_WEIGHTED_SEGMENT_LENGTH = 750;

/**
 * use 0 for UDP based cloud proxy
 * use 2 for TCP based cloud proxy
 * airmeet uses TCP based proxy on production.
 * do not change this without consulting @vinay or @revanth or @ashish
 */
const AGORA_CLOUD_PROXY_TYPE = 2;
export default class AirmeetRTCClient extends EventEmitter {
    constructor(accountUid, appId, params) {
        super();

        this.airmeetId = params.airmeetId || null;
        this.clientMode = params.mode === 'live' ? 'live' : 'rtc';
        this.useAirmeetProxy = false;

        const clientArgs = isAutomationMode()
            ? {
                  codec:
                      localStorage.getItem(`automation-vc-${this.airmeetId}`) ||
                      'vp8',
                  mode:
                      localStorage.getItem(`automation-vm-${this.airmeetId}`) ||
                      'rtc',
              }
            : { mode: this.clientMode };

        if (params.useAirmeetProxy) {
            logger.info(
                'using airmeet proxy server',
                REACT_APP_AIRMEET_PROXY_SERVER_URL
            );
            clientArgs.proxyServer = REACT_APP_AIRMEET_PROXY_SERVER_URL;
            this.useAirmeetProxy = true;
        }

        if (params.geofencing) {
            const geofencing = params.geofencing;
            if (geofencing.areaCode) {
                clientArgs.areaCode = geofencing.areaCode.split(',');
            }
            if (geofencing.excludedArea) {
                clientArgs.excludedArea = geofencing.excludedArea;
            }
            logger.info('Geofencing settings applied', geofencing);
        }
        this.client = AgoraRTC.createClient(clientArgs);
        this.automationCanSub =
            !isAutomationMode() ||
            localStorage.getItem(`automation-cs-${this.airmeetId}`) !== '0';
        this.reset();
        this.localStreamSubscribed = [];
        this.accountUid = accountUid;
        this.airmeetId = params.airmeetId || null;
        this.isShareScreenAccount = params.isShareScreenAccount ? true : false;
        this.isCustomMediaAccount = params.isCustomMediaAccount ? true : false;
        this.appId = appId;
        this.activeSpeaker = 0;
        this.mainStream = null;
        this.remoteMuteVideos = {};
        this.remoteMuteAudios = {};
        this._liveStreaming = false;
        this.videoDevices = videoDevices;
        this.audioDevices = audioDevices;
        this.audioOutputDevices = audioOutputDevices;
        this.downlinkNetworkQuality = 0;
        this.uplinkNetworkQuality = 0;
        this.networkStats = {
            downlinkNetworkQuality: [],
            uplinkNetworkQuality: [],
        };
        this.watermarkInfo = {};
        this.liveStreamingURL = {};
        this.videoProfile = null;
        this.localVideoStream = null;
        this.transcodingUpdateRequest = null;
        this.localStreamAudioLevel = 0;
        this.viewMode = params.role || 'ATTENDEE';
        this.skipProxyIfAlreadyJoined = false;

        this.isEnableLocalAudioMonitor = params.isEnableLocalAudioMonitor;
        this.pingPongTimeoutThreshold = 30;
        this.pingPongTimeout = false;
        this.useAirmeetTURNServer = false;
        this.turnServerConfig = null;
        this.isChannelConnected = false;
        //Safari does not support enabling dual-stream mode.
        this.hasEnableDualStream = !this.isShareScreenAccount && !isSafari();

        /**
         * this condition can programatically
         * enable agora SDK to connect with the agora cloud through a cloud proxy.
         * this allows users behind a firewall to connect with agora.
         * Agora SDK uses a TCP based cloud proxy server to help users
         * whose system firewalls block UDP and TCP ports required by Agora for Web RTC
         * connections
         * @param {Boolean} connectViaProxy true/false
         * not setting a type will use a UDP based proxy which may not work for users whose
         * system UDP ports are blocked)
         * we will only allow TCP based proxy on production
         * see (https://docs.agora.io/en/Video/cloud_proxy_web?platform=Web) for more information
         */
        if (params.useAirmeetTURNServer && params.turnServerConfig) {
            logger.info('setting custom turn server config');
            this.turnServerConfig = params.turnServerConfig;
            // this.useAirmeetTURNServer = params.useAirmeetTURNServer;
        }

        if (params.connectViaProxy) {
            this.enableProxyServer();
        }

        if (
            params.useAirmeetTURNServer &&
            !params.connectViaProxy &&
            !this.isCustomTURNInitialized
        ) {
            this.useAirmeetTURNServer = true;
        }

        /**
            "0": The network quality is unknown.
            "1": The network quality is excellent.
            "2": The network quality is quite good, but the bitrate may be slightly lower than excellent.
            "3": Users can feel the communication slightly impaired.
            "4": Users can communicate only not very smoothly.
            "5": The network is so bad that users can hardly communicate.
            "6": The network is down and users cannot communicate at all.
            Optional uplinkNetworkQuality
        **/
        AgoraRTC.setParameter(
            'PING_PONG_TIME_OUT',
            this.pingPongTimeoutThreshold
        );
        this.bindCommonEvents();
        this.bindEvents();
        this.bindLiveStreamEvents();
        this.clientInit();
    }

    async clientInit() {
        if (!['test', 'dev'].includes(process.env.REACT_APP_ENV)) {
            AgoraRTC.Logger.setLogLevel(AgoraRTC.Logger.ERROR);
            //AgoraRTC.Logger.enableLogUpload();
        }

        // Enable Airmeet logging
        this.enableErrorLogging();

        // Inititalize
        try {
            await new Promise((res, rej) =>
                this.client.init(this.appId, res, rej)
            );

            // Enable monitoring our audio locally for muted talking check
            this.enableLocalAudioMonitor();

            // Enable reporting volumne to determine active speakers
            this.enableChannelAudioMonitor();

            // Enable token refresh for RTC
            this.enableTokenRefresh();

            // Enable active speaker detection
            this.enableActiveSpeakerMonitor();

            globalLog('RTC client initialized');
        } catch (err) {
            logger.error('Error initializing RTC client', err);
        }
    }

    updateTURNServerConfiguration(config) {
        this.useAirmeetTURNServer = true;
        this.turnServerConfig = config;
    }

    enableProxyServer(type) {
        if (type === 'airmeet' && this.client && !this.client.proxyServer) {
            console.info('setting airmeet proxy server');
            this.client.setProxyServer(REACT_APP_AIRMEET_PROXY_SERVER_URL);
        }

        return new Promise((resolve, reject) => {
            if (this.connectViaProxy) {
                return resolve();
            }
            const hasJoined = !!this.channelName;
            logger.info(`
                Agora TCP cloud proxy server enabled.
            `);
            const callBackOnLeave = () => {
                this.connectViaProxy = true;
                this.client.startProxyServer(AGORA_CLOUD_PROXY_TYPE);
                if (hasJoined) {
                    this.streams.forEach((stream) => {
                        if (stream) {
                            stream.close();
                        }
                    });
                    this.streams = [];

                    this.clientInit()
                        .then(() => {
                            if (
                                this.useAirmeetTURNServer &&
                                this.turnServerConfig
                            ) {
                                logger.info(
                                    'setting Airmeet TURN server with proxy'
                                );

                                this.client.setTurnServer(
                                    this.turnServerConfig
                                );
                            }

                            return this.joinChannel(
                                this.channelName,
                                null,
                                this.viewMode
                            );
                        })
                        .then(() => {
                            if (this.localStream) {
                                this.publish();
                            }
                        });
                }
                return resolve();
            };

            if (hasJoined) {
                if (this.skipProxyIfAlreadyJoined) {
                    return reject({
                        code: 'ALREADY_CHANNEL_JOINED',
                    });
                }
                this.client.leave(() => {
                    setTimeout(callBackOnLeave, 200);
                });
            } else {
                callBackOnLeave();
            }
        });
    }

    enableTokenRefresh() {
        this.client.on('onTokenPrivilegeWillExpire', () => {
            QOEUserDropLogger(userDropCases.AGORA_TOKEN_EXPIRED.label);
            errorLog('onTokenPrivilegeWillExpire', {
                channelName: this.channelName,
            });
            return this.accountUid && this.channelName
                ? this.getChannelToken(
                      this.accountUid,
                      this.channelName,
                      this.viewMode
                  ).then((token) => this.client.renewToken(token))
                : null;
        });
    }

    enableErrorLogging() {
        this.client.on('error', ({ reason }) => {
            if (reason !== 'SOCKET_DISCONNECTED') {
                logger.error(`Agora Error (${this.clientMode}): ${reason}`);
            } else {
                logger.warn(`Agora Error (${this.clientMode}): ${reason}`);
            }
            // Emit always
            this.emit('rtc-error', reason);
        });
        // [varevarao]: Disable logging service exceptions due to pointlessness of this info
        // [Mukul] enabling for debugging
        this.client.on('exception', ({ code, msg, uid }) => {
            QOEUserDropLogger(userDropCases.AGORA_EXCEPTION.label, msg);
            logger.debug(
                `Agora Service Exception: (${code}) on user ${uid}: ${msg}`
            );
        });
    }

    setWatermarkInfo(watermarkInfo) {
        this.watermarkInfo = watermarkInfo || {};
        mobileTranscodingLog(
            'watermarkInfo',
            JSON.stringify(this.watermarkInfo)
        );
    }

    /**
     * Enables a temporary stream to monitor the user's local audio input volume
     * while they have a published stream.
     * This enables a feature like detecting the user talking while muted
     */
    enableLocalAudioMonitor() {
        if (!this.isEnableLocalAudioMonitor) {
            return;
        }
        this.client.on('stream-published', (evt) => {
            this.initLocalVolumeCheck();
        });
        this.client.on('stream-unpublished', (evt) => {
            this.stopLocalVolumeCheck();
        });
    }

    async checkStreamAudioContextNotSuspended() {
        if (!this.streams || !this.streams.length) {
            return;
        }
        let stream = this.streams[0];
        if (stream?.audioLevelHelper?.audioContext?.state === 'suspended') {
            logger.info('Resuming audio  context', stream.elementID);
            try {
                await stream.audioLevelHelper.audioContext.resume();
                logger.info('Resumed audio  context', stream.elementID);
            } catch (e) {
                logger.error(
                    'Failed to resume audio context',
                    stream.elementID
                );
            }
        }
    }

    /**
     * Initiates a `volume-indicator` event which iterates over all subscribed
     * streams and reports every remote user's audio level every
     * `AUDIO_WEIGHTED_SEGMENT_LENGTH`ms
     */
    enableChannelAudioMonitor() {
        const monitor = () => {
            this.checkStreamAudioContextNotSuspended();
            const userVolumes = this.streams.reduce(
                (all, curr) => [
                    ...all,
                    {
                        uid: curr.getId(),
                        level:
                            // do not make a custom media stream the active speaker
                            // messes with closed captions active speaker logic on stage
                            // will not impact lounge as lounge does not support custom media playback
                            // can be modfitied later as required
                            isCustomMediaStream(curr.getId()) ||
                            isScreenShareStream(curr.getId())
                                ? 0
                                : Math.floor(curr.getAudioLevel() * 100),
                    },
                ],
                []
            );

            this.emit('volume-indicator', userVolumes);
        };

        const startMonitor = () => {
            if (!this.volumeMonitor) {
                this.volumeMonitor = setInterval(
                    () => monitor(),
                    AUDIO_WEIGHTED_SEGMENT_LENGTH
                );
            }
        };
        const stopMonitor = () => {
            if (this.volumeMonitor) {
                clearInterval(this.volumeMonitor);
                this.volumeMonitor = null;
            }
        };

        this.client.on('connection-state-change', ({ curState }) => {
            if (curState === 'CONNECTED') {
                this.pingPongTimeout = false;
                this.isChannelConnected = true;
                startMonitor();
            } else {
                this.isChannelConnected = false;
                stopMonitor();
            }

            logger.info('Connection state changed', curState);
            this.emit('connection-state-change', curState);
        });
    }

    /**
     * Tracks the `volume-indicator` event to track an active speaker using
     * consecutive `AUDIO_WEIGHTED_SEGMENT_COUNT` "segments" of user volumes.
     * The function:
     * 1. performs a weighted average on the sequence of segments
     *   - reports the average "talk time" of each user in the subscribed streams
     * 2. Finds the max of this weighted average across all subscribed streams
     *   - reports the user taking up a major portion of talk-time
     *   - gives preference to speakers towards the end of the iteration
     */
    enableActiveSpeakerMonitor() {
        let currentSegment;
        let trackedSegments;

        const resetCounters = () => {
            currentSegment = 0;
            trackedSegments = {};
        };

        const onVolumeReported = (userVolumes) => {
            // Reduce the reported volumes into a map of segments (keyed by stream id)
            userVolumes.reduce((all, { uid, level }) => {
                if (!all[uid]) {
                    // Initialize with a list of empty audio levels
                    all[uid] = new Array(AUDIO_WEIGHTED_SEGMENT_COUNT).fill(0);
                }

                // Set the user's current segment level
                all[uid][currentSegment] = level;
                return all;
            }, trackedSegments);

            currentSegment++;
            if (currentSegment >= AUDIO_WEIGHTED_SEGMENT_COUNT) {
                // Once we have the required count of segments
                // calculate a weighted average of each user's segment levels
                // and fetch the maximum average level
                // using the current user as the default
                const { uid: activeSpeaker } = Object.entries(
                    trackedSegments
                ).reduce(
                    (max, [uid, segments]) => {
                        const curr = {
                            uid,
                            level:
                                segments.reduce(
                                    (weightedSum, segmentLevel, index) =>
                                        weightedSum +
                                        segmentLevel * (index + 1),
                                    0
                                ) / segments.length,
                        };

                        if (curr.level > max.level) {
                            max = curr;
                        }
                        return max;
                    },
                    {
                        level: this.localStream
                            ? this.localStream.getAudioLevel() * 100
                            : 0,
                        uid: this.accountUid,
                    }
                );

                if (activeSpeaker && this.activeSpeaker !== activeSpeaker) {
                    // Inform the world
                    this.updateActiveSpeaker(activeSpeaker);
                }

                // Reset counters
                resetCounters();
            }
        };

        const startMonitor = () => {
            resetCounters();
            this.on('volume-indicator', onVolumeReported);
        };
        const stopMonitor = () => {
            resetCounters();
            this.off('volume-indicator', onVolumeReported);
        };

        this.client.on('connection-state-change', ({ curState }) =>
            curState === 'CONNECTED' ? startMonitor() : stopMonitor()
        );
    }

    bindEvents() {
        const { client } = this;
        const self = this;

        // For Share screen client no need to subscribe to events
        if (this.isShareScreenAccount) {
            return;
        }

        client.on('stream-reconnect-start', (evt) => {
            if (
                Object.keys(client.gatewayClient.localStreams).includes(
                    evt.uid.toString()
                )
            ) {
                this.emit('local-stream-reconnect-start', evt.uid);
            }
        });

        client.on('stream-reconnect-end', (evt) => {
            localLog('stream-reconnect-end', evt.uid, evt.success, evt.reason);
            if (
                Object.keys(client.gatewayClient.localStreams).includes(
                    evt.uid.toString()
                ) &&
                evt.success
            ) {
                this.emit('local-stream-reconnect-end', evt.uid);
            }
            if (!evt.success) {
                QOEUserDropLogger(
                    userDropCases.AGORA_GAVE_UP_ON_RECOVERABILITY.label,
                    evt.reason
                );
            }

            console.log(
                'stream-reconnect-end',
                evt.uid,
                evt.success,
                evt.reason
            );
        });

        client.on('peer-online', function (evt) {
            const id = evt.uid;
            localLog(
                'New peer added: ' + id,
                'at',
                new Date().toLocaleTimeString()
            );

            if (self.isLocalScreenShare(id)) {
                // Ignore local screenshare events
                return;
            }

            if (self.isScreenShare(id)) {
                // Handle non local screenshare events
                self.emit('stream-online-screen', {
                    screenUserId: self.getScreenUserId(id),
                });
                return;
            }
        });

        // subscribeStreamEvents
        client.on('stream-added', function (evt) {
            const stream = evt.stream;
            const id = stream.getId();
            localLog(
                'New stream added: ' + id,
                'at',
                new Date().toLocaleTimeString()
            );

            if (self.isLocalScreenShare(id) || !self.automationCanSub) {
                // Ignore local screenshare events
                return;
            }

            localLog('Subscribe ', id);
            QOELogger(
                tableLogConstants.ATTEMPTING_TO_SUBSCRIBE_TO_REMOTE_STREAM,
                self.accountUid,
                `remote stream id ${stream.getId()}`
            );
            client.subscribe(stream, function (err) {
                QOELogger(
                    tableLogConstants.FAILED_TO_SUBSCRIBE_TO_REMOTE_STREAM,
                    self.accountUid,
                    `${err} and remote stream id ${stream.getId()}`
                );
                localLog('Subscribe stream failed', {
                    err,
                    stream: stream.getId(),
                });
            });
        });

        client.on('stream-updated', function (evt) {
            const stream = evt.stream;
            const id = stream.getId();
            localLog(
                'Stream updated: ' + id,
                'at',
                new Date().toLocaleTimeString()
            );

            if (self.isLocalScreenShare(id)) {
                // Ignore local screenshare events
                return;
            }

            localLog('Updated ', id);

            self.updateStream(stream);
        });

        client.on('stream-removed', function (evt) {
            const { stream } = evt;
            const id = stream.getId();
            localLog('Stream removed: ' + id);

            if (self.isLocalScreenShare(id)) {
                // Ignore local screenshare events
                return;
            }

            if (self.isScreenShare(id)) {
                self.emit('stream-removed-screen', {
                    id,
                    screenUserId: self.getScreenUserId(id),
                });
                return;
            }

            localLog(new Date().toLocaleTimeString());
            /*
            Agora SDK can remove stream even when peer has not left, at that time SDK state for remote user mute status become non-muted (state is cleared internally) irrespective of what the actual state of the remote user is.

            */
            self.removeStream(stream.getId(), false);
        });

        client.on('peer-leave', function (evt) {
            const id = evt.uid;
            localLog(
                'Peer has left: ' + id,
                'at',
                new Date().toLocaleTimeString()
            );

            if (self.isLocalScreenShare(id)) {
                // Ignore local screenshare events
                return;
            }

            if (self.isScreenShare(id)) {
                self.emit('stream-offline-screen', {
                    id,
                    screenUserId: self.getScreenUserId(id),
                });
                return;
            }

            self.emit('peer-leave', { id });
            self.removeStream(evt.uid);
            self.removeLocalStreamSubscriber(evt.uid);
        });

        client.on('network-quality', function (stats) {
            const quality = {
                downlinkNetworkQuality: stats.downlinkNetworkQuality,
                uplinkNetworkQuality: stats.uplinkNetworkQuality,
            };
            if (
                stats.downlinkNetworkQuality !== self.downlinkNetworkQuality ||
                stats.uplinkNetworkQuality !== self.uplinkNetworkQuality
            ) {
                localLog(`network-quality-updated`, quality);
            }
            self.downlinkNetworkQuality = stats.downlinkNetworkQuality;
            self.uplinkNetworkQuality = stats.uplinkNetworkQuality;
            self.emit('network-quality-updated', {
                uid: self.accountUid,
                quality,
            });
            self.logPingPongTimer();
        });

        client.on('stream-subscribed', (evt) => {
            const { stream } = evt;
            QOELogger(
                tableLogConstants.SUBSCRIBED_TO_REMOTE_STREAM_SUCCESSFULLY,
                self.accountUid,
                `remote stream id ${stream.getId()}`
            );
            localLog(
                'Got stream-subscribed event at',
                new Date().toLocaleTimeString(),
                stream.getId()
            );

            if (this.subP2PLostStreams) {
                if (this.subP2PLostStreams[stream.getId()] === stream) {
                    errorLog(
                        '[Old bug] Same instance of stream would not have played on tables'
                    );
                }
                delete this.subP2PLostStreams[stream.getId()];
            }

            localLog('Subscribe remote stream successfully: ' + stream.getId());
            window.debugLogger &&
                window.debugLogger.add(
                    'Subscribe remote stream successfully: ' + stream.getId()
                );
            self.addStream(stream);
            // Under poor network conditions, the SDK can choose to subscribe to the low-video stream or only the audio stream.
            client.setStreamFallbackOption(stream, 2);
            self.emit('stream-subscribed', { id: stream.getId() });
        });

        client.on('stream-fallback', function ({ attr, uid }) {
            localLog('stream-fallback', { attr, uid });
            if (attr === 1) {
                // the remote media stream falls back to audio-only due to unreliable network conditions.
                self.emit(Events.onMuteVideo, { uid });
            }
            if (attr === 0) {
                // the remote media stream switches back to the video stream after the network conditions improve.
                self.emit(Events.onUnmuteVideo, { uid });
            }
        });

        ['mute-video', 'unmute-video'].forEach((eventName) => {
            const isMute = eventName === 'mute-video';
            client.on(eventName, function (evt) {
                const propName = camelCase(`on-${eventName}`);
                self.remoteMuteVideos[evt.uid] = isMute;
                localLog('Remote mute videos', self.remoteMuteVideos);
                self.emit(propName, evt);
            });
        });

        ['mute-audio', 'unmute-audio'].forEach((eventName) => {
            const isMute = eventName === 'mute-audio';
            client.on(eventName, function (evt) {
                self.setUserAudioMuteStatus(evt.uid, isMute);
            });
        });

        client.on('subP2PLost', (evt) => {
            localLog('[DEBUG] [RTC-ONLY] subP2PLost', {
                stream: evt.stream.getId(),
                attr: evt.attr,
                type: evt.type,
            });
            const { stream } = evt;
            if (!this.subP2PLostStreams) {
                this.subP2PLostStreams = {};
            }
            this.subP2PLostStreams[stream.getId()] = stream; // For metrics, will be removed later
            this.removeStream(stream.getId(), false);
            this.emit('subP2PLost', evt);
        });

        client.on('pubP2PLost', (evt) => {
            localLog('[DEBUG] [RTC-ONLY] pubP2PLost', {
                stream: evt.stream.getId(),
                attr: evt.attr,
                type: evt.type,
            });
            this.emit('pubP2PLost', evt);
        });

        this.infoDetectSchedule();
    }

    setUserAudioMuteStatus(uid, isMute) {
        this.remoteMuteAudios[uid] = isMute;
        const eventName = isMute ? Events.onMuteAudio : Events.onUnmuteAudio;
        this.emit(eventName, { uid });
        localLog('Remote mute audios', this.remoteMuteVideos);
    }

    async switchAudioDevice(props = {}) {
        if (!this.localStream || !this.localStream.getAudioTrack()) {
            return Promise.resolve();
        }
        const { overwriteMicroPhoneId } = props;
        const { microphoneId } = await getDevicesForStream({
            cameraId: null,
            microphoneId: null,
        });

        logger.info('Recording device update request', {
            currentMicrophoneId: this.localStream.microphoneId,
            microphoneId: microphoneId,
        });
        // If updated device Id is same as old one then we need to overwrite to other one, otherwise agora will not update the track
        if (
            ['communications', 'default'].includes(
                this.localStream.microphoneId
            ) &&
            this.localStream.microphoneId === microphoneId &&
            overwriteMicroPhoneId
        ) {
            logger.info('Recording Device overwrite with', {
                currentMicrophoneId: this.localStream.microphoneId,
                overwriteMicroPhoneId: overwriteMicroPhoneId,
            });
            this.localStream.microphoneId = overwriteMicroPhoneId;
        }

        return new Promise(async (resolve, reject) => {
            if (this.isEnableLocalAudioMonitor) {
                this.initLocalVolumeCheck();
            }

            logger.info('Recording device update call', {
                microphoneId: microphoneId,
            });
            this.localStream.switchDevice(
                'audio',
                microphoneId,
                resolve,
                reject
            );
        });
    }

    switchVideoDevice() {
        // if (!this.localStream || !this.localStream.getVideoTrack()) {
        //     return Promise.resolve();
        // }
        // return new Promise(async (resolve, reject) => {
        //     const { cameraId } = await getDevicesForStream({
        //         cameraId: null,
        //         microphoneId: null,
        //     });
        //     this.localStream.switchDevice('video', cameraId, resolve, reject);
        // });
    }

    bindCommonEvents() {
        const { client } = this;
        client.on('recording-device-changed', (evt) => {
            const audioTrackLabel = this.localStream?.getAudioTrack()?.label;
            if (audioTrackLabel) {
                logger.info('Recording Device Changed', {
                    state: evt.state,
                    device: evt.device,
                    audioTrackLabel,
                });

                this.switchAudioDevice({
                    overwriteMicroPhoneId: evt.device.deviceId,
                })
                    .then(() => {
                        logger.info('Recording device changed successfully');

                        this.emit('recording-device-change-success', {
                            localStream: this.localStream,
                        });
                    })
                    .catch((error) => {
                        logger.info('Unable to change device', {
                            error,
                        });

                        return this.emit(
                            'local-stream-recording-device-notfound',
                            {
                                microphoneId: this.localStream.microphoneId,
                            }
                        );
                    });
            }

            this.emit('recording-device-changed', {
                state: evt.state,
                device: evt.device,
            });
        });

        client.on('camera-changed', (evt) => {
            logger.info('Camera Changed', evt.state, evt.device);
            // this.switchVideoDevice().catch((error) => {
            //     localLog('Unable to change video device', {
            //         error,
            //     });
            // });
            this.emit('camera-device-changed', {
                state: evt.state,
                device: evt.device,
            });
        });

        client.on('playout-device-changed', (evt) => {
            logger.info('Playout Device Changed', evt.state, evt.device);
            this.emit('playout-device-changed', {
                state: evt.state,
                device: evt.device,
            });
        });

        client.on('error', function (err) {
            errorLog('Got agora error msg:', err);
        });

        client.on('rejoin', function (data) {
            localLog('rejoin', data);
            // TODO: Handle rejoin
        });

        client.on('rejoin-start', (err) => {
            localLog('rejoin-start:', err);
        });

        client.on('reconnect', function (data) {
            localLog('reconnect', data);
        });

        client.on('stream-reconnect-start', function (data) {
            localLog('rejoin stream-reconnect-start');
        });

        client.on('stream-type-changed', function (evt) {
            localLog('stream-type-changed', evt);
        });

        client.on('pubP2PLost', function (err) {
            localLog('pubP2PLost:', err);
        });

        client.on('recover', function (err) {
            localLog('recover:', err);
        });

        client.on('subP2PLost', function (evt) {
            logger.info('subP2PLost:', {
                stream: evt.stream.getId(),
                attr: evt.attr,
                type: evt.type,
            });
        });

        client.on('connection-state-change', ({ curState }) => {
            logger.info('Connection state changed', curState);
            this.emit('connection-state-change', curState);
        });

        client.on('stream-published', (evt) => {
            logger.info('Stream published', this.accountUid);
            this.emit('stream-published', evt.stream);
        });

        client.on('stream-unpublished', (evt) => {
            logger.info('Stream unpublished', this.accountUid);
            this.emit('stream-unpublished', {
                id: evt.stream.getId(),
                preventScreen: this.preventScreen,
            });
        });
    }

    bindLiveStreamEvents() {
        // Occurs when the live streaming starts.
        this.client.on('liveStreamingStarted', (evt) => {
            localLog('liveStreamingStarted');
            this._liveStreaming = true;
            console.log('liveStreamingStarted', evt);
            if (this.liveStreamingURL[evt.url]) {
                this.liveStreamingURL[evt.url].callback &&
                    this.liveStreamingURL[evt.url].callback({ status: 1 });
                this.liveStreamingURL[evt.url].callback = null;
            }
            this.liveStreamingURL[evt.url] = evt;
            this.emit('liveStreamingStarted', evt);
        });
        // Occurs when the live streaming fails.
        this.client.on('liveStreamingFailed', (evt) => {
            errorLog('liveStreamingFailed', JSON.stringify(evt));
            console.log('liveStreamingFailed', JSON.stringify(evt));
            if (this.liveStreamingURL[evt.url]) {
                this.liveStreamingURL[evt.url].callback &&
                    this.liveStreamingURL[evt.url].callback({ status: 0 });
                delete this.liveStreamingURL[evt.url];
            }

            this.emit('liveStreamingFailed', evt);
        });
        // Occurs when the live streaming stops.
        this.client.on('liveStreamingStopped', (evt) => {
            localLog('liveStreamingStopped');
            console.log('liveStreamingStopped', evt);
            if (this.liveStreamingURL[evt.url]) {
                this.liveStreamingURL[evt.url].callback &&
                    this.liveStreamingURL[evt.url].callback({ status: 0 });
                delete this.liveStreamingURL[evt.url];
            }
            this.emit('liveStreamingStopped', evt);
            this._liveStreaming = !(Object.keys(this.liveStreamingURL) === 0);
        });
        // Occurs when the live transcoding setting is updated.
        this.client.on('liveTranscodingUpdated', (evt) => {
            localLog('liveTranscodingUpdated');
            console.log('liveTranscodingUpdated', evt);
            if (
                this.transcodingUpdateRequest &&
                this.transcodingUpdateRequest.newLiveTranscoding
            ) {
                if (this.transcodingUpdateRequest.timeout) {
                    clearTimeout(this.transcodingUpdateRequest.timeout);
                }
                this.transcodingUpdateRequest = null;
                this.setLiveTranscoding();
            }
        });

        this.setLiveTranscoding = this.setLiveTranscoding.bind(this);
    }

    getStreams() {
        return this.streams;
    }

    getStream(id) {
        return this.streams.find((s) => s.getId() === id);
    }

    getChannelToken(uid, channelName, role, token) {
        return getChannelToken(
            uid,
            channelName,
            role,
            token,
            this.airmeetId
        ).catch((error) => {
            errorLog('token-error', {
                error,
            });

            const invalidAuthToken =
                error instanceof Error && error.message === INVALID_AUTH_USER;
            if (invalidAuthToken) {
                errorLog('rtc token login failed: ', INVALID_AUTH_USER);
            }
            this.emit('token-error', { error, invalidAuthToken });
            return null;
        });
    }

    getScreenUserId(id) {
        return this.isScreenShare(id)
            ? parseInt(id, 10) - SCREEN_SHARE_USER_ID_START_FROM
            : null;
    }

    updateVideoProfile(profile) {
        if (this.localStream && this.videoProfile !== profile) {
            this.localStream.setVideoProfile(profile);
            this.videoProfile = profile;
        }
    }

    isScreenShare(id) {
        return id > SCREEN_SHARE_USER_ID_START_FROM;
    }

    isLocalScreenShare(id) {
        return this.getScreenUserId(id) === this.uid;
    }

    joinChannel(channelName, token = null, role) {
        if (role) this.viewMode = role;
        else role = this.viewMode;
        return this.getChannelToken(
            this.accountUid,
            channelName,
            role,
            token
        ).then((tokenKey) => {
            return new Promise((resolve, reject) => {
                if (this.useAirmeetTURNServer && this.turnServerConfig) {
                    this.client.setTurnServer(this.turnServerConfig);
                }
                QOELogger(
                    tableLogConstants.ATTEMPTING_TO_JOIN_CHANNEL,
                    this.accountUid
                );
                return this.client.join(
                    tokenKey,
                    channelName,
                    this.accountUid,
                    (uid) => {
                        this.uid = uid;
                        this.channelName = channelName;
                        QOELogger(
                            tableLogConstants.CHANNEL_JOINED_SUCCESSFULLY,
                            this.accountUid
                        );
                        log(
                            uid,
                            'brown',
                            `User ${uid} join channel successfully`
                        );
                        log(uid, 'brown', new Date().toLocaleTimeString());
                        window.debugLogger &&
                            window.debugLogger.add(
                                `User ${uid} join channel successfully`
                            );
                        /* Tradeoff between DualStream and Camera light issue resolution. As add/removeTrack is not supported with Dualstream
                https://trello.com/c/djqcaaVG/561-camera-light-is-on-even-when-the-camera-is-on-mute
              */
                        if (!isChromeBrowser()) {
                            this.client.enableDualStream(
                                function () {
                                    console.log('Enable dual stream success!');
                                    window.debugLogger &&
                                        window.debugLogger.add(
                                            `Enable dual stream success!`
                                        );
                                },
                                function (err) {
                                    console.log(err);
                                }
                            );
                        }
                        let lowStreamParam = [160, 120, 15, 65]; //RESOLUTION_ARR[options.videoProfileLow];
                        this.client.setLowStreamParameter({
                            width: lowStreamParam[0],
                            height: lowStreamParam[1],
                            framerate: lowStreamParam[2],
                            bitrate: lowStreamParam[3],
                        });

                        // Create localstream
                        resolve(uid);
                    },
                    (err) => {
                        QOELogger(
                            tableLogConstants.FAILED_TO_JOIN_CHANNEL,
                            this.accountUid,
                            err
                        );
                        reject(err);
                        window.debugLogger && window.debugLogger.add(err);
                    }
                );
            });
        });
    }

    streamInit(uid, options, config) {
        const defaultConfig = {
            streamID: uid,
            audio: true,
            video: true,
            screen: false,
        };

        switch (options.attendeeMode) {
            case 'audio-only':
                defaultConfig.video = false;
                break;
            case 'video-only':
                defaultConfig.audio = false;
                break;
            case 'audience':
                defaultConfig.video = false;
                defaultConfig.audio = false;
                break;
            case 'screen':
                defaultConfig.screen = true;
                defaultConfig.video = false;
                defaultConfig.audio = false;
                /*
        - This function supports only Chrome 73 or later on Windows.
        - For the audio sharing to take effect, the user must check Share audio in the pop-up window when sharing the screen.
         */
                defaultConfig.screenAudio = true;
                break;
            default:
            case 'video':
                break;
        }
        // eslint-disable-next-line
        const steamConfig = merge(defaultConfig, config);
        try {
            logger.info(
                'Configuration for creating stream',
                JSON.stringify(steamConfig),
                'current videoDevices: ',
                (videoDevices || []).length,
                'videoDevices in instance: ',
                (this.videoDevices || []).length
            );
        } catch (err) {
            logger.error('Error while printing config details', err);
        }
        steamConfig.video = steamConfig.video && this.videoDevices.length > 0;
        const stream = AgoraRTC.createStream(steamConfig);
        if (steamConfig.screen && options.screenProfile) {
            stream.setScreenProfile(options.screenProfile);
        }
        if (steamConfig.video) {
            stream.setVideoProfile(options.videoProfile);
        }
        if (options.audioProfile) {
            stream.setAudioProfile(options.audioProfile);
        }

        return stream;
    }

    updateStream(stream) {
        const id = stream.getId();

        if (this.isScreenShare(id)) {
            this.emit('stream-updated-screen', {
                id,
                stream,
                screenUserId: this.getScreenUserId(id),
            });
            return;
        }

        const streamIndex = this.streams.findIndex((item) => {
            return item.getId() === id;
        });

        if (streamIndex >= 0) {
            this.streams[streamIndex] = stream;
            this.emit('stream-updated', { id });
        }
    }

    addStream(stream, push = false) {
        const streamList = this.streams;
        const id = stream.getId();

        if (this.isScreenShare(id)) {
            this.emit(Events.streamAddedScreen, {
                id,
                stream,
                screenUserId: this.getScreenUserId(id),
            });

            return;
        }

        // If redundant, replace the stream
        const redundant = streamList.findIndex((item) => {
            return item.getId() === id;
        });
        if (redundant >= 0) {
            streamList.splice(redundant, 1);
        }
        // Do push for localStream and unshift for other streams
        if (push) {
            streamList.push(stream);
        } else {
            streamList.unshift(stream);
        }

        this.streams = streamList;
        this.emit('stream-added', { id, isLocal: stream.local });
    }

    updateActiveSpeaker(uid) {
        if (this.activeSpeaker === parseInt(uid)) {
            return;
        }
        this.activeSpeaker = parseInt(uid);
        this.emit(Events.activeSpeaker, { id: this.activeSpeaker });
    }

    removeStream(id, removePermanently = true, offline) {
        const streamList = this.streams;

        streamList.reduce((done, item, index) => {
            if (!done && item.getId() === id) {
                streamList.splice(index, 1);
                return true;
            }
            return done;
        }, false);

        if (removePermanently) {
            this.remoteMuteAudios[id] = false;
            this.remoteMuteVideos[id] = false;
        }
        this.streams = streamList;

        if (!this.mainStream || this.mainStream.getId() === id) {
            const [mainStream] = this.streams;
            this.mainStream = mainStream;
        }

        if (
            (this.activeSpeaker === id ||
                isScreenShareStream(id) ||
                isCustomMediaStream(id)) &&
            this.mainStream
        ) {
            this.updateActiveSpeaker(0);
        }

        this.emit('stream-removed', { id, offline });
    }

    setHighStream(prev, next) {
        if (prev === next) {
            return;
        }
        const { streams, client } = this;
        let prevStream;
        let nextStream;
        // Get stream by id
        for (let stream of streams) {
            let id = stream.getId();
            if (id === prev) {
                prevStream = stream;
            } else if (id === next) {
                nextStream = stream;
            } else {
                // Do nothing
            }
        }
        // Set prev stream to low
        prevStream && client.setRemoteVideoStreamType(prevStream, 1);
        // Set next stream to high
        nextStream && client.setRemoteVideoStreamType(nextStream, 0);
        this.mainStream = nextStream;
    }

    async initLocalVolumeCheck() {
        if (!this.channelName) {
            return;
        }
        if (this.audioCheckStream) {
            this.stopLocalVolumeCheck();
        }
        const { microphoneId } = await getDevicesForStream();
        const audioCheckStream = this.streamInit(
            null,
            {
                attendeeMode: 'audio-only',
            },
            { microphoneId }
        );
        audioCheckStream.init(
            () => {
                this.audioCheckStream = audioCheckStream;
                const onVolumeCheck = () => {
                    this.localStreamAudioLevel = this.audioCheckStream
                        ? this.audioCheckStream.getAudioLevel() * 100
                        : 0;
                    this.emit(Events.localAudioCheck, {
                        level: this.localStreamAudioLevel,
                    });
                };
                this.localVolumeChecker = setInterval(
                    onVolumeCheck,
                    OPTS.ACTIVE_SPEAKER_DELAY * 1000
                );
            },
            (err) => {}
        );
    }

    stopLocalVolumeCheck() {
        if (this.audioCheckStream) {
            this.audioCheckStream.close();
            this.audioCheckStream = null;
        }

        if (this.localVolumeChecker) clearInterval(this.localVolumeChecker);
        this.localStreamAudioLevel = 0;
    }

    async createScreenStream({ screenProfile }) {
        this.screenShareStream = null;
        const config = {};
        const stream = this.streamInit(
            this.uid,
            {
                attendeeMode: 'screen',

                screenProfile,
            },
            config
        );

        return new Promise((res, rej) => {
            // Inititalize Agora stream
            stream.init(
                () => {
                    this.screenShareStream = stream;
                    res(stream);
                },
                (error) => {
                    this.screenShareStream = null;
                    errorLog('Failed to initialize the screen stream', error);
                    rej(error);
                }
            );
        });
    }

    /**
     * Publishes the requested stream on the channel (creating one if none provided)
     */
    async publishManagedStream({
        stream = null,
        attendeeMode = 'attendee',
        profile = { video: '240p', screen: '720p_2' },
        devices = {
            cameraId: null,
            microphoneId: null,
        },
        channelName,
        add = false,
    }) {
        const isScreen = attendeeMode === 'screen';
        if (isScreen && this.screenShareStream) {
            stream = this.screenShareStream;
        }
        if (!stream) {
            const { cameraId, microphoneId } = await getDevicesForStream(
                devices
            );
            const { video: videoProfile, screen: screenProfile } =
                profile || {};

            // Stream spec
            const config =
                isScreen || isSafari()
                    ? {}
                    : {
                          cameraId,
                          microphoneId,
                      };

            // Setup the stream, and media profiles
            stream = this.streamInit(
                this.uid,
                {
                    attendeeMode,
                    videoProfile,
                    screenProfile,
                },
                config
            );
        }

        return new Promise((res, rej) => {
            if (isScreen && this.screenShareStream) {
                return res();
            }
            // Inititalize Agora stream
            stream.init(res, rej);
        })
            .then(async () => {
                // If we're publishing to a different channel
                if (this.channelName !== channelName) {
                    // Unpublish any active stream, and channel
                    if (this.localStream) {
                        await this.unpublishManagedStream({
                            stream: this.localStream,
                            leaveOnUnpublish: true,
                        });
                    }
                    // Join the new channel, if present
                    if (channelName) {
                        await this.joinChannel(channelName);
                    }
                }
            })
            .then(
                () =>
                    new Promise(async (resolve, reject) => {
                        // Setup success callback
                        const onPublish = () => {
                            this.localStream = stream;
                            this.addStream(stream, true);
                            QOELogger(
                                tableLogConstants.PUBLISHED_STREAM_SUCCESSFULLY,
                                this.accountUid
                            );
                            if (isScreen) {
                                localStorage.setItem(
                                    `active-screen-share`,
                                    this.accountUid
                                );
                            }

                            this.client.off('stream-published', onPublish);
                            resolve(stream);
                        };
                        QOELogger(
                            tableLogConstants.ATTEMPTING_TO_PUBLISH,
                            this.accountUid
                        );
                        this.client.on('stream-published', onPublish);

                        // Publish to the current channel
                        this.client.publish(stream, (err) => {
                            reject(err);
                            QOELogger(
                                tableLogConstants.FAILED_TO_PUBLISH_STREAM,
                                this.accountUid
                            );
                            errorLog('Failed to publish', {
                                err,
                                stream: stream.getId(),
                            });
                        });
                    })
            )
            .then((stream) => {
                this.emit('stream-published', stream);
                return stream;
            });
    }

    publish() {}

    /**
     * <Deprecated>
     *  Use `streamInit` + `publishClientStream` to perform the same tasks
     * </Deprecated>
     */
    async publishStream({
        attendeeMode = 'attendee',
        videoProfile,
        cameraId,
        microphoneId,
    }) {
        const { client } = this;
        const { uid } = this;

        const isScreen = attendeeMode === 'screen';
        const devices = isScreen
            ? {}
            : await getDevicesForStream({ cameraId, microphoneId });

        // Stream spec
        const config = isSafari()
            ? {}
            : {
                  ...devices,
              };

        // Keep video muted if joining as attendee on Chrome
        // Agora currently doesn't have good support for dynamic tracks on other browsers
        attendeeMode =
            attendeeMode === 'attendee' && isChromeBrowser()
                ? 'audio-only'
                : attendeeMode;

        const localStream = this.streamInit(
            this.uid,
            {
                attendeeMode,
                videoProfile,
                screenProfile: attendeeMode === 'screen' ? videoProfile : null,
            },
            config
        );

        return new Promise((resolve, reject) => {
            localStream.init(
                () => {
                    this.localStream = localStream;
                    this.addTrackListener(this.localStream);
                    if (attendeeMode !== 'audience') {
                        client.publish(localStream, (err) => {
                            QOELogger(
                                tableLogConstants.FAILED_TO_PUBLISH_STREAM,
                                this.accountUid,
                                `${err} and stream id ${localStream.getId()}`
                            );
                            reject(err);
                            errorLog('Failed to publish', {
                                err,
                                stream: localStream.getId(),
                            });
                        });
                        this.addStream(localStream, true);
                        this.addLocalStreamSubscriber(localStream.getId());

                        const onPublish = (evt) => {
                            QOELogger(
                                tableLogConstants.PUBLISHED_STREAM_SUCCESSFULLY,
                                this.accountUid
                            );
                            client.off('stream-published', onPublish);

                            if (isScreen) {
                                localStorage.setItem(
                                    `active-screen-share`,
                                    this.accountUid
                                );
                            }
                            logger.log(
                                uid,
                                'brown',
                                `Your local Stream has published`
                            );
                            logger.log(
                                uid,
                                'brown',
                                new Date().toLocaleTimeString()
                            );
                            window.debugLogger &&
                                window.debugLogger.add(
                                    `Your (${uid}) local Stream has published`
                                );
                            this.emit('stream-published', localStream);
                            resolve(true);
                        };
                        QOELogger(
                            tableLogConstants.ATTEMPTING_TO_PUBLISH,
                            this.accountUid
                        );
                        client.on('stream-published', onPublish);
                    } else {
                        resolve(false);
                    }
                },
                (err) => {
                    if (
                        err &&
                        err.type === 'error' &&
                        err.msg === 'NotAllowedError'
                    ) {
                        //          Notify.danger('Media access NotAllowed Error: The request is not allowed by the user agent or the platform in the current context.', 50000);
                    } else if (
                        err &&
                        err.type === 'error' &&
                        err.msg === 'NotFoundError'
                    ) {
                        errorLog('Failed to find to local media.', 50000);
                    } else {
                        errorLog('Failed to get access to local media.', 50000);
                    }
                    reject(err);
                    window.debugLogger && window.debugLogger.add(err, 'error');
                }
            );
        });
    }

    addTrackListener(stream) {
        const onTrackEnd = async () => {
            errorLog(
                'Audio track ended for stream',
                this.localStream.elementID
            );
            // Stream is already open, just add the audio track
            try {
                const { microphoneId } = await getDevicesForStream({
                    cameraId: null,
                    microphoneId: null,
                });

                // Stream spec
                const config = isSafari()
                    ? {}
                    : {
                          microphoneId,
                      };

                // Setup the stream, and media profiles
                const mediaStream = this.streamInit(
                    null,
                    {
                        attendeeMode: 'audio-only',
                        videoProfile: {},
                        screenProfile: {},
                    },
                    config
                );

                mediaStream.init(
                    () => {
                        var newTrack = mediaStream.getAudioTrack();
                        let oldTrack = this.localStream.getAudioTrack();
                        newTrack.enabled = oldTrack.enabled;
                        newTrack.onended = oldTrack.onended;
                        this.localStream.replaceTrack(newTrack);
                    },
                    (error) => {
                        throw error;
                    }
                );
            } catch (error) {
                console.error(
                    'Could not get audio track to recover, get user media failed',
                    error,
                    stream.elementID
                );
            }
        };

        stream.on('audioTrackEnded', onTrackEnd);
    }
    startVideoTrack() {
        if (!this.localStream || !this.localVideoStream) {
            return;
        }

        this.localVideoStream.unmuteVideo();
        this.localStream.unmuteVideo();
    }

    stopVideoTrack() {
        if (!this.localStream || !this.localVideoStream) {
            return;
        }

        this.localVideoStream.muteVideo();
        this.localStream.muteVideo();
    }

    _startLocalVideo(videoProfile = '240p', mute_retry = false) {
        if (this.localStream) {
            return new Promise(async (resolve, reject) => {
                const { cameraId } = await getDevicesForStream();
                const config = isSafari()
                    ? {}
                    : {
                          cameraId,
                      };
                try {
                    this.localVideoStream = this.streamInit(
                        this.uid,
                        { attendeeMode: 'video-only', videoProfile },
                        config
                    );

                    // initialize the temp video stream (this is where getUserMedia is called under the hood)
                    this.localVideoStream.init(() => {
                        try {
                            // add the video track from the freshly initialized temp video stream to the local stream
                            if (this.localStream.hasVideo()) {
                                this.localStream.replaceTrack(
                                    this.localVideoStream.getVideoTrack()
                                );
                            } else {
                                this.localStream.addTrack(
                                    this.localVideoStream.getVideoTrack()
                                );
                            }

                            // play stream with html element id "local_stream"
                            if (!!document.getElementById(`${this.accountUid}`))
                                this.localStream.play(`${this.accountUid}`);

                            this.localStream.muteVideo();
                            this.localStream.unmuteVideo();
                            resolve();
                        } catch (e) {
                            errorLog(e);
                            if (!mute_retry)
                                setTimeout(
                                    () =>
                                        this._startLocalVideo(
                                            videoProfile,
                                            true
                                        ),
                                    500
                                );
                        }
                    }, reject);
                } catch (e) {
                    errorLog(e);
                    if (!mute_retry)
                        setTimeout(
                            () => this._startLocalVideo(videoProfile, true),
                            200
                        );
                }
            });
        } else {
            errorLog('Stream is not initialized');
        }
    }

    _stopLocalVideo(mute_retry = false) {
        const { localStream, localVideoStream } = this;
        if (localStream && localVideoStream) {
            try {
                // mute video so remote participants get notification, then immediately unmute
                localStream.muteVideo();

                // close the temp video stream, then remove track and stop local stream (order is important)
                if (localVideoStream !== null) localVideoStream.close();
                this.localVideoStream = null;
                localStream.removeTrack(localStream.getVideoTrack());
                localStream.stop();
                // localStream.play(`${this.accountUid}`);
                localStream.unmuteVideo();
                return true;
            } catch (e) {
                errorLog(e);
                if (!mute_retry) {
                    setTimeout(() => this._stopLocalVideo(true), 500);
                } else {
                    return false;
                }
            }
        } else {
            errorLog('Stream is not initialized');
            return true;
        }
    }

    addLocalStreamSubscriber(id) {
        this.removeLocalStreamSubscriber(id);
        this.localStreamSubscribed.push(id);
    }

    removeLocalStreamSubscriber(id) {
        this.localStreamSubscribed = this.localStreamSubscribed.filter(
            (rowId) => rowId !== id
        );
    }

    infoDetectSchedule() {
        if (
            !window.debugLogger &&
            !['test', 'dev'].includes(process.env.REACT_APP_ENV)
        ) {
            return;
        }
        const DURATION = 10;
        setInterval(() => {
            const streamList = this.getStreams();
            const { localStream } = this;
            let no = streamList.length;
            for (let i = 0; i < no; i++) {
                let item = streamList[i];
                let id = item.getId();
                let videoBytes,
                    audioBytes,
                    videoPackets,
                    audioPackets,
                    videoPacketsLost,
                    audioPacketsLost;
                item.getStats((stats) => {
                    let str = `Stream Id: ${id}`;
                    if (localStream && id === localStream.getId()) {
                        str =
                            str +
                            `
              <p>Local Stream accessDelay: ${stats.accessDelay}</p>
              <p>Local Stream audioSendBytes: ${stats.audioSendBytes}</p>
              <p>Local Stream audioSendPackets: ${stats.audioSendPackets}</p>
              <p>Local Stream audioSendPacketsLost: ${stats.audioSendPacketsLost}</p>
              <p>Local Stream videoSendBytes: ${stats.videoSendBytes}</p>
              <p>Local Stream videoSendFrameRate: ${stats.videoSendFrameRate}</p>
              <p>Local Stream videoSendPackets: ${stats.videoSendPackets}</p>
              <p>Local Stream videoSendPacketsLost: ${stats.videoSendPacketsLost}</p>
              <p>Local Stream videoSendResolutionHeight: ${stats.videoSendResolutionHeight}</p>
              <p>Local Stream videoSendResolutionWidth: ${stats.videoSendResolutionWidth}</p>
            `;
                    } else {
                        videoBytes = stats.videoReceiveBytes;
                        audioBytes = stats.audioReceiveBytes;
                        videoPackets = stats.videoReceivePackets;
                        audioPackets = stats.audioReceivePackets;
                        videoPacketsLost = stats.videoReceivePacketsLost;
                        audioPacketsLost = stats.audioReceivePacketsLost;
                        str =
                            str +
                            `
              <p>Remote Stream accessDelay: ${stats.accessDelay}</p>
              <p>Remote Stream audioReceiveBytes: ${stats.audioReceiveBytes}</p>
              <p>Remote Stream audioReceiveDelay: ${stats.audioReceiveDelay}</p>
              <p>Remote Stream audioReceivePackets: ${stats.audioReceivePackets}</p>
              <p>Remote Stream audioReceivePacketsLost: ${stats.audioReceivePacketsLost}</p>
              <p>Remote Stream endToEndDelay: ${stats.endToEndDelay}</p>
              <p>Remote Stream videoReceiveBytes: ${stats.videoReceiveBytes}</p>
              <p>Remote Stream videoReceiveDecodeFrameRate: ${stats.videoReceiveDecodeFrameRate}</p>
              <p>Remote Stream videoReceiveDelay: ${stats.videoReceiveDelay}</p>
              <p>Remote Stream videoReceiveFrameRate: ${stats.videoReceiveFrameRate}</p>
              <p>Remote Stream videoReceivePackets: ${stats.videoReceivePackets}</p>
              <p>Remote Stream videoReceivePacketsLost: ${stats.videoReceivePacketsLost}</p>
              <p>Remote Stream videoReceiveResolutionHeight: ${stats.videoReceiveResolutionHeight}</p>
              <p>Remote Stream videoReceiveResolutionWidth: ${stats.videoReceiveResolutionWidth}</p>
            `;
                        // Do calculate
                        let videoBitrate =
                            (videoBytes / 1000 / DURATION).toFixed(2) + 'KB/s';
                        let audioBitrate =
                            (audioBytes / 1000 / DURATION).toFixed(2) + 'KB/s';

                        let vPacketLoss =
                            ((videoPacketsLost / videoPackets) * 100).toFixed(
                                2
                            ) + '%';
                        let aPacketLoss =
                            ((audioPacketsLost / audioPackets) * 100).toFixed(
                                2
                            ) + '%';
                        let sumPacketLoss = (
                            (videoPacketsLost / videoPackets) * 100 +
                            (audioPacketsLost / audioPackets) * 100
                        ).toFixed(2);

                        let videoCardHtml =
                            '<p>Video Bitrate:' +
                            videoBitrate +
                            ' Packet Loss: ' +
                            vPacketLoss +
                            '</p>';
                        let audioCardHtml =
                            '<p>Audio Bitrate: ' +
                            audioBitrate +
                            ' Packet Loss: ' +
                            aPacketLoss +
                            '</p>';
                        let qualityHtml;
                        if (sumPacketLoss < 1) {
                            qualityHtml = 'Excellent';
                        } else if (sumPacketLoss < 5) {
                            qualityHtml = 'Good';
                        } else if (sumPacketLoss < 10) {
                            qualityHtml = 'Poor';
                        } else if (sumPacketLoss < 100) {
                            qualityHtml = 'Bad';
                        } else {
                            qualityHtml = 'Get media failed.';
                        }
                        qualityHtml = '<p>Quality: ' + qualityHtml + '</p>';
                        str =
                            str + (videoCardHtml + audioCardHtml + qualityHtml);
                    }

                    window.debugLogger && window.debugLogger.add(str);
                });
            }
        }, DURATION * 1000);
    }

    reset() {
        this.channelName = null;
        this.localStream = null;
        this.streams = [];
        this.localStreamSubscribed = [];
        this.remoteMuteVideos = {};
        this.remoteMuteAudios = {};
    }

    unpublishManagedStream({ stream, leaveOnUnpublish = false }) {
        stream = stream || this.localStream;
        return new Promise((resolve, reject) => {
            if (!this.channelName || !this.client || !stream) {
                resolve(false);
            }

            const id = stream.getId();
            this.client.unpublish(stream, reject);

            if (localStorage.getItem(`active-screen-share`)) {
                localStorage.removeItem(`active-screen-share`);
            }

            stream.close();
            this.emit(`stream-removed`, { id });

            this.localStream = null;

            resolve(true);
        }).then((done) =>
            done && leaveOnUnpublish ? this.leaveManagedChannel() : done
        );
    }

    unpublishStream() {
        const { localStream, client } = this;

        if (!localStream || !client) {
            return Promise.resolve(false);
        }

        if (localStorage.getItem(`active-screen-share`)) {
            localStorage.removeItem(`active-screen-share`);
        }

        return new Promise((resolve, reject) => {
            client.unpublish(localStream, reject);
            this.removeLocalStreamSubscriber(localStream.getId());
            this.removeStream(localStream.getId());
            this.localStream = null;
            this.localVideoStream = null;
            resolve(true);
        });
    }

    leaveManagedChannel() {
        return new Promise((resolve, reject) => {
            this.channelName = null;
            this.client.leave(resolve, reject);
        });
    }

    leaveChannel(callback = null) {
        const { client } = this;

        return new Promise((resolve, reject) => {
            this.unpublishStream().finally(() => {
                if (this.channelName) {
                    client.leave(resolve, reject);
                } else {
                    reject();
                }
            });
        })
            .then(() => {
                this.reset();
            })
            .finally(() => callback && callback());
    }

    getChannelLiveStreamingUrl() {
        return `${process.env.REACT_APP_RTMP_SERVER_URL}/${this.channelName}`;
    }

    startClientLiveStreaming(urls = []) {
        if (!this.client || !this.channelName) {
            console.log('Please Join First!');
            return;
        }

        const [url, ...otherUrls] = urls || [];
        console.log('mobile Transcoding Live Streaming URL', url);
        mobileTranscodingLog('Starting Live streaming URL:', url);
        // to push stream to CDN & set second param to enable transcoding
        this.client.startLiveStreaming(url, true);

        this.liveStreamingURL[url] = { status: 0, callback: () => {} };
        if (otherUrls.length > 0) {
            this.liveStreamingURL[url].callback = () => {
                this.startClientLiveStreaming(otherUrls);
            };
        }
    }

    startLiveStreamings(urls, params = { layoutUpdate: true }) {
        if (!this.client || !this.channelName) {
            console.log('Please Join First!');
            return;
        }

        if (params.layoutUpdate) {
            this.updateLiveTranscoding(this.liveTranscodingConf || {});
        }

        this.startClientLiveStreaming(urls);
        // Updating live transcoding on Mute/Unmute event for every user on stage.
        // binding context in setLiveTranscoding and clearing the eventEmitter
        // on stopLiveStreaming function
        ['mute-video', 'unmute-video'].forEach((eventName) => {
            this.client.off(eventName, this.setLiveTranscoding);
            this.client.on(eventName, this.setLiveTranscoding);
        });
    }

    // you can still update live transcoding when you already start live streaming
    updateLiveTranscoding(props) {
        let {
            maxResolutionUid,
            layoutType = 'split',
            streamLabels,
            //  excludeStreamsUid = [],
            noOfStreams,
            streamsInfo,
            mainStreamUids,
            smallStreamUids,
            backdrop = null,
        } = props;
        if (!this.client || !this.channelName) {
            !this.client && mobileTranscodingErrorLog('Client not available');
            !this.channelName &&
                mobileTranscodingErrorLog('ChannelName not available');
            this.liveTranscodingConf = props;
            return;
        }

        /* if (!this._liveStreaming && !preConfig) {
      console.log("Please Start Streaming First!");
      return;
    }*/
        const totalNoOfStreams = streamsInfo.length;
        mobileTranscodingLog(`${totalNoOfStreams} number of streams`);
        if (totalNoOfStreams === 0) {
            mobileTranscodingErrorLog(
                'No Speaker and Attendee available for streaming'
            );
            return;
        }

        let mainStream;
        if (layoutType === 'screen') {
            mainStream = streamsInfo.find(
                ({ id }) => parseInt(id) === parseInt(maxResolutionUid)
            );
        }

        if (noOfStreams === 0) {
            mobileTranscodingErrorLog(
                'No Speaker and Attendee available for streaming'
            );
        }
        const width = LITE_MODE_DIMENSIONS.width;
        const height = LITE_MODE_DIMENSIONS.height;
        mobileTranscodingLog(
            `W&H noOfStreams ${width} ${height} ${noOfStreams}`
        );

        //Check if pre-recorded video is playing
        const audioChannels =
            mainStream && isCustomMediaStream(parseInt(mainStream?.id)) ? 2 : 1;
        const liveTranscoding = {
            width,
            height,
            videoBitrate: 1710,
            videoFramerate: 30,
            lowLatency: false,
            audioSampleRate: AgoraRTC.AUDIO_SAMPLE_RATE_48000,
            audioBitrate: 48,
            audioChannels,
            videoGop: 30,
            videoCodecProfile: AgoraRTC.VIDEO_CODEC_PROFILE_HIGH,
            userCount: noOfStreams,
            backgroundColor: 0x000000,
            images: [],
            transcodingUsers: [],
        };

        liveTranscoding.transcodingUsers = this.getVideoLayouts({
            layoutType,
            size: {
                width,
                height,
            },
            mainStreamSetting: mainStream?.streamMetaData?.settings || {},
            mainStreamUids,
            smallStreamUids,
            backdrop,
        });
        const liveTranscodingConf = {
            ...props,
            liveTranscoding,
            maxResolutionUid,
        };
        /*if (
      this.liveTranscodingConf &&
      JSON.stringify(liveTranscodingConf) ===
        JSON.stringify(this.liveTranscodingConf)
    ) {
      return;
    }*/
        this.liveTranscodingConf = liveTranscodingConf;

        this.setLiveTranscoding();
    }

    muteLocalVideo() {
        if (isChromeBrowser()) {
            this._stopLocalVideo();
        } else {
            // for Firefox and Safari
            this.localStream.muteVideo();
        }
    }

    async unmuteLocalVideo() {
        if (isChromeBrowser()) {
            this._startLocalVideo();
        } else {
            // for Firefox and Safari
            this.localStream.unmuteVideo();
        }
    }

    setLiveTranscoding() {
        const {
            liveTranscoding,
            users,
            streamLabels = {},
            transcodingUpdateRequest,
            backdrop,
        } = this.liveTranscodingConf || {};
        const { localStream, remoteMuteVideos, client } = this;
        if (!liveTranscoding || !users || !client || !localStream) {
            !liveTranscoding &&
                mobileTranscodingErrorLog(`liveTranscoding not available`);
            !users && mobileTranscodingErrorLog(`users not available`);
            !client && mobileTranscodingErrorLog(`client not available`);
            !localStream &&
                mobileTranscodingErrorLog(`localStream not available`);
            return;
        }

        const waitDelay = 3000;
        // Check for any update is running for set live transcoding
        if (
            transcodingUpdateRequest &&
            transcodingUpdateRequest.liveTranscoding &&
            transcodingUpdateRequest.requestTime &&
            transcodingUpdateRequest.requestTime > Date.now() - waitDelay
        ) {
            this.transcodingUpdateRequest.newLiveTranscoding = this.liveTranscodingConf;
            const delay =
                transcodingUpdateRequest.requestTime + waitDelay - Date.now();
            // Try to re-run after some time if response not come / fail with lastest config
            if (!this.transcodingUpdateRequest.timeout) {
                this.transcodingUpdateRequest.timeout = setTimeout(
                    () => {
                        if (
                            this &&
                            this.transcodingUpdateRequest &&
                            this.transcodingUpdateRequest.newLiveTranscoding
                        ) {
                            this.transcodingUpdateRequest = null;
                            this.setLiveTranscoding();
                        }
                    },
                    delay > 10 ? delay : 10
                );
            }
            return;
        }

        const muteVideos = remoteMuteVideos;
        // console.log(localStream.isVideoOn());
        if (localStream) {
            muteVideos[localStream.getId()] = !localStream.isVideoOn();
        }

        const images = [];
        if (backdrop) {
            images.push({
                x: 0,
                y: 0,
                width: LITE_MODE_DIMENSIONS.width,
                height: LITE_MODE_DIMENSIONS.height,
                url: backdrop,
                zOrder: 1,
            });
        }
        let waterMarkZOrder = 100;
        if (users) {
            const { transcodingUsers } = liveTranscoding;
            for (let i = 0; i < transcodingUsers.length; i++) {
                const layout = transcodingUsers[i];
                const { uid } = layout;
                if (uid && users[uid] && muteVideos[uid]) {
                    mobileTranscodingLog(`${uid} on Mute, added thumbnail`);
                    const watermarkUser = {
                        x: layout.x,
                        y: layout.y,
                        width: layout.width,
                        height: layout.height,
                        url: users[uid].profile_img,
                        zOrder: layout.zOrder + 1,
                    };
                    if (waterMarkZOrder <= layout.zOrder + 1) {
                        waterMarkZOrder = layout.zOrder + 10;
                    }
                    images.push({ ...watermarkUser });
                }
                if (uid && streamLabels && streamLabels[uid]) {
                    const { role, smallImageUrl, imageUrl } = streamLabels[uid];
                    const roleLabels = {
                        host:
                            'https://airmeet-images.s3.ap-south-1.amazonaws.com/events/roleLabel/host.png',
                        speaker:
                            'https://airmeet-images.s3.ap-south-1.amazonaws.com/events/roleLabel/speaker.png',
                        attendee:
                            'https://airmeet-images.s3.ap-south-1.amazonaws.com/events/roleLabel/attendee.png',
                        organizer:
                            'https://airmeet-images.s3.ap-south-1.amazonaws.com/events/roleLabel/organizer.png',
                    };
                    const roleWidths = {
                        host: 43,
                        speaker: 59,
                        attendee: 66,
                        organizer: 74,
                    };
                    //console.log(role, smallImageUrl, imageUrl);

                    // Pushing Role tag into transcoding
                    images.push({
                        x: layout.x + layout.width - roleWidths[role] - 8,
                        y: layout.y + 8,
                        width: roleWidths[role],
                        height: 20,
                        url: roleLabels[role],
                        zOrder: layout.zOrder + 3,
                    });

                    const isBigBox = layout.height > liveTranscoding.height / 2;
                    const blockSizes = isBigBox
                        ? { width: 200, height: 40 }
                        : { width: 200, height: 20 };
                    const labelImageUrl = isBigBox ? imageUrl : smallImageUrl;
                    const width =
                        blockSizes.width > layout.width ? layout.width : 200;
                    const height = parseInt(
                        (width * blockSizes.height) / blockSizes.width
                    );
                    // Pushing Name info tag into transcoding
                    if (labelImageUrl) {
                        images.push({
                            x: layout.x + (isBigBox ? 10 : 0),
                            y: layout.y + layout.height - height,
                            width: width,
                            height: height,
                            url: labelImageUrl, //streamLabels[uid].smallImageUrl,
                            zOrder: layout.zOrder + 3,
                        });
                    }
                    if (waterMarkZOrder <= layout.zOrder + 1) {
                        waterMarkZOrder = layout.zOrder + 10;
                    }
                } else {
                    uid &&
                        mobileTranscodingErrorLog(
                            `Streamlabel missing for ${uid}`
                        );
                }
            }
        }
        if (this.watermarkInfo?.image) {
            let watermarkWidth = this.watermarkInfo.width || 200;
            let watermarkHeight = this.watermarkInfo.height || 50;
            const width = parseInt(watermarkWidth > 200 ? 200 : watermarkWidth);
            const height = parseInt((watermarkHeight / watermarkWidth) * width);
            const offsetPadding = 20;

            images.push({
                x: LITE_MODE_DIMENSIONS.width - width - offsetPadding,
                y: LITE_MODE_DIMENSIONS.height - height - offsetPadding,
                width: width,
                height: height,
                url: this.watermarkInfo.image,
                zOrder: waterMarkZOrder,
            });
        }
        // console.log(images);
        liveTranscoding.images = images;
        // console.log('images',images);

        logger.info('mobile Transcoding setLiveTranscoding', liveTranscoding);
        mobileTranscodingLog(
            `liveTranscoding ${JSON.stringify(liveTranscoding)}`
        );

        // always need to set before startLiveStreaming when transcoding enabled
        client.setLiveTranscoding(liveTranscoding);
        this.transcodingUpdateRequest = {
            requestTime: Date.now(),
            liveTranscoding: liveTranscoding,
        };
    }

    getVideoLayouts() {
        return [
            {
                uid: this.mainStream
                    ? this.mainStream.getId()
                    : this.accountUid,
                alpha: 1,
                width: 640,
                height: 360,
                zOrder: 1,
                x: 0,
                y: 0,
            },
        ];
    }

    stopLiveStreaming() {
        if (!this.client) {
            console.log('Please Join First!');
            return;
        }
        if (!this._liveStreaming) {
            console.log('Not find the live streaming!');
            return;
        }

        Object.keys(this.liveStreamingURL).forEach((url) => {
            mobileTranscodingLog('Stop Live streaming URL:', url);
            this.client.stopLiveStreaming(url);
        });
        this.liveStreamingURL = {};
    }

    getStreamInfo(stream) {
        if (!stream) {
            stream = this.localStream;
        }
        if (!stream) {
            return {};
        }
        const track = stream.getVideoTrack();
        return track
            ? {
                  settings: track.getSettings(),
                  constraints: track.getConstraints(),
              }
            : {};
    }

    getAudioVolume(stream) {
        let vol = stream ? Math.round(stream.getAudioLevel() * 100) : 0;
        if (isNaN(vol)) {
            return 0;
        }
        return vol;
    }

    logPingPongTimer() {
        if (!this.client && !this.client.gatewayClient) return;
        const pingPongCount = this.client.gatewayClient.pingpongCounter;
        if (!this.pingPongTimeout && pingPongCount > 9) {
            logger.info(
                `PingPong Timer has been reached 10 [${this.accountUid}]`
            );
        } else if (this.pingPongTimeout && pingPongCount <= 9) {
            logger.info(
                `PingPong Timer has been recovered ${pingPongCount} [${this.accountUid}]`
            );
        } else if (pingPongCount >= this.pingPongTimeoutThreshold) {
            logger.info(
                `PingPong Timer has been reached, disconnection happened, non-recoverable network [${this.accountUid}]`
            );
        }

        this.pingPongTimeout = pingPongCount > 9;
    }
}
