import os
import io
import wave
import numpy as np
import tempfile
import shutil
from flask import Flask, request, jsonify, Response, send_file
from pydub import AudioSegment # Import pydub for audio conversion
import torch
from openvoice import se_extractor
from openvoice.api import ToneColorConverter
from melo.api import TTS
from glob import glob
from flask_socketio import SocketIO, emit
from flask_cors import CORS,cross_origin
# --- Flask Application Setup ---
app = Flask(__name__)
CORS(app)
# Global configuration for the TTS service
device = 'cpu' # Specifies the processing device (CPU for this example), 'auto' will be handled by TTS class
ckpt_converter = 'checkpoints_v2/converter'
device = "cuda:0" if torch.cuda.is_available() else "cpu"
output_dir = 'outputs'

# Initialize ToneColorConverter
tone_color_converter = ToneColorConverter(f'{ckpt_converter}/config.json', device=device)
tone_color_converter.load_ckpt(f'{ckpt_converter}/checkpoint.pth')

os.makedirs(output_dir, exist_ok=True)

# --- API Endpoint Definition ---
@app.route("/")
def hello_world():
    return "<p>Welcome to txtparrot!</p>"

@app.route("/clone", methods=['POST'])
@cross_origin(origin='*')

def clone_speaker():
    """
    API endpoint for cloning a speaker's voice.
    
    Expects a FormData payload with:
    - 'audio': The audio file (WebM format) to be cloned.
    - 'userId': The user ID associated with this cloning request.
    
    Returns:
    - A JSON response with success message if successful.
    - A JSON error message with a 400 or 500 status code if an error occurs.
    """
    
    if 'audio' not in request.files:
        return jsonify({"error": "No audio file provided."}), 400
    
    if 'userId' not in request.form:
        return jsonify({"error": "Missing 'userId' in request payload."}), 400

    audio_file = request.files['audio']
    userId = request.form['userId']
    
    # Create a temporary directory for processing
    webm_path = os.path.join("resources", f"{userId}_voice.webm")
    mp3_path = os.path.join("resources", f"{userId}_voice.mp3")

    try:
        # Save the incoming webm audio file
        audio_file.save(webm_path)
        
        # Convert webm to mp3 using pydub
        # Ensure ffmpeg is installed and accessible in your system's PATH
        audio = AudioSegment.from_file(webm_path, format="webm")
        audio.export(mp3_path, format="mp3")
        
        # Now use the MP3 file for speaker embedding extraction
        reference_speaker = mp3_path # This is the voice you want to clone
        
        # Assuming se_extractor.get_se uses the tone_color_converter and returns target_se, audio_name
        target_se, audio_name = se_extractor.get_se(reference_speaker, tone_color_converter, vad=True)
        
        # In a real application, you would store `target_se` associated with `userId`
        # For demonstration, we'll just return a success message.
        # Note: target_se is a tensor, you might want to save it or convert to list/numpy array for storage.
        
        return jsonify({"success": f"Audio cloned successfully for user {userId}! Audio path: {str(audio_name)}"})
    except Exception as e:
        print(f"Error during cloning for user {userId}: {e}")
        return jsonify({"error": f"Failed to clone speaker: {str(e)}"}), 500

@app.route('/tts', methods=['POST'])
@cross_origin(origin='*')

def generate_and_send_audio():
    """
    API endpoint for converting text to speech, generating a full WAV file,
    and sending it back to the client.
    
    Expects a JSON payload with:
    - 'text': The text to convert to speech (required).
    - 'language': The language of the text (e.g., 'EN', 'ES', 'FR') (required).
    - 'userId': The key for the desired speaker (e.g., 'EN_NEWEST', 'EN'). Defaults to 'EN_NEWEST'.
    - 'speed': The speech speed (e.g., 1.0 for normal). Defaults to 1.0.
    - 'apply_tone_conversion': Boolean to indicate if tone conversion should be applied. Defaults to False.
    
    Returns:
    - An audio/wav file if successful.
    - A JSON error message with a 400 or 500 status code if an error occurs.
    """
    data = request.json
    if not data:
        return jsonify({"error": "Invalid JSON payload. Please send a JSON object."}), 400

    text = data.get('text')
    language = data.get('language')
    userId = data.get('userId', 'EN_NEWEST') 
    speed = data.get('speed', 1.0)
    apply_tone_conversion = data.get('apply_tone_conversion', False)

    # Validate required inputs
    if not text:
        return jsonify({"error": "Missing 'text' in request payload."}), 400
    if not language:
        return jsonify({"error": "Missing 'language' in request payload."}), 400


    try:
       

        src_path = f'{output_dir}/tmp.wav'

        # Speed is adjustable
        speed = 1.0

        model = TTS(language="EN", device=device)
        speaker_ids = model.hps.data.spk2id
        reference_speaker = os.path.join("resources", f"{userId}_voice.mp3")
        if not  os.path.exists(reference_speaker) and os.path.getsize(reference_speaker) > 0:
            return jsonify({"error": f"Speaker {userId} not found. Please clone the speaker first."}), 404
        if not os.path.exists(f'{output_dir}/{userId}'):
            os.makedirs(f'{output_dir}/{userId}', exist_ok=True)
        target_se, audio_name = se_extractor.get_se(reference_speaker, tone_color_converter, vad=True)

        #speaker_id = speaker_ids[speaker_key]
        speaker_id="EN_INDIA"
        speaker_key = speaker_id.lower().replace('_', '-')
        source_se = torch.load(f'checkpoints_v2/base_speakers/ses/{speaker_key}.pth', map_location=device)
        if torch.backends.mps.is_available() and device == 'cpu':
            torch.backends.mps.is_available = lambda: False
        model.tts_to_file(text, 2, src_path, speed=speed)
        save_path = f'{output_dir}/{userId}/output_v2_{speaker_key}.wav'
        # Run the tone color converter
        encode_message = "@MyShell"
        tone_color_converter.convert(
        audio_src_path=src_path, 
        src_se=source_se, 
        tgt_se=target_se, 
        output_path=save_path,
        message=encode_message)
        # Step 3: Send the generated WAV file
        # Use send_file to send the WAV file directly
        return send_file(save_path, mimetype='audio/wav', as_attachment=False)

    except Exception as e:
        # Log the error for debugging purposes
        print(f"An error occurred during audio generation or sending: {e}")
        return jsonify({"error": f"Internal server error: {str(e)}"}), 500
        
