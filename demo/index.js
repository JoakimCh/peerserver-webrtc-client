
import {PeerServerClient, DEFAULT_CONFIG} from '../source/peerserver-webrtc-client.js'
const log = console.log
const connectedPeers = new Map()
const d = {} // module's DOM elements

function TitleCase(string) {
  return string.slice(0,1).toUpperCase()+string.slice(1)
}
function dateToMyFormat(date, withTime) {
  if (!date) date = new Date()
  const year    = date.getFullYear()
      , month  = (date.getMonth()+1).toString().padStart(2,'0')
      , day     = date.getDate().toString().padStart(2,'0')
      , hours   = date.getHours().toString().padStart(2,'0')
      , minutes = date.getMinutes().toString().padStart(2,'0')
      , seconds = date.getSeconds().toString().padStart(2,'0')
  let string = year+'.'+month+'.'+day
  if (withTime) string += ' - '+hours+':'+minutes+':'+seconds
  return string
}
async function getRevision() {
  let response = await fetch('https://joakimch.github.io/peerserver-webrtc-client/demo/', {method: 'head'})
  let lastModifiedString = response.headers.get('last-modified')
  const indexDate = new Date(lastModifiedString)
  response = await fetch('https://joakimch.github.io/peerserver-webrtc-client/source/peerserver-webrtc-client.js', {method: 'head'})
  lastModifiedString = response.headers.get('last-modified')
  const libDate = new Date(lastModifiedString)
  if (libDate > indexDate) return dateToMyFormat(libDate, true)
  return dateToMyFormat(indexDate, true)
}

//#region DOM
d.h1 = document.createElement('h1')
d.h1.append('peerserver-webrtc-client demo, revision: '+await getRevision())
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

const githubLink = document.createElement('a')
githubLink.setAttribute('href', 'https://github.com/JoakimCh/peerserver-webrtc-client')
githubLink.append('Click here to check the GitHub repository.')
githubLink.style.display = 'block'
githubLink.style.marginTop = '20px'
document.body.append(githubLink)
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
  d.chatLog.value += 'Signalling server closed.\n'
})
signallingServer.addEventListener('error', event => {
  // when anything is wrong with the signalling server
  log('Signalling server error:', event.detail)
  d.chatLog.value += event.detail.message+'\n'
})
signallingServer.addEventListener('incoming', event => {
  const {peerId, payload, accept} = event.detail
  if (payload.attempt <= 1) {
    log('Incoming connection request', event.detail)
  }
  accept(true)
  // accept(false, 'because')
})
signallingServer.addEventListener('failed connection', event => {
  const {error, peerId, payload} = event.detail
  const msg = 'Incoming connection ('+peerId+') failed after '+payload.attempt+' attempts.'
  d.chatLog.value += msg+'\n'
  log(msg, event.detail)
})
signallingServer.addEventListener('connection', event => {
  const {connection, peerId, payload} = event.detail
  const msg = 'Incoming connection ('+peerId+') succeeded after '+payload.attempt+' attempts.'
  d.chatLog.value += msg+'\n'
  log(msg, event.detail)
  monitorConnection(peerId, connection)
  connection.addEventListener('negotiationneeded', event => {
    console.warn('negotiationneeded on incoming connection')
  })
})

function onDataChannel(peerId, dataChannel) {
  dataChannel.addEventListener('open', event => {
    d.chatLog.value += peerId+': data channel established.\n'
    connectedPeers.set(peerId, dataChannel)
    dataChannel.binaryType = 'arraybuffer'
  })
  dataChannel.addEventListener('error', event => {
    console.warn('peer error:', peerId, event.error, event)
    if (event.error.errorDetail == 'sctp-failure' 
    && event.error.sctpCauseCode == null) {
       return // non-graceful termination is not really an error
    }
    d.chatLog.value += peerId+' had an error.\n'
  })
  dataChannel.addEventListener('close', event => {
    if (!connectedPeers.has(peerId)) return
    d.chatLog.value += peerId+' data channel terminated.\n'
    connectedPeers.delete(peerId)
  })
  dataChannel.addEventListener('message', event => {
    if (typeof event.data == 'string') {
      d.chatLog.value += peerId+': '+event.data+'.\n'
    }
  })
}

function monitorConnection(peerId, connection) {
  connection.addEventListener('datachannel', event => {
    const dataChannel = event.channel
    onDataChannel(peerId, dataChannel)
  })

}

function getValue(element, clear, focus) {
  const value = element.value
  if (clear) element.value = ''
  if (focus) element.focus()
  return value
}
function onClickOrEnter(func, inputElement, buttonElement) {
  if (buttonElement) buttonElement.addEventListener('click', func)
  if (inputElement) inputElement.addEventListener('keydown', event => {
    if (event.key == 'Enter') func()
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
      const error = event.detail
      const msg = 'Error: '+error.message+'\n'+JSON.stringify(error, null, 2)
      console.error('broker error', msg)
      d.chatLog.value += msg+'.\n'
    })
    broker.addEventListener('success', event => {
      console.info('broker success', event.detail)
    })
    connection.addEventListener('negotiationneeded', broker)
    monitorConnection(peerId, connection)
    const dataChannel = connection.createDataChannel('data')
    onDataChannel(peerId, dataChannel)
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
