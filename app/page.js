'use client'; // This directive ensures the component is rendered on the client side

import React, { useState, useEffect, useRef, useCallback } from 'react';
// pdfjs-dist is now dynamically imported inside useEffect

// Ensure Tailwind CSS is configured in your Next.js project (e.g., via postcss.config.js and tailwind.config.js)
// Also ensure you have 'pdfjs-dist' installed: npm install pdfjs-dist

// Custom CSS for PDF viewer (highlighting removed)
const customStyles = `
  .pdf-page-container {
    position: relative;
    margin-bottom: 20px;
    border: 1px solid #e2e8f0; /* gray-200 */
    box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    border-radius: 8px;
    overflow: hidden;
  }
  .pdf-page-canvas {
    display: block;
    width: 100%; /* Ensure canvas scales */
    height: auto;
  }
  .pdf-text-layer {
    position: absolute;
    left: 0;
    top: 0;
    right: 0;
    bottom: 0;
    overflow: hidden;
    opacity: 1; /* Make text layer visible for interaction/selection */
    line-height: 1; /* Important for accurate text positioning */
    pointer-events: auto; /* Allow text selection */
    user-select: text; /* Enable user selection on the text layer */
  }
  .pdf-text-layer span {
    position: absolute;
    color: transparent !important; /* Make original text completely invisible */
    background-color: transparent; /* Ensure no default highlight */
    transition: background-color 0.1s ease; /* Smooth transition, though not used for highlighting now */
    white-space: pre; /* Preserve whitespace for accurate text layout */
    transform-origin: 0% 0%; /* Crucial for correct matrix transformations */
    -webkit-text-fill-color: transparent !important; /* For WebKit browsers */
  }
  /* The .current-segment-highlight rule has been removed */
`;

