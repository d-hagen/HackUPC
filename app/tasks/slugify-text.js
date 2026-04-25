// Example bundled task: uses the `slugify` npm package to convert text to URL slugs.
// Run with: bundle tasks/slugify-text.js "Hello World! Foo & Bar"
//
// The worker does NOT need `slugify` installed — esbuild inlines it into the bundle.

import slugify from 'slugify'

export default async function (text) {
  return {
    original: text,
    slug: slugify(text, { lower: true, strict: true }),
    slugUpper: slugify(text),
    slugCustom: slugify(text, { replacement: '_', lower: true })
  }
}
