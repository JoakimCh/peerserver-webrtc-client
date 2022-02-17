/*
My alternative to peerjs. A more lightweight/low-level solution. Which is compatible with their signalling server.

Todo:
  Check if we need to adjust anything according to this:
  https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
  * variable max retries (ICE restarts)
  * notify when offer is from ICE restart
  * count restarts used before success (and dispatch in event)
*/
const log = console.log
function randomToken() { // what peerjs use
  return Math.random().toString(36).slice(2)
}

const HEARTBEAT_INTERVAL = 5000 // every 5 seconds
export const DEFAULT_CONFIG = {
  iceServers: [
    {urls: [
      'stun:stun.l.google.com:19302',
      // 'stun:stun1.l.google.com:19302',
      // 'stun:stun2.l.google.com:19302',
      // 'stun:stun3.l.google.com:19302',
      // 'stun:stun4.l.google.com:19302',
    ]},
    // {urls: 'stun:global.stun.twilio.com:3478?transport=udp'}
  ]
}

/**
  
*/
export class PeerServerClient extends EventTarget {
  #ws
  #peerId
  #connectionAttempts = 0
  #maxConnectionAttempts
  #maxIceRestarts 
  #peerConnectionTimeout // time before ICE restart (outgoing)
  #incomingPeerConnectionTimeout
  #endpoint
  #isConnecting // if a connection try to signalling server is ongoing
  #incomingListener // will need to accept or reject connections
  #configuration // for RTCPeerConnection
  #reuseConnections // whether to reuse already open connections
  #connectionMap = new Map()
  #connectionAttemptSet = new Set()
  #connectionMetadataWeakMap = new WeakMap()
  /** The signalling server can share some metadata with incoming connections before the connection attempt (do not share secrets if you don't trust the signalling server). */
  defaultMetadataForIncoming

  /**
   * @param {string} endpoint The PeerServer WebSocket endpoint URL. Defaults to a free to use public endpoint (wss://0.peerjs.com/peerjs). To host your own use: https://github.com/peers/peerjs-server.
   * @param {string} peerId The ID other peers need to use to be able to connect to you, defaults to `crypto.randomUUID()` and is stored in the `peerId` property.
   * @param {object} configuration The configuration given to every `RTCPeerConnection`, defaults to `DEFAULT_CONFIG` which is set to use some free STUN servers (provided by Google and Twilio).
   */
  constructor({
    endpoint = 'wss://0.peerjs.com/peerjs', // the WS/WSS connection endpoint
    peerId = crypto.randomUUID(), // can be anything, but must be unique or it will error
    configuration = DEFAULT_CONFIG,
    options = {}
  } = {}) {
    super()
    options = {
      maxIceRestarts: 10,
      reuseConnections: true,
      maxConnectionAttempts: 3,
      peerConnectionTimeout: 1000,
      incomingPeerConnectionTimeout: 2000,
      defaultMetadataForIncoming: undefined,
      ...options
    }
    this.#maxIceRestarts = options.maxIceRestarts
    this.#reuseConnections = options.reuseConnections
    this.#maxConnectionAttempts = options.maxConnectionAttempts
    this.#peerConnectionTimeout = options.peerConnectionTimeout
    this.defaultMetadataForIncoming = options.defaultMetadataForIncoming
    this.#incomingPeerConnectionTimeout = options.incomingPeerConnectionTimeout
    
    this.#configuration = configuration
    this.#endpoint = endpoint
    this.#peerId = peerId ?? crypto.randomUUID()
    this.addEventListener('offer', this.#handleOffer)
    this.#ensureConnection()
    if (this.#reuseConnections) this.#setupConnectionReuse()
    console.info('Current config:', this.getConfig())
  }

  /** Returns the state of configureable options. Could be used for debugging. */
  getConfig() {
    const config = {
      peerId: this.#peerId,
      endpoint: this.#endpoint,
      configuration: this.#configuration,
      maxIceRestarts: this.#maxIceRestarts,
      reuseConnections: this.#reuseConnections,
      maxConnectionAttempts: this.#maxConnectionAttempts,
      peerConnectionTimeout: this.#peerConnectionTimeout,
      defaultMetadataForIncoming: this.defaultMetadataForIncoming,
      incomingPeerConnectionTimeout: this.#incomingPeerConnectionTimeout,
    }
    return config
  }

  #setupConnectionReuse() {
    this.addEventListener('connection', event => {
      const {connection, peerId, payload} = event.detail
      console.warn('connection added:', peerId)
      this.#connectionMap.set(peerId, connection)
      const connectionAbort = new AbortController()
      connectionAbort.signal.addEventListener('abort', () => {
        console.warn('connection deleted:', peerId)
        this.#connectionMap.delete(peerId)
      }, {once: true})
      connection.addEventListener('connectionstatechange', () => {
        switch (connection.connectionState) {
          case 'disconnected':
          case 'failed': connectionAbort.abort()
        }
      }, {signal: connectionAbort.signal})
      // to more quicly delete a broken connection:
      connection.addEventListener('datachannel', event => {
        const dataChannel = event.channel
        dataChannel.addEventListener('error', event => {
          const error = event.error // an RTCError
          switch (error.errorDetail) {
            case 'sdp-syntax-error': break // forgiveable error?
            // case 'sctp-failure': // ungraceful disconnect
            default: connectionAbort.abort()
          }
        }, {signal: connectionAbort.signal})
      }, {signal: connectionAbort.signal})
      // connection.addEventListener('track', event => {
    })
  }

  get peerId() {return this.#peerId}

  // So we can monitor if a listener to the "incoming" event is set.
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options)
    if (type == 'incoming') {
      this.#incomingListener = true
    }
  }

