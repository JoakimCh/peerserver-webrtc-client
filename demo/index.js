
import {PeerServerClient, DEFAULT_CONFIG} from '../source/peerserver-webrtc-client.js'
const log = console.log
const connectedPeers = new Map()
const d = {} // module's DOM elements

function TitleCase(string) {
  return string.slice(0,1).toUpperCase()+string.slice(1)
}

//#region DOM
d.h1 = document.createElement('h1')
d.h1.append('peerserver-webrtc-client demo')
d.h1.style.margin = '0px'

d.container = document.createElement('div')
d.container.style.display = 'grid'
d.container.style.gridTemplateColumns = '80px auto 80px'
d.container.style.gridTemplateRows = '300px'
document.body.append(d.h1, d.container)

d.chatLog = document.createElement('textarea')
d.chatLog.style.gridArea = '1 / 1 / 2 / 4'
d.chatLog.setAttribute('readonly', true)
d.container.append(d.chatLog)

{ //  create some input fields
  const rows = [
    ['message', 'send'],
    ['peerId', 'connect'],
    ['myId', 'copy'],
  ]
  for (let rowId=2; rowId<5; rowId++) {
    const row = rows[rowId-2]
    d[row[0]] = document.createElement('input')
    d[row[0]].setAttribute('type', 'text')
    d[row[0]].setAttribute('id', row[0])
    const label = document.createElement('label')
    label.setAttribute('for', row[0])
    label.append(TitleCase(row[0]))
    d[row[1]] = document.createElement('button')
    d[row[1]].textContent = TitleCase(row[1])
    label.style.gridArea     = rowId+' / 1 / '+(rowId+1)+' / 2'
    d[row[0]].style.gridArea = rowId+' / 2 / '+(rowId+1)+' / 3'
    d[row[1]].style.gridArea = rowId+' / 3 / '+(rowId+1)+' / 4'
    d.container.append(label, d[row[0]], d[row[1]])
  }
}
//#endregion DOM

d.myId.setAttribute('readonly', true)
d.copy.addEventListener('click', () => {
  navigator.clipboard.writeText(d.myId.value)
})
d.peerId.value = localStorage.getItem('remotePeerId')
d.peerId.focus()

const signallingServer = new PeerServerClient({
  peerId: localStorage.getItem('myPeerId')
})
localStorage.setItem('myPeerId', signallingServer.peerId)
log('My ID:', signallingServer.peerId)
d.myId.value = signallingServer.peerId
// signallingServer.defaultMetadataForIncoming = 'yo mama'

signallingServer.addEventListener('ready', event => {
  log('Signalling server ready')
})
signallingServer.addEventListener('close', event => {
  log('Signalling server closed:', event.detail)
})
signallingServer.addEventListener('error', event => {
  // when anything is wrong with the signalling server
  log('Signalling server error:', event.detail)
})
signallingServer.addEventListener('incoming', event => {
  log('Incoming connection request', event.detail)
  const {peerId, payload, accept} = event.detail
  accept(true)
  // accept(false, 'because')
})
signallingServer.addEventListener('failed connection', event => {
  console.log('Incoming connection failed:', event.detail)
})
signallingServer.addEventListener('connection', event => {
  const {connection, peerId, payload} = event.detail
  console.log('Incoming connection:', {peerId, payload})
  d.chatLog.value += 'Incoming connection: '+peerId+'\n'
  connection.addEventListener('datachannel', event => {
    const dataChannel = event.channel
    dataChannel.addEventListener('open', event => {
      d.chatLog.value += peerId+' opened a data channel.\n'
      connectedPeers.set(peerId, dataChannel)
      dataChannel.binaryType = 'arraybuffer'
    })
    dataChannel.addEventListener('error', event => {
      console.warn('peer error:', peerId, event)
      d.chatLog.value += peerId+' had an error.\n'
    })
    dataChannel.addEventListener('close', event => {
      d.chatLog.value += peerId+' data channel closed.\n'
      connectedPeers.delete(peerId)
    })
    dataChannel.addEventListener('message', event => {
      if (typeof event.data == 'string') {
        d.chatLog.value += peerId+': '+event.data+'.\n'
      }
    })
  })

})




// function onPeerData(data) {
  // chatLog.value += 'Peer: '+data+'\n'
// }


// const peer = new Peer()
// let peerConnection
// peer.on('open', (id) => {
//   // log(id)
//   myId.value = id
// })
// peer.on('error', (error) => {
//   chatLog.value += 'Error: '+error+'\n'
// })
// peer.on('connection', peerConnection_ => { // you received connection
//   peerConnection = peerConnection_
//   chatLog.value += 'Remote connection from: '+peerConnection.peer+'\n'
//   peerConnection.on('data', onPeerData)
//   peerConnection.on('error', error => chatLog.value += 'Peer connection error: '+error+'\n')
// })

function getValue(element, clear, focus) {
  const value = element.value
  if (clear) element.value = ''
  if (focus) element.focus()
  return value
}
function onClickOrEnter(func, inputElement, buttonElement) {
  if (buttonElement) buttonElement.addEventListener('click', func)
  if (inputElement) inputElement.addEventListener('keydown', event => {
    if (event.code == 'Enter') func()
  })
}

{
  const f_connect = () => {
    const peerId = getValue(d.peerId)
    if (!peerId) return
    localStorage.setItem('remotePeerId', peerId)
    d.chatLog.value += 'Connecting to: '+peerId+'...\n'
    const connection = new RTCPeerConnection(DEFAULT_CONFIG)
    const broker = signallingServer.broker(peerId)
    broker.addEventListener('error', event => {
      console.error('broker error', JSON.stringify(event.detail, null, 2))
      d.chatLog.value += 'Timed out connecting to: '+peerId+'.\n'
    })
    broker.addEventListener('success', event => {
      console.info('broker success', event.detail)
    })
    connection.addEventListener('negotiationneeded', broker)
    const dataChannel = connection.createDataChannel('data')
    dataChannel.addEventListener('open', event => {
      d.chatLog.value += 'Successfully connected to: '+peerId+'.\n'
      connectedPeers.set(peerId, dataChannel)
      dataChannel.binaryType = 'arraybuffer'
    })
    dataChannel.addEventListener('error', event => {
      console.warn('peer error:', peerId, event)
      d.chatLog.value += peerId+' had an error.\n'
    })
    dataChannel.addEventListener('close', event => {
      if (!connectedPeers.has(peerId)) return
      d.chatLog.value += peerId+' data channel closed.\n'
      connectedPeers.delete(peerId)
    })
    dataChannel.addEventListener('message', event => {
      if (typeof event.data == 'string') {
        d.chatLog.value += peerId+': '+event.data+'.\n'
      }
    })
  }
  onClickOrEnter(f_connect, d.peerId, d.connect)
}
{
  const f_send = () => {
    const message = getValue(d.message, true, true)
    d.chatLog.value += 'You: '+message+'\n'
    for (const dataChannel of connectedPeers.values()) {
      if (dataChannel.readyState == 'open') {
        dataChannel.send(message)
      }
    }
  }
  onClickOrEnter(f_send, d.message, d.send)
}
