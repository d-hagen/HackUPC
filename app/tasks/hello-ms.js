// Example bundled task: uses the `ms` npm package to format a duration.
// Run with: bundle tasks/hello-ms.js
//
// The worker does NOT need `ms` installed — esbuild inlines it into the bundle.

import ms from 'ms'

export default async function () {
  const durations = [1000, 60000, 3600000, 86400000]
  return durations.map(d => `${d}ms = ${ms(d)}`)
}