  async #connect() {
    if (this.#isConnecting) return
    this.#isConnecting = true
    this.#ws?.close()
    this.#ws = undefined // only set at success
    let ws, wsClosedByUs
    const failureAbortController = new AbortController()
    const dispatchError = (message, details = {}) => {
      const error = message instanceof Error ? message : Error(message)
      for (const key of Object.keys(details)) {error[key] = details[key]}
      this.dispatchEvent(new CustomEvent('error', {detail: error}))
      failureAbortController.abort()
    }
    try {
      const getParameters = new URLSearchParams({
        key: 'peerjs', // "API key for the cloud PeerServer. This is not used for servers other than 0.peerjs.com"
        id: this.#peerId,
        token: randomToken() // used when connecting to the PeerServer, purpose unknown
      })
      const endpointUrl = this.#endpoint+'?'+getParameters.toString()
      ws = await wsConnectWithRetry(endpointUrl, this.#maxConnectionAttempts)
    } catch (error) {
      return dispatchError('Signalling server WebSocket connection could not be established.', {
        code: 'SIGNALLING_SERVER_CONNECTION',
        cause: error
      })
    }

    const timeoutTimer = setTimeout(() => {
      dispatchError('Signalling server open message timed out.', {
        code: 'SIGNALLING_SERVER_CONNECTION'
      })
    }, 2000)
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState != WebSocket.OPEN) return
      ws.send('{"type":"HEARTBEAT"}')
    }, HEARTBEAT_INTERVAL)

    let successCleanupDone
    const successCleanup = () => {
      successCleanupDone = true
      this.#isConnecting = false
      clearTimeout(timeoutTimer)
    }
    function failureCleanup() {
      if (!successCleanupDone) successCleanup()
      clearInterval(heartbeatInterval)
      wsClosedByUs = true
      ws?.close()
    }
    failureAbortController.signal.addEventListener('abort', failureCleanup, {once: true})

    let hadWsError
    ws.addEventListener('error', event => {
      hadWsError = true // will collect details from close event and dispatch error there
      console.warn('Signalling server WebSocket error.')
    }, {once: true})

    ws.addEventListener('close', event => {
      const {code, reason} = event
      console.warn('Signalling server WebSocket closed.')
      this.#ws = undefined
      if (hadWsError) {
        dispatchError('Signalling server WebSocket error, reason: '+reason, {
          code: 'SIGNALLING_SERVER_CONNECTION',
          close: {code, reason}
        })
      } else {
        failureAbortController.abort()
      }
      this.dispatchEvent(new CustomEvent('close', {detail: {code, reason}}))
      if (code != 1000 && !this.#isConnecting && !wsClosedByUs) { // if not normal closure
        console.warn('Reconnecting to signalling server.')
        this.#ensureConnection() // reconnect then, since it was outside of any connection attempt
      }
    }, {once: true})

    ws.addEventListener('message', event => {
      const msg = JSON.parse(event.data)
      switch (msg.type) {
        case 'OPEN':
          successCleanup()
          this.#ws = ws
          this.dispatchEvent(new CustomEvent('ready')) // signalling server connected and ready
        break
        case 'ID-TAKEN': {
          this.#connectionAttempts = this.#maxConnectionAttempts
          dispatchError('Signalling server: peerId is already connected!', {
            code: 'SIGNALLING_SERVER_PEERID_TAKEN'
          })
        } break
        default: this.#messageHandler(msg)
      }
    }, {signal: failureAbortController.signal})
  }

  /* Ensures a ready connection, reconnects if needed. returns true when connected and false when maxConnectionAttempts have been reached. */
  async #ensureConnection() {
    const connectionResolver = resolve => {
      this.addEventListener('ready', () => resolve(true), {once: true})
      this.addEventListener('error', () => resolve(false), {once: true})
    }
    const awaitConnection = async () => {
      this.#connectionAttempts ++
      const successfullyConnected = await new Promise(connectionResolver)
      if (successfullyConnected) {
        this.#connectionAttempts = 0
        return true
      }
      if (this.#connectionAttempts < this.#maxConnectionAttempts) {
        return this.#ensureConnection() // else try again
      }
      return false
    }
    if (this.#isConnecting) return await awaitConnection()
    if (this.#ws?.readyState == WebSocket.OPEN) return true
    this.#connect() // async
    return await awaitConnection()
  }

  async changePeerId(peerId) {
    this.#peerId = peerId ?? crypto.randomUUID()
    if (this.#isConnecting) {
      await new Promise(resolve => {
        this.addEventListener('ready', () => resolve(true), {once: true})
        this.addEventListener('error', () => resolve(false), {once: true})
      })
    }
    this.#connect() // connect with the new peerId
  }

  async #messageHandler(msg) {
    switch (msg.type) {
      case 'OFFER':// this.#handleOffer(msg); break
      case 'ANSWER':
      case 'CANDIDATE': {
        const {src: fromPeerId, payload} = msg
        const connectionId = payload.connectionId
        let eventTitle = msg.type.toLowerCase()
        if (msg.type != 'OFFER') eventTitle += connectionId
        this.dispatchEvent(new CustomEvent(eventTitle, {detail: {fromPeerId, payload}}))
      } break
    }
  }

  /* Accepts or rejects incoming offers. */
  #handleOffer(event) {
    const {fromPeerId: peerId, payload} = event.detail
    const connectionId = payload.connectionId
    let acceptCalled // so we don't double execute it
    let acceptTimeout

    /**
     * Decide whether to accept the incoming connection or reject it.
     * @param {boolean} acceptConnection If we accept it or not.
     * @param {*} metadata Any (JSON convertible) metadata to send with the answer (relayed through the signalling server; so do not send secrets if you don't trust it).
     */
    const accept = async (acceptConnection, metadata = this.defaultMetadataForIncoming) => {
      if (acceptCalled) return console.warn('Trying to call accept a second time.')
      acceptCalled = true
      clearTimeout(acceptTimeout)
      if (!acceptConnection) {
        this.#ws.send(JSON.stringify({
          type: 'ANSWER',
          dst: peerId,
          payload: {
            connectionId,
            rejected: true, 
            metadata // could add reason here, e.g.
          }
        }))
        return
      }
      const connection = new RTCPeerConnection(this.#configuration)
      const eventListenersAbortController = new AbortController() // abort cleans up all event listeners
      this.#connection_attachDebuggers(connection, peerId, connectionId)
      let timeoutTimer
      const dispatchError = (message, details) => {
        const error = message instanceof Error ? message : Error(message)
        for (const key of Object.keys(details)) {error[key] = details[key]}
        clearTimeout(timeoutTimer)
        eventListenersAbortController.abort()
        connection.close()
        this.dispatchEvent(new CustomEvent('failed connection', {detail: {
          error, peerId, payload
        }}))
      }
      timeoutTimer = setTimeout(() => {
        dispatchError('Connection timed out.', {code: 'PEER_CONNECTION_TIMEOUT'})
      }, this.#incomingPeerConnectionTimeout)

      console.info('Signalling started...', peerId)
      eventListenersAbortController.signal.addEventListener('abort', () => {
        console.info('Signalling completed!', peerId)
      }, {once: true})
      await connection.setRemoteDescription(payload.sdp)
      await connection.setLocalDescription() // auto creates answer

      this.#ws.send(JSON.stringify({
        type: 'ANSWER',
        dst: peerId,
        payload: {
          sdp: connection.localDescription,
          connectionId,
          metadata // optional metadata
        }
      }))

      connection.addEventListener('icecandidate', event => {
        //if (event.candidate == null) return
        this.#ws.send(JSON.stringify({
          type: 'CANDIDATE',
          dst: peerId,
          payload: {
            candidate: event.candidate,
            connectionId,
          }
        }))
      }, {signal: eventListenersAbortController.signal})

      this.addEventListener('offer', event => {
        const {fromPeerId, payload} = event.detail
        if (fromPeerId != peerId) return
        // another offer with same id is a connection retry
        if (payload.connectionId == connectionId) {
          // then abort this one
          console.warn('Connection retry before timeout, ignoring first try then.')
          clearTimeout(timeoutTimer)
          eventListenersAbortController.abort()
          connection.close() // force it close then
        }
      }, {signal: eventListenersAbortController.signal})

      this.addEventListener('candidate'+connectionId, event => {
        const {fromPeerId, payload} = event.detail
        if (fromPeerId != peerId) return
        if (connection.remoteDescription == null) {
          console.warn('addIceCandidate when remoteDescription is null')
          const listenerAbort = new AbortController()
          connection.addEventListener('signalingstatechange', () => {
            if (connection.remoteDescription) {
              listenerAbort.abort()
              console.warn('adding queued ice-candidate')
              connection.addIceCandidate(payload.candidate)
            }
          }, {signal: listenerAbort.signal})
        } else {
          connection.addIceCandidate(payload.candidate)
        }
      }, {signal: eventListenersAbortController.signal})

      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState == 'connected') {
          clearTimeout(timeoutTimer)
          eventListenersAbortController.abort()
          this.dispatchEvent(new CustomEvent('connection', {detail: {
            peerId: peerId,
            payload, // includes any metadata
            connection
          }}))
        }
      }, {signal: eventListenersAbortController.signal})
    }

    if (this.#reuseConnections) {
      const connection = this.#connectionMap.get(peerId)
      if (connection) {
        console.warn('rejecting offer because already connected')
        accept(false, {alreadyConnected: true})
        return
      }
    }

    if (this.#incomingListener) { // then have it accept or reject it
      acceptTimeout = setTimeout(accept, 2000, false, 'Accept timed out.')
      this.dispatchEvent(new CustomEvent('incoming', {detail: {
        accept,
        peerId: peerId, // who wants to connect
        payload // the payload sent with the attempt
      }}))
    } else {
      accept(true)
    }
  }

  /** Leave this PeerServer (and no longer be able to receive incoming connections through it). If using `connect` after calling this then it will reconnect to PeerServer automatically. This will not terminate any peer connections. */
  leave() {
    this.#ws?.close()
    // todo: if useful then look into sending leave messages to connected peers?
  }

  #connection_attachDebuggers(connection, peerId, connectionId) {
    log(peerId, connectionId, 'connectionState', connection.connectionState)
    log(peerId, connectionId, 'signalingState', connection.signalingState)
    log(peerId, connectionId, 'iceConnectionState', connection.iceConnectionState)
    log(peerId, connectionId, 'iceGatheringState', connection.iceGatheringState)
    connection.addEventListener('signalingstatechange', () => {
      log(peerId, connectionId, 'signalingState', connection.signalingState)
    })
    connection.addEventListener('connectionstatechange', () => {
      log(peerId, connectionId, 'connectionState', connection.connectionState)
    })
    connection.onicecandidateerror = event => {
      const {errorCode, errorText, address, port} = event
      log(peerId, connectionId, 'iceCandidateError', {errorCode, errorText, address, port})
    }
    connection.oniceconnectionstatechange = () => {
      log(peerId, connectionId, 'iceConnectionState', connection.iceConnectionState)
      // iceConnectionState connected == success
    }
    connection.onicegatheringstatechange = () => {
      log(peerId, connectionId, 'iceGatheringState', connection.iceGatheringState)
    }
  }

  #connectionMetadata(connection) {
    let connectionMetadata = this.#connectionMetadataWeakMap.get(connection)
    if (!connectionMetadata) {
      connectionMetadata = {
        connectionId: randomToken(),
        iceRestarts: 0
      }
      this.#connectionMetadataWeakMap.set(connectionMetadata)
    }
    return connectionMetadata
  }

  /**
   * Returns a connection broker compatible with the `negotiationneeded` event on a `RTCPeerConnection`. The broker will emit `success` or `error` events according to how the connection attempt went, check the event `detail` property for relevant information.
   * @param {*} peerId 
   * @param {*} metadata 
   */
  broker(peerId, metadata) {
    const eventTarget = new EventTarget()
    let remoteMetadata, eventListener, brokerRefuse

    if (this.#reuseConnections) {
      if (this.#connectionAttemptSet.has(peerId)) {
        const error = Error('Broker refuse because we\'re already trying to connect.')
        error.peerId = peerId
        error.code = 'PEER_CONNECTION_ONGOING'
        brokerRefuse = true
        setTimeout(() => {
          eventTarget.dispatchEvent(new CustomEvent('error', {detail: error}))
        }, 0)
      } else if (this.#connectionMap.has(peerId)) {
        const error = Error('Broker refuse because we\'re already connected')
        error.peerId = peerId
        error.code = 'PEER_ALREADY_CONNECTED'
        error.connection = this.#connectionMap.get(peerId)
        brokerRefuse = true
        setTimeout(() => {
          eventTarget.dispatchEvent(new CustomEvent('error', {detail: error}))
        }, 0)
      }
    }
    
    if (brokerRefuse) {
      // called by negotiationneeded
      eventListener = event => {
        const connection = event.target
        connection.close() // since we refused it
      }
    } else {
      if (this.#reuseConnections) this.#connectionAttemptSet.add(peerId)
      eventListener = async event => {
        const connection = event.target
        const connectionMetadata = this.#connectionMetadata(connection)
        const connectionId = connectionMetadata.connectionId
        const signallingAbort = new AbortController()
        let timeoutTimer
        const dispatchError = (message, details) => {
          const error = message instanceof Error ? message : Error(message)
          for (const key of Object.keys(details)) {error[key] = details[key]}
          error.peerId = peerId
          if (remoteMetadata) error.peerMetadata = remoteMetadata
          signallingAbort.abort()
          connection.close()
          if (this.#reuseConnections) this.#connectionAttemptSet.delete(peerId)
          eventTarget.dispatchEvent(new CustomEvent('error', {detail: error}))
        }
        if (this.#reuseConnections) {
          const connectionAbort = new AbortController()
          connectionAbort.signal.addEventListener('abort', () => {
            console.warn('connection deleted:', peerId)
            this.#connectionMap.delete(peerId)
          }, {once: true})
          connection.addEventListener('connectionstatechange', async () => {
            switch (connection.connectionState) {
              case 'connected':
                console.warn('connection added:', peerId)
                this.#connectionMap.set(peerId, connection)
                this.#connectionAttemptSet.delete(peerId)
                // console.log([...(await connection.getStats()).entries()])
              break
              case 'disconnected':
              case 'failed': connectionAbort.abort()
            }
          }, {signal: connectionAbort.signal})
        }
        if (await this.#ensureConnection() == false) {
          return dispatchError('Signalling server is not connected and failed to broker the connection.', {code: 'SIGNALLING_SERVER_CONNECTION'})
        }
        this.#connection_attachDebuggers(connection, peerId, connectionId)
        timeoutTimer = setTimeout(() => {
          if (connection.remoteDescription == null) {
            return dispatchError('No answer from peer received before the timeout. This usually means the peerId is offline or mistyped.', {
              code: 'PEER_CONNECTION_FAILED', 
              attempts: connectionMetadata.iceRestarts+1
            })
          }
          if (connectionMetadata.iceRestarts < this.#maxIceRestarts) {
            connectionMetadata.iceRestarts ++
            console.warn('restartIce') // It might need 3 restarts, but it does the trick!!
            signallingAbort.abort() // cleanup listeners here first
            connection.restartIce() // triggers negotiationneeded (this eventListener)
          } else {
            dispatchError('Connection failed after '+(connectionMetadata.iceRestarts+1)+' attempts.', {
              code: 'PEER_CONNECTION_FAILED', 
              attempts: connectionMetadata.iceRestarts+1
            })
          }
        }, this.#peerConnectionTimeout)
        console.info('Signalling started...', peerId)
  
        signallingAbort.signal.addEventListener('abort', () => {
          clearTimeout(timeoutTimer)
          console.info('Signalling completed!', peerId)
        }, {once: true})
        await connection.setLocalDescription() // auto creates offer
  
        this.#ws.send(JSON.stringify({
          type: 'OFFER',
          dst: peerId, // peer to connect to
          payload: { // whatever I put here is relayed
            sdp: connection.localDescription,
            connectionId, // for this signalling
            // type: 'data', // what kind of connection to open
            metadata,
            attempt: connectionMetadata.iceRestarts+1
          }
        }))
  
        connection.addEventListener('icecandidate', event => {
          //if (event.candidate == null) return
          this.#ws.send(JSON.stringify({
            type: 'CANDIDATE',
            dst: peerId,
            payload: {
              candidate: event.candidate,
              connectionId,
            }
          }))
        }, {signal: signallingAbort.signal})
  
        this.addEventListener('candidate'+connectionId, event => {
          const {fromPeerId, payload} = event.detail
          if (fromPeerId != peerId) return
          if (connection.remoteDescription == null) {
            console.warn('addIceCandidate when remoteDescription is null')
            const listenerAbort = new AbortController()
            connection.addEventListener('signalingstatechange', () => {
              if (connection.remoteDescription) {
                listenerAbort.abort()
                console.warn('adding queued ice-candidate')
                connection.addIceCandidate(payload.candidate)
              }
            }, {signal: listenerAbort.signal})
          } else {
            connection.addIceCandidate(payload.candidate)
          }
        }, {signal: signallingAbort.signal})
  
        this.addEventListener('answer'+connectionId, event => {
          const {fromPeerId, payload} = event.detail
          if (fromPeerId != peerId) return // then it's not for us
          if (payload.metadata) remoteMetadata = payload.metadata
          if (payload.rejected) {
            return dispatchError('Peer rejected the connection.', {code: 'PEER_CONNECTION_REJECTED'})
          }
          connection.setRemoteDescription(payload.sdp)
        }, {signal: signallingAbort.signal})
  
        connection.addEventListener('connectionstatechange', () => {
          if (connection.connectionState == 'connected') {
            clearTimeout(timeoutTimer)
            signallingAbort.abort()
            eventTarget.dispatchEvent(new CustomEvent('success', {detail: {
              peerId,
              peerMetadata: remoteMetadata,
              connectionMetadata // extra details about the attempt
            }}))
          }
        }, {signal: signallingAbort.signal})
      }
    }

    eventListener.addEventListener    = eventTarget.addEventListener.bind(eventTarget)
    eventListener.removeEventListener = eventTarget.removeEventListener.bind(eventTarget)
    // eventListener.dispatchEvent       = eventTarget.dispatchEvent
    return eventListener
  }
}