# --- WebSocket Event Handlers ---
#@socketio.on('connect')
#def handle_connect():
#    print('Client connected:', request.sid)
#    emit('message', {'status': 'Connected to WebSocket.'})
#
#@socketio.on('disconnect')
#def handle_disconnect():
#    print('Client disconnected:', request.sid)
#
#@socketio.on('message')
#def handle_message(data):
#    # Expecting a JSON string from the frontend
#    try:
#        message = json.loads(data)
#        message_type = message.get('type')
#
#        if message_type == 'text_to_speech':
#            text = message.get('text')
#            language = message.get('language')
#            userId = message.get('userId')
#            speed = message.get('speed', 1.0)
#            apply_tone_conversion = message.get('apply_tone_conversion', False)
#
#            if not text or not language or not userId:
#                emit('message', {'status': 'Error: Missing text, language, or userId.'})
#                return
#
#            temp_dir = tempfile.mkdtemp()
#            src_path = os.path.join(temp_dir, 'tmp_tts_output.wav')
#            final_audio_path = os.path.join(temp_dir, 'final_output.wav')
#
#            try:
#                tts_model = get_tts_model(language)
#                speaker_id_numeric = tts_model.hps.data.spk2id.get(userId.upper()) 
#
#                if speaker_id_numeric is None:
#                    emit('message', {'status': f"Error: Invalid userId: '{userId}' for language: '{language}'."})
#                    return
#
#                tts_model.tts_to_file(text, speaker_id_numeric, src_path, speed=speed)
#
#                if apply_tone_conversion:
#                    # In a real app, load the actual cloned speaker embedding for userId
#                    tone_color_converter.convert(
#                        audio_src_path=src_path,
#                        src_se=mock_target_se, # Placeholder
#                        tgt_se=mock_target_se, # Placeholder
#                        output_path=final_audio_path,
#                        message="@MyShell" 
#                    )
#                else:
#                    shutil.copyfile(src_path, final_audio_path)
#
#                # Stream raw PCM data over WebSocket
#                with wave.open(final_audio_path, 'rb') as wf:
#                    wf.readframes(0) # Skip WAV header
#                    chunk_size = 1024 * 2 # Read 1024 samples (2 bytes/sample for 16-bit)
#                    while True:
#                        frames = wf.readframes(chunk_size // wf.getsampwidth())
#                        if not frames:
#                            break
#                        emit('message', frames, binary=True) # Emit binary data
#                        socketio.sleep(0.001) # Small sleep to allow other events to process
#
#                emit('message', {'status': 'Audio stream finished.'})
#
#            except Exception as e:
#                print(f"Error during audio generation or streaming: {e}")
#                emit('message', {'status': f"Internal server error: {str(e)}"})
#            finally:
#                if os.path.exists(temp_dir):
#                    shutil.rmtree(temp_dir)
#        else:
#            emit('message', {'status': f"Unknown message type: {message_type}"})
#
#    except json.JSONDecodeError:
#        emit('message', {'status': 'Error: Invalid JSON format.'})
#    except Exception as e:
#        print(f"Unhandled WebSocket message error: {e}")
#        emit('message', {'status': f"Unhandled server error: {str(e)}"})
#
#
## --- How to Run the Flask Application with SocketIO ---
#if __name__ == '__main__':
#    # Use socketio.run instead of app.run
#    socketio.run(app, debug=True, port=5000, allow_unsafe_werkzeug=True)
#
#