function App() {
  const [pdfjs, setPdfjs] = useState(null); // State to hold the dynamically imported pdfjsLib
  const [pdfPages, setPdfPages] = useState([]); // Stores rendered page data { page, textContent }
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(0);
  // isPlaying now strictly indicates the user's intent for continuous playback.
  // It's set to true when "Play" is pressed or playback starts, and false on "Pause" or "Stop".
  const [isPlaying, setIsPlaying] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [isLoading, setIsLoading] = useState(false);
  const [message, setMessage] = useState('Loading PDF.js library...');
  const [voices, setVoices] = useState([]);
  const [selectedVoice, setSelectedVoice] = useState(null);
  const [skipAmount, setSkipAmount] = useState(1); // New state for skip amount
  const pdfViewerRef = useRef(null); // Ref for the scrollable PDF viewer container

  const speechSynthesisRef = useRef(null); // Ref to window.speechSynthesis
  const currentUtteranceRef = useRef(null); // Ref to the currently speaking utterance
  const textSegmentsRef = useRef([]); // A ref to store the actual text segments for speech

  // Ref to store ongoing PDF rendering tasks, keyed by page number
  const renderTasksRef = useRef({});

  // Effect to dynamically import pdfjs-dist and initialize speech synthesis
  useEffect(() => {
    // Dynamic import for pdfjs-dist
    import('pdfjs-dist')
      .then((module) => {
        setPdfjs(module);
        setMessage(''); // Clear loading message once loaded
      })
      .catch((error) => {
        console.error('Failed to load pdfjs-dist:', error);
        setMessage('Error loading PDF.js library.');
      });

    // Initialize speech synthesis
    speechSynthesisRef.current = window.speechSynthesis;

    const populateVoiceList = () => {
      const availableVoices = speechSynthesisRef.current.getVoices();
      setVoices(availableVoices);
      const defaultVoice = availableVoices.find(
        (voice) => voice.lang.startsWith('en') && voice.default
      ) || availableVoices.find((voice) => voice.lang.startsWith('en'));
      setSelectedVoice(defaultVoice || availableVoices[0]);
    };

    if (speechSynthesisRef.current.onvoiceschanged !== undefined) {
      speechSynthesisRef.current.onvoiceschanged = populateVoiceList;
    }
    populateVoiceList(); // Call immediately in case voices are already loaded

    // Cleanup function
    return () => {
      if (speechSynthesisRef.current) {
        speechSynthesisRef.current.cancel();
        speechSynthesisRef.current.onvoiceschanged = null;
      }
      // Cancel any ongoing PDF rendering tasks on unmount
      Object.values(renderTasksRef.current).forEach(task => {
        if (task && task.cancel) {
          task.cancel();
        }
      });
      renderTasksRef.current = {};
    };
  }, []);

  // Function to display messages to the user
  const showMessage = (msg, type = 'info') => {
    setMessage(msg);
    // You might want to re-enable setTimeout later if you want messages to disappear
    // setTimeout(() => setMessage(''), 5000);
  };

  // Function to render a single PDF page to a canvas, dynamically scaling
  const renderPage = useCallback(async (page, canvas, containerWidth, pageNumber) => {
    if (!pdfjs) return null; // Ensure pdfjs is loaded

    // Cancel any previous rendering task for this canvas
    if (renderTasksRef.current[pageNumber] && renderTasksRef.current[pageNumber].cancel) {
      renderTasksRef.current[pageNumber].cancel();
    }

    const originalViewport = page.getViewport({ scale: 1.0 });
    const scale = containerWidth / originalViewport.width;
    const viewport = page.getViewport({ scale: scale });

    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    const renderContext = {
      canvasContext: context,
      viewport: viewport,
    };

    // Store the new render task
    const renderTask = page.render(renderContext);
    renderTasksRef.current[pageNumber] = renderTask;

    try {
      await renderTask.promise;
      renderTasksRef.current[pageNumber] = null; // Clear task on completion
    } catch (error) {
      if (error.name === 'RenderingCancelledException') {
        console.log(`Page ${pageNumber} rendering cancelled.`);
      } else {
        console.error(`Error rendering page ${pageNumber}:`, error);
      }
      renderTasksRef.current[pageNumber] = null; // Clear task on error/cancellation
    }
    return viewport; // Return the actual viewport used for rendering
  }, [pdfjs]); // Dependency on pdfjs

  // Function to handle PDF file upload
  const handleFileChange = async (event) => {
    if (!pdfjs) {
      showMessage('PDF.js library is still loading. Please wait.', 'warning');
      return;
    }

    const file = event.target.files[0];
    if (!file) {
      showMessage('Please select a PDF file.', 'error');
      return;
    }

    if (file.type !== 'application/pdf') {
      showMessage('Invalid file type. Please upload a PDF.', 'error');
      return;
    }

    setIsLoading(true);
    setMessage('Processing PDF...');
    setPdfPages([]);
    textSegmentsRef.current = [];
    setCurrentSegmentIndex(0);
    setIsPlaying(false); // Reset playback state

    if (speechSynthesisRef.current) {
      speechSynthesisRef.current.cancel();
    }

    // Cancel any existing render tasks before loading new PDF
    Object.values(renderTasksRef.current).forEach(task => {
      if (task && task.cancel) {
        task.cancel();
      }
    });
    renderTasksRef.current = {};


    try {
      // Set the worker source for PDF.js to a local path.
      // You MUST copy 'node_modules/pdfjs-dist/build/pdf.worker.mjs'
      // to your Next.js 'public' directory (e.g., 'public/pdf.worker.mjs')
      pdfjs.GlobalWorkerOptions.workerSrc = `/pdf.worker.mjs`; // Updated to .mjs

      const arrayBuffer = await file.arrayBuffer();
      const pdfDocument = await pdfjs.getDocument({ data: arrayBuffer }).promise;

      const loadedPages = [];
      let fullText = '';

      for (let i = 1; i <= pdfDocument.numPages; i++) {
        const page = await pdfDocument.getPage(i);
        const textContent = await page.getTextContent();
        loadedPages.push({
          page,
          textContent,
          pageNumber: i,
        });

        // Add a space to ensure words from different items are separated
        fullText += textContent.items.map((item) => item.str).join(' ') + '\n\n';
      }

      setPdfPages(loadedPages);

      // Simple sentence segmentation (can be improved for accuracy)
      // This regex tries to split by sentence-ending punctuation followed by whitespace and an uppercase letter
      const segments = fullText.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim().length > 0);
      textSegmentsRef.current = segments;

      if (segments.length === 0) {
        showMessage('No readable text found in the PDF.', 'warning');
        setIsLoading(false);
        return;
      }

      showMessage(`PDF processed. Found ${pdfDocument.numPages} pages and ${segments.length} text segments.`, 'success');
    } catch (error) {
      console.error('Error processing PDF:', error);
      showMessage(`Error processing PDF: ${error.message}`, 'error');
    } finally {
      setIsLoading(false);
    }
  };

  // Effect to render PDF pages when `pdfPages` state changes or viewer size changes
  useEffect(() => {
    const renderAllPages = async () => {
      if (!pdfjs || pdfPages.length === 0 || !pdfViewerRef.current) return;

      const viewerWidth = pdfViewerRef.current.offsetWidth;

      for (const pageData of pdfPages) {
        const canvas = document.getElementById(`pdf-canvas-${pageData.pageNumber}`);
        const textLayerDiv = document.getElementById(`pdf-text-layer-${pageData.pageNumber}`);

        if (canvas && textLayerDiv) {
          const viewport = await renderPage(pageData.page, canvas, viewerWidth, pageData.pageNumber);

          textLayerDiv.innerHTML = ''; // Clear previous text layer content

          textLayerDiv.style.width = `${canvas.width}px`;
          textLayerDiv.style.height = `${canvas.height}px`;

          pageData.textContent.items.forEach(item => {
            const span = document.createElement('span');
            span.textContent = item.str;

            // Apply the transform matrix directly for precise positioning
            const textTransform = pdfjs.Util.transform(viewport.transform, item.transform);
            span.style.transform = `matrix(${textTransform.join(',')})`;

            span.style.fontSize = `${item.height * viewport.scale}px`;
            span.style.fontFamily = item.fontName;
            span.style.whiteSpace = 'pre'; // Preserve whitespace for accurate text layout
            span.style.lineHeight = '1'; // Ensure line height doesn't add extra space

            textLayerDiv.appendChild(span);
          });
        }
      }
    };

    renderAllPages();

    const resizeObserver = new ResizeObserver(() => {
      renderAllPages();
    });

    if (pdfViewerRef.current) {
      resizeObserver.observe(pdfViewerRef.current);
    }

    return () => {
      if (pdfViewerRef.current) {
        resizeObserver.unobserve(pdfViewerRef.current);
      }
    };
  }, [pdfjs, pdfPages, renderPage]);

  // Function to speak a specific segment
  const speakSegment = useCallback((indexToSpeak) => {
    if (!speechSynthesisRef.current || textSegmentsRef.current.length === 0) {
      setIsPlaying(false); // No speech possible
      return;
    }

    // Handle end of document scenario
    if (indexToSpeak >= textSegmentsRef.current.length) {
      setIsPlaying(false); // Not playing anymore
      setCurrentSegmentIndex(0); // Reset for next time
      if (speechSynthesisRef.current.speaking || speechSynthesisRef.current.paused) {
        speechSynthesisRef.current.cancel(); // Ensure all speech is stopped
      }
      showMessage('End of document.', 'info');
      return;
    }
    // Handle going below start
    if (indexToSpeak < 0) {
      indexToSpeak = 0;
    }

    // Always cancel any existing speech before queueing a new one.
    // This is crucial for smooth transitions and state reliability.
    if (speechSynthesisRef.current.speaking || speechSynthesisRef.current.paused) {
      speechSynthesisRef.current.cancel();
    }

    const textToSpeak = textSegmentsRef.current[indexToSpeak];
    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    utterance.rate = playbackRate;
    if (selectedVoice) {
      utterance.voice = selectedVoice;
    }
    setIsPlaying(true);

    utterance.onend = () => {
      // The `isPlaying` state is the source of truth for *continuous playback intent*.
      // If `isPlaying` is true, it means the user wants it to keep playing.
      // We also make sure the API itself isn't paused (e.g., if togglePlayPause paused it).
      if (isPlaying && !speechSynthesisRef.current.paused) {
        setCurrentSegmentIndex((prevIndex) => {
          const nextIndex = prevIndex + 1;
          speakSegment(nextIndex); // Recursively call to play the next segment
          return nextIndex; // Update the index state
        });
      } else {
        // If `isPlaying` is false or the API is paused, we stop auto-advancing.
        // This ensures that if the user hits pause or stop, auto-advance doesn't override it.
        // `setIsPlaying(false)` might already be set by `togglePlayPause` or `stopPlayback`.
        setIsPlaying(false); // Ensure we are not in a playing state
        currentUtteranceRef.current = null;
      }
    };

    utterance.onerror = (event) => {
      // 'interrupted' errors are expected when we programmatically cancel speech.
      // Log other types of errors as actual issues.
      if (event.error !== 'interrupted') {
        console.error('SpeechSynthesisUtterance.onerror', event);
        showMessage(`Speech error: ${event.error}`, 'error');
      }
      setIsPlaying(false); // Set state to not playing on any error
      currentUtteranceRef.current = null;
    };

    currentUtteranceRef.current = utterance;
    speechSynthesisRef.current.speak(utterance);
    // When we explicitly call speak, our intent is always to play continuously.
    setCurrentSegmentIndex(indexToSpeak); // Make sure our component's index is aligned
  }, [isPlaying, playbackRate, selectedVoice]);


  // Stop playback and reset all related states
  const stopPlayback = useCallback(() => {
    if (speechSynthesisRef.current) {
      speechSynthesisRef.current.cancel(); // Stop any ongoing speech
    }
    setIsPlaying(false); // Set our internal state to not playing
    setCurrentSegmentIndex(0); // Reset segment index for fresh start
    currentUtteranceRef.current = null; // Clear the utterance ref
  }, []); // No dependencies as it just cancels speech

  // Play/Pause toggle - This is the most crucial function for reliability
  const togglePlayPause = useCallback(() => {
    if (!textSegmentsRef.current.length) {
      showMessage('Please upload a PDF first.', 'warning');
      return;
    }

    if (!speechSynthesisRef.current) {
      showMessage('Speech synthesis not available.', 'error');
      return;
    }

    // Determine action based on the actual state of the Web Speech API
    if (speechSynthesisRef.current.speaking) {
      // If currently speaking, pause it
      speechSynthesisRef.current.pause();
      setIsPlaying(false); // User's intent is now to pause/stop continuous playback
    } else if (speechSynthesisRef.current.paused) {
      // If currently paused, resume it
      speechSynthesisRef.current.resume();
      setIsPlaying(true); // User's intent is now to resume continuous playback
    } else {
      // If neither speaking nor paused (e.g., initial state, or after stop/end/cancel)
      // We want to start new speech from the current segment.
      // `speakSegment` will handle cancelling existing utterances and setting `isPlaying` to true.
      speakSegment(currentSegmentIndex);
      // setIsPlaying is set to true within speakSegment itself
    }
  }, [currentSegmentIndex, speakSegment, textSegmentsRef]);


  // Move to the next segment
  const forward = useCallback(() => {
    if (!textSegmentsRef.current.length) return;
    const nextIndex = Math.min(currentSegmentIndex + skipAmount, textSegmentsRef.current.length - 1);
    // Call speakSegment directly. It will handle canceling current speech and setting isPlaying = true.
    speakSegment(nextIndex);
  }, [currentSegmentIndex, skipAmount, speakSegment, textSegmentsRef]);

  // Move to the previous segment
  const backward = useCallback(() => {
    if (!textSegmentsRef.current.length) return;
    const prevIndex = Math.max(currentSegmentIndex - skipAmount, 0);
    // Call speakSegment directly. It will handle canceling current speech and setting isPlaying = true.
    speakSegment(prevIndex);
  }, [currentSegmentIndex, skipAmount, speakSegment, textSegmentsRef]);

  // Change playback speed
  const handleSpeedChange = useCallback((event) => {
    const newRate = parseFloat(event.target.value);
    setPlaybackRate(newRate);

    // If `isPlaying` is true, it means we want continuous playback.
    // So, we restart the current segment with the new rate.
    // `speakSegment` handles cancelling the old utterance and starting a new one.
    if (isPlaying) {
      speakSegment(currentSegmentIndex);
    }
  }, [isPlaying, currentSegmentIndex, speakSegment]);

  // Handle voice selection
  const handleVoiceChange = useCallback((event) => {
    const selectedVoiceURI = event.target.value;
    const voice = voices.find(v => v.voiceURI === selectedVoiceURI);
    setSelectedVoice(voice);

    // If `isPlaying` is true, restart the current segment with the new voice.
    if (isPlaying) {
      speakSegment(currentSegmentIndex);
    }
  }, [isPlaying, currentSegmentIndex, voices, speakSegment]);


  return (
    <div className="h-screen w-screen bg-gradient-to-br from-purple-100 to-blue-200 flex items-center justify-center font-inter">
      {/* Inject custom styles for PDF viewer */}
      <style>{customStyles}</style>

      <div className="bg-white p-8 rounded-2xl shadow-xl w-full h-full max-w-full text-center flex flex-col md:flex-row">
        {/* Left Panel: Controls */}
        <div className="md:w-1/3 p-4 border-b md:border-b-0 md:border-r border-gray-200">
          <h1 className="text-4xl font-extrabold text-gray-800 mb-6">
            TxtParrot
          </h1>

          {/* File Upload */}
          <div className="mb-6">
            <label
              htmlFor="pdf-upload"
              className="block text-lg font-medium text-gray-700 mb-2"
            >
              Upload your PDF file:
            </label>
            <input
              type="file"
              id="pdf-upload"
              accept=".pdf"
              onChange={handleFileChange}
              className="block w-full text-sm text-gray-500
                          file:mr-4 file:py-2 file:px-4
                          file:rounded-full file:border-0
                          file:text-sm file:font-semibold
                          file:bg-blue-50 file:text-blue-700
                          hover:file:bg-blue-100 cursor-pointer"
            />
          </div>

          {/* Loading Indicator */}
          {isLoading && (
            <div className="flex items-center justify-center mb-4 text-blue-600">
              <svg
                className="animate-spin -ml-1 mr-3 h-5 w-5 text-blue-600"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                ></circle>
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                ></path>
              </svg>
              {message}
            </div>
          )}

          {/* Message Box */}
          {message && !isLoading && (
            <div
              className={`p-3 rounded-lg mb-4 ${message.includes('Error') ? 'bg-red-100 text-red-700' :
                message.includes('warning') ? 'bg-yellow-100 text-yellow-700' :
                  'bg-green-100 text-green-700'
                }`}
            >
              {message}
            </div>
          )}

          {/* Playback Controls */}
          <div className="flex justify-center items-center space-x-4 mb-6">
            <button
              onClick={backward}
              disabled={isLoading || textSegmentsRef.current.length === 0 || currentSegmentIndex === 0}
              className="p-3 bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-all duration-200
                          disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              aria-label="Backward"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M11 19l-7-7 7-7m8 14l-7-7 7-7"
                />
              </svg>
            </button>

            <button
              onClick={togglePlayPause}
              disabled={isLoading || textSegmentsRef.current.length === 0}
              className="p-4 bg-purple-600 text-white rounded-full shadow-lg hover:bg-purple-700 transition-all duration-200
                          disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              // The icon now accurately reflects `isPlaying` which tracks continuous playback intent
              aria-label={isPlaying ? "Pause" : "Play"}
            >
              {isPlaying ? ( // `isPlaying` is our component's state tracking play intent
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-8 w-8"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              ) : (
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-8 w-8"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                  />
                </svg>
              )}
            </button>

            <button
              onClick={stopPlayback}
              // Disable if not speaking AND not paused
              disabled={isLoading || !(speechSynthesisRef.current?.speaking || speechSynthesisRef.current?.paused)}
              className="p-3 bg-red-500 text-white rounded-full shadow-md hover:bg-red-600 transition-all duration-200
                          disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              aria-label="Stop"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                />
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M9 9h6v6H9V9z"
                />
              </svg>
            </button>

            <button
              onClick={forward}
              disabled={isLoading || textSegmentsRef.current.length === 0 || currentSegmentIndex >= textSegmentsRef.current.length - 1}
              className="p-3 bg-blue-500 text-white rounded-full shadow-md hover:bg-blue-600 transition-all duration-200
                          disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center"
              aria-label="Forward"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-6 w-6"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M13 5l7 7-7 7M5 5l7 7-7 7"
                />
              </svg>
            </button>
          </div>

          {/* Playback Speed Control */}
          <div className="mb-6 flex flex-col items-center">
            <label htmlFor="speed-control" className="block text-lg font-medium text-gray-700 mb-2">
              Playback Speed: {playbackRate.toFixed(1)}x
            </label>
            <input
              type="range"
              id="speed-control"
              min="0.5"
              max="2.0"
              step="0.1"
              value={playbackRate}
              onChange={handleSpeedChange}
              className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-500"
              disabled={isLoading || textSegmentsRef.current.length === 0}
            />
          </div>

          {/* Skip Amount Control */}
          <div className="mb-6 flex flex-col items-center">
            <label htmlFor="skip-amount" className="block text-lg font-medium text-gray-700 mb-2">
              Segments to Skip/Rewind:
            </label>
            <input
              type="number"
              id="skip-amount"
              min="1"
              value={skipAmount}
              onChange={(e) => setSkipAmount(parseInt(e.target.value) || 1)}
              className="w-24 p-2 border border-gray-300 rounded-md shadow-sm text-center focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              disabled={isLoading || textSegmentsRef.current.length === 0}
            />
          </div>

          {/* Voice Selection */}
          <div className="mb-6 flex flex-col items-center">
            <label htmlFor="voice-select" className="block text-lg font-medium text-gray-700 mb-2">
              Select Voice:
            </label>
            <select
              id="voice-select"
              value={selectedVoice?.voiceURI || ''}
              onChange={handleVoiceChange}
              className="block w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-blue-500 focus:border-blue-500 sm:text-sm"
              disabled={isLoading || voices.length === 0}
            >
              {voices.length === 0 && <option value="">Loading voices...</option>}
              {voices.map((voice) => (
                <option key={voice.voiceURI} value={voice.voiceURI}>
                  {voice.name} ({voice.lang}) {voice.default ? '[Default]' : ''}
                </option>
              ))}
            </select>
          </div>

          {/* Current Text Display (for debugging/reference) */}
          {textSegmentsRef.current.length > 0 && (
            <div className="mt-8 p-4 bg-gray-50 rounded-lg border border-gray-200 shadow-inner max-h-40 overflow-y-auto text-left text-sm">
              <h2 className="text-md font-semibold text-gray-800 mb-2">
                Current Segment:
              </h2>
              <p className="text-gray-700 leading-relaxed">
                {textSegmentsRef.current[currentSegmentIndex]}
              </p>
              <p className="text-sm text-gray-500 mt-2">
                Segment {currentSegmentIndex + 1} of {textSegmentsRef.current.length}
              </p>
            </div>
          )}
        </div>

        {/* Right Panel: PDF Viewer */}
        <div className="md:w-2/3 p-4 flex flex-col items-center">
          <h2 className="text-2xl font-bold text-gray-800 mb-4">PDF Viewer</h2>
          <div
            ref={pdfViewerRef}
            className="pdf-viewer-container w-full max-h-[80vh] overflow-y-auto bg-gray-100 rounded-lg p-2 shadow-inner"
          >
            {pdfPages.length === 0 && !isLoading && (
              <p className="text-gray-500">Upload a PDF to view it here.</p>
            )}
            {pdfPages.map((pageData) => (
              <div key={pageData.pageNumber} className="pdf-page-container relative">
                <canvas
                  id={`pdf-canvas-${pageData.pageNumber}`}
                  className="pdf-page-canvas"
                ></canvas>
                <div
                  id={`pdf-text-layer-${pageData.pageNumber}`}
                  className="pdf-text-layer"
                // Styles for width/height will be set dynamically by useEffect
                >
                  {/* Text content will be dynamically inserted here by useEffect */}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;