/**
 * Resolves with the WebSocket when connected, else throws/rejects if it reached max retries.
 * @param {*} url 
 * @param {*} maxRetries 
 * @param {*} timeout 
 * @returns 
 */
async function wsConnectWithRetry(url, maxRetries = 3, timeout = 3000) {
  let connectPromise, connectionTries = 0
  do {
    if (navigator.onLine == false) {
      console.warn('WebSocket connection: Browser offline?')
      await new Promise(resolve => setTimeout(resolve, 1000)) // wait longer then
    }
    if (connectionTries == maxRetries) {
      throw Error('WebSocket connection: Max retries reached.')
    }
    if (connectionTries > 0) {
      // wait a little before trying again
      await new Promise(resolve => setTimeout(resolve, connectionTries * 1000))
    }
    connectionTries ++
    connectPromise = new Promise((resolve, reject) => {
      const ws = new WebSocket(url)
      const timeoutTimer = setTimeout(() => {
        ws.close() // so it can not open after a timeout
        resolve(false)
      }, timeout)
      ws.addEventListener('open', () => {
        clearTimeout(timeoutTimer)
        resolve(ws)
      })
      // ws.addEventListener('error', event => {
      //   // console.warn('WebSocket connection error:', event)
      // })
      ws.addEventListener('close', () => { // will always fire at errors
        resolve(false)
      })
    })
  } while (await connectPromise == false)
  // this function will throw when all connection attempts failed
  return await connectPromise // return the WebSocket at success
}
