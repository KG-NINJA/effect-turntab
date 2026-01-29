// Global variables
let audioContext;
let mediaStreamSource;
let noiseSource;
let isPlaying = false;
let workletNode;

// Elements
const startBtn = document.getElementById('start-btn');
const stopBtn = document.getElementById('stop-btn');
const statusMsg = document.getElementById('status-message');
const recordIndicator = document.getElementById('record-indicator');

// Audio Nodes references for cleanup
let inputGain;
let delayNode;
let lfo;
let lfoGain;
let highPass;
let filterNode;
let compressor;
let masterGain;
let noiseGain;

startBtn.addEventListener('click', startAudio);
stopBtn.addEventListener('click', stopAudio);

async function startAudio() {
    try {
        // Initialize AudioContext
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioContext.state === 'suspended') {
            await audioContext.resume();
        }

        // Get Microphone Input
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });

        // Update UI
        startBtn.disabled = true;
        stopBtn.disabled = false;
        recordIndicator.classList.add('spinning');
        statusMsg.innerText = "録音中... (アナログエフェクト適用中)";
        isPlaying = true;

        // Build Audio Graph
        setupAudioGraph(stream);

    } catch (err) {
        console.error('Error accessing microphone:', err);
        statusMsg.innerText = "マイクのアクセスに失敗しました。";
    }
}

function setupAudioGraph(stream) {
    // 1. Source
    mediaStreamSource = audioContext.createMediaStreamSource(stream);

    // 2. Input Gain (Control volume)
    inputGain = audioContext.createGain();
    inputGain.gain.value = 1.0;

    // 3. Wobble Effect (Tape/Vinyl flutter)
    // Delay node with variable delay time
    delayNode = audioContext.createDelay();
    delayNode.delayTime.value = 0.05; // Base delay 50ms

    // LFO to modulate delay (Pitch wobble)
    lfo = audioContext.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.5; // Slow wobble (0.5 Hz)

    lfoGain = audioContext.createGain();
    lfoGain.gain.value = 0.002; // Depth of wobble (affects pitch intensity)

    // Connect LFO -> LFO Gain -> Delay.delayTime
    lfo.connect(lfoGain);
    lfoGain.connect(delayNode.delayTime);
    lfo.start();

    // 4. Filter (Muffled / Old Radio sound)
    filterNode = audioContext.createBiquadFilter();
    filterNode.type = 'lowpass';
    filterNode.frequency.value = 1200; // Cut off highs around 1.2kHz
    filterNode.Q.value = 0.5;

    // Optional: Highpass to remove extreme low rumble
    highPass = audioContext.createBiquadFilter();
    highPass.type = 'highpass';
    highPass.frequency.value = 150;

    // 5. Compressor (Glue it together)
    compressor = audioContext.createDynamicsCompressor();
    compressor.threshold.value = -20;
    compressor.knee.value = 40;
    compressor.ratio.value = 12;
    compressor.attack.value = 0;
    compressor.release.value = 0.25;

    // 6. Master Gain
    masterGain = audioContext.createGain();
    masterGain.gain.value = 1.0;

    // 7. Vinyl Noise Generator
    createVinylNoise();

    // --- Connections ---
    // Mic -> InputGain -> Delay (Wobble) -> HighPass -> LowPass -> Compressor -> Master -> Out
    mediaStreamSource.connect(inputGain);
    inputGain.connect(delayNode);
    delayNode.connect(highPass);
    highPass.connect(filterNode);
    filterNode.connect(compressor);
    compressor.connect(masterGain);
    masterGain.connect(audioContext.destination);
}

function createVinylNoise() {
    const bufferSize = audioContext.sampleRate * 4; // 4 seconds loop
    const buffer = audioContext.createBuffer(1, bufferSize, audioContext.sampleRate);
    const data = buffer.getChannelData(0);

    let lastOut = 0;
    for (let i = 0; i < bufferSize; i++) {
        // Pink noise approximation
        const white = Math.random() * 2 - 1;
        const pink = (lastOut + (0.02 * white)) / 1.02;
        lastOut = pink;

        data[i] = pink * 0.15; // Base noise level

        // Add random pops/crackle
        if (Math.random() < 0.0008) {
            data[i] += (Math.random() * 2 - 1) * 0.8; // Pop
        }
    }

    noiseSource = audioContext.createBufferSource();
    noiseSource.buffer = buffer;
    noiseSource.loop = true;

    noiseGain = audioContext.createGain();
    noiseGain.gain.value = 0.3; // Noise volume relative to voice

    noiseSource.connect(noiseGain);
    noiseGain.connect(audioContext.destination);
    noiseSource.start();
}

function stopAudio() {
    if (!isPlaying) return;

    // Disconnect and stop everything
    if (mediaStreamSource) {
        mediaStreamSource.disconnect();
        // Stop the tracks to release the mic
        mediaStreamSource.mediaStream.getTracks().forEach(track => track.stop());
    }

    if (noiseSource) {
        noiseSource.stop();
        noiseSource.disconnect();
    }

    if (lfo) {
        lfo.stop();
        lfo.disconnect();
    }

    // Disconnect nodes to be safe
    if (inputGain) inputGain.disconnect();
    if (delayNode) delayNode.disconnect();
    if (lfoGain) lfoGain.disconnect();
    if (highPass) highPass.disconnect();
    if (filterNode) filterNode.disconnect();
    if (compressor) compressor.disconnect();
    if (masterGain) masterGain.disconnect();

    isPlaying = false;
    startBtn.disabled = false;
    stopBtn.disabled = true;
    recordIndicator.classList.remove('spinning');
    statusMsg.innerText = "ボタンを押して開始してください";
}
