#!/usr/bin/env python3
"""
GPU benchmark for PeerCompute workers.
Auto-selects: CUDA -> MPS (Apple Silicon) -> CPU
Usage: python3 gpu-benchmark.py [--size 4096]
"""
import sys
import time

def get_device():
    import torch
    if torch.cuda.is_available():
        return torch.device('cuda'), f"CUDA ({torch.cuda.get_device_name(0)})"
    if hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        return torch.device('mps'), "MPS (Apple Silicon Metal)"
    return torch.device('cpu'), f"CPU"

def sync(device):
    import torch
    if device.type == 'cuda':
        torch.cuda.synchronize()
    elif device.type == 'mps':
        torch.mps.synchronize()

try:
    import torch
except ImportError:
    print("ERROR: PyTorch not installed. Run: pip install torch")
    sys.exit(1)

size = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[1] == '--size' else 4096
device, device_name = get_device()

print(f"Device: {device_name}")
print(f"Matrix size: {size}x{size} float32")

a = torch.randn(size, size, device=device)
b = torch.randn(size, size, device=device)

# Warm-up
sync(device)
_ = torch.matmul(a, b)
sync(device)

# Benchmark — 3 iterations
times = []
for _ in range(3):
    sync(device)
    t0 = time.perf_counter()
    c = torch.matmul(a, b)
    sync(device)
    times.append(time.perf_counter() - t0)

avg_ms = (sum(times) / len(times)) * 1000
tflops = (2 * size ** 3) / (sum(times) / len(times)) / 1e12

print(f"Avg time: {avg_ms:.1f}ms")
print(f"Performance: {tflops:.2f} TFlops")
print(f"Result checksum: {c.sum().item():.4f}")
