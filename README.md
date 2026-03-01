# AudioHide 1.0.1

Hide a song inside a PNG image using LSB (Least Significant Bit) steganography.  
Runs entirely in your browser — no server, no file uploads, no tracking.

also a open source so feel free to use no credit needed

## Live tool

**[Open AudioHide](https://kuro123ri.github.io/audiohide/)** <-- click this ;P

---

## What it does

AudioHide lets you embed an audio file (MP3, WAV, FLAC, etc.) into a PNG image.  
The resulting image looks identical to the original but contains the full song hidden in the pixel data.  
Anyone with the tool can extract the audio back out — or no one can, if you use a passkey.

## How to use

**Encode (hide a song):**
1. Drop a PNG or BMP image into the tool
2. Drop a song file (any audio format)
3. Click **Encode and Download Image**
4. The image downloads with the song hidden inside it

**Decode (extract a song):**
1. Go to the Decode tab
2. Drop an AudioHide-encoded PNG
3. Click **Extract Audio**
4. Play or download the audio

try decode on this lemon

![lemons](https://github.com/kuro123ri/audiohide/edit/main/lemon.PNG?raw=true)

## Features

- **100% local** — nothing leaves your browser
- **Auto speed adjustment** — if the image is too small, audio is sped up automatically to fit
- **Manual speed control** — set exact playback speed and see the pitch shift in semitones
- **Image resize** — resize by pixel dimensions or percentage scale before encoding
- **Pre-compression** — optional JPEG pass to reduce carrier noise before embedding
- **Sample rate control** — lower rate = smaller audio = fits at lower speed = less pitch distortion
- **Audio normalize** — boost quiet audio to full volume before encoding
- **Scatter passkey** — randomise which pixels store which bits using a passphrase, making LSB detection much harder
- **Shows output file size** — see the actual PNG size after encoding

## Technical notes

- Uses the RGB channels (1 bit per channel, 3 bits per pixel, alpha untouched)
- Audio is converted to mono PCM WAV at your chosen sample rate before embedding
- Header stores: magic bytes `AHID`, audio length, speed multiplier, original duration
- Scatter mode uses FNV-1a key hash → Mulberry32 PRNG → Fisher-Yates segment shuffle
- Output is always PNG (lossless) — never re-save as JPEG or the data is destroyed

## License

Public domain — [Unlicense](LICENSE)
