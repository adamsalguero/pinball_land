const codeForm = document.getElementById("code-form");
const codeInput = document.getElementById("code-input");
const shareButton = document.getElementById("share-button");
const stopButton = document.getElementById("stop-button");
const statusEl = document.getElementById("status");
const iosHelp = document.getElementById("ios-help");
const secureHelp = document.getElementById("secure-help");

const ios = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

let socket = null;
let session = null;
let signalChain = Promise.resolve();
let stream = null;
let pc = null;
let heartbeat = null;

if (ios) {
  iosHelp.hidden = false;
  shareButton.hidden = true;
  codeForm.hidden = true;
}

if (!window.isSecureContext) {
  secureHelp.hidden = false;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function send(message) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
}

function connectSocket() {
  if (socket && (socket.readyState === 0 || socket.readyState === 1)) return;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  socket = new WebSocket(`${proto}://${location.host}/ws`);
  socket.addEventListener("open", () => {
    if (!session) return;
    send({
      type: "present-hello",
      presentationId: session.presentationId,
      role: "sharer",
      token: session.token,
    });
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.type === "present-viewer-ready") {
      publishOffer().catch((err) => setStatus(err.message || "Could not start the share"));
    } else if (message.type === "present-signal") {
      signalChain = signalChain.then(() => acceptSignal(message.payload)).catch(() => {});
    } else if (message.type === "present-error") {
      setStatus(message.error || "Share was rejected");
    }
  });
  socket.addEventListener("close", () => {
    if (stream) setTimeout(connectSocket, 1000);
  });
}

async function publishOffer() {
  if (!stream || !session) return;
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: [] });
  for (const track of stream.getTracks()) pc.addTrack(track, stream);
  pc.onicecandidate = (event) => {
    if (!event.candidate || !session) return;
    send({
      type: "present-signal",
      presentationId: session.presentationId,
      token: session.token,
      payload: { kind: "ice", candidate: event.candidate },
    });
  };
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({
    type: "present-signal",
    presentationId: session.presentationId,
    token: session.token,
    payload: { kind: "offer", sdp: pc.localDescription },
  });
  setStatus("Sharing. The TV should show this screen. Leave this page open.");
}

async function acceptSignal(signal) {
  if (!pc || !signal) return;
  if (signal.kind === "answer" && signal.sdp) {
    await pc.setRemoteDescription(signal.sdp);
    return;
  }
  if (signal.kind === "ice" && signal.candidate) {
    await pc.addIceCandidate(signal.candidate).catch(() => {});
  }
}

async function startShare(event) {
  event.preventDefault();
  if (ios || !navigator.mediaDevices?.getDisplayMedia) {
    iosHelp.hidden = false;
    return;
  }
  if (!window.isSecureContext) {
    secureHelp.hidden = false;
    setStatus("Open the https address from the TV first.");
    return;
  }
  const code = codeInput.value.replace(/\D/g, "");
  if (code.length !== 4) {
    setStatus("Enter the 4-digit code on the TV.");
    return;
  }
  shareButton.disabled = true;
  try {
    const res = await fetch("/api/present/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Code was not accepted");
    session = data;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    } catch (err) {
      if (err && err.name === "NotAllowedError") throw err;
      stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    }
    stream.getVideoTracks()[0].addEventListener("ended", stopShare);
    connectSocket();
    if (socket.readyState === 1) {
      send({
        type: "present-hello",
        presentationId: session.presentationId,
        role: "sharer",
        token: session.token,
      });
    }
    heartbeat = setInterval(() => {
      send({
        type: "present-heartbeat",
        presentationId: session.presentationId,
        token: session.token,
      });
    }, 15000);
    stopButton.hidden = false;
    setStatus("Connected. Pick the screen or tab in the browser prompt if you still see it.");
  } catch (err) {
    if (!stream) session = null;
    shareButton.disabled = false;
    setStatus(err.message || "Could not share");
  }
}

function stopShare() {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (session) {
    send({
      type: "present-ended",
      presentationId: session.presentationId,
      token: session.token,
    });
  }
  if (stream) stream.getTracks().forEach((track) => track.stop());
  stream = null;
  if (pc) pc.close();
  pc = null;
  session = null;
  stopButton.hidden = true;
  shareButton.disabled = false;
  setStatus("Sharing stopped. The TV returns to rotation.");
}

codeForm.addEventListener("submit", startShare);
stopButton.addEventListener("click", stopShare);
