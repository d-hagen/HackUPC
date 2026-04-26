#!/usr/bin/env python3
"""
GPU-accelerated image blur for PeerCompute.
Reads a strip of pixel data from stdin (JSON), applies Gaussian blur using
PyTorch (CUDA/MPS/CPU), returns result as JSON to stdout.

Input JSON: { startRow, endRow, width, height, pixels: [[r,g,b],...] }
Output JSON: { startRow, endRow, width, pixels: [[r,g,b],...], device, elapsed_ms }
"""
import sys
import json
import time

def get_device():
    import torch
    if torch.cuda.is_available():
        return torch.device('cuda'), 'CUDA'
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps'), 'MPS (Apple Silicon)'
    return torch.device('cpu'), 'CPU'

try:
    import torch
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False

def blur_with_torch(pixels, width, device_obj, kernel_size=15, sigma=4.0):
    import torch
    import torch.nn.functional as F
    import math

    h = len(pixels)
    # Build tensor [1, 3, H, W]
    flat = [v for row in pixels for px in row for v in px]
    t = torch.tensor(flat, dtype=torch.float32, device=device_obj).reshape(1, h, width, 3)
    t = t.permute(0, 3, 1, 2)  # [1, 3, H, W]

    # Gaussian kernel
    k = kernel_size
    x = torch.arange(k, dtype=torch.float32, device=device_obj) - k // 2
    gauss = torch.exp(-x**2 / (2 * sigma**2))
    gauss = gauss / gauss.sum()
    kernel_2d = gauss.unsqueeze(0) * gauss.unsqueeze(1)  # [k, k]
    kernel_2d = kernel_2d.unsqueeze(0).unsqueeze(0)       # [1, 1, k, k]
    kernel_2d = kernel_2d.repeat(3, 1, 1, 1)              # [3, 1, k, k]

    pad = k // 2
    t_padded = F.pad(t, (pad, pad, pad, pad), mode='reflect')
    blurred = F.conv2d(t_padded, kernel_2d, groups=3)

    # Sync before timing
    if device_obj.type == 'cuda':
        torch.cuda.synchronize()
    elif device_obj.type == 'mps':
        torch.mps.synchronize()

    # Back to CPU + clamp
    blurred = blurred.permute(0, 2, 3, 1).squeeze(0).clamp(0, 255)
    arr = blurred.to('cpu').to(torch.uint8).tolist()
    return [[tuple(px) for px in row] for row in arr]

def blur_cpu_fallback(pixels, kernel_size=15):
    """Simple box blur fallback when PyTorch not available."""
    h = len(pixels)
    w = len(pixels[0]) if h > 0 else 0
    out = []
    r = kernel_size // 2
    for y in range(h):
        row = []
        for x in range(w):
            rs = gs = bs = cnt = 0
            for dy in range(-r, r+1):
                for dx in range(-r, r+1):
                    ny, nx = y+dy, x+dx
                    if 0 <= ny < h and 0 <= nx < w:
                        px = pixels[ny][nx]
                        rs += px[0]; gs += px[1]; bs += px[2]; cnt += 1
            row.append([rs//cnt, gs//cnt, bs//cnt])
        out.append(row)
    return out

data = json.loads(sys.stdin.read())
pixels = data['pixels']
width = data['width']
start_row = data['startRow']
end_row = data['endRow']

t0 = time.time()

if HAS_TORCH:
    device_obj, device_name = get_device()
    result_pixels = blur_with_torch(pixels, width, device_obj)
else:
    device_name = 'CPU (no PyTorch)'
    result_pixels = blur_cpu_fallback(pixels)

elapsed = (time.time() - t0) * 1000

print(json.dumps({
    'startRow': start_row,
    'endRow': end_row,
    'width': width,
    'rows': result_pixels,
    'device': device_name,
    'elapsed_ms': round(elapsed, 1)
}))
