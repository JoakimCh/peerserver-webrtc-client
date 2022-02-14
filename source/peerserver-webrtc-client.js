/*
My alternative to peerjs. A more lightweight/low-level solution. Which is compatible with their signalling server.

Todo:
  Check if we need to adjust anything according to this:
  https://w3c.github.io/webrtc-pc/#perfect-negotiation-example
*/
const log = console.log
function randomToken() { // what peerjs use
  return Math.random().toString(36).slice(2)
}

const HEARTBEAT_INTERVAL = 5000 // every 5 seconds
const PEER_CONNECTION_TIMEOUT = 6000
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
  #maxConnectionTries = 3
  #throwOnConnectionErrors
  #endpointUrl // stored for reconnection
  #isConnecting
  #incomingListener
  #configuration
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
    configuration = DEFAULT_CONFIG
  } = {}) {
    super()
    this.#configuration = configuration
    this.#peerId = peerId ?? crypto.randomUUID()
    const getParameters = new URLSearchParams({
      key: 'peerjs', // "API key for the cloud PeerServer. This is not used for servers other than 0.peerjs.com"
      id: this.#peerId,
      token: randomToken() // used when connecting to the PeerServer, purpose unknown
    })
    this.#endpointUrl = endpoint+'?'+getParameters.toString()
    this.#ensureConnection()
  }

  get peerId() {return this.#peerId}

  // So we can monitor if a listener to the "incoming" event is set.
  addEventListener(type, listener, options) {
    super.addEventListener(type, listener, options)
    if (type == 'incoming') {
      this.#incomingListener = true
    }
  }

  /* Ensures a ready connection, reconnects if needed. Throws if no connection could be made. */
  async #ensureConnection() {
    // todo: improve error details
    if (this.#isConnecting) {
      const successfullyConnected = await new Promise((resolve, reject) => {
        this.addEventListener('ready', () => resolve(true), {once: true})
        this.addEventListener('error', () => resolve(false), {once: true})
      })
      if (successfullyConnected) return true
      return this.#ensureConnection()
    }
    if (this.#ws) {
      // switch (this.#ws.readyState) {
      //   case WebSocket.OPEN:
      //   case WebSocket.CONNECTING:
      //   return true
      // }
      if (this.#ws.readyState == WebSocket.OPEN) {
        return true
      }
      this.#ws = undefined
    }
    this.#isConnecting = true
    let ws
    try {
      ws = await wsConnectWithRetry(this.#endpointUrl, this.#maxConnectionTries)
    } catch (error) {
      throw error
    }
    
    const heartbeatInterval = setInterval(() => {
      if (ws.readyState != WebSocket.OPEN) return
      ws.send('{"type":"HEARTBEAT"}')
    }, 5000)

    const abortController = new AbortController()
    abortController.signal.addEventListener('abort', () => {
      clearInterval(heartbeatInterval)
    }, {once: true})

    let hadWsError
    ws.addEventListener('error', event => {
      hadWsError = true // will collect details from close event and dispatch error there
      console.warn('Signalling server WebSocket error.')
    }, {once: true})

    ws.addEventListener('close', event => {
      const {code, reason} = event
      if (hadWsError) {
        const error = Error('Signalling server WebSocket error, reason: '+reason)
        error.code = 'SIGNALLING_SERVER_CONNECTION'
        error.close = {code, reason}
        this.dispatchEvent(new CustomEvent('error', {detail: error}))
      }
      console.warn('Signalling server WebSocket closed.')
      abortController.abort()
      this.dispatchEvent(new CustomEvent('close', {detail: {code, reason}}))
      if (code != 1000 && !this.#isConnecting) { // if not normal closure
        this.#ensureConnection() // reconnect then, since it was outside of any connection attempt
      }
    }, {once: true})

    // setup message handler and wait for server "open message" or timeout
    const readyPromise = new Promise((resolve, reject) => {
      const timeoutTimer = setTimeout(reject, 2000, Error('Signalling server open message timed out.'))
      ws.addEventListener('message', event => {
        const msg = JSON.parse(event.data)
        switch (msg.type) {
          case 'OPEN':
            clearTimeout(timeoutTimer)
            resolve(true)
          break
          default: this.#messageHandler(msg)
        }
      }, {signal: abortController.signal})
    })

    try {
      await readyPromise
      this.#ws = ws
      this.dispatchEvent(new CustomEvent('ready')) // signalling server connected and ready
    } catch (error) {
      console.warn(error)
      ws.close()
      this.dispatchEvent(new CustomEvent('error', {detail: error})) // error connecting
      throw error
    } finally {
      this.#isConnecting = false // meaning we can retry
    }

    return true // if reached; then connection is open
  }

  async #messageHandler(msg) {
    switch (msg.type) {
      case 'OFFER': this.#handleOffer(msg); break
      case 'ANSWER':
      case 'CANDIDATE': {
        const {src: fromPeerId, payload} = msg
        const connectionId = payload.connectionId
        this.dispatchEvent(new CustomEvent(msg.type.toLowerCase()+connectionId, {detail: {fromPeerId, payload}}))
      } break
    }
  }

  /* Accepts or rejects incoming offers. */
  #handleOffer(msg) {
    const {src: peerId, payload} = msg
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
      this.#connection_attachDebuggers(connection)
      let timeoutTimer
      const dispatchError = (message, code) => {
        const error = message instanceof Error ? message : Error(message)
        error.code = code
        clearTimeout(timeoutTimer)
        eventListenersAbortController.abort()
        connection.close()
        this.dispatchEvent(new CustomEvent('failed connection', {detail: {
          error, peerId, payload
        }}))
      }
      timeoutTimer = setTimeout(() => {
        dispatchError('Connection timed out.', 'PEER_CONNECTION_TIMEOUT')
      }, PEER_CONNECTION_TIMEOUT)

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
        if (event.candidate == null) return
        this.#ws.send(JSON.stringify({
          type: 'CANDIDATE',
          dst: peerId,
          payload: {
            candidate: event.candidate,
            connectionId,
          }
        }))
      }, {signal: eventListenersAbortController.signal})

      this.addEventListener('candidate'+connectionId, event => {
        const {candidate} = event.detail
        connection.addIceCandidate(candidate)
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

  #connection_attachDebuggers(connection) {
    connection.addEventListener('connectionstatechange', () => {
      log('connectionState', connection.connectionState)
    })
    connection.onicecandidateerror = event => {
      log('iceCandidateError', event.errorCode, event)
    }
    connection.oniceconnectionstatechange = () => {
      log('iceConnectionState', connection.iceConnectionState)
    }
    connection.onicegatheringstatechange = () => {
      log('iceGatheringState', connection.iceGatheringState)
    }
  }

  /**
   * Returns a connection broker compatible with the `negotiationneeded` event on a `RTCPeerConnection`. The broker will emit `success` or `error` events according to how the connection attempt went, check the event `detail` property for relevant information.
   * @param {*} peerId 
   * @param {*} metadata 
   */
  broker(peerId, metadata) {
    const eventTarget = new EventTarget()
    let remoteMetadata

    const eventListener = async event => {
      const connection = event.target
      const signallingAbort = new AbortController()
      this.#connection_attachDebuggers(connection)
      let timeoutTimer
      const dispatchError = (message, code) => {
        const error = message instanceof Error ? message : Error(message)
        error.code = code
        error.peerId = peerId
        if (remoteMetadata) error.peerMetadata = remoteMetadata
        clearTimeout(timeoutTimer)
        signallingAbort.abort()
        connection.close()
        if (this.#throwOnConnectionErrors) throw error
        eventTarget.dispatchEvent(new CustomEvent('error', {detail: error}))
      }
      timeoutTimer = setTimeout(() => {
        dispatchError('Connection timed out.', 'PEER_CONNECTION_TIMEOUT')
      }, PEER_CONNECTION_TIMEOUT)

      try {
        await this.#ensureConnection()
      } catch (error) {
        return dispatchError(error, 'SIGNALLING_SERVER_CONNECTION')
      }
      console.info('Signalling started...', peerId)
      const connectionId = randomToken()

      signallingAbort.signal.addEventListener('abort', () => {
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
          metadata
        }
      }))

      connection.addEventListener('icecandidate', event => {
        if (event.candidate == null) return
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
        connection.addIceCandidate(payload.candidate)
      }, {signal: signallingAbort.signal})

      this.addEventListener('answer'+connectionId, event => {
        const {fromPeerId, payload} = event.detail
        if (fromPeerId != peerId) return // then it's not for us
        if (payload.metadata) remoteMetadata = payload.metadata
        if (payload.rejected) {
          return dispatchError('Peer rejected the connection.', 'PEER_CONNECTION_REJECTED')
        }
        connection.setRemoteDescription(payload.sdp)
      }, {signal: signallingAbort.signal})

      connection.addEventListener('connectionstatechange', () => {
        if (connection.connectionState == 'connected') {
          clearTimeout(timeoutTimer)
          signallingAbort.abort()
          eventTarget.dispatchEvent(new CustomEvent('success', {detail: {
            peerId,
            peerMetadata: remoteMetadata
          }}))
        }
      }, {signal: signallingAbort.signal})
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
