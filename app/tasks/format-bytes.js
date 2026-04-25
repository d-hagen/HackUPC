// Example bundled task with arguments: formats a byte count into a human-readable string.
// Run with: bundle tasks/format-bytes.js 1048576
//
// Uses ms just to demonstrate a real npm dep alongside arguments.

import ms from 'ms'

export default async function (bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = Number(bytes)
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return {
    formatted: `${value.toFixed(2)} ${units[unit]}`,
    // demo: show ms of a made-up transfer time (1 byte/ms)
    transferTime: ms(Number(bytes))
  }
}
