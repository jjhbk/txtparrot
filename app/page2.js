'use client'; // This directive marks the component as a Client Component in Next.js

import React, { useState, useRef, useEffect } from 'react';

// Define the expected sample rate from your backend for raw PCM data.
// IMPORTANT: This MUST match the sample rate of the audio data your Flask backend sends.
const SAMPLE_RATE = 44000; // Sample rate for audio processing

// Function to generate a UUID (Universally Unique Identifier)
const generateUUID = () => {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
        const r = Math.random() * 16 | 0,
            v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
};

// Main App component
const App = () => {
    // State variables for managing application state
    const [isRecording, setIsRecording] = useState(false);
    const [recordedAudioBlob, setRecordedAudioBlob] = useState(null);
    const [recordedAudioURL, setRecordedAudioURL] = useState('');
    const [textInput, setTextInput] = useState('');
    const [statusMessage, setStatusMessage] = useState('Ready to record or type.');
    const [isPlayingGeneratedAudio, setIsPlayingGeneratedAudio] = useState(false); // New state for generated audio playback
    const [userId, setUserId] = useState(null); // User ID stored in local storage

    // Refs for MediaRecorder and AudioContext
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);
    const audioContextRef = useRef(null); // Reference to the AudioContext for playing generated audio

    // Initialize AudioContext and User ID
    useEffect(() => {
        // Initialize AudioContext
        if (window.AudioContext || window.webkitAudioContext) {
            audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)();
        } else {
            setStatusMessage('Web Audio API not supported in this browser.');
        }

        // Generate or retrieve User ID
        let storedUserId = localStorage.getItem('voice_cloning_user_id');
        if (!storedUserId) {
            storedUserId = generateUUID();
            localStorage.setItem('voice_cloning_user_id', storedUserId);
        }
        setUserId(storedUserId);

        // Cleanup function for AudioContext
        return () => {
            if (recordedAudioURL) {
                URL.revokeObjectURL(recordedAudioURL);
            }
            if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
                audioContextRef.current.close();
            }
        };
    }, [recordedAudioURL]); // Re-run if recordedAudioURL changes to revoke previous URL

    /**
     * Starts the audio recording process.
     * Requests microphone access and initializes MediaRecorder.
     */
    const startRecording = async () => {
        setStatusMessage('Requesting microphone access...');
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            audioChunksRef.current = [];

            // Using 'audio/webm' for broader browser compatibility
            mediaRecorderRef.current = new MediaRecorder(stream, { mimeType: 'audio/webm' });

            mediaRecorderRef.current.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    audioChunksRef.current.push(event.data);
                }
            };

            mediaRecorderRef.current.onstop = () => {
                const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
                setRecordedAudioBlob(audioBlob);
                setRecordedAudioURL(URL.createObjectURL(audioBlob));
                setStatusMessage('Recording stopped. Audio ready to send or play.');
                stream.getTracks().forEach(track => track.stop());
            };

            mediaRecorderRef.current.start();
            setIsRecording(true);
            setStatusMessage('Recording...');
        } catch (error) {
            console.error('Error accessing microphone:', error);
            setStatusMessage(`Error: ${error.message}. Please allow microphone access.`);
        }
    };

    /**
     * Stops the audio recording process.
     */
    const stopRecording = () => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
            mediaRecorderRef.current.stop();
            setIsRecording(false);
        }
    };

    /**
     * Sends the recorded audio to the backend via HTTP POST for cloning.
     */
    const sendAudioToServer = async () => {
        if (!recordedAudioBlob) {
            setStatusMessage('No audio recorded yet.');
            return;
        }
        if (!userId) {
            setStatusMessage('User ID not available. Please refresh.');
            return;
        }

        setStatusMessage('Sending audio to server for cloning...');
        const formData = new FormData();
        formData.append('audio', recordedAudioBlob, 'recorded_audio.webm');
        formData.append('userId', userId); // Append the user ID to the form data

        try {
            const response = await fetch('http://localhost:5000/clone', {
                method: 'POST',
                body: formData,
            });

            if (response.ok) {
                const result = await response.json();
                setStatusMessage(`Cloning successful: ${result.success}`);
                setRecordedAudioBlob(null);
                setRecordedAudioURL('');
            } else {
                const errorData = await response.json();
                setStatusMessage(`Failed to send audio: ${errorData.error || response.statusText}`);
            }
        } catch (error) {
            console.error('Error sending audio:', error);
            setStatusMessage(`Network error: ${error.message}`);
        }
    };

    /**
     * Sends the text input to the backend via HTTP POST and plays the received WAV audio.
     */
    const sendTextAndPlayAudio = async () => {
        if (!textInput.trim()) {
            setStatusMessage('Please enter some text.');
            return;
        }
        if (!userId) {
            setStatusMessage('User ID not available. Please refresh.');
            return;
        }
        if (!audioContextRef.current) {
            setStatusMessage('AudioContext not initialized. Cannot play audio.');
            return;
        }

        setStatusMessage('Sending text and requesting audio...');
        setIsPlayingGeneratedAudio(true);

        try {
            // Ensure AudioContext is in 'running' state
            if (audioContextRef.current.state === 'suspended') {
                await audioContextRef.current.resume();
            }

            // Send text and userId as a JSON string via HTTP POST
            const response = await fetch('http://localhost:5000/tts', { // Changed endpoint to /tts
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    text: textInput,
                    userId: userId,
                    language: 'EN', // You might want to make this dynamic
                    speed: 1.0,      // You might want to make this dynamic
                    apply_tone_conversion: false // You might want to make this dynamic
                }),
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(`Server error: ${errorData.error || response.statusText}`);
            }

            // Get the audio data as an ArrayBuffer
            const audioArrayBuffer = await response.arrayBuffer();

            // Decode and play the audio
            const audioBuffer = await audioContextRef.current.decodeAudioData(audioArrayBuffer);
            const source = audioContextRef.current.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(audioContextRef.current.destination);

            source.onended = () => {
                setIsPlayingGeneratedAudio(false);
                setStatusMessage('Audio playback finished.');
            };

            source.start(0); // Play immediately
            setStatusMessage('Playing generated audio...');

        } catch (error) {
            console.error('Error sending text or playing audio:', error);
            setStatusMessage(`Error: ${error.message}`);
            setIsPlayingGeneratedAudio(false);
        }
    };

    return (
        <div className="min-h-screen bg-gradient-to-br from-purple-800 to-indigo-900 flex items-center justify-center p-4 font-inter text-white">
            <div className="bg-gray-800 bg-opacity-70 backdrop-blur-md p-8 rounded-xl shadow-2xl w-full max-w-2xl border border-purple-700">
                <h1 className="text-4xl font-extrabold text-center mb-8 text-transparent bg-clip-text bg-gradient-to-r from-purple-400 to-pink-500">
                    Voice Cloning App
                </h1>

                {/* Status Message */}
                <p className="text-center text-lg mb-6 text-gray-300">
                    {statusMessage}
                </p>

                {/* Display User ID */}
                {userId && (
                    <p className="text-center text-sm mb-4 text-gray-400">
                        Your User ID: <span className="font-mono text-purple-200">{userId}</span>
                    </p>
                )}

                {/* Audio Recording Section */}
                <div className="mb-8 p-6 bg-gray-700 bg-opacity-50 rounded-lg shadow-inner border border-gray-600">
                    <h2 className="text-2xl font-semibold mb-4 text-purple-300">Record Your Voice</h2>
                    <div className="flex justify-center space-x-4 mb-4">
                        <button
                            onClick={startRecording}
                            disabled={isRecording}
                            className={`px-6 py-3 rounded-full text-lg font-bold transition-all duration-300 ${isRecording
                                    ? 'bg-red-600 cursor-not-allowed opacity-70'
                                    : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700 shadow-lg'
                                }`}
                        >
                            {isRecording ? 'Recording...' : 'Start Recording'}
                        </button>
                        <button
                            onClick={stopRecording}
                            disabled={!isRecording}
                            className={`px-6 py-3 rounded-full text-lg font-bold transition-all duration-300 ${!isRecording
                                    ? 'bg-gray-500 cursor-not-allowed opacity-70'
                                    : 'bg-gradient-to-r from-orange-500 to-red-600 hover:from-orange-600 hover:to-red-700 shadow-lg'
                                }`}
                        >
                            Stop Recording
                        </button>
                    </div>
                    {recordedAudioURL && (
                        <div className="mt-4 text-center">
                            <audio controls src={recordedAudioURL} className="w-full max-w-md mx-auto rounded-md bg-gray-900 p-2"></audio>
                            <button
                                onClick={sendAudioToServer}
                                className="mt-4 px-6 py-3 rounded-full text-lg font-bold bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 shadow-lg transition-all duration-300"
                            >
                                Send Audio for Cloning
                            </button>
                        </div>
                    )}
                </div>

                {/* Text Input and Audio Stream Section */}
                <div className="p-6 bg-gray-700 bg-opacity-50 rounded-lg shadow-inner border border-gray-600">
                    <h2 className="text-2xl font-semibold mb-4 text-purple-300">Generate Cloned Audio</h2>
                    <textarea
                        value={textInput}
                        onChange={(e) => setTextInput(e.target.value)}
                        placeholder="Enter text to generate cloned audio..."
                        rows="4"
                        className="w-full p-3 rounded-lg bg-gray-900 text-white border border-gray-600 focus:outline-none focus:ring-2 focus:ring-purple-500 mb-4 resize-none"
                        disabled={isPlayingGeneratedAudio}
                    ></textarea>
                    <button
                        onClick={sendTextAndPlayAudio}
                        disabled={isPlayingGeneratedAudio || !textInput.trim()}
                        className={`px-6 py-3 rounded-full text-lg font-bold w-full transition-all duration-300 ${isPlayingGeneratedAudio || !textInput.trim()
                                ? 'bg-gray-500 cursor-not-allowed opacity-70'
                                : 'bg-gradient-to-r from-purple-500 to-pink-600 hover:from-purple-600 hover:to-pink-700 shadow-lg'
                            }`}
                    >
                        {isPlayingGeneratedAudio ? 'Playing Audio...' : 'Generate and Play Audio'}
                    </button>
                </div>
            </div>
        </div>
    );
};

export default App;
