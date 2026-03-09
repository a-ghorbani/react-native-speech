#!/usr/bin/env python3
"""
Convert Kitten TTS voices.npz to JSON format for React Native consumption.

Usage:
    python convert-kitten-voices.py voices.npz [output_dir]

Input:
    voices.npz - NPZ file from KittenTTS HuggingFace model
                 Contains voice arrays keyed by voice name (e.g., 'Bella', 'Jasper')
                 Each array has shape [N, D] where N=num embeddings, D=embedding dim

Output:
    voices.json           - All voices in a single JSON file (for eager loading)
    voices-manifest.json  - Manifest listing available voices (for lazy loading)
    voices/<name>.json    - Individual voice files (for lazy loading)

The JSON format matches what KittenEngine.VoiceLoader expects:
    {
        "Bella": { "embeddings": [[...], [...], ...], "shape": [N, D] },
        "Jasper": { "embeddings": [[...], [...], ...], "shape": [N, D] },
        ...
    }
"""

import json
import os
import sys

import numpy as np


def convert_voices(npz_path: str, output_dir: str) -> None:
    print(f"Loading voices from: {npz_path}")
    voices = np.load(npz_path, allow_pickle=True)

    all_voices = {}
    voice_names = []

    for key in sorted(voices.files):
        arr = voices[key]
        if arr.ndim != 2:
            print(f"  Skipping '{key}': unexpected shape {arr.shape} (expected 2D)")
            continue

        shape = list(arr.shape)
        print(f"  Voice '{key}': shape {shape}, dtype {arr.dtype}")

        # Convert to float32 list for JSON
        embeddings = arr.astype(np.float32).tolist()
        all_voices[key] = {"embeddings": embeddings, "shape": shape}
        voice_names.append(key)

    if not voice_names:
        print("Error: No valid voice arrays found in NPZ file")
        sys.exit(1)

    # Write all-in-one voices.json
    all_path = os.path.join(output_dir, "voices.json")
    print(f"\nWriting all voices to: {all_path}")
    with open(all_path, "w") as f:
        json.dump(all_voices, f)
    size_mb = os.path.getsize(all_path) / (1024 * 1024)
    print(f"  Size: {size_mb:.1f} MB")

    # Write individual voice files for lazy loading
    voices_dir = os.path.join(output_dir, "voices")
    os.makedirs(voices_dir, exist_ok=True)

    for name in voice_names:
        voice_path = os.path.join(voices_dir, f"{name}.json")
        with open(voice_path, "w") as f:
            json.dump(all_voices[name], f)
        voice_size = os.path.getsize(voice_path) / 1024
        print(f"  {voice_path} ({voice_size:.0f} KB)")

    # Write manifest for lazy loading
    # baseUrl is where individual voice JSON files can be fetched from.
    # Update this to match your HuggingFace repo or CDN.
    base_url = os.environ.get(
        "KITTEN_VOICES_BASE_URL",
        "https://huggingface.co/palshub/kitten-tts-nano-0.8-fp32/resolve/main/voices",
    )
    manifest = {"baseUrl": base_url, "voices": voice_names}
    manifest_path = os.path.join(output_dir, "voices-manifest.json")
    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"\nManifest: {manifest_path}")
    print(f"  baseUrl: {base_url}")
    print(f"  (Override with KITTEN_VOICES_BASE_URL env var)")

    print(f"\nDone! Converted {len(voice_names)} voices: {', '.join(voice_names)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"Usage: {sys.argv[0]} <voices.npz> [output_dir]")
        sys.exit(1)

    npz_path = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.dirname(npz_path) or "."

    if not os.path.exists(npz_path):
        print(f"Error: File not found: {npz_path}")
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)
    convert_voices(npz_path, output_dir)
