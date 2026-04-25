"""
Compute statistics on a JSON array of numbers.
Reads from stdin, writes result to stdout.

Usage: echo '[1,2,3,4,5]' | python3 stats.py
"""
import json, sys

data = json.loads(sys.stdin.read())
result = {
    "sum": sum(data),
    "count": len(data),
    "min": min(data),
    "max": max(data),
    "mean": sum(data) / len(data)
}
print(json.dumps(result))
