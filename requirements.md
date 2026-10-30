# Requirements

## Blender

| | Version | Notes |
|---|---|---|
| **Required** | **Blender 5.2** (5.2.x LTS) | The version the generator is developed and tested with. CI installs the newest 5.2.x Linux build automatically. |
| Should work | 4.2 LTS – 5.1 | Version-specific APIs have fallbacks: EEVEE engine ID, Principled BSDF socket names, layered vs. legacy actions, compositor node tree, Glare node type. These versions are untested. |
| Not supported | ≤ 4.1 | Missing `compositor_device`, the `Coat` socket name, and Cycles adaptive sampling defaults. |

The script also runs with the official **`bpy` Python module** (`pip install bpy==5.2.3` on Python 3.13). It's handy for building the scene without a Blender install.

### Render engine and hardware

- **Default: Cycles on the CPU.** No GPU is assumed anywhere: the device is forced to CPU, the compositor runs on the CPU, and denoising uses OpenImageDenoise (CPU).
- **EEVEE** (`--engine EEVEE`) needs an OpenGL/EGL context, which means a GPU or a desktop session. It does not work on headless CI runners.

Measured on a 4-core CPU, which matches a GitHub-hosted `ubuntu-24.04` runner for public repos:

| Mode | Render size | Frames rendered | Samples | Motion blur | Time per frame | Total CPU time |
|---|---|---:|---:|---|---:|---:|
| `preview` | 540×960 (encoded at 1080×1920) | 941 (every 2nd) | 12 | off | ~5–6 s | ~1.5 h |
| `final` | 1080×1920 | 1,881 | 32 | on | ~55–60 s | ~30 h |

Per-frame times were measured on the ~46 s version; the totals are extrapolated to the current 1,881 frames. Building the scene, with all 25 Jimmy instances, takes another ~9 minutes. The CI workflow builds it once, caches it, and shares it with every render job.

## System packages (Linux)

The Blender Linux build needs a few X11/GL client libraries, even when running headless:

```bash
sudo apt-get install -y libxi6 libxxf86vm1 libxfixes3 libxrender1 libxkbcommon0 \
  libsm6 libice6 libgl1 libegl1 libglu1-mesa xz-utils
```

## Encoding

- **FFmpeg** with `libx264` (Ubuntu: `sudo apt-get install ffmpeg`).
- Output: H.264 High profile, 1080×1920, 30 fps, `yuv420p`, `+faststart`. That's the standard vertical-video format TikTok, Reels and Shorts accept.

## Python

- Blender's bundled Python runs `animation.py`. There are no third-party packages.
- `python3 animation.py --table | --validate | --plan` run on any Python ≥ 3.8 without Blender.
- CI also uses `jq`, which is preinstalled on GitHub runners.

## Optional assets

Licensed `.glb` / `.gltf` / `.fbx` / `.obj` models in `assets/` replace individual procedural models. See STORYBOARD.md §6. None are required.
