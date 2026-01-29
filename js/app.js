// Global variables
let audioContext;
let mediaStreamSource;
let noiseSource;
let isPlaying = false;

// Elements
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusMsg = document.getElementById('status-message');
const recordIndicator = document.getElementById('record-indicator');

// File Upload Elements
const fileUpload = document.getElementById('file-upload');
const processBtn = document.getElementById('process-btn');
const downloadArea = document.getElementById('download-area');

// Audio Nodes references for cleanup (for Realtime)
let cleanupNodes = [];

// --- Event Listeners ---
startBtn.addEventListener('click', startAudio);
stopBtn.addEventListener('click', stopAudio);

fileUpload.addEventListener('change', () => {
    if (fileUpload.files.length > 0) {
        processBtn.disabled = false;
        statusMsg.innerText = "ファイルが選択されました。「変換してダウンロード」を押してください。";
    } else {
        processBtn.disabled = true;
    }
});

processBtn.addEventListener('click', processFile);


// --- Realtime Microphone Logic ---

async function startAudio() {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

        startBtn.disabled = true;
        stopBtn.disabled = false;
        recordIndicator.classList.add('spinning');
        statusMsg.innerText = "録音中... (アナログエフェクト適用中)";
        isPlaying = true;

        mediaStreamSource = audioContext.createMediaStreamSource(stream);

        // Use the shared graph builder, outputting to speakers
        const nodes = createAudioProcessor(audioContext, mediaStreamSource, audioContext.destination);

        // Store nodes for cleanup
        cleanupNodes = nodes;

        // Start LFO and Noise (returned in nodes)
        nodes.lfo.start();
        nodes.noiseSource.start();

    } catch (err) {
        console.error('Error accessing microphone:', err);
        statusMsg.innerText = "マイクのアクセスに失敗しました。";
    }
}

function stopAudio() {
    if (!isPlaying) return;

    // Disconnect mic
    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
        mediaStreamSource.mediaStream.getTracks().forEach(track => track.stop());
    }

    // Stop generators
    if (cleanupNodes.noiseSource) {
        try { cleanupNodes.noiseSource.stop(); } catch(e){}
    }
    if (cleanupNodes.lfo) {
        try { cleanupNodes.lfo.stop(); } catch(e){}
    }

    // Disconnect all created nodes
    cleanupNodes.allNodes.forEach(node => {
        try { node.disconnect(); } catch(e){}
    });
    cleanupNodes = [];

    isPlaying = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    recordIndicator.classList.remove('spinning');
    statusMsg.innerText = "ボタンを押して開始してください";
}


// --- Core Audio Graph (Shared) ---

function createAudioProcessor(context, sourceNode, destinationNode) {
    const nodes = []; // To keep track for cleanup/connection

    // 1. Input Gain
    const inputGain = context.createGain();
    inputGain.gain.value = 1.0;
    nodes.push(inputGain);

    // 2. Wobble Effect
    const delayNode = context.createDelay();
    delayNode.delayTime.value = 0.05;
    nodes.push(delayNode);

    const lfo = context.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.5;
    nodes.push(lfo);

    const lfoGain = context.createGain();
    lfoGain.gain.value = 0.002;
    nodes.push(lfoGain);

    lfo.connect(lfoGain);
    lfoGain.connect(delayNode.delayTime);

    // 3. Filter
    const filterNode = context.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 1200;
    filterNode.Q.value = 0.5;
    nodes.push(filterNode);

    const highPass = context.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 150;
    nodes.push(highPass);

    // 4. Compressor
    const compressor = context.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;
    nodes.push(compressor);

    // 5. Master Gain
    const masterGain = context.createGain();
    masterGain.gain.value = 1.0;
    nodes.push(masterGain);

    // 6. Vinyl Noise
    const noiseSetup = createVinylNoise(context);
    const noiseSource = noiseSetup.source;
    const noiseGain = noiseSetup.gain;
    nodes.push(noiseSource);
    nodes.push(noiseGain);

    // --- Connections ---
    sourceNode.connect(inputGain);
    inputGain.connect(delayNode);
    delayNode.connect(highPass);
    highPass.connect(filterNode);
    filterNode.connect(compressor);
    compressor.connect(masterGain);
    masterGain.connect(destinationNode);

    // Mix Noise into Master Gain (or Destination)
    // Connecting to masterGain ensures compressor applies if we connected noise before it,
    // but here we mix it at the end to keep noise consistent regardless of input level.
    noiseGain.connect(destinationNode);

    return {
        lfo,
        noiseSource,
        allNodes: nodes
    };
}

function createVinylNoise(context) {
    const bufferSize = context.sampleRate * 4; // 4s loop
    const buffer = context.createBuffer(1, bufferSize, context.sampleRate);
    const data = buffer.getChannelData(0);

    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
        const white = Math.random() * 2 - 1;
        const pink = (lastOut + (0.02 * white)) / 1.02;
        lastOut = pink;
        data[i] = pink * 0.15;

        if (Math.random() < 0.0008) {
            data[i] += (Math.random() * 2 - 1) * 0.8;
        }
    }

    const noiseSource = context.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;

    const noiseGain = context.createGain();
    noiseGain.gain.value = 0.3;

    noiseSource.connect(noiseGain);

    return { source: noiseSource, gain: noiseGain };
}


// --- File Processing Logic ---

async function processFile() {
    const file = fileUpload.files[0];
    if (!file) return;

    processBtn.disabled = true;
    processBtn.innerText = "変換中...";
    downloadArea.innerHTML = "";

    try {
        // 1. Read File
        const arrayBuffer = await file.arrayBuffer();

        // 2. Decode Audio (Needs a temporary context to decode)
        const tempCtx = new (window.AudioContext || window.webkitAudioContext)();
        const audioBuffer = await tempCtx.decodeAudioData(arrayBuffer);

        // 3. Prepare Offline Context
        const offlineCtx = new OfflineAudioContext(
            audioBuffer.numberOfChannels,
            audioBuffer.length,
            audioBuffer.sampleRate
        );

        // 4. Source Node (File)
        const source = offlineCtx.createBufferSource();
        source.buffer = audioBuffer;

        // 5. Build Graph
        const nodes = createAudioProcessor(offlineCtx, source, offlineCtx.destination);

        // 6. Schedule Start
        source.start(0);
        nodes.lfo.start(0);
        nodes.noiseSource.start(0);

        // 7. Render
        const renderedBuffer = await offlineCtx.startRendering();

        // 8. Convert to WAV
        const wavBlob = audioBufferToWav(renderedBuffer, { float32: false });
        const url = URL.createObjectURL(wavBlob);

        // 9. Show Download Link
        const link = document.createElement('a');
        link.href = url;
        link.download = `vinyl_${file.name.replace(/\.[^/.]+$/, "")}.wav`;
        link.innerText = "ダウンロード (WAV)";
        link.style.display = "block";
        link.style.padding = "10px";
        link.style.background = "#d84315";
        link.style.color = "white";
        link.style.textDecoration = "none";
        link.style.borderRadius = "5px";
        link.style.marginTop = "10px";

        downloadArea.appendChild(link);

        statusMsg.innerText = "変換完了！";
        processBtn.innerText = "変換してダウンロード";
        processBtn.disabled = false;

        // Cleanup temp context
        tempCtx.close();

    } catch (err) {
        console.error(err);
        statusMsg.innerText = "エラーが発生しました: " + err.message;
        processBtn.disabled = false;
        processBtn.innerText = "変換してダウンロード";
    }
}
