# Visualizer Audio Bridge

This Chrome/Edge MV3 extension captures the audio output of the active Visualizer tab and sends FFT data to the app. It works when Spotify Web Playback SDK is playing inside that same tab.

## Install locally

1. Open `edge://extensions` or `chrome://extensions`.
2. Enable **Developer mode**.
3. Choose **Load unpacked**.
4. Select this `extension` folder.
5. Open the visualizer at `http://127.0.0.1:5173/`.
6. Connect Spotify and start a track.
7. Click the extension toolbar button while the visualizer tab is active.

The browser may require the extension button to be clicked once per capture session. The extension re-routes captured audio to the speakers and sends real frequency bins to the visualizer.
